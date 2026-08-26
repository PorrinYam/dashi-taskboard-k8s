# K8s shared board deployment (B版: PostgreSQL 多副本)

Run the Taskboard server as a shared board on an existing Kubernetes cluster.

Architecture in this release:

- **PostgreSQL storage** via [CloudNativePG](https://cloudnative-pg.io) (`Cluster` CR,
  2 instances, RW service `taskboard-db-rw`). PostgreSQL is the single authoritative
  store: issues, comments, activities, attachments bytes (`attachment_blobs`) and the
  realtime event log all live there. SQLite remains only for the device-local
  standalone mode (no `DATABASE_URL`).
- **Stateless multi-replica** Taskboard Deployment: default `replicas: 2`,
  `RollingUpdate` strategy (`maxUnavailable: 0`). Pods hold no persistent state; `/data`
  is an emptyDir scratch used only by per-pod file paths that the remote board does not
  rely on.
- **Per-device credentials**: Basic auth is still the transport, but username is now a
  device id and the password a per-device token stored (SHA-256 hash only) in the
  `devices` table. Issuance, verification and revocation all go through the database;
  revocation takes effect immediately on every replica. The legacy
  `CODEX_TASKBOARD_SHARED_SECRET` env keeps its previous behaviour when set (its check
  wins over device auth) so standalone container smoke-tests stay deterministic.
- **Cross-replica realtime fanout** over PostgreSQL LISTEN/NOTIFY (no Redis): writers
  append each change envelope into `taskboard_events` and NOTIFY its sequence number;
  every replica tails the log by sequence and pushes SSE frames plus WebSocket
  `{type:"revision",revision}` frames to its own clients. Delivery latency between
  replicas is the round-trip of one NOTIFY (<5s by design).
- **A档 hardening** shipped in the manifests: non-root user (uid 1000),
  read-only root filesystem, RuntimeDefault seccomp, all capabilities dropped,
  no privilege escalation, memory limits, NetworkPolicies for both the board pods and
  the database, and scheduled VolumeSnapshot backups.

Out of scope (Goal 2): unattended scheduling, automatic issue flow, branch assignment.

## 0. Cluster prerequisites

* Kubernetes ≥ 1.25 with an ingress controller (nginx templates included).
* The CloudNativePG operator. Check whether it is installed:

  ```bash
  kubectl get crd clusters.postgresql.cnpg.io
  ```

  If missing, install it from upstream before running `apply.sh`
  (<https://cloudnative-pg.io/documentation/current/installation_upgrade/>);
  `apply.sh` aborts with instructions when the CRD is absent.
* HTTPS: an existing TLS Secret such as a wildcard certificate.
* For backups: a CSI driver supporting volume snapshots and a `VolumeSnapshotClass`.

## 1. Build the image

On any machine with Docker and this repository checked out:

```bash
IMAGE=registry.example.com/org/dashi-taskboard:v1   # adjust
docker build -f deploy/Dockerfile -t "$IMAGE" .
docker push "$IMAGE"
```

Optional local smoke (standalone fallback path):

```bash
docker run --rm -p 47823:47823 "$IMAGE" &
sleep 3
curl -s http://127.0.0.1:47823/health                       # {"status":"ok"}
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:47823/api/projects   # 401 vs devicemode? see §3
kill %1
```

With neither `DATABASE_URL` nor shared secret set, the container serves open
standalone SQLite — expected output is `200`, not `401`. To rehearse the exact
container auth path locally add `-e CODEX_TASKBOARD_SHARED_SECRET=x` (then any Basic
password works) or point `DATABASE_URL` at a reachable PostgreSQL and register a
device (§3).

## 2. Deploy the base stack

```bash
NAMESPACE=taskboard                                # adjust
IMAGE=registry.example.com/org/dashi-taskboard:v1
BOARD_HOST=taskboard.example.com                   # public HTTPS hostname
INGRESS_CLASS=nginx                                # adjust to your controller
TLS_SECRET=wildcard-tls                            # existing cert Secret name
deploy/k8s/apply.sh                                # env vars above
```

`apply.sh` additionally accepts:

| Variable            | Default          | Meaning                                            |
|---------------------|------------------|----------------------------------------------------|
| `REPLICAS`          | `2`              | Taskboard Deployment replicas                      |
| `INGRESS_NAMESPACE` | `ingress-nginx`  | namespace whose ingress pods may reach port 47823  |
| `SNAPSHOT_CLASS`    | *(unset)*        | enable backup CronJob; unset skips backups         |
| `DB_PASSWORD`       | generated        | DB owner password for the created Secret           |

It creates namespace/configmap/service, verifies the CNPG CRD, seeds the
`taskboard-db-owner` Secret (never overwrites), applies the CNPG `Cluster`, waits for
it to become Ready, applies both NetworkPolicies and the Deployment/RollingUpdate
wave, waits for rollout, and finally installs the backup CronJob when
`SNAPSHOT_CLASS` was provided.

## 3. Device registration and revocation

Device credentials are administered directly against the authoritative store, which
works identically against a local development database and inside the cluster:

```bash
# issue (token printed ONCE; only its SHA-256 hash persists)
kubectl -n taskboard exec deploy/taskboard -- \
  node scripts/device-admin.mjs issue mac-a "Mac A"
# {"device":{"id":"mac-a","name":"Mac A"},"token":"<TOKEN>"}

kubectl -n taskboard exec deploy/taskboard -- node scripts/device-admin.mjs list

# revoke — effective immediately on every replica
kubectl -n taskboard exec deploy/taskboard -- \
  node scripts/device-admin.mjs revoke mac-a
```

Every authenticated request then carries `Authorization: Basic base64(<deviceId>:<token>)`:

* **Browsers** use the native Basic prompt (server answers `401` +
  `WWW-Authenticate: Basic` on first visit): username = device id, password = token.
* **The desktop App companion** stores the pair as one composite string in
  `.data/cloud-companion.json` (mode 0600); `cloud-proxy` splits it when building the
  Authorization header. Log a device in with:

  ```bash
  npm run taskctl -- cloud login --url https://taskboard.example.com --actor-name "Mac A"
  # prompt now expects <deviceId>:<token> pasted as one line
  ```

  Boards still running the legacy shared-secret model keep working: without a `:` in
  the secret the proxy sends the configured actor name and the secret unchanged.
* **taskctl / curl** against the remote board always flow through the same companion.

Revocation returns `401 UNAUTHORIZED` instantly for that device while other devices
are unaffected (three-state evidence recipe lives in `verify.sh` + §6 below).

## 4. Cutover from a phase-1 SQLite board

Prerequisites: the phase-1 Deployment (`SQLite + taskboard-data PVC`) is deployed and
the B版 image is pushed.

1. Deploy everything except traffic switch: `deploy/k8s/apply.sh` (§2). The Job
   template below mounts the **old** `taskboard-data` PVC read-only.
2. Freeze writes on the phase-1 board (announce the cut-over window).
3. Run the one-shot importer — it copies the source (plus `-wal/-shm` and the
   `attachments/` directory) into a scratch dir, runs every historical schema
   migration against the copy, imports rows with `ON CONFLICT DO NOTHING`, moves
   attachment files into `attachment_blobs`, reconciles the change-revision counter
   and prints a source/target comparison table. Any row-count mismatch exits non-zero
   — do not proceed unless every line reads `yes`:

   ```bash
   kubectl -n taskboard create job --from=job/taskboard-migrate taskboard-migrate-1
   kubectl -n taskboard wait --for=condition=complete job/taskboard-migrate-1 --timeout=3600s
   kubectl -n taskboard logs job/taskboard-migrate-1
   ```

   Re-running the Job is safe: second pass reports identical counts and imports zero
   additional rows (forward-replayable + idempotent).
4. Point traffic at the new board: the new Deployment already owns the
   `taskboard` Service selector, so simply delete/repurpose the phase-1 Deployment:

   ```bash
   kubectl -n taskboard scale deploy/taskboard-old --replicas=0   # if you kept it alongside
   ```

5. Register real devices (§3) and hand out `<deviceId>:<token>` composites.
6. After a verified soak period the legacy PVC can be retained as cold backup or
   deleted (`kubectl -n taskboard delete pvc taskboard-data`).

## 5. Verify the deployment

```bash
BOARD_HOST=taskboard.example.com NAMESPACE=taskboard \
DEVICE_ID=<id> DEVICE_TOKEN=<token> VERIFY_ISSUE_ID=<active task id> \
  deploy/k8s/verify.sh
```

It checks: replica list; anonymous request rejected with `401`; device credentials
accepted (`200`); public `/health` (`200`); cross-replica realtime — a WebSocket held
on one replica receives `{type:"revision"}` within seconds of an issue move hitting
the *other* replica (both directions); resilience — killing one pod mid-flight and
completing an issue move on the survivor, followed by a return to two Ready replicas.

## 6. Live-board browser check

Open `https://taskboard.example.com` twice (two devices, e.g. two Macs), authenticating
each with its own device id/token through the native Basic prompt. Create an issue in
window A; the card appears in window B without refresh; during
`kubectl -n taskboard rollout restart deployment/taskboard` pages automatically
reconnect their SSE/WebSocket channels and resume live updates once the replica is
back (RollingUpdate keeps ≥1 replica serving at all times).

## 7. Backups — choice recorded

**Chosen: VolumeSnapshot CronJob** (`backup-cronjob.yaml`, daily 03:17,
concurrency-safe, RBAC-scoped to snapshot objects).

Reasoning: the scope offered either CSI snapshots of the data volume or a Litestream
sidecar. Litestream replicates *SQLite* WAL files — it targets exactly the single-node
storage this release replaces, so a sidecar would be dead weight inside a PostgreSQL
deployment. CloudNativePG's primary volume is continuously WAL-written; a CSI snapshot
taken while PostgreSQL runs stays crash-consistent and recovers via standard WAL
replay. Requires a `VolumeSnapshotClass`; retention/pruning of old snapshots follows
your cluster's policy tooling (e.g. Kyverno TTL rules).

## 8. A档 hardening inventory

| Control | Manifest location |
|---|---|
| `runAsNonRoot: true`, fixed uid/gid 1000, fsGroup | deployment.yaml pod securityContext |
| `readOnlyRootFilesystem: true` | deployment.yaml container securityContext |
| `seccompProfile: RuntimeDefault` | pod securityContext |
| `allowPrivilegeEscalation: false` | container securityContext |
| `capabilities: drop ALL` | container securityContext |
| Resource requests + memory limits | deployment.yaml / migration-job.yaml / backup-cronjob.yaml |
| Ingress lockdown: unlabeled same-ns pods cannot reach 47823 | networkpolicy.yaml |
| Database reachable only by `app=taskboard` pods | networkpolicy.yaml (second rule) |
| Non-root + read-only rootfs also for migration Job & backup jobs | respective manifests |

Writable space for the few file paths the server touches (client-storage KV, jira
config) comes from the `/data` emptyDir — contents are pod-local and disappear with
the pod, which is safe because the authoritative state is PostgreSQL.

## 9. Known limitations

* Per-pod paths on `/data` are ephemeral (documented consequence of stateless pods).
* `LOCAL_COMPANION_ROUTES` behaviour is unchanged from phase 1: those routes never
  proxy and stay device-local.
* Revoked credentials receive `401` with no grace period; clients must re-login with
  newly issued credentials.

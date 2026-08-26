# K8s shared board deployment (phase 1)

Run the Taskboard server as a shared board on an existing Kubernetes cluster.
Each Mac keeps its device-local companion and connects remotely with the same
shared-password Basic Auth model described in
[cloud-collaboration.md](./cloud-collaboration.md).

Architecture in this phase:

- one single-replica Deployment (SQLite + ReadWriteOnce PVC, no horizontal scaling);
- `CODEX_TASKBOARD_SHARED_SECRET` gates every route except `/health` (HTTP and
  WebSocket upgrades) and is injected from a K8s Secret, never committed;
- `CODEX_TASKBOARD_TRUSTED_HOSTS` explicitly allowlists the board hostname for
  the local-network host check — without it the public domain is rejected with
  `INVALID_HOST`;
- realtime: direct browsers use the existing SSE stream; companions bridge
  their embedded browsers over WebSocket (`/api/events`) and the server
  broadcasts `{"type":"revision",...}` frames.

Out of scope for phase 1: host scheduling, automatic issue flow, branch
assignment.

## 1. Build the image

On any machine with Docker and this repository checked out (the phase-1
commit on `feature/k8s-multi-host-phase1` or its merge):

```bash
IMAGE=registry.example.com/org/dashi-taskboard:v1   # adjust
docker build -f deploy/Dockerfile -t "$IMAGE" .
docker push "$IMAGE"
```

Optional local smoke before pushing (verifies the exact container layout):

```bash
docker run --rm -p 47823:47823 \
  -e CODEX_TASKBOARD_SHARED_SECRET=local-smoke-key \
  "$IMAGE" &
sleep 3
curl -s http://127.0.0.1:47823/health                      # {"status":"ok"}
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:47823/api/projects   # 401
curl -s -o /dev/null -w "%{http_code}\n" -u any:local-smoke-key \
  http://127.0.0.1:47823/api/projects                      # 200
kill %1
```

## 2. Deploy to the cluster

Prerequisites: `kubectl` write access to the target namespace, an ingress
controller, and (for HTTPS) an existing TLS Secret such as a wildcard
certificate.

Create the shared-key Secret first — the value must never enter Git. Paste the
key at the hidden prompt:

```bash
NAMESPACE=taskboard                                # adjust
read -rs TASKBOARD_SHARED_KEY && export TASKBOARD_SHARED_KEY; echo
kubectl -n "$NAMESPACE" create secret generic taskboard-shared-key \
  --from-literal="sharedKey=$TASKBOARD_SHARED_KEY"
unset TASKBOARD_SHARED_KEY
```

Apply the rendered manifests (create the namespace if it does not exist yet):

```bash
IMAGE=registry.example.com/org/dashi-taskboard:v1
BOARD_HOST=taskboard.example.com                   # public HTTPS hostname
INGRESS_CLASS=nginx                                # adjust to your controller
TLS_SECRET=wildcard-tls                            # existing cert Secret name
deploy/k8s/apply.sh                                # env vars as above
```

`apply.sh` also accepts `NAMESPACE`, `STORAGE_SIZE` (default `5Gi`), and
`TRUSTED_HOSTS` (default `$BOARD_HOST`; comma-separate extra hostnames).

Verify (Done #1/#2 evidence):

```bash
kubectl -n "$NAMESPACE" get pods                          # taskboard ... 1/1 Running
curl -s -o /dev/null -w "%{http_code}\n" https://"$BOARD_HOST"/api/projects   # 401
curl -s -o /dev/null -w "%{http_code}\n" -u "host-a:$KEY" \
  https://"$BOARD_HOST"/api/projects                      # 200
```

Controller notes: the nginx ingress proxies WebSocket upgrades natively. For
other controllers add the required Upgrade annotations to
`deploy/k8s/ingress.yaml` before applying.

## 3. Connect a Mac

On each Mac (both Mac A and Mac B), from this repository checkout:

```bash
npm ci
CODEX_TASKBOARD_HOST=127.0.0.1 npm start        # device-local companion
```

In a second terminal, log the device in with its own actor name and the shared
key at the hidden `Shared key:` prompt:

```bash
npm run taskctl -- cloud login \
  --url https://taskboard.example.com \
  --actor-name "mac-a"                          # use "mac-b" on the other Mac
npm run taskctl -- cloud status                 # mode: cloud
npm run taskctl -- project list                 # proxied through the companion
```

Credentials persist in `.data/cloud-companion.json` (mode 0600) on that Mac
only; `cloud logout` returns it to standalone local mode.

Phase-1 verification recipes:

- **Live board (Done #4)** — open `https://taskboard.example.com` in a browser
  on Mac A (username: any display name, password: the shared key). On Mac B
  run `npm run taskctl -- issue create --project local --title "live check"`.
  The new card appears on Mac A without a refresh.
- **Distinct host identities (Done #5)** — each Mac claims a different issue:

  ```bash
  CODEX_THREAD_ID=thread-a npm run taskctl -- issue move LOCAL-1 \
    --status in_progress --if-version 1 \
    --binding-thread-id thread-a --binding-codex-project-id demo \
    --binding-codex-project-kind remote --binding-codex-host-id mac-a \
    --binding-workspace-path /Users/a/work/demo
  ```

  then `issue get <ID> --json` on both issues shows different
  `threadBinding.codexHostId` values (`mac-a` / `mac-b`).
- **No takeover (Done #6)** — on Mac B, move the issue Mac A claimed (no
  `--if-version`, no binding flags): taskctl exits with code 5 and prints
  `{"error":{"code":"BINDING_CONFLICT",...,"details":{"codexHostId":"mac-a"}}}`;
  `issue get` still shows Mac A's binding.

## 4. Rotate the shared key

Generate a new key and replace the Secret without a delete/recreate gap:

```bash
read -rs NEW_KEY && export NEW_KEY; echo
kubectl -n "$NAMESPACE" create secret generic taskboard-shared-key \
  --from-literal="sharedKey=$NEW_KEY" \
  --dry-run=client -o yaml | kubectl apply -f -
unset NEW_KEY
kubectl -n "$NAMESPACE" rollout restart deployment/taskboard
kubectl -n "$NAMESPACE" rollout status deployment/taskboard
```

After rotation both Macs rerun `taskctl cloud login` with the new key.
Browsers cache Basic credentials, so close the authenticated session (or clear
site data) and re-authenticate. Rotation affects both Macs at once; there is
no per-host revocation in the shared-password model.

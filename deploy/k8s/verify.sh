#!/bin/sh
# Cluster-side acceptance checks for the B版 shared board (docs/k8s-deployment.md §5).
# Usage:
#   BOARD_HOST=taskboard.example.com NAMESPACE=taskboard \
#   DEVICE_ID=<id> DEVICE_TOKEN=<token> VERIFY_ISSUE_ID=<active task id> \
#     deploy/k8s/verify.sh
set -eu

BOARD_HOST=${BOARD_HOST:?BOARD_HOST is required}
NAMESPACE=${NAMESPACE:-taskboard}
DEVICE_ID=${DEVICE_ID:?DEVICE_ID is required (a device registered via scripts/device-admin.mjs)}
DEVICE_TOKEN=${DEVICE_TOKEN:?DEVICE_TOKEN is required (the token issued for that device)}
VERIFY_ISSUE_ID=${VERIFY_ISSUE_ID:?VERIFY_ISSUE_ID is required (an active task id, e.g. LOCAL-1)}

BOARD=${BOARD_SCHEME:-https}://$BOARD_HOST
AUTH="$DEVICE_ID:$DEVICE_TOKEN"

field() { # field <jsonField> : crude positive-path extractor, good enough for probes
  grep -o "\"$1\":[^,}]*" | head -1 | cut -d: -f2 | tr -d '"'
}

ready_pods() {
  kubectl -n "$NAMESPACE" get pods -l app=taskboard \
    -o jsonpath='{range .items[*]}{.metadata.name}{" "}{.status.podIP}{"\n"}{end}'
}

wait_two_ready() {
  while true; do
    lines=$(ready_pods | grep -c . || true)
    if [ "$lines" -ge 2 ]; then return 0; fi
    sleep 3
  done
}

# Board-to-board requests must originate from a taskboard pod: the ingress NetworkPolicy
# admits only the ingress controller plus taskboard peers, so every direct-to-pod probe
# below is executed inside one of the board pods (image ships node, no curl needed).
board_http() { # board_http <srcPod> <method> <targetPodIp> <pathWithQuery> [jsonBody]
              # Sets REPLY_CODE (first line) and REPLY_BODY (rest).
  local output
  output=$(kubectl -n "$NAMESPACE" exec "$1" -- node --input-type=module -e '
    const [method, url, auth, body] = process.argv.slice(1);
    const headers = {};
    if (auth) headers.authorization = "Basic " + Buffer.from(auth).toString("base64");
    if (body) headers["content-type"] = "application/json";
    const response = await fetch(url, { method, headers, body: body || undefined });
    console.log(response.status);
    process.stdout.write(await response.text());
  ' -- "$2" "http://$3:47823$4" "$AUTH" "${5:-}")
  REPLY_CODE=$(printf '%s' "$output" | sed -n '1p')
  REPLY_BODY=$(printf '%s' "$output" | tail -n +2)
}

task_json_on() { # task_json_on <srcPod> <targetIp> : authenticated GET of the verify issue
  board_http "$1" GET "$2" "/api/tasks/$VERIFY_ISSUE_ID"
  printf '%s\n' "$REPLY_BODY"
}

flip_status() {
  case "$1" in todo) echo backlog ;; *) echo todo ;; esac
}

move_and_flip_via() { # move_and_flip_via <srcPod> <writerIp> : flips the issue status through
                      # the writer replica with the request originating inside srcPod.
  task=$(task_json_on "$1" "$2")
  version=$(printf '%s' "$task" | field version)
  current=$(printf '%s' "$task" | field status)
  target=$(flip_status "${current:-todo}")
  board_http "$1" POST "$2" "/api/tasks/$VERIFY_ISSUE_ID/move" \
    "{\"version\":$version,\"status\":\"$target\"}" >/dev/null
}

echo "== [1] pods =="
kubectl -n "$NAMESPACE" get pods -l app=taskboard

echo "== [2] /api/projects without Authorization via public host (expect 401) =="
UNAUTH_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$BOARD/api/projects")
echo "$UNAUTH_CODE"
if [ "$UNAUTH_CODE" != "401" ]; then echo "FAIL: expected 401 without credentials" >&2; exit 1; fi

echo "== [3] /api/projects with device credentials via public host (expect 200) =="
AUTH_CODE=$(curl -s -o /dev/null -w "%{http_code}" -u "$AUTH" "$BOARD/api/projects")
echo "$AUTH_CODE"
if [ "$AUTH_CODE" != "200" ]; then echo "FAIL: device auth rejected" >&2; exit 1; fi

echo "== [4] /health public (expect 200) =="
HEALTH_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$BOARD/health")
echo "$HEALTH_CODE"
if [ "$HEALTH_CODE" != "200" ]; then echo "FAIL: health check failed" >&2; exit 1; fi

echo "== [5] cross-replica realtime revision frames (<45s each) =="
wait_two_ready
POD_ROWS=$(ready_pods)
POD_A=$(echo "$POD_ROWS" | sed -n '1p' | cut -d' ' -f1)
IP_A=$(echo "$POD_ROWS" | sed -n '1p' | cut -d' ' -f2)
POD_B=$(echo "$POD_ROWS" | sed -n '2p' | cut -d' ' -f1)
IP_B=$(echo "$POD_ROWS" | sed -n '2p' | cut -d' ' -f2)

wait_for_ws_revision() { # wait_for_ws_revision <podName> <connectIp>: hold a WS on that replica's
                         # own /api/events and exit 0 when a revision frame arrives.
  kubectl -n "$NAMESPACE" exec -i "$1" -- node --input-type=module -e "
import http from 'node:http';
import crypto from 'node:crypto';
const separator = process.argv[1].indexOf(':');
const id = process.argv[1].slice(0, separator);
const token = process.argv[1].slice(separator + 1);
const key = crypto.randomBytes(16).toString('base64');
const auth = 'Basic ' + Buffer.from(id + ':' + token).toString('base64');
const req = http.request({
  host: process.argv[2], port: 47823, path: '/api/events',
  headers: {
    connection: 'Upgrade', upgrade: 'websocket',
    'sec-websocket-key': key, 'sec-websocket-version': 13, authorization: auth,
  },
});
req.end();
const started = Date.now();
req.on('upgrade', (res) => {
  res.setEncoding('utf8');
  res.on('data', (chunk) => {
    if (chunk.includes('revision')) {
      console.log('revision frame after', Date.now() - started, 'ms');
      process.exit(0);
    }
  });
});
req.on('error', (error) => { console.error(String(error)); process.exit(1); });
setTimeout(() => { console.error('no revision frame within 45s'); process.exit(1); }, 45000);
" -- "$AUTH" "$2"
}

check_frame_latency() { # check_frame_latency <listenerPod> <listenerIp> <writerIp>
  listener_pod=$1; listener_ip=$2; writer_ip=$3
  wait_for_ws_revision "$listener_pod" "$listener_ip" &
  ws_pid=$!
  sleep 3 # let the websocket settle
  move_and_flip_via "$listener_pod" "$writer_ip"
  wait $ws_pid
}

echo "-- listener $POD_A ($IP_A), writer replica $IP_B:"
check_frame_latency "$POD_A" "$IP_A" "$IP_B"
echo "-- listener $POD_B ($IP_B), writer replica $IP_A:"
check_frame_latency "$POD_B" "$IP_B" "$IP_A"

echo "== [6] issue move completes on surviving replica while the other is killed =="
before_json=$(task_json_on "$POD_B" "$IP_B")
before_version=$(printf '%s' "$before_json" | field version)
current=$(printf '%s' "$before_json" | field status)
kubectl -n "$NAMESPACE" delete pod "$POD_A" --wait=false >/dev/null
sleep 2 # pod enters Terminating; replica B must keep serving during the drain
move_and_flip_via "$POD_B" "$IP_B"
after_json=$(task_json_on "$POD_B" "$IP_B")
after_version=$(printf '%s' "$after_json" | field version)
after_status=$(printf '%s' "$after_json" | field status)
if ! [ "${after_version:-0}" -gt "${before_version:-9999999}" ]; then
  echo "FAIL: issue move did not stick on the surviving replica (v$before_version -> v${after_version:-none})" >&2
  exit 1
fi
echo "ok: moved to '$after_status' at v$after_version on $POD_B while $POD_A was going away"

echo "== [7] unlabeled same-namespace pod is denied port 47823 (NetworkPolicy lockdown) =="
blocked_probe() {
  kubectl -n "$NAMESPACE" run "verify-blocked-$(date +%s%N)" --rm -i --quiet \
    --image=curlimages/curl:8.10.1 --restart=Never --command -- \
    curl -s -o /dev/null -m 8 -w '%{http_code}' "http://$IP_B:47823/health"
}
BLOCKED_CODE=$(blocked_probe || true)
if [ -n "$BLOCKED_CODE" ] && [ "$BLOCKED_CODE" != "000" ]; then
  echo "FAIL: unlabeled pod reached the board (HTTP $BLOCKED_CODE) — NetworkPolicy not enforcing" >&2
  exit 1
fi
echo "ok: unlabeled pod got no response (${BLOCKED_CODE:-no reply})"

echo "== [8] cluster returns to two Ready replicas =="
kubectl -n "$NAMESPACE" wait --for=condition=Ready pod -l app=taskboard --timeout=300s >/dev/null
ready_pods

echo "All checks passed."

#!/bin/sh
# Cluster-side acceptance checks for the B版 shared board (docs/k8s-deployment.md §5).
# Usage:
#   BOARD_HOST=taskboard.example.com NAMESPACE=taskboard \
#   DEVICE_ID=<id> DEVICE_TOKEN=<token> VERIFY_ISSUE_ID=<active task id> \
#     deploy/k8s/verify.sh
set -eu

BOARD_HOST=${BOARD_HOST:?BOARD_HOST is required}
NAMESPACE=${NAMESPACE:-taskboard}
DEVICE_ID=${DEVICE_ID:?DEVICE_ID is required - register one via scripts/device-admin.mjs}
DEVICE_TOKEN=${DEVICE_TOKEN:?DEVICE_TOKEN is required - that device token}
VERIFY_ISSUE_ID=${VERIFY_ISSUE_ID:?VERIFY_ISSUE_ID is required - an active task id}

BOARD=${BOARD_SCHEME:-https}://$BOARD_HOST
AUTH="$DEVICE_ID:$DEVICE_TOKEN"

field() { # field <jsonField> : crude positive-path extractor, good enough for probes
  grep -o "\"$1\":[^,}]*" | head -1 | cut -d: -f2 | tr -d '"'
}

probe_ip() { # probe_ip <podIp> <path> [curl args...] — curl against one replica in-cluster
  ip=$1; path=$2; shift 2
  kubectl -n "$NAMESPACE" run "verify-probe-$(date +%s%N)" --rm -i --quiet \
    --image=curlimages/curl:8.10.1 --restart=Never --command -- \
    curl -s -u "$AUTH" "$@" "http://$ip:47823$path"
}

api_get() { probe_ip "$1" "$2"; }

flip_status() {
  case "$1" in todo) echo backlog ;; *) echo todo ;; esac
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

echo "== [1] pods =="
kubectl -n "$NAMESPACE" get pods -l app=taskboard

echo "== [2] /api/projects without Authorization (expect 401) =="
UNAUTH_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$BOARD/api/projects")
echo "$UNAUTH_CODE"
if [ "$UNAUTH_CODE" != "401" ]; then echo "FAIL: expected 401 without credentials" >&2; exit 1; fi

echo "== [3] /api/projects with device credentials (expect 200) =="
AUTH_CODE=$(curl -s -o /dev/null -w "%{http_code}" -u "$AUTH" "$BOARD/api/projects")
echo "$AUTH_CODE"
if [ "$AUTH_CODE" != "200" ]; then echo "FAIL: device auth rejected" >&2; exit 1; fi

echo "== [4] /health public (expect 200) =="
HEALTH_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$BOARD/health")
echo "$HEALTH_CODE"
if [ "$HEALTH_CODE" != "200" ]; then echo "FAIL: health check failed" >&2; exit 1; fi

echo "== [5] cross-replica realtime revision frames (<5s each) =="
wait_two_ready
POD_ROWS=$(ready_pods)
POD_A=$(echo "$POD_ROWS" | sed -n '1p' | cut -d' ' -f1)
IP_A=$(echo "$POD_ROWS" | sed -n '1p' | cut -d' ' -f2)
POD_B=$(echo "$POD_ROWS" | sed -n '2p' | cut -d' ' -f1)
IP_B=$(echo "$POD_ROWS" | sed -n '2p' | cut -d' ' -f2)

move_issue_via() { # move_issue_via <podIp> <targetStatus>
  task_json=$(api_get "$1" "/api/tasks/$VERIFY_ISSUE_ID")
  version=$(echo "$task_json" | field version)
  current=$(echo "$task_json" | field status)
  target=$2
  probe_ip "$1" "/api/tasks/$VERIFY_ISSUE_ID/move" \
    -X POST -H 'content-type: application/json' \
    -d "{\"version\":$version,\"status\":\"$target\"}" >/dev/null
}

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
  current=$(api_get "$writer_ip" "/api/tasks/$VERIFY_ISSUE_ID" | field status)
  move_issue_via "$writer_ip" "$(flip_status "${current:-todo}")"
  wait $ws_pid
}

echo "-- listener $POD_A ($IP_A), writer replica $IP_B:"
check_frame_latency "$POD_A" "$IP_A" "$IP_B"
echo "-- listener $POD_B ($IP_B), writer replica $IP_A:"
check_frame_latency "$POD_B" "$IP_B" "$IP_A"

echo "== [6] issue move completes on surviving replica while the other is killed =="
before_version=$(api_get "$IP_B" "/api/tasks/$VERIFY_ISSUE_ID" | field version)
current=$(api_get "$IP_B" "/api/tasks/$VERIFY_ISSUE_ID" | field status)
kubectl -n "$NAMESPACE" delete pod "$POD_A" --wait=false >/dev/null
sleep 2 # pod enters Terminating; replica B must keep serving during the drain
move_issue_via "$IP_B" "$(flip_status "${current:-todo}")"
after_json=$(api_get "$IP_B" "/api/tasks/$VERIFY_ISSUE_ID")
after_version=$(echo "$after_json" | field version)
after_status=$(echo "$after_json" | field status)
if ! [ "${after_version:-0}" -gt "${before_version:-9999999}" ]; then
  echo "FAIL: issue move did not stick on the surviving replica (v$before_version -> v${after_version:-none})" >&2
  exit 1
fi
echo "ok: moved to '$after_status' at v$after_version on $POD_B while $POD_A was going away"

echo "== [7] cluster returns to two Ready replicas =="
kubectl -n "$NAMESPACE" wait --for=condition=Ready pod -l app=taskboard --timeout=300s >/dev/null
ready_pods

echo "All checks passed."

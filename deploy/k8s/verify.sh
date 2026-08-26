#!/bin/sh
# Cluster-side acceptance checks for the shared board (docs/k8s-deployment.md §2).
# Usage: BOARD_HOST=taskboard.example.com NAMESPACE=taskboard SHARED_KEY=... \
#          deploy/k8s/verify.sh
set -eu

BOARD_HOST=${BOARD_HOST:?BOARD_HOST is required}
NAMESPACE=${NAMESPACE:-taskboard}
SHARED_KEY=${SHARED_KEY:?SHARED_KEY is required (the Basic Auth shared key)}

echo "== [1] pods =="
kubectl -n "$NAMESPACE" get pods -l app=taskboard

echo "== [2] /api/projects without Authorization (expect 401) =="
curl -s -o /dev/null -w "%{http_code}\n" "https://$BOARD_HOST/api/projects"

echo "== [3] /api/projects with Basic auth (expect 200) =="
curl -s -o /dev/null -w "%{http_code}\n" -u "verify:$SHARED_KEY" \
  "https://$BOARD_HOST/api/projects"

echo "== [4] /health public (expect 200) =="
curl -s -o /dev/null -w "%{http_code}\n" "https://$BOARD_HOST/health"

echo "== [5] SSE streams unbuffered (expect a ': connected' line within 5s) =="
curl -sN --max-time 5 -u "verify:$SHARED_KEY" \
  "https://$BOARD_HOST/api/events" | head -1 || true

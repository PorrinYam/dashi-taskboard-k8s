#!/bin/sh
# Render deploy/k8s templates and apply them to the target cluster.
# Required environment:
#   IMAGE       container image reference, e.g. registry.example.com/org/dashi-taskboard:v1
#   BOARD_HOST  public board origin hostname, e.g. taskboard.example.com
# Optional environment:
#   NAMESPACE         target namespace (default: taskboard; created if missing)
#   INGRESS_CLASS     ingressClassName (default: nginx)
#   TLS_SECRET        existing TLS Secret name; leave empty to serve plain HTTP
#   SHARED_KEY_SECRET Secret holding the Basic Auth key (default: taskboard-shared-key;
#                     create it first — see docs/k8s-deployment.md)
#   STORAGE_SIZE      PVC size (default: 5Gi)
#   TRUSTED_HOSTS     comma-separated exact hostnames passed to the server
#                     allowlist (default: $BOARD_HOST)
set -eu

IMAGE=${IMAGE:?IMAGE is required (e.g. registry.example.com/org/dashi-taskboard:v1)}
BOARD_HOST=${BOARD_HOST:?BOARD_HOST is required (e.g. taskboard.example.com)}
NAMESPACE=${NAMESPACE:-taskboard}
INGRESS_CLASS=${INGRESS_CLASS:-nginx}
TLS_SECRET=${TLS_SECRET:-}
SHARED_KEY_SECRET=${SHARED_KEY_SECRET:-taskboard-shared-key}
STORAGE_SIZE=${STORAGE_SIZE:-5Gi}
TRUSTED_HOSTS=${TRUSTED_HOSTS:-$BOARD_HOST}

here=$(cd "$(dirname "$0")" && pwd)
render() {
  sed -e "s|__IMAGE__|$IMAGE|g" \
    -e "s|__NAMESPACE__|$NAMESPACE|g" \
    -e "s|__BOARD_HOST__|$BOARD_HOST|g" \
    -e "s|__INGRESS_CLASS__|$INGRESS_CLASS|g" \
    -e "s|__TLS_SECRET__|$TLS_SECRET|g" \
    -e "s|__SECRET_NAME__|$SHARED_KEY_SECRET|g" \
    -e "s|__STORAGE_SIZE__|$STORAGE_SIZE|g" \
    -e "s|__TRUSTED_HOSTS__|$TRUSTED_HOSTS|g" \
    "$here/$1"
}

kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -
render pvc.yaml | kubectl -n "$NAMESPACE" apply -f -
render configmap.yaml | kubectl -n "$NAMESPACE" apply -f -
render service.yaml | kubectl -n "$NAMESPACE" apply -f -
render deployment.yaml | kubectl -n "$NAMESPACE" apply -f -
if [ -n "$TLS_SECRET" ]; then
  render ingress.yaml | kubectl -n "$NAMESPACE" apply -f -
else
  render ingress.yaml | sed '/# tls-begin/,/# tls-end/d' | kubectl -n "$NAMESPACE" apply -f -
fi
kubectl -n "$NAMESPACE" rollout status deployment/taskboard

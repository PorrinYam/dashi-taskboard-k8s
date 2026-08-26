#!/bin/sh
# Render deploy/k8s templates and apply them to the target cluster (B版: PostgreSQL 多副本).
# Required environment:
#   IMAGE       container image reference, e.g. registry.example.com/org/dashi-taskboard:v1
#   BOARD_HOST  public board origin hostname, e.g. taskboard.example.com
# Optional environment:
#   NAMESPACE         target namespace (default: taskboard; created if missing)
#   INGRESS_CLASS     ingressClassName (default: nginx)
#   TLS_SECRET        existing TLS Secret name; leave empty to serve plain HTTP
#   REPLICAS          taskboard Deployment replicas (default: 2)
#   INGRESS_NAMESPACE namespace running the ingress controller for the NetworkPolicy
#                     allowlist (default: ingress-nginx)
#   SNAPSHOT_CLASS    VolumeSnapshotClass name enabling the backup CronJob
#                     (leave empty to skip installing backups)
#   DB_PASSWORD       password for the taskboard DB owner; generated when creating the
#                     Secret and not provided (existing Secrets are never overwritten)
#   TRUSTED_HOSTS     comma-separated exact hostnames passed to the server allowlist
#                     (default: $BOARD_HOST)
set -eu

IMAGE=${IMAGE:?IMAGE is required (e.g. registry.example.com/org/dashi-taskboard:v1)}
BOARD_HOST=${BOARD_HOST:?BOARD_HOST is required (e.g. taskboard.example.com)}
NAMESPACE=${NAMESPACE:-taskboard}
INGRESS_CLASS=${INGRESS_CLASS:-nginx}
TLS_SECRET=${TLS_SECRET:-}
REPLICAS=${REPLICAS:-2}
INGRESS_NAMESPACE=${INGRESS_NAMESPACE:-ingress-nginx}
SNAPSHOT_CLASS=${SNAPSHOT_CLASS:-}
TRUSTED_HOSTS=${TRUSTED_HOSTS:-$BOARD_HOST}
DB_OWNER_SECRET=taskboard-db-owner

here=$(cd "$(dirname "$0")" && pwd)
render() {
  sed -e "s|__IMAGE__|$IMAGE|g" \
    -e "s|__NAMESPACE__|$NAMESPACE|g" \
    -e "s|__BOARD_HOST__|$BOARD_HOST|g" \
    -e "s|__INGRESS_CLASS__|$INGRESS_CLASS|g" \
    -e "s|__TLS_SECRET__|$TLS_SECRET|g" \
    -e "s|__REPLICAS__|$REPLICAS|g" \
    -e "s|__INGRESS_NAMESPACE__|$INGRESS_NAMESPACE|g" \
    -e "s|__SNAPSHOT_CLASS__|$SNAPSHOT_CLASS|g" \
    -e "s|__TRUSTED_HOSTS__|$TRUSTED_HOSTS|g" \
    "$here/$1"
}

kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -

echo "== CloudNativePG operator =="
if ! kubectl get crd clusters.postgresql.cnpg.io >/dev/null 2>&1; then
  echo "ERROR: the CloudNativePG operator is not installed in this cluster." >&2
  echo "Install it first: https://cloudnative-pg.io/documentation/current/installation_upgrade/" >&2
  exit 1
fi

echo "== Database owner Secret =="
if ! kubectl -n "$NAMESPACE" get secret "$DB_OWNER_SECRET" >/dev/null 2>&1; then
  password=${DB_PASSWORD:-$(openssl rand -hex 16)}
  kubectl -n "$NAMESPACE" create secret generic "$DB_OWNER_SECRET" \
    --from-literal="password=$password"
else
  echo "Secret $DB_OWNER_SECRET already exists — leaving it untouched"
fi

render configmap.yaml | kubectl -n "$NAMESPACE" apply -f -
render service.yaml | kubectl -n "$NAMESPACE" apply -f -

echo "== PostgreSQL cluster (CloudNativePG) =="
render cnpg-cluster.yaml | kubectl -n "$NAMESPACE" apply -f -
kubectl -n "$NAMESPACE" wait --for=condition=Ready cluster/taskboard-db --timeout=600s

render networkpolicy.yaml | kubectl -n "$NAMESPACE" apply -f -

render deployment.yaml | kubectl -n "$NAMESPACE" apply -f -
if [ -n "$TLS_SECRET" ]; then
  render ingress.yaml | kubectl -n "$NAMESPACE" apply -f -
else
  render ingress.yaml | sed '/# tls-begin/,/# tls-end/d' | kubectl -n "$NAMESPACE" apply -f -
fi
kubectl -n "$NAMESPACE" rollout status deployment/taskboard

if [ -n "$SNAPSHOT_CLASS" ]; then
  render backup-cronjob.yaml | kubectl -n "$NAMESPACE" apply -f -
else
  echo "SNAPSHOT_CLASS not set — skipping backup CronJob installation"
fi

echo
echo "Next steps:"
echo "* Fresh install: done. Register the first device with scripts/device-admin.mjs."
echo "* Cutover from phase-1 SQLite: run the one-shot import Job, e.g."
echo "    kubectl -n $NAMESPACE create job --from=job/taskboard-migrate taskboard-migrate-1"

#!/usr/bin/env bash
set -euo pipefail

CLUSTER_NAME="${CLUSTER_NAME:-inner-platform-local}"
NAMESPACE="${NAMESPACE:-inner-platform-local}"
IMAGE="${IMAGE:-inner-platform-bff:local}"
LOCAL_PORT="${LOCAL_PORT:-18787}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KIND_CONFIG="${ROOT_DIR}/infra/k8s/local/kind-config.yaml"
KUSTOMIZE_DIR="${ROOT_DIR}/infra/k8s/overlays/local"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

require_cmd docker
require_cmd kind
require_cmd kubectl
require_cmd curl

cd "$ROOT_DIR"

if ! docker info >/dev/null 2>&1; then
  echo "Docker is not running. Start Docker Desktop, then retry." >&2
  exit 1
fi

if ! kind get clusters | grep -Fxq "$CLUSTER_NAME"; then
  kind create cluster --name "$CLUSTER_NAME" --config "$KIND_CONFIG"
fi

for attempt in 1 2 3; do
  if docker build --pull=false -f server/bff/Dockerfile -t "$IMAGE" .; then
    break
  fi
  if [ "$attempt" = "3" ]; then
    echo "Docker image build failed after ${attempt} attempts." >&2
    exit 1
  fi
  echo "Docker image build failed; retrying (${attempt}/3)..." >&2
  sleep 10
done
kind load docker-image "$IMAGE" --name "$CLUSTER_NAME"

kubectl config use-context "kind-${CLUSTER_NAME}" >/dev/null
kubectl apply -k "$KUSTOMIZE_DIR"
kubectl -n "$NAMESPACE" rollout restart deployment/mysc-bff
kubectl -n "$NAMESPACE" rollout status deployment/mysc-bff --timeout=180s

PF_LOG="$(mktemp -t inner-platform-bff-port-forward.XXXXXX.log)"
kubectl -n "$NAMESPACE" port-forward svc/mysc-bff "${LOCAL_PORT}:8080" >"$PF_LOG" 2>&1 &
PF_PID="$!"
cleanup() {
  kill "$PF_PID" >/dev/null 2>&1 || true
}
trap cleanup EXIT

for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${LOCAL_PORT}/api/v1/health" >/tmp/inner-platform-bff-health.json; then
    cat /tmp/inner-platform-bff-health.json
    echo
    echo "Local BFF is reachable at http://127.0.0.1:${LOCAL_PORT}/api/v1/health"
    exit 0
  fi
  sleep 1
done

echo "Port-forward health check failed. Port-forward log:" >&2
cat "$PF_LOG" >&2
exit 1

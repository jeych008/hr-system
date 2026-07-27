#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [[ ! -f .env ]]; then
  echo "Missing .env. Create it from .env.example and replace all placeholder secrets." >&2
  exit 1
fi

for command in docker npm curl; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "Required command is unavailable: $command" >&2
    exit 1
  fi
done

set -a
# shellcheck disable=SC1091
source .env
set +a

if [[ -z "${MYSQL_PASSWORD:-}" ]]; then
  echo "MYSQL_PASSWORD is missing from .env" >&2
  exit 1
fi

pull_with_retry() {
  local image="$1"
  local attempt
  for attempt in 1 2 3; do
    echo "Pulling ${image} (attempt ${attempt}/3)"
    if docker pull "$image"; then
      return 0
    fi
    if [[ "$attempt" -lt 3 ]]; then
      sleep $((attempt * 5))
    fi
  done
  echo "Unable to pull ${image}. Check Docker Desktop proxy/network settings and retry." >&2
  return 1
}

echo "[1/6] Checking Docker Engine"
docker info >/dev/null

echo "[2/6] Pulling required images sequentially"
for image in mysql:8.4 redis:7.4-alpine nginx:1.27-alpine node:22-bookworm-slim; do
  pull_with_retry "$image"
done

echo "[3/6] Starting MySQL and Redis"
docker compose up -d --wait --wait-timeout 300 mysql redis

echo "[4/6] Migrating the sanitized JSON dataset"
STORAGE_DRIVER=mysql \
MYSQL_URL="mysql://hr_app:${MYSQL_PASSWORD}@127.0.0.1:3307/hr_resume" \
npm run db:migrate -- data/db.json --confirm-credentials-rotated

echo "[5/6] Building and starting the local staging stack"
docker compose up -d --build --wait --wait-timeout 600

echo "[6/6] Verifying readiness"
curl --fail --silent --show-error http://127.0.0.1:8080/health/ready
printf '\n'
docker compose ps

echo "Local staging is ready at http://127.0.0.1:8080"

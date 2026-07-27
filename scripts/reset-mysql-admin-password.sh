#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [[ ! -f .env ]]; then
  echo "Missing .env" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1091
source .env
set +a

read -r -s -p "New admin password: " ADMIN_NEW_PASSWORD
printf '\n'
read -r -s -p "Confirm admin password: " ADMIN_PASSWORD_CONFIRMATION
printf '\n'

trap 'unset ADMIN_NEW_PASSWORD ADMIN_PASSWORD_CONFIRMATION ADMIN_PASSWORD' EXIT

if [[ "$ADMIN_NEW_PASSWORD" != "$ADMIN_PASSWORD_CONFIRMATION" ]]; then
  echo "Passwords do not match" >&2
  exit 1
fi
if [[ "${#ADMIN_NEW_PASSWORD}" -lt 10 ]]; then
  echo "Admin password must contain at least 10 characters" >&2
  exit 1
fi

export ADMIN_NEW_PASSWORD
MYSQL_URL="mysql://hr_app:${MYSQL_PASSWORD}@127.0.0.1:3307/hr_resume" \
  node scripts/reset-mysql-admin-password.js

echo "Running local staging verification"
ADMIN_PASSWORD="$ADMIN_NEW_PASSWORD" node scripts/verify-local-staging.js

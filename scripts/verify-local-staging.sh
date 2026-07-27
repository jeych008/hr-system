#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

read -r -s -p "Admin password: " ADMIN_PASSWORD
printf '\n'
export ADMIN_PASSWORD
trap 'unset ADMIN_PASSWORD' EXIT

node scripts/verify-local-staging.js

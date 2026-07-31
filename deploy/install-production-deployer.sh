#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="${APP_DIR:-/opt/hr-resume-system}"
RUNNER_USER="${RUNNER_USER:-hrdeploy}"
DEPLOY_COMMAND="/usr/local/sbin/hr-resume-deploy"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this installer as root" >&2
  exit 1
fi

[[ -d "$APP_DIR/.git" ]] || { echo "Repository not found: $APP_DIR" >&2; exit 1; }
[[ -f "$APP_DIR/.env" ]] || { echo "Production .env not found: $APP_DIR/.env" >&2; exit 1; }

if ! id "$RUNNER_USER" >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash "$RUNNER_USER"
fi

install -o root -g root -m 750 "$APP_DIR/deploy/hr-resume-deploy" "$DEPLOY_COMMAND"
install -d -o root -g root -m 700 /var/lib/hr-resume-deploy "$APP_DIR/backups/automatic"
chown root:root "$APP_DIR/.env"
chmod 600 "$APP_DIR/.env"

cat > /etc/sudoers.d/hr-resume-deploy <<EOF
Defaults!${DEPLOY_COMMAND} env_reset,secure_path=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
${RUNNER_USER} ALL=(root) NOPASSWD: ${DEPLOY_COMMAND}
EOF
chmod 440 /etc/sudoers.d/hr-resume-deploy
visudo -cf /etc/sudoers.d/hr-resume-deploy

if id -nG "$RUNNER_USER" | tr ' ' '\n' | grep -qx docker; then
  echo "Refusing insecure configuration: remove $RUNNER_USER from the docker group" >&2
  exit 1
fi

sudo -u "$RUNNER_USER" sudo -n "$DEPLOY_COMMAND" invalid-sha >/dev/null 2>&1 && {
  echo "Deployment command unexpectedly accepted an invalid SHA" >&2
  exit 1
}

echo "Production deployer installed. The $RUNNER_USER account has no Docker access and may only invoke $DEPLOY_COMMAND through sudo."

#!/usr/bin/env bash
# ============================================================================
# Maintenance window for the production VPS (OS + Docker updates, reboot). Run
# as root ON the server (scp it to /root), only when Ali says it is time
# (auto-approval paused, a fresh DB dump verified and copied off the server).
#
#   bash server-maintenance.sh check     # read-only: what it would do
#   bash server-maintenance.sh prepare   # site stays up: non-Docker updates, log rotation
#   bash server-maintenance.sh window    # the outage: Docker update (no restart), reboot
#
# No container is stopped by hand: one stopped by hand stays stopped after a
# reboot (restart: unless-stopped). The reboot stops everything, and every
# service starts again on its own.
#
# Data: Postgres and Redis keep their data in named Docker volumes; nothing here
# touches a volume, and a committed transaction survives any stop.
# ============================================================================
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
# needrestart must not restart services mid-upgrade (that would restart Docker).
export NEEDRESTART_MODE=l NEEDRESTART_SUSPEND=1
# Keep every existing config file (sshd on 22+2222, UFW, unattended-upgrades...).
APT_OPTS=(-y -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold)
DOCKER_PKGS=(docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin docker-ce-rootless-extras docker-model-plugin)
DEPLOY_DIR=/home/deploy/transactions-system
log() { echo "==> $(date -u +%T) $*"; }

check() {
  # shellcheck disable=SC1091
  . /etc/os-release
  echo "$PRETTY_NAME, kernel $(uname -r), up $(uptime -p)"
  if [ -f /var/run/reboot-required ]; then echo "reboot required: yes"; else echo "reboot required: no"; fi
  echo "packages to upgrade: $(apt-get -s -o Debug::NoLocking=1 full-upgrade 2>/dev/null | grep -cE '^Inst' || true)"
  echo "packages to remove:  $(apt-get -s -o Debug::NoLocking=1 full-upgrade 2>/dev/null | grep -cE '^Remv' || true)"
  if [ -f /etc/docker/daemon.json ]; then echo "daemon.json: present"; else echo "daemon.json: absent (no log rotation)"; fi
  df -h / | tail -1
  (cd "$DEPLOY_DIR" && ./release.sh prod status 2>/dev/null) || docker ps --format '{{.Names}} {{.Status}}'
}

prepare() {
  log "Updating everything except Docker (the site stays up)"
  apt-mark hold "${DOCKER_PKGS[@]}" >/dev/null
  trap 'apt-mark unhold "${DOCKER_PKGS[@]}" >/dev/null' EXIT
  apt-get update -q
  apt-get "${APT_OPTS[@]}" full-upgrade
  log "Docker log rotation (for containers created from now on)"
  if [ ! -f /etc/docker/daemon.json ]; then
    printf '{\n  "log-driver": "json-file",\n  "log-opts": { "max-size": "20m", "max-file": "5" }\n}\n' >/etc/docker/daemon.json
  fi
  dockerd --validate --config-file /etc/docker/daemon.json
  log "Removing leftover hello-world test containers"
  docker ps -aq --filter ancestor=hello-world | xargs -r docker rm >/dev/null 2>&1 || true
  docker rmi hello-world >/dev/null 2>&1 || true
  log "Prepared — nothing was restarted. Next: window."
}

window() {
  log "Docker update WITHOUT restarting it now (the reboot does that, once)"
  printf '#!/bin/sh\nexit 101\n' >/usr/sbin/policy-rc.d
  chmod +x /usr/sbin/policy-rc.d
  trap 'rm -f /usr/sbin/policy-rc.d' EXIT
  apt-get "${APT_OPTS[@]}" install --only-upgrade "${DOCKER_PKGS[@]}"
  rm -f /usr/sbin/policy-rc.d
  log "Rebooting into the new kernel (every service starts again on its own)"
  systemctl reboot
}

case "${1:-}" in
  check) check ;;
  prepare) prepare ;;
  window) window ;;
  *)
    echo "usage: $0 check|prepare|window" >&2
    exit 2
    ;;
esac

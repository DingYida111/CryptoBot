#!/usr/bin/env bash
set -euo pipefail

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY_ROOT="${CRYPTOBOT_DEPLOY_ROOT:-/opt/cryptobot}"
RELEASE_ID="${CRYPTOBOT_RELEASE_ID:-$(date -u +%Y%m%dT%H%M%SZ)}"
RELEASES_DIR="$DEPLOY_ROOT/releases"
SHARED_DIR="$DEPLOY_ROOT/shared"
CURRENT_LINK="$DEPLOY_ROOT/current"
RELEASE_PATH="$RELEASES_DIR/$RELEASE_ID"
AGENT_ID="${RUNTIME_AGENT_ID:-cryptobot-supervisor}"
LEASE_DURATION_MS="${CRYPTOBOT_DEPLOY_LEASE_DURATION_MS:-300000}"
LEASE_REASON="${CRYPTOBOT_DEPLOY_LEASE_REASON:-planned_deploy}"
LEASE_ID=""

lease_base_dir() {
  if [ -f "$CURRENT_LINK/dist/runtime/run_runtime_maintenance_lease.js" ] && [ -d "$CURRENT_LINK/node_modules" ]; then
    printf "%s\n" "$CURRENT_LINK"
    return
  fi
  printf "%s\n" "$SOURCE_DIR"
}

create_lease() {
  local base_dir output
  base_dir="$(lease_base_dir)"
  output="$(cd "$base_dir" && node dist/runtime/run_runtime_maintenance_lease.js --agent-id "$AGENT_ID" --duration-ms "$LEASE_DURATION_MS" --reason "$LEASE_REASON")"
  printf "%s\n" "$output"
  LEASE_ID="$(printf "%s\n" "$output" | sed -n 's/.*"leaseId": "\([^"]*\)".*/\1/p' | head -1)"
}

clear_lease() {
  if [ -z "$LEASE_ID" ]; then
    return
  fi

  local base_dir
  base_dir="$(lease_base_dir)"
  (cd "$base_dir" && node dist/runtime/run_runtime_maintenance_lease.js --agent-id "$AGENT_ID" --lease-id "$LEASE_ID" --clear >/dev/null) || true
}

copy_release() {
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --delete \
      --exclude ".git" \
      --exclude "node_modules" \
      --exclude "data" \
      --exclude "logs" \
      --exclude "secrets" \
      --exclude "releases" \
      --exclude "current" \
      --exclude "shared" \
      "$SOURCE_DIR/" "$RELEASE_PATH/"
    return
  fi

  mkdir -p "$RELEASE_PATH"
  tar \
    --exclude ".git" \
    --exclude "node_modules" \
    --exclude "data" \
    --exclude "logs" \
    --exclude "secrets" \
    --exclude "releases" \
    --exclude "current" \
    --exclude "shared" \
    -C "$SOURCE_DIR" -cf - . | tar -C "$RELEASE_PATH" -xf -
}

link_shared_paths() {
  mkdir -p "$SHARED_DIR"
  for name in data logs secrets; do
    local shared_path legacy_path
    shared_path="$SHARED_DIR/$name"
    legacy_path="$DEPLOY_ROOT/$name"
    if [ -e "$shared_path" ] || [ -L "$shared_path" ]; then
      continue
    fi
    if [ -e "$legacy_path" ] || [ -L "$legacy_path" ]; then
      ln -s "$legacy_path" "$shared_path"
    else
      mkdir -p "$shared_path"
    fi
  done
  rm -rf "$RELEASE_PATH/data" "$RELEASE_PATH/logs" "$RELEASE_PATH/secrets"
  ln -s "$SHARED_DIR/data" "$RELEASE_PATH/data"
  ln -s "$SHARED_DIR/logs" "$RELEASE_PATH/logs"
  ln -s "$SHARED_DIR/secrets" "$RELEASE_PATH/secrets"

  if [ ! -e "$SHARED_DIR/.env" ] && [ ! -L "$SHARED_DIR/.env" ] && { [ -e "$DEPLOY_ROOT/.env" ] || [ -L "$DEPLOY_ROOT/.env" ]; }; then
    ln -s "$DEPLOY_ROOT/.env" "$SHARED_DIR/.env"
  fi
  if [ -f "$SHARED_DIR/.env" ]; then
    rm -f "$RELEASE_PATH/.env"
    ln -s "$SHARED_DIR/.env" "$RELEASE_PATH/.env"
  fi
}

install_production_dependencies() {
  if [ "${CRYPTOBOT_DEPLOY_SKIP_NPM_CI:-false}" = "true" ]; then
    return
  fi
  if [ "${CRYPTOBOT_DEPLOY_OMIT_DEV:-false}" = "true" ]; then
    npm ci --omit=dev --prefix "$RELEASE_PATH"
    return
  fi
  npm ci --prefix "$RELEASE_PATH"
}

restart_pm2() {
  if [ "${CRYPTOBOT_DEPLOY_PM2_RELOAD:-false}" != "true" ]; then
    return
  fi
  if [ -n "${CRYPTOBOT_DEPLOY_PM2_ONLY:-}" ]; then
    if [ "${CRYPTOBOT_DEPLOY_PM2_RECREATE:-false}" = "true" ]; then
      IFS=',' read -r -a pm2_apps <<< "$CRYPTOBOT_DEPLOY_PM2_ONLY"
      for app_name in "${pm2_apps[@]}"; do
        pm2 delete "$app_name" >/dev/null 2>&1 || true
      done
      pm2 start "$CURRENT_LINK/ecosystem.config.js" --only "$CRYPTOBOT_DEPLOY_PM2_ONLY" --update-env
      return
    fi
    pm2 startOrReload "$CURRENT_LINK/ecosystem.config.js" --only "$CRYPTOBOT_DEPLOY_PM2_ONLY" --update-env
    return
  fi
  pm2 startOrReload "$CURRENT_LINK/ecosystem.config.js" --update-env
}

trap clear_lease EXIT

cd "$SOURCE_DIR"
npm run build

mkdir -p "$RELEASES_DIR" "$SHARED_DIR"
if [ -e "$RELEASE_PATH" ]; then
  echo "Release already exists: $RELEASE_PATH" >&2
  exit 1
fi

create_lease
mkdir -p "$RELEASE_PATH"
copy_release
link_shared_paths
install_production_dependencies
ln -sfn "$RELEASE_PATH" "$CURRENT_LINK"
restart_pm2

echo "Deployed CryptoBot release $RELEASE_ID to $CURRENT_LINK"

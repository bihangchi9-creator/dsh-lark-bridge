#!/bin/bash
# setup.sh — one-command install of dsh-lark-bridge into a dsh profile (bundle mode).
#
# What it does:
#   1. preflight: Node version / pnpm / dsh profile
#   2. build the plugin if lib/ is missing
#   3. symlink the plugin into the profile's node_modules
#   4. register "dsh-lark-bridge" in the profile's dsh.profile.bundles
#   5. print next steps
#
# After this, a bare `dsh web` loads the plugin automatically — no --patch flag.
#
# Usage:
#   bash scripts/setup.sh                  # default profile: web
#   DSH_PROFILE=headless bash scripts/setup.sh
#   DSH_HOME=/custom/.dsh bash scripts/setup.sh
#
# Idempotent: safe to re-run.
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE="${DSH_PROFILE:-web}"
PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"
MANIFEST="$PROFILE_DIR/package.json"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"

echo "==> dsh-lark-bridge setup"
echo "    project : $PROJECT_DIR"
echo "    profile : $PROFILE_DIR"

# 1. Preflight: node (dsh needs ^22.19.0 || >=24.0.0)
if [ -z "$NODE_BIN" ]; then
  echo "ERROR: node not found in PATH. Install Node.js ^22.19.0 or >=24.0.0 (https://nodejs.org)." >&2
  exit 1
fi
NODE_MAJOR="$("$NODE_BIN" -p 'Number(process.versions.node.split(".")[0])')"
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "ERROR: node $("$NODE_BIN" -v) is too old — dsh needs ^22.19.0 || >=24.0.0." >&2
  exit 1
fi
echo "    node    : $("$NODE_BIN" -v) (ok)"

# 2. Build the plugin if needed
if [ ! -f "$PROJECT_DIR/lib/index.js" ]; then
  if ! command -v pnpm >/dev/null 2>&1; then
    echo "ERROR: pnpm not found in PATH — needed to build the plugin (or run 'corepack enable')." >&2
    exit 1
  fi
  echo "==> building plugin (pnpm install && pnpm build)"
  (cd "$PROJECT_DIR" && pnpm install && pnpm build)
else
  echo "    build  : lib/ present, skipping build"
fi

# 3. The profile must exist (first `dsh web` run creates it)
if [ ! -d "$PROFILE_DIR" ]; then
  echo "ERROR: profile '$PROFILE' does not exist yet." >&2
  echo "       Start dsh once (e.g. 'dsh web') so the profile is created, then re-run this script." >&2
  exit 1
fi

# 4. Symlink the plugin into the profile's node_modules (bundle resolution anchor)
mkdir -p "$PROFILE_DIR/node_modules"
LINK="$PROFILE_DIR/node_modules/dsh-lark-bridge"
if [ -e "$LINK" ] && [ ! -L "$LINK" ]; then
  echo "ERROR: $LINK exists and is not a symlink — remove it first." >&2
  exit 1
fi
if [ ! -L "$LINK" ]; then
  ln -s "$PROJECT_DIR" "$LINK"
  echo "==> linked $LINK -> $PROJECT_DIR"
else
  echo "==> link already present: $LINK"
fi

# 5. Register the plugin. Prefer the official `dsh plugin` command (it runs
#    `pnpm add` in the profile and auto-reconciles dsh.profile.bundles);
#    fall back to the manual symlink + manifest edit when `dsh` is not on PATH.
if command -v dsh >/dev/null 2>&1; then
  echo "==> registering via official command: dsh plugin --profile $PROFILE add link:$PROJECT_DIR"
  dsh plugin --profile "$PROFILE" add "link:$PROJECT_DIR"
elif [ -x "$PROJECT_DIR/node_modules/.bin/dsh" ]; then
  echo "==> registering via official command (repo-local dsh): ..."
  "$PROJECT_DIR/node_modules/.bin/dsh" plugin --profile "$PROFILE" add "link:$PROJECT_DIR"
else
  # Manual fallback (no `dsh` on PATH): the symlink from step 4 is the
  # resolution anchor; just append the package name to dsh.profile.bundles.
  "$NODE_BIN" - "$MANIFEST" <<'EOF'
const fs = require('fs')
const path = process.argv[2]
const pkg = JSON.parse(fs.readFileSync(path, 'utf8'))
const bundles = pkg.dsh?.profile?.bundles ?? []
if (bundles.includes('dsh-lark-bridge')) {
  console.log('==> bundle already registered in ' + path)
  process.exit(0)
}
pkg.dsh ??= {}
pkg.dsh.profile ??= {}
pkg.dsh.profile.bundles = [...bundles, 'dsh-lark-bridge']
fs.writeFileSync(path, JSON.stringify(pkg, null, 2) + '\n')
console.log('==> registered dsh-lark-bridge bundle in ' + path)
EOF
fi

echo
echo "==> Done. Next steps:"
echo "  1. Start dsh — the bundle loads automatically, no --patch needed:"
echo "     DSH_PERMISSION_MODE=danger-full-access dsh web"
echo "  2. On first run, scan the QR code with the Feishu app, or open the URL"
echo "     written to ~/.dsh-lark-bridge/register-url.txt in a browser."
echo "  3. Add the bot to a group chat (or DM it) and send /help."

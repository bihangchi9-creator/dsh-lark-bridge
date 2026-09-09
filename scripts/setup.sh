#!/bin/bash
# setup.sh — one-command install of dsh-lark-bridge into a dsh profile (bundle mode).
#
# What it does:
#   1. preflight: Node version / dsh availability
#   2. build the plugin if lib/ is missing
#   3. install the lark-workspace / lark-readonly presets into the dsh
#      harness-home preset root ($DSH_HOME/.agent-presets)
#   4. install the bridge + workspace tool through dsh plugin (preferred), or
#      link both into an already-initialized profile as a manual fallback
#   5. verify both entries and the bundle registration
#   6. print next steps
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

# Prefer dsh's official plugin manager. It owns profile initialization and can
# create shipped profiles (web/headless) on first use. The repo-local binary is
# accepted for source checkouts where dsh is not globally installed.
DSH_BIN=""
if command -v dsh >/dev/null 2>&1; then
  DSH_BIN="$(command -v dsh)"
elif [ -x "$PROJECT_DIR/node_modules/.bin/dsh" ]; then
  DSH_BIN="$PROJECT_DIR/node_modules/.bin/dsh"
fi

# Without a dsh binary we can only use the manual manifest fallback. In that
# case fail before building or copying presets when the profile is absent, so
# a mistaken first run leaves no partial installation.
if [ -z "$DSH_BIN" ] && [ ! -f "$MANIFEST" ]; then
  echo "ERROR: dsh profile '$PROFILE' is not initialized yet." >&2
  echo "       The dsh command is not available, so setup cannot initialize it." >&2
  echo "       Install/ expose dsh in PATH and re-run 'pnpm setup', or initialize" >&2
  echo "       the profile separately before using the manual fallback." >&2
  exit 1
fi
if [ -n "$DSH_BIN" ]; then
  echo "    dsh     : $DSH_BIN (official plugin install)"
else
  echo "    profile : initialized (manual fallback)"
fi

# 2. Build the bridge AND its shipped lark-cli tool if either entry is missing.
#    The workspace preset references dsh-tool-lark-cli, so installing only the
#    bridge would leave the advertised safe tier incomplete.
if [ ! -f "$PROJECT_DIR/lib/index.js" ] || [ ! -f "$PROJECT_DIR/tools/lark-cli/lib/index.js" ]; then
  if ! command -v pnpm >/dev/null 2>&1; then
    echo "ERROR: pnpm not found in PATH — needed to build the plugin (or run 'corepack enable')." >&2
    exit 1
  fi
  echo "==> building plugin (pnpm install && pnpm build)"
  if ! (cd "$PROJECT_DIR" && pnpm install && pnpm build); then
    echo "ERROR: build failed — refusing to install an unbuilt plugin (dsh would fail to load lib/index.js)." >&2
    exit 1
  fi
else
  echo "    build  : lib/ present, skipping build"
fi

# 2b. Hard gate: both entries MUST exist before registration. Otherwise the
#     host either fails to load the bridge or cannot mount the workspace tier.
for entry in "$PROJECT_DIR/lib/index.js" "$PROJECT_DIR/tools/lark-cli/lib/index.js"; do
  if [ ! -f "$entry" ]; then
    echo "ERROR: $entry is missing after build. Not registering." >&2
    echo "       Run 'pnpm install && pnpm build' in $PROJECT_DIR and check for errors." >&2
    exit 1
  fi
done
echo "    entries: bridge + dsh-tool-lark-cli present (ok)"

LARK_TOOL_DIR="$PROJECT_DIR/tools/lark-cli"

# 3. Install the access-tier presets into the harness-home preset root.
#    dsh discovers presets under $DSH_HOME/.agent-presets (uncached — visible
#    on the next mount); without them the workspace/read-only tiers fall back
#    to the deployment default with a warning, silently losing the
#    blast-radius reduction.
if [ -d "$PROJECT_DIR/presets" ]; then
  PRESET_ROOT="$DSH_HOME/.agent-presets"
  mkdir -p "$PRESET_ROOT"
  cp -R "$PROJECT_DIR/presets/." "$PRESET_ROOT/"
  echo "==> presets installed: $PRESET_ROOT/lark-workspace, $PRESET_ROOT/lark-readonly"
else
  echo "    presets: none shipped in this checkout — skipping"
fi

# 4. Install the tool dependency and register the bridge bundle. The tool is a
#    plain profile dependency (the workspace preset resolves it by package
#    name); the bridge is a bundle and auto-registers through `dsh plugin`.
#    `dsh plugin` also initializes a missing profile from the official template.
if [ -n "$DSH_BIN" ]; then
  echo "==> installing workspace tool: dsh plugin --profile $PROFILE add link:$LARK_TOOL_DIR"
  "$DSH_BIN" plugin --profile "$PROFILE" add "link:$LARK_TOOL_DIR"
  echo "==> registering bridge: dsh plugin --profile $PROFILE add link:$PROJECT_DIR"
  "$DSH_BIN" plugin --profile "$PROFILE" add "link:$PROJECT_DIR"
else
  # Manual fallback (no `dsh` on PATH): create links for both packages and
  # record both dependencies. Only the bridge belongs in bundles.
  mkdir -p "$PROFILE_DIR/node_modules"
  LINK="$PROFILE_DIR/node_modules/dsh-lark-bridge"
  if [ -e "$LINK" ] && [ ! -L "$LINK" ]; then
    echo "ERROR: $LINK exists and is not a symlink — remove it first." >&2
    exit 1
  fi
  [ -L "$LINK" ] || ln -s "$PROJECT_DIR" "$LINK"
  LARK_TOOL_LINK="$PROFILE_DIR/node_modules/dsh-tool-lark-cli"
  if [ -e "$LARK_TOOL_LINK" ] && [ ! -L "$LARK_TOOL_LINK" ]; then
    echo "ERROR: $LARK_TOOL_LINK exists and is not a symlink — remove it first." >&2
    exit 1
  fi
  [ -L "$LARK_TOOL_LINK" ] || ln -s "$LARK_TOOL_DIR" "$LARK_TOOL_LINK"
  "$NODE_BIN" - "$MANIFEST" "$PROJECT_DIR" "$LARK_TOOL_DIR" <<'EOF'
const fs = require('fs')
const [path, bridgeDir, toolDir] = process.argv.slice(2)
const pkg = JSON.parse(fs.readFileSync(path, 'utf8'))
pkg.dependencies ??= {}
pkg.dependencies['dsh-lark-bridge'] = `link:${bridgeDir}`
pkg.dependencies['dsh-tool-lark-cli'] = `link:${toolDir}`
pkg.dsh ??= {}
pkg.dsh.profile ??= {}
const bundles = pkg.dsh.profile.bundles ?? []
pkg.dsh.profile.bundles = bundles.includes('dsh-lark-bridge')
  ? bundles
  : [...bundles, 'dsh-lark-bridge']
fs.writeFileSync(path, JSON.stringify(pkg, null, 2) + '\n')
console.log('==> registered bridge + workspace tool in ' + path)
EOF
fi

# 4b. Postcondition: installation is complete only when BOTH packages resolve
#     from the target profile and the bundle registry contains the bridge.
"$NODE_BIN" - "$PROFILE_DIR" "$MANIFEST" <<'EOF'
const fs = require('fs')
const path = require('path')
const [profileDir, manifest] = process.argv.slice(2)
for (const pkg of ['dsh-lark-bridge', 'dsh-tool-lark-cli']) {
  const entry = path.join(profileDir, 'node_modules', pkg, 'lib', 'index.js')
  if (!fs.existsSync(entry)) throw new Error(`installation incomplete: ${entry} is missing`)
}
const data = JSON.parse(fs.readFileSync(manifest, 'utf8'))
if (!data.dsh?.profile?.bundles?.includes('dsh-lark-bridge')) {
  throw new Error('installation incomplete: dsh-lark-bridge is not registered as a bundle')
}
console.log('==> verified bridge bundle + dsh-tool-lark-cli dependency')
EOF

echo
echo "==> Done. Next steps:"
echo "  1. Start dsh — the bundle loads automatically, no --patch needed:"
echo "     DSH_PERMISSION_MODE=danger-full-access dsh web"
echo "  2. On first run, scan the QR code with the Feishu app, or open the URL"
echo "     written to ~/.dsh-lark-bridge/register-url.txt in a browser."
echo "  3. Add the bot to a group chat (or DM it) and send /help."

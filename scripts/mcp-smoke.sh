#!/usr/bin/env bash
# MCP protocol-level smoke test against a packaged ai-ssh-toolkit artifact.
#
# Usage:
#   scripts/mcp-smoke.sh <path-to-installed-package>
#
# The path should be the directory containing node_modules after
# `npm install --prefix <dir> <tarball>`.
#
# Exits non-zero if any assertion fails.
set -euo pipefail

PKG_DIR="${1:?Usage: mcp-smoke.sh <install-prefix-dir>}"

# Support both unscoped (ai-ssh-toolkit) and scoped (@ebmarquez/ai-ssh-toolkit) installs
if [[ -f "${PKG_DIR}/node_modules/ai-ssh-toolkit/dist/index.js" ]]; then
  SERVER="${PKG_DIR}/node_modules/ai-ssh-toolkit/dist/index.js"
  PKG_JSON="${PKG_DIR}/node_modules/ai-ssh-toolkit/package.json"
elif [[ -f "${PKG_DIR}/node_modules/@ebmarquez/ai-ssh-toolkit/dist/index.js" ]]; then
  SERVER="${PKG_DIR}/node_modules/@ebmarquez/ai-ssh-toolkit/dist/index.js"
  PKG_JSON="${PKG_DIR}/node_modules/@ebmarquez/ai-ssh-toolkit/package.json"
else
  echo "FAIL: server entry point not found in ${PKG_DIR}/node_modules/" >&2
  exit 1
fi

# Read expected version from the installed package.json
EXPECTED_VERSION=$(node -e "console.log(require('${PKG_JSON}').version)")

echo "==> MCP smoke test against ${SERVER}"
echo "    Expected version: ${EXPECTED_VERSION}"

# Build JSON-RPC messages (newline-delimited)
INIT_REQ=$(cat <<'EOF'
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke-test","version":"0.0.1"}}}
EOF
)

TOOLS_REQ=$(cat <<'EOF'
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}
EOF
)

INIT_NOTIFY=$(cat <<'EOF'
{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}
EOF
)

# Send all three messages, then close stdin so the server exits.
RESPONSE=$(printf '%s\n%s\n%s\n' "$INIT_REQ" "$INIT_NOTIFY" "$TOOLS_REQ" | node "$SERVER" 2>/dev/null)

echo "==> Raw response:"
echo "$RESPONSE"

# ── Assert initialize response ──────────────────────────────────────────────
echo ""
echo "==> Checking initialize response..."

SERVER_NAME=$(echo "$RESPONSE" | node -e "
  const lines = require('fs').readFileSync(0,'utf-8').trim().split('\\n');
  for (const line of lines) {
    try {
      const msg = JSON.parse(line);
      if (msg.id === 1 && msg.result && msg.result.serverInfo) {
        console.log(msg.result.serverInfo.name);
        process.exit(0);
      }
    } catch {}
  }
  process.exit(1);
")

if [[ "$SERVER_NAME" != "ai-ssh-toolkit" ]]; then
  echo "FAIL: serverInfo.name = '${SERVER_NAME}', expected 'ai-ssh-toolkit'" >&2
  exit 1
fi
echo "    serverInfo.name = '${SERVER_NAME}' ✓"

SERVER_VERSION=$(echo "$RESPONSE" | node -e "
  const lines = require('fs').readFileSync(0,'utf-8').trim().split('\\n');
  for (const line of lines) {
    try {
      const msg = JSON.parse(line);
      if (msg.id === 1 && msg.result && msg.result.serverInfo) {
        console.log(msg.result.serverInfo.version);
        process.exit(0);
      }
    } catch {}
  }
  process.exit(1);
")

if [[ "$SERVER_VERSION" != "$EXPECTED_VERSION" ]]; then
  echo "FAIL: serverInfo.version = '${SERVER_VERSION}', expected '${EXPECTED_VERSION}'" >&2
  exit 1
fi
echo "    serverInfo.version = '${SERVER_VERSION}' ✓"

# ── Assert tools/list response ───────────────────────────────────────────────
echo ""
echo "==> Checking tools/list response..."

TOOLS_JSON=$(echo "$RESPONSE" | node -e "
  const lines = require('fs').readFileSync(0,'utf-8').trim().split('\\n');
  for (const line of lines) {
    try {
      const msg = JSON.parse(line);
      if (msg.id === 2 && msg.result && msg.result.tools) {
        console.log(JSON.stringify(msg.result.tools.map(t => t.name)));
        process.exit(0);
      }
    } catch {}
  }
  process.exit(1);
")

EXPECTED_TOOLS=("ssh_execute" "ssh_multi_execute" "ssh_check_host" "credential_get" "credential_list_backends" "version_check")
for tool in "${EXPECTED_TOOLS[@]}"; do
  if echo "$TOOLS_JSON" | grep -q "\"${tool}\""; then
    echo "    tool '${tool}' present ✓"
  else
    echo "FAIL: tool '${tool}' not found in tools/list response" >&2
    exit 1
  fi
done

echo ""
echo "==> MCP smoke test PASSED ✓"

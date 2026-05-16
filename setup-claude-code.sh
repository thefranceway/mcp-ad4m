#!/bin/bash
# setup-claude-code.sh — One-command AD4M + Claude Code integration
# Tested on macOS 13.3+ ARM64 (Apple M1), ad4m-executor v0.12.x, Claude Code CLI
#
# Usage:
#   ./setup-claude-code.sh --passphrase YOUR_PASSPHRASE
#   ./setup-claude-code.sh --passphrase YOUR_PASSPHRASE --port 4000

set -euo pipefail

# ── Defaults ──────────────────────────────────────────────────────────────────
PORT=4000
PASSPHRASE=""
NODE_BIN="$(command -v node 2>/dev/null || echo "")"
NPM_BIN="$(command -v npm 2>/dev/null || echo "")"
GQL="http://localhost:${PORT}/graphql"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_WRAPPER="$HOME/bin/mcp-ad4m"
UUID_FILE="$HOME/.ad4m/claude-memory-uuid"

# ── Parse args ────────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --passphrase) PASSPHRASE="$2"; shift 2 ;;
    --port)       PORT="$2"; GQL="http://localhost:${PORT}/graphql"; shift 2 ;;
    *) echo "Unknown argument: $1"; exit 1 ;;
  esac
done

# ── Preflight checks ──────────────────────────────────────────────────────────
echo "→ Checking prerequisites..."

if [[ -z "$PASSPHRASE" ]]; then
  echo "Error: --passphrase is required."
  echo "Usage: ./setup-claude-code.sh --passphrase YOUR_PASSPHRASE"
  exit 1
fi

if [[ -z "$NODE_BIN" ]]; then
  echo "Error: Node.js not found. Install via nvm: https://github.com/nvm-sh/nvm"
  exit 1
fi

if [[ -z "$NPM_BIN" ]]; then
  echo "Error: npm not found."
  exit 1
fi

NODE_VERSION=$("$NODE_BIN" --version)
echo "  Node.js: $NODE_VERSION"

if ! curl -s --max-time 3 "$GQL" -d '{"query":"{ agentStatus { isInitialized } }"}' \
    -H "Content-Type: application/json" | grep -q "isInitialized"; then
  echo ""
  echo "Error: AD4M executor not reachable at $GQL"
  echo "Start it with:  ad4m serve --port $PORT"
  echo "Or install:     npm install -g @coasys/ad4m-cli"
  exit 1
fi
echo "  AD4M executor: reachable at $GQL"

# ── Build MCP server ──────────────────────────────────────────────────────────
echo ""
echo "→ Building MCP server..."
cd "$SCRIPT_DIR"
npm install --silent
npm run build
echo "  Built: dist/index.js"

# ── Install wrapper script ────────────────────────────────────────────────────
echo ""
echo "→ Installing wrapper to ~/bin/mcp-ad4m..."
mkdir -p "$HOME/bin"
cat > "$BIN_WRAPPER" << WRAPPER
#!/bin/bash
export PATH="$(dirname "$NODE_BIN"):$PATH"
exec "$NODE_BIN" "$SCRIPT_DIR/dist/index.js" "\$@"
WRAPPER
chmod +x "$BIN_WRAPPER"
echo "  Installed: $BIN_WRAPPER"

# ── Store passphrase in macOS Keychain ────────────────────────────────────────
echo ""
echo "→ Storing passphrase in macOS Keychain..."
security delete-generic-password -s "ad4m-mcp" -a "passphrase" 2>/dev/null || true
security add-generic-password -s "ad4m-mcp" -a "passphrase" -w "$PASSPHRASE"
echo "  Stored in Keychain as service=ad4m-mcp account=passphrase"

# ── Unlock agent ──────────────────────────────────────────────────────────────
echo ""
echo "→ Unlocking AD4M agent..."
UNLOCK_RESULT=$(curl -s "$GQL" \
  -H "Content-Type: application/json" \
  -d "{\"query\":\"mutation { agentUnlock(passphrase: \\\"${PASSPHRASE}\\\") { isUnlocked } }\"}")
if echo "$UNLOCK_RESULT" | grep -q '"isUnlocked":true'; then
  echo "  Agent unlocked"
else
  echo "  Warning: unlock may have failed — check your passphrase"
  echo "  Response: $UNLOCK_RESULT"
fi

# ── Create or reuse ClaudeMemory perspective ──────────────────────────────────
echo ""
echo "→ Setting up ClaudeMemory perspective..."
mkdir -p "$HOME/.ad4m"

if [[ -f "$UUID_FILE" ]]; then
  UUID=$(cat "$UUID_FILE")
  echo "  Reusing existing ClaudeMemory: $UUID"
else
  CREATE_RESULT=$(curl -s "$GQL" \
    -H "Content-Type: application/json" \
    -d '{"query":"mutation { perspectiveAdd(name: \"ClaudeMemory\") { uuid name } }"}')
  UUID=$(echo "$CREATE_RESULT" | grep -o '"uuid":"[^"]*"' | head -1 | cut -d'"' -f4)
  if [[ -z "$UUID" ]]; then
    echo "  Error creating perspective: $CREATE_RESULT"
    exit 1
  fi
  echo "$UUID" > "$UUID_FILE"
  echo "  Created ClaudeMemory: $UUID"
fi

# ── Install launchd auto-unlock job ──────────────────────────────────────────
echo ""
echo "→ Installing launchd auto-unlock job..."
PLIST_SRC="$SCRIPT_DIR/launchd/dev.ad4m.auto-unlock.plist"
PLIST_DEST="$HOME/Library/LaunchAgents/dev.ad4m.auto-unlock.plist"

sed "s|__GQL__|$GQL|g; s|__HOME__|$HOME|g" "$PLIST_SRC" > "$PLIST_DEST"
launchctl unload "$PLIST_DEST" 2>/dev/null || true
launchctl load "$PLIST_DEST"
echo "  Installed: $PLIST_DEST"
echo "  AD4M will auto-unlock on every login"

# ── Print settings.json snippet ──────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Setup complete."
echo ""
echo "  Add this to ~/.claude/settings.json under \"mcpServers\":"
echo ""
cat << JSON
    "ad4m": {
      "command": "$BIN_WRAPPER",
      "args": [],
      "env": {
        "AD4M_GQL_URL": "$GQL"
      }
    }
JSON
echo ""
echo "  ClaudeMemory perspective UUID: $UUID"
echo "  Save this — you will use it in every ad4m_write_memory call."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

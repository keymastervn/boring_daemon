#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
OPENCODE_CONFIG="$HOME/.config/opencode/config.json"

echo "=== boring_daemon — MCP Server Installer ==="
echo ""

# Check tmux
if ! command -v tmux &>/dev/null; then
  echo "Error: tmux is required. Install with: brew install tmux"
  exit 1
fi
echo "✓ tmux found: $(tmux -V)"

# Check node
if ! command -v node &>/dev/null; then
  echo "Error: Node.js is required."
  exit 1
fi
echo "✓ node found: $(node -v)"

# Install deps
echo ""
echo "Installing dependencies..."
cd "$SCRIPT_DIR" && npm install --silent
echo "✓ Dependencies installed"

# Create log directory
mkdir -p "$HOME/.boring_daemon/logs"
echo "✓ Log directory: ~/.boring_daemon/logs"

# Register with OpenCode
echo ""
echo "Registering MCP server with OpenCode..."

# Use node to safely merge into config.json
mkdir -p "$(dirname "$OPENCODE_CONFIG")"
node -e "
const fs = require('fs');
const configPath = '$OPENCODE_CONFIG';
let config = {};
try { config = JSON.parse(fs.readFileSync(configPath, 'utf-8')); } catch {}
if (!config.mcp) config.mcp = {};
config.mcp['boring-daemon'] = {
  type: 'local',
  command: ['node', '$SCRIPT_DIR/server.js']
};
fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
console.log('✓ Registered boring-daemon in ' + configPath);
"

echo ""
echo "Done! Restart OpenCode to pick up the new MCP server."
echo ""
echo "Usage:"
echo "  1. Ask OpenCode to create a session: 'create a terminal session called prod'"
echo "  2. Watch live in iTerm2: tmux attach -t bd-prod"
echo "  3. OpenCode can send commands, read output, and wait for readiness"

# boring_daemon

An MCP server that gives Claude Code full terminal control — create sessions, send commands, read output, and wait for readiness. Like browser-use/CUA, but for CLI.

Built on **tmux** for reliability: every session is a real tmux session you can attach to and watch in real-time.

## How it works

```
Claude Code ←── stdio MCP ──→ boring_daemon (Node.js)
                                    │
                                    ├── tmux send-keys    → inject commands
                                    ├── tmux capture-pane ← read screen
                                    └── tmux pipe-pane    → stream to log file
```

Claude gets 6 tools:

| Tool             | Description                                                      |
| ---------------- | ---------------------------------------------------------------- |
| `session_create` | Spawn a new terminal session (optionally with a startup command) |
| `session_list`   | List all active sessions                                         |
| `send_command`   | Type a command + Enter into a session                            |
| `send_keys`      | Send raw keystrokes (Ctrl-C, y/n, arrow keys)                    |
| `read_output`    | Read the current screen or output since last command             |
| `wait_for_ready` | Block until the prompt reappears, then return all output         |

## Use cases

- Let Claude interact with a **production Rails/Django/Node console**
- Run and observe **database queries** through a CLI client
- SSH into servers and execute operational tasks
- Run **long-running processes** and monitor their output
- Any interactive CLI workflow that needs back-and-forth

## Prerequisites

- **Node.js** 20+
- **tmux** — install with `brew install tmux` (macOS) or `apt install tmux` (Linux)

## Quick start

### 1. Install dependencies

```bash
cd ~/tmp/boring_daemon
npm install
```

### 2. Register with Claude Code

```bash
./install.sh
```

This adds `boring-daemon` to your `~/.claude.json` MCP server config. Restart Claude Code after running this.

### 3. Try it out

Start a conversation with Claude Code and ask it to use a terminal session:

```
Create a terminal session called "demo" and run `ls -la /tmp` in it. Show me the output.
```

Claude will:

1. Call `session_create(name="demo")`
2. Call `wait_for_ready(session="demo")` — wait for shell prompt
3. Call `send_command(session="demo", command="ls -la /tmp")`
4. Call `wait_for_ready(session="demo")` — get the output

You can watch what's happening live in another terminal:

```bash
tmux attach -t bd-demo
```

### A more realistic example

```
Create a session called "db", start it with "psql -h localhost mydb",
then run "SELECT count(*) FROM users WHERE created_at > '2025-01-01';"
and tell me the result.
```

Claude will create the session, launch psql, wait for the `postgres=>` prompt, run the query, and read the result back.

## Manual MCP configuration

If you prefer to configure the MCP server manually instead of using `install.sh`, add this to your `~/.claude.json`:

```json
{
  "mcpServers": {
    "boring-daemon": {
      "command": "node",
      "args": ["/full/path/to/boring_daemon/server.js"],
      "type": "stdio"
    }
  }
}
```

## Configuration

### Custom prompt patterns

By default, boring_daemon detects common prompts: `$`, `#`, `>`, `%`, `❯`, `➜` (oh-my-zsh), plus REPL prompts for Ruby (irb/pry), Python, Elixir, MySQL, and PostgreSQL.

Override per-session when creating:

```
session_create(name="rails", command="rails console", prompt_pattern="irb.*>")
```

Or per-call when waiting:

```
wait_for_ready(session="rails", prompt_pattern="irb.*>")
```

### Log files

All session output is streamed to `~/.boring_daemon/logs/bd-<name>.log`. These persist after sessions close — useful for debugging or auditing what was run.

## Development

### Running tests

```bash
# All tests (unit + integration)
npm test

# Unit tests only (no tmux required, uses mocks)
npm run test:unit

# Integration tests only (requires tmux)
npm run test:integration
```

### Test structure

```
test/
├── session-manager.unit.test.js         # 36 tests — mocked tmux, pure logic
└── session-manager.integration.test.js  # 12 tests — real tmux sessions
```

**Unit tests** cover:

- Name prefixing/stripping
- ANSI escape code stripping (7 cases)
- tmux command argument construction
- Prompt pattern matching (11 prompt formats)
- Session state management
- Error handling (dead sessions, missing files)

**Integration tests** cover:

- Full session lifecycle (create → list → close)
- Command execution and output capture
- Output offset tracking (`since_last_command`)
- Raw keystroke sending (Ctrl-C to interrupt)
- Prompt detection with real shell and custom PS1
- Multiple concurrent session isolation
- Special character handling in commands

### Running the server directly

```bash
node server.js
```

The server communicates over stdin/stdout using the MCP protocol. It logs to stderr.

### Testing with a raw MCP message

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}' | node server.js
```

## Architecture

- **`server.js`** — MCP server entry point. Registers 6 tools with the MCP SDK, delegates to SessionManager.
- **`session-manager.js`** — Core logic. Manages tmux sessions, output tracking (via `pipe-pane` log files), and prompt detection (polling `capture-pane`).
- **`install.sh`** — Registers the MCP server in `~/.claude.json`.

### Session naming

All sessions are prefixed with `bd-` to avoid collisions with your own tmux sessions. When using the tools, you use short names (e.g., `prod`) and the prefix is added internally.

## Troubleshooting

**"tmux: command not found"**
Install tmux: `brew install tmux` or `apt install tmux`.

**Session not detected / tools return errors**
Make sure tmux server is running. You can check with `tmux list-sessions`.

**Prompt not detected (wait_for_ready times out)**
Your shell prompt might not match the default pattern. Pass a custom `prompt_pattern` regex that matches the last line of your prompt. To see what your prompt looks like:

```bash
tmux new-session -d -s test && sleep 1 && tmux capture-pane -t test -p | od -c | tail -5 && tmux kill-session -t test
```

**Stale sessions after a crash**
List and kill orphaned sessions:

```bash
tmux list-sessions | grep ^bd-
tmux kill-session -t bd-<name>
```

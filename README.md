# boring_daemon

An MCP server that gives Claude Code full terminal control — create sessions, attach to existing ones, send commands, read output, and wait for readiness. Like browser-use/CUA, but for CLI.

Built on **tmux** for reliability: every session is a real tmux session you can attach to and watch in real-time.

## How it works

```
Claude Code ←── stdio MCP ──→ boring_daemon (Node.js)
                                    │
                                    ├── tmux send-keys    → inject commands
                                    ├── tmux capture-pane ← read screen
                                    └── tmux pipe-pane    → stream to log file
```

Claude gets 12 tools:

**Session management**

| Tool               | Description                                                       |
| ------------------ | ----------------------------------------------------------------- |
| `session_create`   | Spawn a new terminal session (optionally with a startup command)  |
| `session_attach`   | Attach to an existing tmux session (e.g., one you already opened) |
| `session_list`     | List sessions managed by boring_daemon                            |
| `session_list_all` | List ALL tmux sessions on the system (to discover what to attach) |
| `send_command`     | Type a command + Enter into a session                             |
| `send_keys`        | Send raw keystrokes (Ctrl-C, y/n, arrow keys)                     |
| `read_output`      | Read the current screen or output since last command              |
| `wait_for_ready`   | Block until the prompt reappears, then return all output          |

**Recording & replay**

| Tool           | Description                                                             |
| -------------- | ----------------------------------------------------------------------- |
| `record_start` | Begin recording all tool calls to a JSONL file                          |
| `record_stop`  | Finalise the recording and return the file path                         |
| `record_event` | Append a custom event mid-recording (e.g. an `LLM_TURN` reasoning step) |
| `replay`       | Re-execute a recording verbatim (`auto`) or with LLM review (`hybrid`)  |

## Use cases

- Let Claude interact with a **production Rails/Django/Node console**
- Run and observe **database queries** through a CLI client
- SSH into servers and execute operational tasks
- Run **long-running processes** and monitor their output
- **Attach to an existing terminal tab** and let Claude work inside it
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

### 2. Register with your AI coding tool

**Claude Code:**

```bash
./scripts/claude_install.sh
```

This adds `boring-daemon` to your `~/.claude.json` MCP server config. Restart Claude Code after running this.

**OpenCode:**

```bash
./scripts/opencode_install.sh
```

This adds `boring-daemon` to your `~/.config/opencode/config.json`. Restart OpenCode after running this.

### 3. Try it out — new session

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

### 4. Try it out — attach to an existing terminal

If you already have a terminal tab running something (e.g., a Rails console, a psql session), you can let Claude attach to it.

**Step 1: Wrap your existing terminal tab in tmux**

In your iTerm2 tab, run:

```bash
npx boring-daemon wrap my-console
```

This wraps your current shell in a tmux session named `my-console`. Everything continues to work as before — you're just now inside tmux.

**Step 2: Tell Claude to attach**

```
Attach to my existing terminal session "my-console" and run User.count in it.
```

Claude will:

1. Call `session_list_all()` — discover available tmux sessions
2. Call `session_attach(name="console", tmux_session="my-console")`
3. Call `send_command(session="console", command="User.count")`
4. Call `wait_for_ready(session="console")` — read the result

**If you're already in tmux**, you don't need the `wrap` command — Claude can attach directly to your session name.

### A more realistic example

```
Create a session called "db", start it with "psql -h localhost mydb",
then run "SELECT count(*) FROM users WHERE created_at > '2025-01-01';"
and tell me the result.
```

Claude will create the session, launch psql, wait for the `postgres=>` prompt, run the query, and read the result back.

## Recording & Replay

Record a session once, then replay it deterministically — useful for automation scripts that need reliable, repeatable execution instead of free-form prompting.

### Record a session

```
Start recording as "count-users".
[Call record_start with session="count-users"]

Now create a session "db", run psql, query SELECT count(*) FROM users, and close.
[Claude works through the task — every tool call is auto-recorded]

Before each reasoning step, log an LLM_TURN event with record_event.
[Call record_event with type="LLM_TURN", data={model, prompt, response}]

Stop recording.
[Call record_stop]
```

The recording is saved to `~/.boring_daemon/record_logs/count-users-<timestamp>.jsonl`.

### JSONL format

Each file is a stream of JSON lines:

```jsonl
{"type":"header","schema_version":"1.0","session":"count-users","start":"2026-04-22T16:20:00Z","recorder":"boring-daemon"}
{"type":"session_create","idx":1,"ts":"...","session":"db","params":{"command":"psql -h localhost mydb"}}
{"type":"wait_for_ready","idx":2,"ts":"...","session":"db","params":{"timeout":30},"result":{"ready":true,"elapsed":1.2}}
{"type":"LLM_TURN","idx":3,"ts":"...","model":"claude-sonnet-4-6","prompt":"run the count query","response":"I'll run SELECT count(*)..."}
{"type":"send_command","idx":4,"ts":"...","session":"db","params":{"command":"SELECT count(*) FROM users;","enter":true}}
{"type":"wait_for_ready","idx":5,"ts":"...","session":"db","params":{"timeout":30},"result":{"ready":true,"elapsed":0.8}}
{"type":"session_close","idx":6,"ts":"...","session":"db"}
{"type":"footer","end":"2026-04-22T16:25:00Z","total_events":6,"session":"count-users"}
```

### Replay a recording

**Auto mode** — executes all tool events verbatim; `LLM_TURN` events are skipped:

```
Replay ~/.boring_daemon/record_logs/count-users-2026-04-22T16-20-00.jsonl in auto mode.
[Call replay with file=..., mode="auto"]
```

**Hybrid mode** — same as auto, but `LLM_TURN` events are surfaced in the replay output so you can review the original prompt and decide whether to adjust before continuing:

```
Replay count-users-....jsonl in hybrid mode.
[Call replay with file=..., mode="hybrid"]
```

The replay returns a log entry per event with `status: ok | skipped | llm_turn | error`.

## CLI commands

The `boring-daemon` CLI helps you manage terminal sessions.

```bash
# Wrap current terminal in a named tmux session
npx boring-daemon wrap <name>

# Detach from the tmux session (back to plain terminal)
npx boring-daemon unwrap

# List all tmux sessions
npx boring-daemon list

# Kill a specific session
npx boring-daemon kill <name>

# Kill all boring-daemon (bd-*) sessions
npx boring-daemon kill-all
```

After wrapping, tell Claude: `Attach to session "<name>"`.

To detach manually, press `Ctrl-B` then `D`.

## Manual MCP configuration

If you prefer to configure the MCP server manually instead of using the install scripts, add this to your `~/.claude.json` (Claude Code) or `~/.config/opencode/config.json` (OpenCode):

**Claude Code** (`~/.claude.json`):

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

**OpenCode** (`~/.config/opencode/config.json`):

```json
{
  "mcp": {
    "boring-daemon": {
      "type": "local",
      "command": ["node", "/full/path/to/boring_daemon/server.js"]
    }
  }
}
```

## Configuration

### Custom prompt patterns

By default, boring_daemon detects common prompts: `$`, `#`, `>`, `%`, `❯`, `➜` (oh-my-zsh), plus REPL prompts for Ruby (irb/pry), Python, Elixir, MySQL, and PostgreSQL.

Override per-session when creating or attaching:

```
session_create(name="rails", command="rails console", prompt_pattern="irb.*>")
session_attach(name="db", tmux_session="psql-prod", prompt_pattern="postgres.*>")
```

Or per-call when waiting:

```
wait_for_ready(session="rails", prompt_pattern="irb.*>")
```

### Log files

All session output is streamed to `~/.boring_daemon/logs/<session>.log`. These persist after sessions close — useful for debugging or auditing what was run.

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
├── session-manager.unit.test.js         # 76 tests — mocked tmux, pure logic
├── session-manager.integration.test.js  # 18 tests — real tmux sessions
├── recorder.unit.test.js                # 26 tests — Recorder class, JSONL correctness
├── replayer.unit.test.js                # 24 tests — replay routing (mock manager)
└── recording.integration.test.js        # 10 tests — full record→replay with real tmux
```

**Session manager unit tests** cover:

- Name prefixing/stripping and resolution (`_resolve`)
- ANSI escape code stripping (7 cases)
- tmux command argument construction
- Prompt pattern matching (11 prompt formats)
- Session create, attach, close lifecycle
- `listAll` with managed/unmanaged session detection
- Attached session operations target real tmux name (not `bd-` prefix)
- Error handling (dead sessions, missing files, nonexistent sessions)

**Session manager integration tests** cover:

- Full session lifecycle (create → list → close)
- Command execution and output capture
- Output offset tracking (`since_last_command`)
- Raw keystroke sending (Ctrl-C to interrupt)
- Prompt detection with real shell and custom PS1
- Multiple concurrent session isolation
- Attach to external tmux sessions (create outside, attach inside)
- Send commands and read output from attached sessions
- `listAll` showing both `bd-` and non-`bd-` sessions
- Special character handling in commands

**Recorder unit tests** cover:

- Initial state, `start()`, `append()`, `stop()` lifecycle
- File creation, header structure, footer structure
- Sequential `idx` assignment and ISO `ts` on every event
- Field spreading (nested `params`, `result`, `meta`, arbitrary keys)
- Guard: throws if already recording; throws on `stop()` with no active session
- Idempotent start→stop→start cycle
- Full JSONL correctness (every line parseable)

**Replayer unit tests** cover:

- File validation: empty file, missing header, malformed JSON
- Event routing for all 7 tool types (mock manager, captures args)
- `enter` default (true) when absent from recorded params
- `since_last_command` / `lines` translation to `sinceLastCommand`
- Auto mode: `LLM_TURN` skipped, unknown types skipped with reason
- Hybrid mode: `LLM_TURN` surfaced with `prompt` and `hint`; tool events still execute
- Error handling: throws on first failure with `idx` and type; aborts subsequent events
- Return value shape: `header`, `mode`, `log[]` with `idx`/`type`/`status` per entry

**Recording integration tests** cover:

- File lands in `~/.boring_daemon/record_logs/` with correct naming
- Real session tool calls produce correct JSONL (header → events → footer)
- `LLM_TURN` events captured via `record_event` pattern
- Two concurrent `Recorder` instances write to separate files without interference
- Auto replay: creates real tmux session, runs command, closes — all events `ok`
- Auto replay: `LLM_TURN` events appear as `skipped` in log
- Hybrid replay: `LLM_TURN` events appear as `llm_turn` with prompt/hint; tools still run
- Replay log `idx` and `type` match the original recording
- Replay aborts with descriptive error on bad session reference

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

- **`server.js`** — MCP server entry point. Registers 12 tools with the MCP SDK, delegates to SessionManager and Recorder.
- **`session-manager.js`** — Core logic. Manages tmux sessions (create and attach), output tracking (via `pipe-pane` log files), and prompt detection (polling `capture-pane`).
- **`recorder.js`** — Singleton `Recorder` class. Streams tool-call events to a JSONL file line-by-line as they happen (crash-safe, no buffering).
- **`replayer.js`** — `replay(filePath, manager, {mode})` function. Reads a JSONL recording and re-executes events against a live `SessionManager`.
- **`cli.js`** — CLI tool (`boring-daemon wrap/unwrap`) for wrapping existing terminal tabs in tmux.
- **`scripts/claude_install.sh`** — Registers the MCP server in `~/.claude.json` (Claude Code).
- **`scripts/opencode_install.sh`** — Registers the MCP server in `~/.config/opencode/config.json` (OpenCode).

### Session naming

Sessions created by boring_daemon are prefixed with `bd-` to avoid collisions with your own tmux sessions. Attached sessions keep their original tmux name. Internally, `_resolve()` maps the alias you use to the real tmux session name.

## Troubleshooting

**"tmux: command not found"**
Install tmux: `brew install tmux` or `apt install tmux`.

**Session not detected / tools return errors**
Make sure tmux server is running. You can check with `tmux list-sessions`.

**Can't attach to a session**
Use `session_list_all` to see all available tmux sessions. The session name must match exactly. If your terminal tab isn't in tmux yet, wrap it first: `npx boring-daemon wrap <name>`.

**Prompt not detected (wait_for_ready times out)**
Your shell prompt might not match the default pattern. Pass a custom `prompt_pattern` regex that matches the last line of your prompt. To see what your prompt looks like:

```bash
tmux new-session -d -s test && sleep 1 && tmux capture-pane -t test -p | od -c | tail -5 && tmux kill-session -t test
```

**Model "corrects" commands instead of sending them verbatim**
LLMs may rewrite unusual command names (e.g., `heroclistag` → `heroctl staging`) because they look like typos. The tool descriptions instruct the model to send commands exactly as written, but this isn't always enough. To reduce the risk:

- Wrap commands in backticks in your prompt: `` run `heroclistag app run-tty ats` ``
- Be explicit: "run this exact command: ..."
- If the model still rewrites it, correct it and it will learn within the conversation

**Stale sessions after a crash**
List and kill orphaned sessions:

```bash
boring-daemon list
boring-daemon kill <name>
boring-daemon kill-all    # kills all bd-* sessions
```

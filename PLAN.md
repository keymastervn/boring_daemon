# boring_daemon

An MCP server that gives Claude Code full terminal control — send commands, read output, wait for readiness. Like browser-use/CUA, but for CLI.

## Why tmux?

Instead of fighting iTerm2 APIs or managing raw PTYs, we use **tmux** as the backend:
- `tmux send-keys` — inject commands into any pane
- `tmux capture-pane -p` — read the entire visible buffer
- `tmux pipe-pane` — stream output to a log file
- Sessions are visible in iTerm2 (user can watch in real-time)
- Works over SSH (attach to remote tmux sessions)
- Battle-tested, no native deps

The user can `tmux attach -t <session>` in iTerm2 to watch Claude work.

## Architecture

```
Claude Code ←── stdio MCP ──→ boring_daemon (Node.js MCP server)
                                    │
                                    ├── tmux send-keys ──→ [session: prod-console]
                                    ├── tmux capture-pane ←── read output
                                    └── log files ←── tmux pipe-pane (streaming)
```

## MCP Tools

### session_list
List all boring_daemon-managed tmux sessions with their status.

### session_create
Create a new tmux session. Optionally run a startup command (e.g., `ssh prod`, `rails console`).
- `name` (string) — session name
- `command` (string, optional) — initial command to run
- `prompt_pattern` (string, optional) — regex to detect when terminal is ready (default: common shell prompts)
- `working_dir` (string, optional) — starting directory

### send_command
Send a command to a session. Does NOT wait for completion — use `wait_for_ready` after.
- `session` (string) — session name
- `command` (string) — command to type + Enter
- `enter` (boolean, default true) — whether to press Enter after

### read_output
Read the current terminal buffer content.
- `session` (string) — session name
- `lines` (number, optional) — last N lines (default: all visible)
- `since_last_command` (boolean, optional) — only output since last `send_command`

### wait_for_ready
Block until the terminal prompt reappears (or timeout). Returns all output since the last command.
- `session` (string) — session name
- `timeout` (number, optional) — max wait in seconds (default: 30)
- `prompt_pattern` (string, optional) — override the session's prompt pattern

### send_keys
Send raw keystrokes (for interactive prompts like y/n, Ctrl-C, etc.).
- `session` (string) — session name
- `keys` (string) — tmux key notation (e.g., "y", "Enter", "C-c", "q")

### session_close
Kill a session.
- `session` (string) — session name

## Output Tracking

Each session maintains:
- **Full log** — `pipe-pane` streams all output to `~/.boring_daemon/logs/<session>.log`
- **Command marker** — after each `send_command`, we record the log file offset
- **`read_output(since_last_command=true)`** — returns only text since the marker
- **`wait_for_ready`** — polls `capture-pane` every 500ms for the prompt pattern, returns accumulated output

## Prompt Detection

Default prompt regex matches common patterns:
```
[$#>%] \s*$          — bash/zsh/fish
irb.*[>*]\s*$        — Ruby IRB
pry.*[>*]\s*$        — Pry
>>>\s*$              — Python
iex.*>\s*$           — Elixir IEx
mysql>\s*$           — MySQL
postgres.*[#>]\s*$   — PostgreSQL
```

Users can override per-session with `prompt_pattern`.

## File Structure

```
boring_daemon/
├── PLAN.md
├── package.json
├── server.js          — MCP server entry point
├── session-manager.js — tmux session lifecycle + output tracking
└── install.sh         — sets up Claude Code MCP config
```

## Setup

1. `cd ~/tmp/boring_daemon && npm install`
2. `./install.sh` — registers as MCP server in Claude Code config
3. tmux must be installed (`brew install tmux`)

## Security Notes

- Sessions are local tmux sessions — same privileges as the user
- Log files in `~/.boring_daemon/logs/` may contain sensitive output
- The daemon prefixes session names with `bd-` to avoid colliding with user tmux sessions

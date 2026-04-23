# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] — 2026-04-24

### Added

**Recording & Replay** — deterministic automation scripting for terminal sessions.

Four new MCP tools:

| Tool           | Description                                           |
| -------------- | ----------------------------------------------------- |
| `record_start` | Begin recording all tool calls to a JSONL file        |
| `record_stop`  | Finalise the recording and return the file path       |
| `record_event` | Append a custom event mid-recording (e.g. `LLM_TURN`) |
| `replay`       | Re-execute a recording in `auto` or `hybrid` mode     |

**JSONL recording format** (`~/.boring_daemon/record_logs/<session>-<timestamp>.jsonl`):

- Line 1: `header` — `schema_version`, `session`, `start`, `recorder`, optional `description`
- Middle lines: events — `type`, `idx`, `ts`, `session`, `params`, optional `result`/`meta`
- Last line: `footer` — `end`, `total_events`, `session`

Supported event types:

| Type             | Source                                                                             |
| ---------------- | ---------------------------------------------------------------------------------- |
| `session_create` | Auto-recorded on `session_create` tool call                                        |
| `session_attach` | Auto-recorded on `session_attach` tool call                                        |
| `session_close`  | Auto-recorded on `session_close` tool call                                         |
| `send_command`   | Auto-recorded on `send_command` tool call                                          |
| `send_keys`      | Auto-recorded on `send_keys` tool call                                             |
| `read_output`    | Auto-recorded on `read_output` tool call (includes result)                         |
| `wait_for_ready` | Auto-recorded on `wait_for_ready` tool call (includes ready/elapsed)               |
| `LLM_TURN`       | Logged explicitly via `record_event` — captures the user prompt and model response |
| _(custom)_       | Any string type accepted by `record_event` for future extension                    |

**Replay modes:**

- `auto` — executes all tool events verbatim in sequence; `LLM_TURN` events are skipped
- `hybrid` — same as `auto`, but `LLM_TURN` events are surfaced in the replay log with the original prompt, so the calling LLM can review and adapt before continuing

**New source files:**

- `recorder.js` — singleton `Recorder` class; streams events to JSONL line-by-line (crash-safe)
- `replayer.js` — `replay(filePath, manager, {mode})` function

**New test files** (60 new tests, all passing):

- `test/recorder.unit.test.js` — 26 unit tests covering Recorder lifecycle, append, stop, and JSONL correctness
- `test/replayer.unit.test.js` — 24 unit tests covering event routing, hybrid/auto modes, error handling, and return shape (mock manager)
- `test/recording.integration.test.js` — 10 integration tests covering the full record→replay lifecycle with real tmux sessions

### Changed

- `server.js` — all 7 existing tool handlers now call `recorder.append()` after each successful execution; no change to existing tool behaviour
- `package.json` — version bumped to `0.3.0`
- `server.js` — version string updated to `0.3.0`

---

## [0.2.1] — 2026-03-06

### Fixed

- Timeout detection in custom IRB prompts (e.g. `ats(staging)>`): switched from 120 s timeout heuristic to bracket paste mode marker (`\x1b[?2004h` on last capture-pane line) for reliable prompt detection in non-standard REPLs.

---

## [0.2.0] — 2026-03-06

### Added

- Reliable prompt detection via `pane_current_command` (primary) with regex and bracket-paste-mode fallbacks for REPLs
- CLI session management (`boring-daemon wrap / unwrap / list / kill / kill-all`)
- Verbatim command guardrails in `send_command` tool description

### Changed

- `waitForReady` polling strategy overhauled; primary check is now `tmux display-message #{pane_current_command}` to detect idle shell, removing dependency on fragile last-line regex for standard shells

---

## [0.1.0] — 2026-03-05

### Added

- Initial release
- 8 MCP tools: `session_create`, `session_attach`, `session_list`, `session_list_all`, `send_command`, `send_keys`, `read_output`, `wait_for_ready`, `session_close`
- tmux-based session management with log-file output tracking
- ANSI stripping, prompt pattern detection, output offset tracking

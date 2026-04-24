#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { SessionManager } from "./session-manager.js";
import { recorder } from "./recorder.js";
import { replay as replayRecording } from "./replayer.js";

const manager = new SessionManager();

const server = new McpServer({
  name: "boring-daemon",
  version: "0.3.0",
});

// --- Tools ---

server.tool(
  "session_list",
  "List all terminal sessions managed by boring_daemon (created or attached)",
  {},
  async () => {
    const sessions = await manager.list();
    return {
      content: [
        {
          type: "text",
          text:
            sessions.length === 0
              ? "No active sessions. Use session_create or session_attach to start one."
              : JSON.stringify(sessions, null, 2),
        },
      ],
    };
  },
);

server.tool(
  "session_list_all",
  "List ALL tmux sessions on the system (including ones not managed by boring_daemon). Use this to discover existing sessions you can attach to.",
  {},
  async () => {
    const sessions = await manager.listAll();
    return {
      content: [
        {
          type: "text",
          text:
            sessions.length === 0
              ? "No tmux sessions found. The user can create one with: tmux new-session -s <name>"
              : JSON.stringify(sessions, null, 2),
        },
      ],
    };
  },
);

server.tool(
  "session_attach",
  "Attach to an existing tmux session (not created by boring_daemon). Use session_list_all to discover available sessions. After attaching, you can use send_command, read_output, wait_for_ready as normal. The user can also wrap an existing iTerm2 tab with: npx boring-daemon wrap <name>",
  {
    name: z.string().describe("Name to refer to this session in boring_daemon"),
    tmux_session: z
      .string()
      .optional()
      .describe(
        "Actual tmux session name to attach to (defaults to name if not provided)",
      ),
    prompt_pattern: z
      .string()
      .optional()
      .describe("Regex to detect when terminal is ready/idle"),
  },
  async ({ name, tmux_session, prompt_pattern }) => {
    try {
      const result = await manager.attach(name, {
        tmuxSession: tmux_session,
        promptPattern: prompt_pattern,
      });
      recorder.append({
        type: "session_attach",
        session: name,
        params: { tmux_session, prompt_pattern },
      });
      return {
        content: [
          {
            type: "text",
            text: `Attached to tmux session "${result.tmuxName}" as "${name}".\nLog file: ${result.logFile}\nAll tools (send_command, read_output, wait_for_ready) now work with session="${name}".`,
          },
        ],
      };
    } catch (e) {
      return {
        content: [{ type: "text", text: `Error: ${e.message}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  "session_create",
  "Create a new terminal session. Optionally run a startup command (e.g. ssh, rails console). Use `tmux attach -t bd-<name>` in iTerm2 to watch.",
  {
    name: z.string().describe("Session name (alphanumeric, dashes)"),
    command: z
      .string()
      .optional()
      .describe(
        "Initial command to run, verbatim from the user (e.g. 'ssh prod', 'rails console'). Never correct or reformat.",
      ),
    prompt_pattern: z
      .string()
      .optional()
      .describe(
        "Regex to detect when terminal is ready/idle. Defaults to common shell/repl prompts.",
      ),
    working_dir: z.string().optional().describe("Starting working directory"),
  },
  async ({ name, command, prompt_pattern, working_dir }) => {
    try {
      const result = await manager.create(name, {
        command,
        promptPattern: prompt_pattern,
        workingDir: working_dir,
      });
      recorder.append({
        type: "session_create",
        session: name,
        params: { command, prompt_pattern, working_dir },
      });
      return {
        content: [
          {
            type: "text",
            text: `Session "${name}" created.\nLog file: ${result.logFile}\nWatch live: tmux attach -t bd-${name}`,
          },
        ],
      };
    } catch (e) {
      return {
        content: [{ type: "text", text: `Error: ${e.message}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  "send_command",
  `Send a command to a terminal session. The command is typed and Enter is pressed. Use wait_for_ready afterwards to get the output.

CRITICAL: You MUST send commands EXACTLY as the user wrote them, character-for-character. NEVER "correct", reformat, or split user-provided commands. Users often use custom aliases, typo-looking tool names, or domain-specific CLIs that you won't recognize — these are intentional. If the user writes \`heroclistag app run-tty ats\`, send exactly that, not \`heroctl staging app run-tty ats\`. When in doubt, copy the command verbatim from the user's prompt.`,
  {
    session: z.string().describe("Session name"),
    command: z
      .string()
      .describe(
        "The exact command string to type — must match the user's input verbatim, never corrected or reformatted",
      ),
    enter: z
      .boolean()
      .optional()
      .default(true)
      .describe("Press Enter after typing (default: true)"),
  },
  async ({ session, command, enter }) => {
    try {
      await manager.sendCommand(session, command, enter);
      recorder.append({
        type: "send_command",
        session,
        params: { command, enter },
      });
      return {
        content: [
          {
            type: "text",
            text: `Command sent to "${session}": ${command}`,
          },
        ],
      };
    } catch (e) {
      return {
        content: [{ type: "text", text: `Error: ${e.message}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  "send_keys",
  "Send raw keystrokes to a session (for interactive prompts, Ctrl-C, etc.). Uses tmux key notation.",
  {
    session: z.string().describe("Session name"),
    keys: z
      .string()
      .describe('Keys in tmux notation (e.g. "y", "Enter", "C-c", "q", "Up")'),
  },
  async ({ session, keys }) => {
    try {
      await manager.sendKeys(session, keys);
      recorder.append({ type: "send_keys", session, params: { keys } });
      return {
        content: [{ type: "text", text: `Keys sent to "${session}": ${keys}` }],
      };
    } catch (e) {
      return {
        content: [{ type: "text", text: `Error: ${e.message}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  "read_output",
  "Read the current terminal screen content. Use since_last_command=true to get only output from the last command.",
  {
    session: z.string().describe("Session name"),
    lines: z
      .number()
      .optional()
      .describe("Number of lines to read from bottom (default: full screen)"),
    since_last_command: z
      .boolean()
      .optional()
      .default(false)
      .describe("Only return output since the last send_command"),
  },
  async ({ session, lines, since_last_command }) => {
    try {
      const output = await manager.readOutput(session, {
        lines,
        sinceLastCommand: since_last_command,
      });
      recorder.append({
        type: "read_output",
        session,
        params: { lines, since_last_command },
        result: output,
      });
      return {
        content: [{ type: "text", text: output || "(empty)" }],
      };
    } catch (e) {
      return {
        content: [{ type: "text", text: `Error: ${e.message}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  "wait_for_ready",
  "Wait until the terminal shows a prompt (is ready for the next command). Returns all output produced since the last send_command. Use this after send_command to get results.",
  {
    session: z.string().describe("Session name"),
    timeout: z
      .number()
      .optional()
      .default(30)
      .describe("Max seconds to wait (default: 30)"),
    prompt_pattern: z
      .string()
      .optional()
      .describe("Override prompt regex for this call"),
  },
  async ({ session, timeout, prompt_pattern }) => {
    try {
      const result = await manager.waitForReady(session, {
        timeout,
        promptPattern: prompt_pattern,
      });
      recorder.append({
        type: "wait_for_ready",
        session,
        params: { timeout, prompt_pattern },
        result: { ready: result.ready, elapsed: result.elapsed },
      });
      const status = result.ready
        ? `Ready (${result.elapsed}s)`
        : `Timed out (${result.elapsed}s)`;
      return {
        content: [
          {
            type: "text",
            text: `[${status}]\n\n${result.output}`,
          },
        ],
      };
    } catch (e) {
      return {
        content: [{ type: "text", text: `Error: ${e.message}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  "session_close",
  "Kill a terminal session and clean up",
  {
    session: z.string().describe("Session name"),
  },
  async ({ session }) => {
    try {
      await manager.close(session);
      recorder.append({ type: "session_close", session });
      return {
        content: [{ type: "text", text: `Session "${session}" closed.` }],
      };
    } catch (e) {
      return {
        content: [{ type: "text", text: `Error: ${e.message}` }],
        isError: true,
      };
    }
  },
);

// --- Recording tools ---

server.tool(
  "record_start",
  `Start recording all boring-daemon tool calls to a JSONL file.
Every subsequent send_command, send_keys, wait_for_ready, read_output, session_create, session_attach, and session_close call will be appended as a structured event.

Use record_event to log LLM reasoning turns (LLM_TURN) or any other custom events mid-recording.
Call record_stop to finalise the file.

File is written to: ~/.boring_daemon/record_logs/<session>-<timestamp>.jsonl`,
  {
    session: z
      .string()
      .describe(
        "Label for this recording (used in the filename and as the session identifier in the log)",
      ),
    description: z
      .string()
      .optional()
      .describe("Human-readable description of what this recording does"),
  },
  async ({ session, description }) => {
    try {
      const filePath = recorder.start(session, { description });
      return {
        content: [
          {
            type: "text",
            text: `Recording started.\nSession label: ${session}\nFile: ${filePath}\n\nAll tool calls will be recorded until record_stop is called.`,
          },
        ],
      };
    } catch (e) {
      return {
        content: [{ type: "text", text: `Error: ${e.message}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  "record_stop",
  "Stop the active recording and finalise the JSONL file. Returns the file path and event count.",
  {},
  async () => {
    try {
      const { filePath, totalEvents, session } = recorder.stop();
      return {
        content: [
          {
            type: "text",
            text: `Recording stopped.\nSession: ${session}\nEvents recorded: ${totalEvents}\nFile: ${filePath}`,
          },
        ],
      };
    } catch (e) {
      return {
        content: [{ type: "text", text: `Error: ${e.message}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  "record_event",
  `Append a custom event to the active recording. Use this to log LLM reasoning turns and other non-tool events.

Common usage — log an LLM turn before acting on a user prompt:
  type: "LLM_TURN", data: { model: "claude-sonnet-4-6", prompt: "<user message>", response: "<your plan>" }

The type field can be any string. Known special types:
  LLM_TURN  — a user prompt handed to the LLM agent, with optional model/response fields
  NOTE      — a free-form human annotation

No-ops silently if no recording is active.`,
  {
    type: z
      .string()
      .describe('Event type (e.g. "LLM_TURN", "NOTE", or any custom string)'),
    data: z
      .object({})
      .passthrough()
      .describe("Arbitrary key-value payload for this event"),
  },
  async ({ type, data }) => {
    if (!recorder.isRecording()) {
      return {
        content: [
          {
            type: "text",
            text: "No active recording. Event not saved. Call record_start first.",
          },
        ],
      };
    }
    recorder.append({ type, ...data });
    return {
      content: [
        {
          type: "text",
          text: `Event recorded: ${type}`,
        },
      ],
    };
  },
);

server.tool(
  "replay",
  `Replay a boring-daemon recording from a JSONL file.

Modes:
  auto   — executes all tool events (send_command, send_keys, wait_for_ready, etc.) verbatim
            in sequence. LLM_TURN events are skipped.
  hybrid — same as auto, but LLM_TURN events are surfaced in the replay log so you can
            review the original prompt and decide whether to adjust subsequent commands
            before the replay continues.

The replay uses the current live session manager, so sessions created during replay are
real tmux sessions you can attach to.

Returns a structured log of every event: status ok | skipped | llm_turn | error.`,
  {
    file: z
      .string()
      .describe(
        "Absolute path to the .jsonl recording file (e.g. ~/.boring_daemon/record_logs/my-session-2026-04-22T16-20-00.jsonl)",
      ),
    mode: z
      .enum(["auto", "hybrid"])
      .optional()
      .default("auto")
      .describe(
        "auto: execute all tool events, skip LLM turns. hybrid: surface LLM turns for review.",
      ),
  },
  async ({ file, mode }) => {
    try {
      const expandedFile = file.startsWith("~")
        ? file.replace("~", process.env.HOME || "")
        : file;
      const { header, log } = await replayRecording(expandedFile, manager, {
        mode,
      });

      const ok = log.filter((e) => e.status === "ok").length;
      const skipped = log.filter((e) => e.status === "skipped").length;
      const llmTurns = log.filter((e) => e.status === "llm_turn").length;
      const errors = log.filter((e) => e.status === "error").length;

      const summary = [
        `Replay complete — ${header.session} (${mode} mode)`,
        `  ok: ${ok}  skipped: ${skipped}  llm_turns: ${llmTurns}  errors: ${errors}`,
        "",
        "Event log:",
        ...log.map((e) => {
          const base = `  [${String(e.idx).padStart(3)}] ${e.type} → ${e.status}`;
          if (e.status === "llm_turn")
            return `${base}\n        prompt: ${e.prompt}\n        ${e.hint}`;
          if (e.status === "error") return `${base}: ${e.error}`;
          if (e.status === "skipped" && e.reason)
            return `${base} (${e.reason})`;
          return base;
        }),
      ].join("\n");

      return { content: [{ type: "text", text: summary }] };
    } catch (e) {
      return {
        content: [{ type: "text", text: `Error: ${e.message}` }],
        isError: true,
      };
    }
  },
);

// --- Start ---

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("boring-daemon MCP server running on stdio");
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});

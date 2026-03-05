#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { SessionManager } from "./session-manager.js";

const manager = new SessionManager();

const server = new McpServer({
  name: "boring-daemon",
  version: "0.2.0",
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

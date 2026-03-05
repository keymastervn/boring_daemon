#!/usr/bin/env node

import { execSync } from "child_process";

const command = process.argv[2];
const name = process.argv[3];

function usage() {
  console.log(`boring-daemon CLI

Usage:
  boring-daemon wrap <name>       Wrap the current terminal in a named tmux session.
  boring-daemon unwrap            Detach from the current tmux session.
  boring-daemon list              List all tmux sessions.
  boring-daemon kill <name>       Kill a tmux session by name.
  boring-daemon kill-all          Kill all boring-daemon (bd-*) sessions.

Examples:
  boring-daemon wrap prod         # Wraps this tab as tmux session "prod"
  boring-daemon list              # Show all tmux sessions
  boring-daemon kill my-console   # Kill the "my-console" session
  boring-daemon kill-all          # Kill all bd-* sessions
`);
}

function tmuxExec(args, opts = {}) {
  return execSync(`tmux ${args}`, { encoding: "utf-8", ...opts }).trim();
}

if (command === "wrap") {
  if (!name) {
    console.error("Error: session name required.\n");
    usage();
    process.exit(1);
  }

  if (process.env.TMUX) {
    console.log(
      `Already inside tmux session. Current session can be used directly.`,
    );
    console.log(
      `Tell Claude to run: session_attach(name="${name}", tmux_session="<current-session-name>")`,
    );
    process.exit(0);
  }

  console.log(`Wrapping this terminal as tmux session: ${name}`);
  console.log(`Claude can now attach with: session_attach(name="${name}")`);
  console.log(
    `To detach later: Ctrl-B then D (or run: boring-daemon unwrap)\n`,
  );

  try {
    execSync(`tmux new-session -s ${JSON.stringify(name)}`, {
      stdio: "inherit",
    });
  } catch {
    // tmux returns non-zero when the session is detached or killed, which is normal
  }
} else if (command === "unwrap") {
  if (!process.env.TMUX) {
    console.log("Not inside a tmux session.");
    process.exit(0);
  }
  execSync("tmux detach-client", { stdio: "inherit" });
} else if (command === "list") {
  try {
    const out = tmuxExec(
      'list-sessions -F "#{session_name}|#{session_created}|#{session_windows}|#{session_attached}|#{pane_current_command}"',
    );
    const sessions = out.split("\n").filter(Boolean);

    if (sessions.length === 0) {
      console.log("No tmux sessions found.");
      process.exit(0);
    }

    console.log(
      "  NAME                 CREATED              WINDOWS  ATTACHED  COMMAND",
    );
    console.log("  " + "-".repeat(75));

    for (const line of sessions) {
      const [sName, created, windows, attached, cmd] = line.split("|");
      const date = new Date(parseInt(created) * 1000).toLocaleString();
      const attachedStr = attached === "1" ? "yes" : "no";
      const prefix = sName.startsWith("bd-") ? "*" : " ";
      console.log(
        `${prefix} ${sName.padEnd(20)} ${date.padEnd(20)} ${windows.padEnd(8)} ${attachedStr.padEnd(9)} ${cmd}`,
      );
    }
    console.log("\n  * = boring-daemon managed (bd-* prefix)");
  } catch {
    console.log("No tmux server running.");
  }
} else if (command === "kill") {
  if (!name) {
    console.error("Error: session name required.\n");
    console.error("Usage: boring-daemon kill <name>");
    console.error("Run `boring-daemon list` to see available sessions.");
    process.exit(1);
  }

  try {
    tmuxExec(`kill-session -t ${JSON.stringify(name)}`);
    console.log(`Session "${name}" killed.`);
  } catch {
    console.error(
      `Session "${name}" not found. Run \`boring-daemon list\` to see available sessions.`,
    );
    process.exit(1);
  }
} else if (command === "kill-all") {
  try {
    const out = tmuxExec('list-sessions -F "#{session_name}"');
    const bdSessions = out.split("\n").filter((s) => s.startsWith("bd-"));

    if (bdSessions.length === 0) {
      console.log("No boring-daemon sessions (bd-*) found.");
      process.exit(0);
    }

    for (const s of bdSessions) {
      try {
        tmuxExec(`kill-session -t ${JSON.stringify(s)}`);
        console.log(`  Killed: ${s}`);
      } catch {
        console.log(`  Failed to kill: ${s}`);
      }
    }
    console.log(`\nKilled ${bdSessions.length} session(s).`);
  } catch {
    console.log("No tmux server running.");
  }
} else {
  usage();
  process.exit(command ? 1 : 0);
}

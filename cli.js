#!/usr/bin/env node

const command = process.argv[2];
const name = process.argv[3];

function usage() {
  console.log(`boring-daemon CLI

Usage:
  boring-daemon wrap <name>    Wrap the current terminal in a named tmux session.
                               After wrapping, Claude can attach to it with:
                               session_attach(name="<name>")

  boring-daemon unwrap         Detach from the tmux session (returns to plain terminal).

Examples:
  boring-daemon wrap prod      # Wraps this tab as tmux session "prod"
  boring-daemon wrap rails-c   # Wraps this tab as tmux session "rails-c"
`);
}

if (command === "wrap") {
  if (!name) {
    console.error("Error: session name required.\n");
    usage();
    process.exit(1);
  }

  // Check if already inside tmux
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

  // Replace the current process with tmux
  const { execSync } = await import("child_process");
  try {
    // Use exec to replace the shell with tmux — this takes over the terminal
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
  const { execSync } = await import("child_process");
  execSync("tmux detach-client", { stdio: "inherit" });
} else {
  usage();
  process.exit(command ? 1 : 0);
}

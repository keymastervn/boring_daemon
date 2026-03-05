import { execFile, execFileSync } from "child_process";
import { mkdirSync, readFileSync, statSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const SESSION_PREFIX = "bd-";
const LOG_DIR = join(homedir(), ".boring_daemon", "logs");

// Shells that indicate the terminal is idle when they appear as pane_current_command
const IDLE_SHELLS = new Set([
  "bash",
  "zsh",
  "fish",
  "sh",
  "dash",
  "ksh",
  "csh",
  "tcsh",
  "ash",
  "login",
  "-bash",
  "-zsh",
  "-fish",
  "-sh",
]);

// Fallback prompt patterns (used when pane_current_command is not a shell,
// e.g. inside a REPL like irb, pry, python, psql)
const DEFAULT_PROMPT_PATTERN =
  "(\\$|#|>|%|❯|➜)\\s*.*$|" + // shell prompts
  "irb.*[>*]\\s*$|" + // ruby irb
  "pry.*[>*]\\s*$|" + // pry
  ">>>\\s*$|" + // python
  "In\\s*\\[\\d+\\]:\\s*$|" + // ipython / jupyter
  "iex.*>\\s*$|" + // elixir
  "mysql>\\s*$|" + // mysql
  "postgres.*[#>]\\s*$"; // postgres

export class SessionManager {
  constructor() {
    // session name -> { tmuxName, promptPattern, logFile, commandOffset }
    this.sessions = new Map();
    mkdirSync(LOG_DIR, { recursive: true });
  }

  _fullName(name) {
    return name.startsWith(SESSION_PREFIX) ? name : SESSION_PREFIX + name;
  }

  _shortName(name) {
    return name.startsWith(SESSION_PREFIX)
      ? name.slice(SESSION_PREFIX.length)
      : name;
  }

  // Resolve the actual tmux session name for a registered session.
  // Attached sessions store their real tmux name; created sessions use bd- prefix.
  _resolve(name) {
    const session = this.sessions.get(name);
    if (session && session.tmuxName) return session.tmuxName;
    return this._fullName(name);
  }

  _exec(args) {
    return new Promise((resolve, reject) => {
      execFile("tmux", args, { timeout: 10000 }, (err, stdout, stderr) => {
        if (err) reject(new Error(stderr || err.message));
        else resolve(stdout);
      });
    });
  }

  _execSync(args) {
    return execFileSync("tmux", args, { timeout: 10000 }).toString();
  }

  _logPath(sessionName) {
    return join(LOG_DIR, `${sessionName}.log`);
  }

  // --- Public API ---

  async list() {
    try {
      const out = await this._exec([
        "list-sessions",
        "-F",
        "#{session_name}|#{session_created}|#{session_windows}|#{session_attached}",
      ]);
      return out
        .trim()
        .split("\n")
        .filter((l) => l.startsWith(SESSION_PREFIX))
        .map((line) => {
          const [name, created, windows, attached] = line.split("|");
          return {
            name: this._shortName(name),
            created: new Date(parseInt(created) * 1000).toISOString(),
            windows: parseInt(windows),
            attached: attached === "1",
          };
        });
    } catch {
      return [];
    }
  }

  async create(name, { command, promptPattern, workingDir } = {}) {
    const tmuxName = this._fullName(name);
    const logFile = this._logPath(tmuxName);

    const args = ["new-session", "-d", "-s", tmuxName, "-x", "200", "-y", "50"];
    if (workingDir) args.push("-c", workingDir);

    await this._exec(args);

    // Start piping output to log file
    await this._exec(["pipe-pane", "-t", tmuxName, `cat >> ${logFile}`]);

    const session = {
      tmuxName,
      promptPattern: promptPattern || DEFAULT_PROMPT_PATTERN,
      logFile,
      commandOffset: 0,
    };
    this.sessions.set(name, session);

    // If a startup command is given, send it and wait for ready
    if (command) {
      await this.sendCommand(name, command);
    }

    return { name, logFile, status: "created" };
  }

  async attach(name, { tmuxSession, promptPattern } = {}) {
    const tmuxName = tmuxSession || name;

    // Verify the tmux session exists
    try {
      await this._exec(["has-session", "-t", tmuxName]);
    } catch {
      throw new Error(
        `tmux session "${tmuxName}" not found. Run: tmux list-sessions`,
      );
    }

    const logFile = this._logPath(tmuxName);

    // Start piping output to log file
    await this._exec(["pipe-pane", "-t", tmuxName, `cat >> ${logFile}`]);

    const session = {
      tmuxName,
      promptPattern: promptPattern || DEFAULT_PROMPT_PATTERN,
      logFile,
      commandOffset: 0,
    };
    this.sessions.set(name, session);

    return { name, tmuxName, logFile, status: "attached" };
  }

  async listAll() {
    try {
      const out = await this._exec([
        "list-sessions",
        "-F",
        "#{session_name}|#{session_created}|#{session_windows}|#{session_attached}",
      ]);
      return out
        .trim()
        .split("\n")
        .filter((l) => l.length > 0)
        .map((line) => {
          const [name, created, windows, attached] = line.split("|");
          const managed =
            this.sessions.has(name) || this.sessions.has(this._shortName(name));
          return {
            name,
            created: new Date(parseInt(created) * 1000).toISOString(),
            windows: parseInt(windows),
            attached: attached === "1",
            managed,
          };
        });
    } catch {
      return [];
    }
  }

  async sendCommand(name, command, enter = true) {
    const fullName = this._resolve(name);
    const session = this.sessions.get(name);

    // Record log offset before command
    if (session) {
      try {
        const stats = statSync(session.logFile);
        session.commandOffset = stats.size;
      } catch {
        session.commandOffset = 0;
      }
    }

    // Use literal mode to avoid tmux key interpretation issues
    // Send the command text, then optionally Enter
    await this._exec(["send-keys", "-t", fullName, "-l", command]);
    if (enter) {
      await this._exec(["send-keys", "-t", fullName, "Enter"]);
    }

    return { sent: true };
  }

  async sendKeys(name, keys) {
    const fullName = this._resolve(name);
    await this._exec(["send-keys", "-t", fullName, keys]);
    return { sent: true };
  }

  async readOutput(name, { lines, sinceLastCommand } = {}) {
    const fullName = this._resolve(name);
    const session = this.sessions.get(name);

    if (sinceLastCommand && session) {
      // Read from log file since the command offset
      try {
        const content = readFileSync(session.logFile, "utf-8");
        const sinceCommand = content.slice(session.commandOffset);
        // Strip ANSI escape codes for cleaner output
        return this._stripAnsi(sinceCommand);
      } catch {
        // Fallback to capture-pane
      }
    }

    // Use capture-pane for current screen
    const args = ["capture-pane", "-t", fullName, "-p"];
    if (lines) {
      args.push("-S", `-${lines}`);
    }
    const output = await this._exec(args);
    return this._stripAnsi(output);
  }

  // Check if the pane's current command indicates an idle shell
  async _isShellIdle(tmuxTarget) {
    try {
      const cmd = await this._exec([
        "display-message",
        "-t",
        tmuxTarget,
        "-p",
        "#{pane_current_command}",
      ]);
      return IDLE_SHELLS.has(cmd.trim());
    } catch {
      return false;
    }
  }

  async waitForReady(name, { timeout = 30, promptPattern } = {}) {
    const session = this.sessions.get(name);
    const pattern = new RegExp(
      promptPattern || session?.promptPattern || DEFAULT_PROMPT_PATTERN,
      "m",
    );

    const fullName = this._resolve(name);
    const startTime = Date.now();
    const timeoutMs = timeout * 1000;

    while (Date.now() - startTime < timeoutMs) {
      // Primary signal: check if the pane is running an idle shell
      // This is far more reliable than regex matching on prompt text.
      const shellIdle = await this._isShellIdle(fullName);

      // Fallback signal: regex match on last line (for REPLs like irb, psql, python)
      let regexMatch = false;
      if (!shellIdle) {
        const screen = await this._exec(["capture-pane", "-t", fullName, "-p"]);
        const trimmed = screen.trimEnd();
        const lastLine = trimmed.split("\n").pop() || "";
        regexMatch = pattern.test(lastLine);
      }

      if (shellIdle || regexMatch) {
        // Terminal is ready — return output since last command
        let output = "";
        if (session) {
          try {
            const content = readFileSync(session.logFile, "utf-8");
            output = content.slice(session.commandOffset);
          } catch {
            const screen = await this._exec([
              "capture-pane",
              "-t",
              fullName,
              "-p",
            ]);
            output = screen.trimEnd();
          }
        } else {
          const screen = await this._exec([
            "capture-pane",
            "-t",
            fullName,
            "-p",
          ]);
          output = screen.trimEnd();
        }
        return {
          ready: true,
          output: this._stripAnsi(output),
          elapsed: Math.round((Date.now() - startTime) / 1000),
        };
      }

      // Poll interval
      await new Promise((r) => setTimeout(r, 500));
    }

    // Timed out — return what we have
    const screen = await this._exec(["capture-pane", "-t", fullName, "-p"]);
    return {
      ready: false,
      output: this._stripAnsi(screen),
      elapsed: timeout,
      error: `Timed out after ${timeout}s waiting for prompt`,
    };
  }

  async close(name) {
    const fullName = this._resolve(name);
    try {
      await this._exec(["kill-session", "-t", fullName]);
    } catch {
      // Session might already be dead
    }
    this.sessions.delete(name);
    return { closed: true };
  }

  _stripAnsi(str) {
    // Remove ANSI escape codes
    return str.replace(
      /\x1b\[[0-9;]*[a-zA-Z]|\x1b\].*?(\x07|\x1b\\)|\x1b[()][AB012]|\x1b\[?[0-9;]*[hHlm]/g,
      "",
    );
  }
}

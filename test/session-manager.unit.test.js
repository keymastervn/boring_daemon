import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

// We test SessionManager's pure logic by mocking _exec and filesystem calls.
// This avoids needing tmux installed for unit tests.

import { SessionManager } from "../session-manager.js";

describe("SessionManager — unit tests", () => {
  let manager;

  beforeEach(() => {
    manager = new SessionManager();
  });

  // --- _fullName / _shortName ---

  describe("_fullName", () => {
    it("prefixes name with bd-", () => {
      assert.equal(manager._fullName("prod"), "bd-prod");
    });

    it("does not double-prefix", () => {
      assert.equal(manager._fullName("bd-prod"), "bd-prod");
    });
  });

  describe("_shortName", () => {
    it("strips bd- prefix", () => {
      assert.equal(manager._shortName("bd-prod"), "prod");
    });

    it("returns name as-is if no prefix", () => {
      assert.equal(manager._shortName("prod"), "prod");
    });
  });

  // --- _resolve ---

  describe("_resolve", () => {
    it("returns tmuxName from session map when registered", () => {
      manager.sessions.set("myalias", { tmuxName: "real-tmux-name" });
      assert.equal(manager._resolve("myalias"), "real-tmux-name");
    });

    it("falls back to _fullName when not registered", () => {
      assert.equal(manager._resolve("unknown"), "bd-unknown");
    });

    it("returns bd- prefixed name for created sessions", async () => {
      manager._exec = mock.fn(async () => "");
      await manager.create("created");
      assert.equal(manager._resolve("created"), "bd-created");
    });
  });

  // --- _logPath ---

  describe("_logPath", () => {
    it("returns path under .boring_daemon/logs", () => {
      const path = manager._logPath("bd-test");
      assert.match(path, /\.boring_daemon\/logs\/bd-test\.log$/);
    });
  });

  // --- _stripAnsi ---

  describe("_stripAnsi", () => {
    it("strips basic color codes", () => {
      assert.equal(manager._stripAnsi("\x1b[32mhello\x1b[0m"), "hello");
    });

    it("strips bold/underline codes", () => {
      assert.equal(manager._stripAnsi("\x1b[1m\x1b[4mtext\x1b[0m"), "text");
    });

    it("strips cursor movement codes", () => {
      assert.equal(manager._stripAnsi("\x1b[2Aup\x1b[3Bdown"), "updown");
    });

    it("strips OSC sequences (title setting)", () => {
      assert.equal(
        manager._stripAnsi("\x1b]0;my title\x07real text"),
        "real text",
      );
    });

    it("handles string with no ANSI codes", () => {
      assert.equal(manager._stripAnsi("plain text"), "plain text");
    });

    it("handles empty string", () => {
      assert.equal(manager._stripAnsi(""), "");
    });

    it("strips multiple interleaved codes", () => {
      const input = "\x1b[31mred\x1b[0m normal \x1b[1;34mblue bold\x1b[0m";
      assert.equal(manager._stripAnsi(input), "red normal blue bold");
    });
  });

  // --- list (mocked) ---

  describe("list", () => {
    it("returns empty array when no tmux sessions", async () => {
      manager._exec = mock.fn(async () => {
        throw new Error("no server running");
      });
      const result = await manager.list();
      assert.deepEqual(result, []);
    });

    it("filters to only bd- prefixed sessions", async () => {
      manager._exec = mock.fn(async () => {
        return [
          "bd-prod|1709640000|1|0",
          "my-other-session|1709640000|1|1",
          "bd-staging|1709641000|2|0",
        ].join("\n");
      });
      const result = await manager.list();
      assert.equal(result.length, 2);
      assert.equal(result[0].name, "prod");
      assert.equal(result[1].name, "staging");
    });

    it("parses session fields correctly", async () => {
      manager._exec = mock.fn(async () => "bd-test|1709640000|3|1\n");
      const result = await manager.list();
      assert.equal(result.length, 1);
      assert.equal(result[0].name, "test");
      assert.equal(result[0].windows, 3);
      assert.equal(result[0].attached, true);
      assert.ok(result[0].created); // ISO string
    });
  });

  // --- create (mocked) ---

  describe("create", () => {
    it("calls tmux new-session with correct args", async () => {
      const calls = [];
      manager._exec = mock.fn(async (args) => {
        calls.push(args);
        return "";
      });

      await manager.create("mytest");

      // First call: new-session
      assert.deepEqual(calls[0], [
        "new-session",
        "-d",
        "-s",
        "bd-mytest",
        "-x",
        "200",
        "-y",
        "50",
      ]);
      // Second call: pipe-pane
      assert.equal(calls[1][0], "pipe-pane");
      assert.equal(calls[1][2], "bd-mytest");
    });

    it("stores session in internal map", async () => {
      manager._exec = mock.fn(async () => "");
      await manager.create("sess1");
      assert.ok(manager.sessions.has("sess1"));
      const sess = manager.sessions.get("sess1");
      assert.equal(sess.commandOffset, 0);
      assert.match(sess.logFile, /bd-sess1\.log$/);
    });

    it("includes workingDir when provided", async () => {
      const calls = [];
      manager._exec = mock.fn(async (args) => {
        calls.push(args);
        return "";
      });

      await manager.create("wd", { workingDir: "/tmp/mydir" });
      assert.ok(calls[0].includes("-c"));
      assert.ok(calls[0].includes("/tmp/mydir"));
    });

    it("sends startup command when provided", async () => {
      const calls = [];
      manager._exec = mock.fn(async (args) => {
        calls.push(args);
        return "";
      });

      await manager.create("cmd", { command: "echo hi" });

      // Should have: new-session, pipe-pane, send-keys (literal), send-keys (Enter)
      const sendKeysCalls = calls.filter((c) => c[0] === "send-keys");
      assert.equal(sendKeysCalls.length, 2);
      assert.ok(sendKeysCalls[0].includes("-l")); // literal mode
      assert.ok(sendKeysCalls[0].includes("echo hi"));
      assert.ok(sendKeysCalls[1].includes("Enter"));
    });

    it("returns expected shape", async () => {
      manager._exec = mock.fn(async () => "");
      const result = await manager.create("shape");
      assert.equal(result.name, "shape");
      assert.equal(result.status, "created");
      assert.match(result.logFile, /bd-shape\.log$/);
    });

    it("uses custom promptPattern when provided", async () => {
      manager._exec = mock.fn(async () => "");
      await manager.create("custom", { promptPattern: "myapp>" });
      const sess = manager.sessions.get("custom");
      assert.equal(sess.promptPattern, "myapp>");
    });
  });

  // --- attach (mocked) ---

  describe("attach", () => {
    it("verifies session exists with has-session", async () => {
      const calls = [];
      manager._exec = mock.fn(async (args) => {
        calls.push(args);
        return "";
      });

      await manager.attach("alias", { tmuxSession: "my-rails-console" });
      assert.deepEqual(calls[0], ["has-session", "-t", "my-rails-console"]);
    });

    it("sets up pipe-pane for logging", async () => {
      const calls = [];
      manager._exec = mock.fn(async (args) => {
        calls.push(args);
        return "";
      });

      await manager.attach("alias", { tmuxSession: "existing" });
      assert.equal(calls[1][0], "pipe-pane");
      assert.equal(calls[1][2], "existing");
    });

    it("stores tmuxName as the real session name (no bd- prefix)", async () => {
      manager._exec = mock.fn(async () => "");
      await manager.attach("myalias", { tmuxSession: "production-rails" });

      const sess = manager.sessions.get("myalias");
      assert.equal(sess.tmuxName, "production-rails");
    });

    it("uses name as tmuxSession when tmuxSession not provided", async () => {
      const calls = [];
      manager._exec = mock.fn(async (args) => {
        calls.push(args);
        return "";
      });

      await manager.attach("my-session");
      assert.deepEqual(calls[0], ["has-session", "-t", "my-session"]);
    });

    it("throws when tmux session does not exist", async () => {
      manager._exec = mock.fn(async (args) => {
        if (args[0] === "has-session") throw new Error("session not found");
        return "";
      });

      await assert.rejects(
        () => manager.attach("bad", { tmuxSession: "nope" }),
        {
          message: /tmux session "nope" not found/,
        },
      );
    });

    it("returns expected shape", async () => {
      manager._exec = mock.fn(async () => "");
      const result = await manager.attach("alias", { tmuxSession: "real" });
      assert.equal(result.name, "alias");
      assert.equal(result.tmuxName, "real");
      assert.equal(result.status, "attached");
      assert.match(result.logFile, /real\.log$/);
    });

    it("uses custom promptPattern", async () => {
      manager._exec = mock.fn(async () => "");
      await manager.attach("r", {
        tmuxSession: "rails",
        promptPattern: "irb>",
      });
      assert.equal(manager.sessions.get("r").promptPattern, "irb>");
    });
  });

  // --- listAll (mocked) ---

  describe("listAll", () => {
    it("returns all sessions including non-bd ones", async () => {
      manager._exec = mock.fn(async () => {
        return [
          "bd-prod|1709640000|1|0",
          "my-rails|1709640000|1|1",
          "user-session|1709641000|2|0",
        ].join("\n");
      });
      const result = await manager.listAll();
      assert.equal(result.length, 3);
      assert.equal(result[0].name, "bd-prod");
      assert.equal(result[1].name, "my-rails");
      assert.equal(result[2].name, "user-session");
    });

    it("marks managed sessions", async () => {
      manager._exec = mock.fn(async () => "");
      await manager.create("prod"); // registers as "prod" → tmuxName "bd-prod"

      manager._exec = mock.fn(async () => {
        return "bd-prod|1709640000|1|0\nother|1709640000|1|0\n";
      });
      const result = await manager.listAll();
      const bdProd = result.find((s) => s.name === "bd-prod");
      const other = result.find((s) => s.name === "other");
      assert.equal(bdProd.managed, true);
      assert.equal(other.managed, false);
    });

    it("returns empty array when no tmux server", async () => {
      manager._exec = mock.fn(async () => {
        throw new Error("no server");
      });
      const result = await manager.listAll();
      assert.deepEqual(result, []);
    });
  });

  // --- operational methods use _resolve for attached sessions ---

  describe("attached session operations", () => {
    beforeEach(async () => {
      manager._exec = mock.fn(async () => "");
      await manager.attach("rails", { tmuxSession: "my-rails-console" });
    });

    it("sendCommand targets real tmux name", async () => {
      const calls = [];
      manager._exec = mock.fn(async (args) => {
        calls.push(args);
        return "";
      });

      await manager.sendCommand("rails", "User.count");
      assert.deepEqual(calls[0], [
        "send-keys",
        "-t",
        "my-rails-console",
        "-l",
        "User.count",
      ]);
    });

    it("readOutput targets real tmux name", async () => {
      const calls = [];
      manager._exec = mock.fn(async (args) => {
        calls.push(args);
        return "output\n";
      });

      await manager.readOutput("rails");
      assert.deepEqual(calls[0], [
        "capture-pane",
        "-t",
        "my-rails-console",
        "-p",
      ]);
    });

    it("sendKeys targets real tmux name", async () => {
      const calls = [];
      manager._exec = mock.fn(async (args) => {
        calls.push(args);
        return "";
      });

      await manager.sendKeys("rails", "C-c");
      assert.deepEqual(calls[0], [
        "send-keys",
        "-t",
        "my-rails-console",
        "C-c",
      ]);
    });

    it("close kills the real tmux session", async () => {
      const calls = [];
      manager._exec = mock.fn(async (args) => {
        calls.push(args);
        return "";
      });

      await manager.close("rails");
      assert.deepEqual(calls[0], ["kill-session", "-t", "my-rails-console"]);
    });
  });

  // --- sendCommand (mocked) ---

  describe("sendCommand", () => {
    beforeEach(async () => {
      manager._exec = mock.fn(async () => "");
      await manager.create("sc");
    });

    it("sends literal keys + Enter by default", async () => {
      const calls = [];
      manager._exec = mock.fn(async (args) => {
        calls.push(args);
        return "";
      });

      await manager.sendCommand("sc", "ls -la");
      assert.equal(calls.length, 2);
      assert.deepEqual(calls[0], ["send-keys", "-t", "bd-sc", "-l", "ls -la"]);
      assert.deepEqual(calls[1], ["send-keys", "-t", "bd-sc", "Enter"]);
    });

    it("skips Enter when enter=false", async () => {
      const calls = [];
      manager._exec = mock.fn(async (args) => {
        calls.push(args);
        return "";
      });

      await manager.sendCommand("sc", "partial", false);
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0], ["send-keys", "-t", "bd-sc", "-l", "partial"]);
    });

    it("returns sent: true", async () => {
      manager._exec = mock.fn(async () => "");
      const result = await manager.sendCommand("sc", "test");
      assert.deepEqual(result, { sent: true });
    });
  });

  // --- sendKeys (mocked) ---

  describe("sendKeys", () => {
    it("sends raw keys without -l flag", async () => {
      const calls = [];
      manager._exec = mock.fn(async (args) => {
        calls.push(args);
        return "";
      });

      // Need a session registered to avoid errors on other paths
      manager.sessions.set("raw", {});
      await manager.sendKeys("raw", "C-c");
      assert.deepEqual(calls[0], ["send-keys", "-t", "bd-raw", "C-c"]);
    });
  });

  // --- readOutput (mocked) ---

  describe("readOutput", () => {
    it("calls capture-pane by default", async () => {
      const calls = [];
      manager._exec = mock.fn(async (args) => {
        calls.push(args);
        return "some output\n";
      });

      const output = await manager.readOutput("x");
      assert.equal(output, "some output\n");
      assert.deepEqual(calls[0], ["capture-pane", "-t", "bd-x", "-p"]);
    });

    it("passes -S flag when lines specified", async () => {
      const calls = [];
      manager._exec = mock.fn(async (args) => {
        calls.push(args);
        return "line\n";
      });

      await manager.readOutput("x", { lines: 10 });
      assert.ok(calls[0].includes("-S"));
      assert.ok(calls[0].includes("-10"));
    });
  });

  // --- _isShellIdle (mocked) ---

  describe("_isShellIdle", () => {
    it("returns true for common shells", async () => {
      for (const shell of [
        "zsh",
        "bash",
        "fish",
        "sh",
        "dash",
        "-zsh",
        "-bash",
        "login",
      ]) {
        manager._exec = mock.fn(async () => shell + "\n");
        assert.equal(
          await manager._isShellIdle("any"),
          true,
          `${shell} should be idle`,
        );
      }
    });

    it("returns false for running commands", async () => {
      for (const cmd of ["sleep", "ruby", "python3", "node", "psql", "ssh"]) {
        manager._exec = mock.fn(async () => cmd + "\n");
        assert.equal(
          await manager._isShellIdle("any"),
          false,
          `${cmd} should not be idle`,
        );
      }
    });

    it("returns false on error", async () => {
      manager._exec = mock.fn(async () => {
        throw new Error("no session");
      });
      assert.equal(await manager._isShellIdle("any"), false);
    });
  });

  // --- waitForReady (mocked) ---

  describe("waitForReady", () => {
    it("returns ready=true immediately when shell is idle (pane_current_command)", async () => {
      manager._exec = mock.fn(async (args) => {
        if (args[0] === "display-message") return "zsh\n";
        if (args[0] === "capture-pane") return "output line\n$ ";
        return "";
      });

      manager.sessions.set("wr", {
        promptPattern: "\\$\\s*$",
        logFile: "/nonexistent",
        commandOffset: 0,
      });

      const result = await manager.waitForReady("wr", { timeout: 2 });
      assert.equal(result.ready, true);
      assert.equal(result.elapsed, 0);
    });

    it("returns ready=true via regex fallback when command is not a shell (REPL)", async () => {
      manager._exec = mock.fn(async (args) => {
        // pane_current_command = ruby (not idle shell)
        if (args[0] === "display-message") return "ruby\n";
        if (args[0] === "capture-pane") return "some output\nirb(main):001:0> ";
        return "";
      });

      const result = await manager.waitForReady("any", { timeout: 2 });
      assert.equal(result.ready, true);
    });

    it("returns ready=true via bracket paste mode signal for custom REPL prompts", async () => {
      manager._exec = mock.fn(async (args) => {
        if (args[0] === "display-message") return "ruby\n";
        if (args[0] === "capture-pane") {
          // -e flag returns raw escape sequences
          if (args.includes("-e")) {
            return "some output\n\x1b[?2004h\x1b[?25lats(staging)> \x1b[?25h";
          }
          return "some output\nats(staging)> ";
        }
        return "";
      });

      const result = await manager.waitForReady("any", { timeout: 2 });
      assert.equal(result.ready, true);
    });

    it("returns ready=false on timeout when command is running and no prompt match", async () => {
      manager._exec = mock.fn(async (args) => {
        if (args[0] === "display-message") return "sleep\n";
        if (args[0] === "capture-pane") return "still running...";
        return "";
      });

      manager.sessions.set("slow", {
        promptPattern: "\\$\\s*$",
        logFile: "/nonexistent",
        commandOffset: 0,
      });

      const result = await manager.waitForReady("slow", { timeout: 1 });
      assert.equal(result.ready, false);
      assert.ok(result.error.includes("Timed out"));
    });

    it("uses custom promptPattern override", async () => {
      manager._exec = mock.fn(async (args) => {
        if (args[0] === "display-message") return "ruby\n";
        if (args[0] === "capture-pane") return "myapp> ";
        return "";
      });

      manager.sessions.set("cp", {
        promptPattern: "\\$\\s*$",
        logFile: "/nonexistent",
        commandOffset: 0,
      });

      const result = await manager.waitForReady("cp", {
        timeout: 2,
        promptPattern: "myapp>",
      });
      assert.equal(result.ready, true);
    });

    it("detects various REPL prompts via regex fallback", async () => {
      const prompts = [
        ">>> ",
        "irb(main):001:0> ",
        "pry(main)> ",
        "[1] pry(main)> ",
        "iex(1)> ",
        "mysql> ",
        "postgres=# ",
        "In [1]: ",
      ];

      for (const prompt of prompts) {
        manager._exec = mock.fn(async (args) => {
          if (args[0] === "display-message") return "ruby\n"; // not a shell
          if (args[0] === "capture-pane") return `some output\n${prompt}`;
          return "";
        });

        const result = await manager.waitForReady("any", { timeout: 1 });
        assert.equal(
          result.ready,
          true,
          `Should detect REPL prompt: "${prompt}"`,
        );
      }
    });
  });

  // --- close (mocked) ---

  describe("close", () => {
    it("calls kill-session", async () => {
      const calls = [];
      manager._exec = mock.fn(async (args) => {
        calls.push(args);
        return "";
      });

      manager.sessions.set("doomed", {});
      await manager.close("doomed");

      assert.deepEqual(calls[0], ["kill-session", "-t", "bd-doomed"]);
      assert.ok(!manager.sessions.has("doomed"));
    });

    it("does not throw if session already dead", async () => {
      manager._exec = mock.fn(async () => {
        throw new Error("session not found");
      });

      manager.sessions.set("ghost", {});
      const result = await manager.close("ghost");
      assert.deepEqual(result, { closed: true });
      assert.ok(!manager.sessions.has("ghost"));
    });
  });
});

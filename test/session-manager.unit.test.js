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

  // --- waitForReady (mocked) ---

  describe("waitForReady", () => {
    it("returns ready=true when prompt detected immediately", async () => {
      manager._exec = mock.fn(async (args) => {
        if (args[0] === "capture-pane") return "output line\n$ ";
        return "";
      });

      // Register a session
      manager.sessions.set("wr", {
        promptPattern: "\\$\\s*$",
        logFile: "/nonexistent",
        commandOffset: 0,
      });

      const result = await manager.waitForReady("wr", { timeout: 2 });
      assert.equal(result.ready, true);
      assert.equal(result.elapsed, 0);
    });

    it("returns ready=false on timeout", async () => {
      manager._exec = mock.fn(async (args) => {
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
        if (args[0] === "capture-pane") return "myapp> ";
        return "";
      });

      manager.sessions.set("cp", {
        promptPattern: "\\$\\s*$", // default won't match
        logFile: "/nonexistent",
        commandOffset: 0,
      });

      // Override with pattern that matches
      const result = await manager.waitForReady("cp", {
        timeout: 2,
        promptPattern: "myapp>",
      });
      assert.equal(result.ready, true);
    });

    it("detects various prompt formats", async () => {
      const prompts = [
        "user@host:~$ ",
        "root@server:/# ",
        ">>> ",
        "irb(main):001:0> ",
        "pry(main)> ",
        "[1] pry(main)> ",
        "iex(1)> ",
        "mysql> ",
        "postgres=# ",
        "➜  project ",
        "❯ ",
      ];

      for (const prompt of prompts) {
        manager._exec = mock.fn(async (args) => {
          if (args[0] === "capture-pane") return `some output\n${prompt}`;
          return "";
        });

        // Use default pattern (no session registered)
        const result = await manager.waitForReady("any", { timeout: 1 });
        assert.equal(result.ready, true, `Should detect prompt: "${prompt}"`);
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

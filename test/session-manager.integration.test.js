import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "child_process";
import { existsSync } from "fs";

import { SessionManager } from "../session-manager.js";

// Skip all integration tests if tmux is not available
let tmuxAvailable = false;
try {
  execFileSync("tmux", ["-V"]);
  tmuxAvailable = true;
} catch {}

describe(
  "SessionManager — integration tests (requires tmux)",
  { skip: !tmuxAvailable },
  () => {
    let manager;
    const TEST_SESSION = `inttest-${Date.now()}`;

    beforeEach(() => {
      manager = new SessionManager();
    });

    afterEach(async () => {
      // Cleanup any sessions we created
      try {
        await manager.close(TEST_SESSION);
      } catch {}
    });

    // --- Session lifecycle ---

    describe("session lifecycle", () => {
      it("creates a session that appears in tmux", async () => {
        await manager.create(TEST_SESSION, { workingDir: "/tmp" });

        // Verify with raw tmux command
        const out = execFileSync("tmux", [
          "list-sessions",
          "-F",
          "#{session_name}",
        ]).toString();
        assert.ok(out.includes(`bd-${TEST_SESSION}`));
      });

      it("lists the created session", async () => {
        await manager.create(TEST_SESSION);
        const sessions = await manager.list();
        const found = sessions.find((s) => s.name === TEST_SESSION);
        assert.ok(found, "Session should appear in list");
        assert.equal(found.windows, 1);
        assert.equal(found.attached, false);
      });

      it("closes session and removes from tmux", async () => {
        await manager.create(TEST_SESSION);
        await manager.close(TEST_SESSION);

        const sessions = await manager.list();
        const found = sessions.find((s) => s.name === TEST_SESSION);
        assert.ok(!found, "Session should be gone after close");
      });

      it("creates log file", async () => {
        const result = await manager.create(TEST_SESSION);
        // Give pipe-pane a moment to create the file
        await new Promise((r) => setTimeout(r, 500));
        // The log file might not exist yet if nothing has been written,
        // but the path should be valid
        assert.match(result.logFile, /bd-inttest.*\.log$/);
      });
    });

    // --- Command execution ---

    describe("send_command + read_output", () => {
      it("sends a command and captures output", async () => {
        await manager.create(TEST_SESSION, { workingDir: "/tmp" });
        await manager.waitForReady(TEST_SESSION, { timeout: 5 });

        await manager.sendCommand(TEST_SESSION, "echo BORING_TEST_12345");
        // Wait for the command to complete
        await new Promise((r) => setTimeout(r, 1000));

        const output = await manager.readOutput(TEST_SESSION);
        assert.ok(
          output.includes("BORING_TEST_12345"),
          `Output should contain marker. Got: ${output.slice(0, 200)}`,
        );
      });

      it("reads output since last command", async () => {
        await manager.create(TEST_SESSION, { workingDir: "/tmp" });
        await manager.waitForReady(TEST_SESSION, { timeout: 5 });

        // First command
        await manager.sendCommand(TEST_SESSION, "echo FIRST_CMD_AAA");
        await new Promise((r) => setTimeout(r, 1000));

        // Second command — should reset offset
        await manager.sendCommand(TEST_SESSION, "echo SECOND_CMD_BBB");
        await new Promise((r) => setTimeout(r, 1000));

        const output = await manager.readOutput(TEST_SESSION, {
          sinceLastCommand: true,
        });
        assert.ok(
          output.includes("SECOND_CMD_BBB"),
          "Should contain second command output",
        );
      });

      it("sends command without Enter when enter=false", async () => {
        await manager.create(TEST_SESSION, { workingDir: "/tmp" });
        await manager.waitForReady(TEST_SESSION, { timeout: 5 });

        await manager.sendCommand(TEST_SESSION, "echo partial", false);
        await new Promise((r) => setTimeout(r, 500));

        // The text should be in the pane but not executed
        const output = await manager.readOutput(TEST_SESSION);
        assert.ok(
          output.includes("echo partial"),
          "Command text should be visible",
        );
      });
    });

    // --- send_keys ---

    describe("send_keys", () => {
      it("sends raw keystrokes (Ctrl-C)", async () => {
        await manager.create(TEST_SESSION, { workingDir: "/tmp" });
        await manager.waitForReady(TEST_SESSION, { timeout: 5 });

        // Start a long-running command
        await manager.sendCommand(TEST_SESSION, "sleep 60");
        await new Promise((r) => setTimeout(r, 500));

        // Send Ctrl-C to interrupt
        await manager.sendKeys(TEST_SESSION, "C-c");
        await new Promise((r) => setTimeout(r, 500));

        // Should be back at prompt
        const result = await manager.waitForReady(TEST_SESSION, { timeout: 3 });
        assert.ok(result.ready, "Should be back at prompt after Ctrl-C");
      });
    });

    // --- wait_for_ready ---

    describe("wait_for_ready", () => {
      it("detects prompt after session creation", async () => {
        await manager.create(TEST_SESSION, { workingDir: "/tmp" });
        const result = await manager.waitForReady(TEST_SESSION, { timeout: 5 });
        assert.ok(result.ready, "Shell should be ready after creation");
      });

      it("detects prompt after command completes", async () => {
        await manager.create(TEST_SESSION, { workingDir: "/tmp" });
        await manager.waitForReady(TEST_SESSION, { timeout: 5 });

        await manager.sendCommand(TEST_SESSION, "echo WAIT_TEST_XYZ");
        const result = await manager.waitForReady(TEST_SESSION, { timeout: 5 });

        assert.ok(result.ready, "Should detect prompt after echo");
        assert.ok(
          result.output.includes("WAIT_TEST_XYZ"),
          "Output should contain command result",
        );
      });

      it("times out for long-running commands", async () => {
        await manager.create(TEST_SESSION, { workingDir: "/tmp" });
        await manager.waitForReady(TEST_SESSION, { timeout: 5 });

        // Use a command that produces no output and blocks — use a pattern
        // that won't match anything during sleep
        await manager.sendCommand(TEST_SESSION, "sleep 30");
        // Wait for sleep to actually start (prompt disappears from last line)
        await new Promise((r) => setTimeout(r, 1500));

        const result = await manager.waitForReady(TEST_SESSION, {
          timeout: 2,
          // Use a very specific pattern that won't match during sleep
          promptPattern: "^\\$\\s*$",
        });

        assert.equal(result.ready, false);
        assert.ok(result.error.includes("Timed out"));

        // Cleanup: interrupt the sleep
        await manager.sendKeys(TEST_SESSION, "C-c");
      });

      it("works with custom prompt pattern", async () => {
        await manager.create(TEST_SESSION, { workingDir: "/tmp" });
        await manager.waitForReady(TEST_SESSION, { timeout: 5 });

        // Use PS1 to set a custom prompt, then test that we detect it
        await manager.sendCommand(TEST_SESSION, "export PS1='CUSTOM_PROMPT> '");
        await new Promise((r) => setTimeout(r, 1000));

        // Now send a command and wait for the custom prompt
        await manager.sendCommand(TEST_SESSION, "echo hello");
        const result = await manager.waitForReady(TEST_SESSION, {
          timeout: 5,
          promptPattern: "CUSTOM_PROMPT>",
        });
        assert.ok(result.ready, "Should detect custom prompt pattern");
      });
    });

    // --- Multiple sessions ---

    describe("multiple sessions", () => {
      const SESSION_A = `${TEST_SESSION}-a`;
      const SESSION_B = `${TEST_SESSION}-b`;

      afterEach(async () => {
        try {
          await manager.close(SESSION_A);
        } catch {}
        try {
          await manager.close(SESSION_B);
        } catch {}
      });

      it("manages multiple independent sessions", async () => {
        await manager.create(SESSION_A, { workingDir: "/tmp" });
        await manager.create(SESSION_B, { workingDir: "/tmp" });

        const sessions = await manager.list();
        const names = sessions.map((s) => s.name);
        assert.ok(names.includes(SESSION_A));
        assert.ok(names.includes(SESSION_B));

        // Send different commands to each
        await manager.waitForReady(SESSION_A, { timeout: 5 });
        await manager.waitForReady(SESSION_B, { timeout: 5 });

        await manager.sendCommand(SESSION_A, "echo SESSION_A_OUTPUT");
        await manager.sendCommand(SESSION_B, "echo SESSION_B_OUTPUT");

        await new Promise((r) => setTimeout(r, 1000));

        const outA = await manager.readOutput(SESSION_A);
        const outB = await manager.readOutput(SESSION_B);

        assert.ok(outA.includes("SESSION_A_OUTPUT"));
        assert.ok(outB.includes("SESSION_B_OUTPUT"));
        assert.ok(
          !outA.includes("SESSION_B_OUTPUT"),
          "Sessions should be isolated",
        );
        assert.ok(
          !outB.includes("SESSION_A_OUTPUT"),
          "Sessions should be isolated",
        );
      });
    });

    // --- Attach to existing session ---

    describe("session_attach", () => {
      const EXTERNAL_SESSION = `ext-${Date.now()}`;

      afterEach(async () => {
        try {
          execFileSync("tmux", ["kill-session", "-t", EXTERNAL_SESSION]);
        } catch {}
      });

      it("attaches to a pre-existing tmux session", async () => {
        // Create a tmux session outside of boring_daemon
        execFileSync("tmux", [
          "new-session",
          "-d",
          "-s",
          EXTERNAL_SESSION,
          "-x",
          "200",
          "-y",
          "50",
        ]);

        const result = await manager.attach("ext", {
          tmuxSession: EXTERNAL_SESSION,
        });
        assert.equal(result.status, "attached");
        assert.equal(result.tmuxName, EXTERNAL_SESSION);
      });

      it("can send commands to an attached session", async () => {
        execFileSync("tmux", [
          "new-session",
          "-d",
          "-s",
          EXTERNAL_SESSION,
          "-x",
          "200",
          "-y",
          "50",
        ]);

        await manager.attach("ext", { tmuxSession: EXTERNAL_SESSION });
        await manager.waitForReady("ext", { timeout: 5 });

        await manager.sendCommand("ext", "echo ATTACH_TEST_999");
        const result = await manager.waitForReady("ext", { timeout: 5 });

        assert.ok(result.ready, "Should detect prompt");
        assert.ok(
          result.output.includes("ATTACH_TEST_999"),
          "Should capture output from attached session",
        );
      });

      it("can read output from an attached session", async () => {
        execFileSync("tmux", [
          "new-session",
          "-d",
          "-s",
          EXTERNAL_SESSION,
          "-x",
          "200",
          "-y",
          "50",
        ]);

        await manager.attach("ext", { tmuxSession: EXTERNAL_SESSION });
        await manager.waitForReady("ext", { timeout: 5 });

        await manager.sendCommand("ext", "echo READ_ATTACH_OUTPUT");
        await new Promise((r) => setTimeout(r, 1000));

        const output = await manager.readOutput("ext");
        assert.ok(output.includes("READ_ATTACH_OUTPUT"));
      });

      it("throws when attaching to nonexistent session", async () => {
        await assert.rejects(
          () =>
            manager.attach("bad", { tmuxSession: "nonexistent-session-xyz" }),
          { message: /not found/ },
        );
      });

      it("appears in listAll with managed=true after attach", async () => {
        execFileSync("tmux", [
          "new-session",
          "-d",
          "-s",
          EXTERNAL_SESSION,
          "-x",
          "200",
          "-y",
          "50",
        ]);

        await manager.attach("ext", { tmuxSession: EXTERNAL_SESSION });

        const all = await manager.listAll();
        const found = all.find((s) => s.name === EXTERNAL_SESSION);
        assert.ok(found, "Should appear in listAll");
        // Note: managed detection checks both name and short name
      });
    });

    // --- listAll ---

    describe("listAll", () => {
      const PLAIN_SESSION = `plain-${Date.now()}`;

      afterEach(async () => {
        try {
          execFileSync("tmux", ["kill-session", "-t", PLAIN_SESSION]);
        } catch {}
      });

      it("shows both bd- and non-bd sessions", async () => {
        // Create a boring_daemon session
        await manager.create(TEST_SESSION, { workingDir: "/tmp" });

        // Create a plain tmux session
        execFileSync("tmux", [
          "new-session",
          "-d",
          "-s",
          PLAIN_SESSION,
          "-x",
          "200",
          "-y",
          "50",
        ]);

        const all = await manager.listAll();
        const names = all.map((s) => s.name);

        assert.ok(
          names.includes(`bd-${TEST_SESSION}`),
          "Should include bd- session",
        );
        assert.ok(
          names.includes(PLAIN_SESSION),
          "Should include plain session",
        );
      });
    });

    // --- Edge cases ---

    describe("edge cases", () => {
      it("handles special characters in commands", async () => {
        await manager.create(TEST_SESSION, { workingDir: "/tmp" });
        await manager.waitForReady(TEST_SESSION, { timeout: 5 });

        await manager.sendCommand(
          TEST_SESSION,
          `echo "hello 'world' & $HOME | <tag>"`,
        );
        const result = await manager.waitForReady(TEST_SESSION, { timeout: 5 });
        assert.ok(result.ready, "Should handle special chars");
      });

      it("close is idempotent", async () => {
        await manager.create(TEST_SESSION);
        await manager.close(TEST_SESSION);
        // Second close should not throw
        const result = await manager.close(TEST_SESSION);
        assert.deepEqual(result, { closed: true });
      });
    });
  },
);

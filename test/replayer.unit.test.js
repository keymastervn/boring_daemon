import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { replay } from "../replayer.js";

// --- helpers ---

const HEADER = {
  type: "header",
  schema_version: "1.0",
  session: "test",
  start: "2026-04-22T16:20:00.000Z",
  recorder: "boring-daemon",
};
const FOOTER = {
  type: "footer",
  end: "2026-04-22T16:25:00.000Z",
  total_events: 0,
  session: "test",
};

function writeTempFile(events) {
  const path = join(
    tmpdir(),
    `bd-replay-unit-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`,
  );
  writeFileSync(
    path,
    events.map((e) => JSON.stringify(e)).join("\n") + "\n",
    "utf8",
  );
  return path;
}

function mockManager(overrides = {}) {
  return {
    create: async () => ({}),
    attach: async () => ({}),
    sendCommand: async () => {},
    sendKeys: async () => {},
    readOutput: async () => "output",
    waitForReady: async () => ({ ready: true, elapsed: 0.5, output: "$ " }),
    close: async () => {},
    ...overrides,
  };
}

describe("replayer — unit tests", () => {
  const tempFiles = [];

  afterEach(() => {
    for (const f of tempFiles) {
      try {
        unlinkSync(f);
      } catch {}
    }
    tempFiles.length = 0;
  });

  // --- file validation ---

  describe("file validation", () => {
    it("throws on empty file", async () => {
      const path = join(tmpdir(), `bd-empty-${Date.now()}.jsonl`);
      writeFileSync(path, "", "utf8");
      tempFiles.push(path);
      await assert.rejects(
        () => replay(path, mockManager()),
        /Empty recording file/,
      );
    });

    it("throws if first line is not a header", async () => {
      const path = writeTempFile([{ type: "send_command" }]);
      tempFiles.push(path);
      await assert.rejects(() => replay(path, mockManager()), /missing header/);
    });

    it("throws on malformed JSON in an event line", async () => {
      const path = join(tmpdir(), `bd-badjson-${Date.now()}.jsonl`);
      writeFileSync(
        path,
        JSON.stringify(HEADER) + "\nnot-valid-json\n",
        "utf8",
      );
      tempFiles.push(path);
      await assert.rejects(() => replay(path, mockManager()), /Invalid JSON/);
    });
  });

  // --- event routing (auto mode) ---

  describe("event routing — auto mode", () => {
    it("calls manager.create for session_create", async () => {
      let called = false;
      const path = writeTempFile([
        HEADER,
        {
          type: "session_create",
          idx: 1,
          ts: "2026-04-22T16:20:01Z",
          session: "s",
          params: { command: "bash", working_dir: "/tmp" },
        },
        FOOTER,
      ]);
      tempFiles.push(path);
      await replay(
        path,
        mockManager({
          create: async (name, opts) => {
            called = true;
            assert.equal(name, "s");
            assert.equal(opts.command, "bash");
            assert.equal(opts.workingDir, "/tmp");
            return {};
          },
        }),
      );
      assert.ok(called);
    });

    it("calls manager.attach for session_attach", async () => {
      let called = false;
      const path = writeTempFile([
        HEADER,
        {
          type: "session_attach",
          idx: 1,
          ts: "2026-04-22T16:20:01Z",
          session: "s",
          params: { tmux_session: "real-session", prompt_pattern: "\\$" },
        },
        FOOTER,
      ]);
      tempFiles.push(path);
      await replay(
        path,
        mockManager({
          attach: async (name, opts) => {
            called = true;
            assert.equal(name, "s");
            assert.equal(opts.tmuxSession, "real-session");
            assert.equal(opts.promptPattern, "\\$");
            return {};
          },
        }),
      );
      assert.ok(called);
    });

    it("calls manager.sendCommand with correct session, command, enter", async () => {
      let captured;
      const path = writeTempFile([
        HEADER,
        {
          type: "send_command",
          idx: 1,
          ts: "2026-04-22T16:20:01Z",
          session: "mydb",
          params: { command: "select 1", enter: true },
        },
        FOOTER,
      ]);
      tempFiles.push(path);
      await replay(
        path,
        mockManager({
          sendCommand: async (session, command, enter) => {
            captured = { session, command, enter };
          },
        }),
      );
      assert.deepEqual(captured, {
        session: "mydb",
        command: "select 1",
        enter: true,
      });
    });

    it("defaults enter to true when absent from params", async () => {
      let capturedEnter;
      const path = writeTempFile([
        HEADER,
        {
          type: "send_command",
          idx: 1,
          ts: "2026-04-22T16:20:01Z",
          session: "s",
          params: { command: "ls" },
        },
        FOOTER,
      ]);
      tempFiles.push(path);
      await replay(
        path,
        mockManager({
          sendCommand: async (_, __, enter) => {
            capturedEnter = enter;
          },
        }),
      );
      assert.equal(capturedEnter, true);
    });

    it("calls manager.sendKeys with correct keys", async () => {
      let capturedKeys;
      const path = writeTempFile([
        HEADER,
        {
          type: "send_keys",
          idx: 1,
          ts: "2026-04-22T16:20:01Z",
          session: "s",
          params: { keys: "C-c" },
        },
        FOOTER,
      ]);
      tempFiles.push(path);
      await replay(
        path,
        mockManager({
          sendKeys: async (_, keys) => {
            capturedKeys = keys;
          },
        }),
      );
      assert.equal(capturedKeys, "C-c");
    });

    it("calls manager.waitForReady and surfaces ready/elapsed/output in log", async () => {
      const path = writeTempFile([
        HEADER,
        {
          type: "wait_for_ready",
          idx: 1,
          ts: "2026-04-22T16:20:01Z",
          session: "s",
          params: { timeout: 60 },
        },
        FOOTER,
      ]);
      tempFiles.push(path);
      const { log } = await replay(
        path,
        mockManager({
          waitForReady: async () => ({
            ready: true,
            elapsed: 2.3,
            output: "done $",
          }),
        }),
      );
      const entry = log.find((e) => e.type === "wait_for_ready");
      assert.equal(entry.status, "ok");
      assert.equal(entry.ready, true);
      assert.equal(entry.elapsed, 2.3);
      assert.equal(entry.output, "done $");
    });

    it("calls manager.readOutput and surfaces output in log", async () => {
      const path = writeTempFile([
        HEADER,
        {
          type: "read_output",
          idx: 1,
          ts: "2026-04-22T16:20:01Z",
          session: "s",
          params: { since_last_command: true, lines: 20 },
        },
        FOOTER,
      ]);
      tempFiles.push(path);
      const { log } = await replay(
        path,
        mockManager({ readOutput: async () => "5000 rows" }),
      );
      const entry = log.find((e) => e.type === "read_output");
      assert.equal(entry.status, "ok");
      assert.equal(entry.output, "5000 rows");
    });

    it("passes since_last_command and lines to readOutput correctly", async () => {
      let capturedOpts;
      const path = writeTempFile([
        HEADER,
        {
          type: "read_output",
          idx: 1,
          ts: "...",
          session: "s",
          params: { since_last_command: true, lines: 50 },
        },
        FOOTER,
      ]);
      tempFiles.push(path);
      await replay(
        path,
        mockManager({
          readOutput: async (_, opts) => {
            capturedOpts = opts;
            return "";
          },
        }),
      );
      assert.equal(capturedOpts.sinceLastCommand, true);
      assert.equal(capturedOpts.lines, 50);
    });

    it("calls manager.close for session_close", async () => {
      let closed = false;
      const path = writeTempFile([
        HEADER,
        {
          type: "session_close",
          idx: 1,
          ts: "2026-04-22T16:20:01Z",
          session: "s",
        },
        FOOTER,
      ]);
      tempFiles.push(path);
      await replay(
        path,
        mockManager({
          close: async () => {
            closed = true;
          },
        }),
      );
      assert.ok(closed);
    });

    it("skips LLM_TURN events in auto mode", async () => {
      const path = writeTempFile([
        HEADER,
        {
          type: "LLM_TURN",
          idx: 1,
          ts: "...",
          model: "claude",
          prompt: "do something",
        },
        FOOTER,
      ]);
      tempFiles.push(path);
      const { log } = await replay(path, mockManager(), { mode: "auto" });
      const entry = log.find((e) => e.type === "LLM_TURN");
      assert.equal(entry.status, "skipped");
    });

    it("skips unknown event types gracefully", async () => {
      const path = writeTempFile([
        HEADER,
        { type: "FUTURE_EVENT_TYPE", idx: 1, ts: "..." },
        FOOTER,
      ]);
      tempFiles.push(path);
      const { log } = await replay(path, mockManager());
      assert.equal(log[0].status, "skipped");
      assert.match(log[0].reason, /unknown event type/);
    });

    it("excludes footer lines from the event log", async () => {
      const path = writeTempFile([
        HEADER,
        {
          type: "send_command",
          idx: 1,
          ts: "...",
          session: "s",
          params: { command: "ls" },
        },
        FOOTER,
      ]);
      tempFiles.push(path);
      const { log } = await replay(path, mockManager());
      assert.ok(log.every((e) => e.type !== "footer"));
    });

    it("executes events in idx order and log preserves that order", async () => {
      const calls = [];
      const path = writeTempFile([
        HEADER,
        {
          type: "send_command",
          idx: 1,
          ts: "...",
          session: "s",
          params: { command: "first" },
        },
        {
          type: "send_command",
          idx: 2,
          ts: "...",
          session: "s",
          params: { command: "second" },
        },
        {
          type: "send_keys",
          idx: 3,
          ts: "...",
          session: "s",
          params: { keys: "Enter" },
        },
        FOOTER,
      ]);
      tempFiles.push(path);
      await replay(
        path,
        mockManager({
          sendCommand: async (_, cmd) => calls.push(cmd),
          sendKeys: async (_, k) => calls.push(k),
        }),
      );
      assert.deepEqual(calls, ["first", "second", "Enter"]);
    });
  });

  // --- hybrid mode ---

  describe("hybrid mode", () => {
    it("surfaces LLM_TURN with status=llm_turn, prompt, and hint", async () => {
      const path = writeTempFile([
        HEADER,
        {
          type: "LLM_TURN",
          idx: 1,
          ts: "...",
          model: "claude-sonnet-4-6",
          prompt: "count active users",
        },
        FOOTER,
      ]);
      tempFiles.push(path);
      const { log } = await replay(path, mockManager(), { mode: "hybrid" });
      const entry = log.find((e) => e.type === "LLM_TURN");
      assert.equal(entry.status, "llm_turn");
      assert.equal(entry.prompt, "count active users");
      assert.ok(entry.hint, "must include a hint string");
    });

    it("still executes tool events before and after LLM_TURN in hybrid mode", async () => {
      const calls = [];
      const path = writeTempFile([
        HEADER,
        {
          type: "send_command",
          idx: 1,
          ts: "...",
          session: "s",
          params: { command: "before" },
        },
        { type: "LLM_TURN", idx: 2, ts: "...", prompt: "review and continue" },
        {
          type: "send_command",
          idx: 3,
          ts: "...",
          session: "s",
          params: { command: "after" },
        },
        FOOTER,
      ]);
      tempFiles.push(path);
      await replay(
        path,
        mockManager({ sendCommand: async (_, cmd) => calls.push(cmd) }),
        { mode: "hybrid" },
      );
      assert.deepEqual(calls, ["before", "after"]);
    });
  });

  // --- error handling ---

  describe("error handling", () => {
    it("throws with descriptive message including idx and type on failure", async () => {
      const path = writeTempFile([
        HEADER,
        {
          type: "send_command",
          idx: 3,
          ts: "...",
          session: "s",
          params: { command: "fail" },
        },
        FOOTER,
      ]);
      tempFiles.push(path);
      await assert.rejects(
        () =>
          replay(
            path,
            mockManager({
              sendCommand: async () => {
                throw new Error("session not found");
              },
            }),
          ),
        /idx=3.*send_command.*session not found/,
      );
    });

    it("aborts on first failure — does not execute subsequent events", async () => {
      const calls = [];
      const path = writeTempFile([
        HEADER,
        {
          type: "send_command",
          idx: 1,
          ts: "...",
          session: "s",
          params: { command: "ok" },
        },
        {
          type: "send_command",
          idx: 2,
          ts: "...",
          session: "s",
          params: { command: "fail" },
        },
        {
          type: "send_command",
          idx: 3,
          ts: "...",
          session: "s",
          params: { command: "never" },
        },
        FOOTER,
      ]);
      tempFiles.push(path);
      await assert.rejects(() =>
        replay(
          path,
          mockManager({
            sendCommand: async (_, cmd) => {
              if (cmd === "fail") throw new Error("boom");
              calls.push(cmd);
            },
          }),
        ),
      );
      assert.deepEqual(calls, ["ok"]);
    });
  });

  // --- return value ---

  describe("return value", () => {
    it("returns the header object verbatim", async () => {
      const path = writeTempFile([HEADER, FOOTER]);
      tempFiles.push(path);
      const { header } = await replay(path, mockManager());
      assert.deepEqual(header, HEADER);
    });

    it("returns mode in the result", async () => {
      const path = writeTempFile([HEADER, FOOTER]);
      tempFiles.push(path);
      const result = await replay(path, mockManager(), { mode: "hybrid" });
      assert.equal(result.mode, "hybrid");
    });

    it("each log entry has idx, type, and status fields", async () => {
      const path = writeTempFile([
        HEADER,
        {
          type: "send_command",
          idx: 1,
          ts: "...",
          session: "s",
          params: { command: "ls" },
        },
        FOOTER,
      ]);
      tempFiles.push(path);
      const { log } = await replay(path, mockManager());
      assert.equal(log.length, 1);
      assert.ok("idx" in log[0], "must have idx");
      assert.ok("type" in log[0], "must have type");
      assert.ok("status" in log[0], "must have status");
    });

    it("returns an empty log for a recording with no events", async () => {
      const path = writeTempFile([HEADER, FOOTER]);
      tempFiles.push(path);
      const { log } = await replay(path, mockManager());
      assert.deepEqual(log, []);
    });
  });
});

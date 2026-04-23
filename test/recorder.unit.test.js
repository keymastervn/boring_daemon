import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, unlinkSync } from "fs";

import { Recorder } from "../recorder.js";

// All recordings land in ~/.boring_daemon/record_logs/; we track and clean them up.
describe("Recorder — unit tests", () => {
  let rec;
  const createdFiles = [];

  beforeEach(() => {
    rec = new Recorder();
  });

  afterEach(() => {
    if (rec.isRecording()) {
      try {
        rec.stop();
      } catch {}
    }
    for (const f of createdFiles) {
      try {
        unlinkSync(f);
      } catch {}
    }
    createdFiles.length = 0;
  });

  // --- initial state ---

  describe("initial state", () => {
    it("isRecording() is false", () => {
      assert.equal(rec.isRecording(), false);
    });

    it("getFilePath() is null", () => {
      assert.equal(rec.getFilePath(), null);
    });

    it("getSession() is null", () => {
      assert.equal(rec.getSession(), null);
    });
  });

  // --- start() ---

  describe("start()", () => {
    it("returns a .jsonl file path containing the session name", () => {
      const path = rec.start("my-session");
      createdFiles.push(path);
      assert.ok(path.endsWith(".jsonl"), "must end with .jsonl");
      assert.ok(path.includes("my-session"), "must contain session name");
    });

    it("creates the file immediately", () => {
      const path = rec.start("exist-check");
      createdFiles.push(path);
      assert.ok(existsSync(path));
    });

    it("writes a valid header as the first JSONL line", () => {
      const path = rec.start("header-check");
      createdFiles.push(path);
      const header = JSON.parse(
        readFileSync(path, "utf8").trim().split("\n")[0],
      );
      assert.equal(header.type, "header");
      assert.equal(header.schema_version, "1.0");
      assert.equal(header.session, "header-check");
      assert.equal(header.recorder, "boring-daemon");
      assert.ok(header.start, "must include start timestamp");
    });

    it("includes description in header when provided", () => {
      const path = rec.start("desc-test", { description: "my workflow" });
      createdFiles.push(path);
      const header = JSON.parse(
        readFileSync(path, "utf8").trim().split("\n")[0],
      );
      assert.equal(header.description, "my workflow");
    });

    it("omits description field when not provided", () => {
      const path = rec.start("nodesc-test");
      createdFiles.push(path);
      const header = JSON.parse(
        readFileSync(path, "utf8").trim().split("\n")[0],
      );
      assert.equal("description" in header, false);
    });

    it("sets isRecording() to true", () => {
      const path = rec.start("active");
      createdFiles.push(path);
      assert.equal(rec.isRecording(), true);
    });

    it("sets getSession() to the session name", () => {
      const path = rec.start("session-name");
      createdFiles.push(path);
      assert.equal(rec.getSession(), "session-name");
    });

    it("sets getFilePath() to the created file", () => {
      const path = rec.start("filepath-test");
      createdFiles.push(path);
      assert.equal(rec.getFilePath(), path);
    });

    it("throws if already recording", () => {
      const path = rec.start("first");
      createdFiles.push(path);
      assert.throws(() => rec.start("second"), /Already recording/);
    });
  });

  // --- append() ---

  describe("append()", () => {
    it("silently no-ops when not recording", () => {
      assert.doesNotThrow(() =>
        rec.append({
          type: "send_command",
          session: "x",
          params: { command: "ls" },
        }),
      );
    });

    it("appends a line with auto-assigned idx=1 for the first event", () => {
      const path = rec.start("append-idx");
      createdFiles.push(path);
      rec.append({
        type: "send_command",
        session: "s",
        params: { command: "echo" },
      });
      const lines = readFileSync(path, "utf8").trim().split("\n");
      const event = JSON.parse(lines[1]);
      assert.equal(event.idx, 1);
    });

    it("increments idx sequentially across multiple appends", () => {
      const path = rec.start("seq-test");
      createdFiles.push(path);
      rec.append({ type: "send_command", session: "s", params: {} });
      rec.append({ type: "send_keys", session: "s", params: {} });
      rec.append({ type: "wait_for_ready", session: "s", params: {} });
      const lines = readFileSync(path, "utf8").trim().split("\n");
      const idxs = lines.slice(1).map((l) => JSON.parse(l).idx);
      assert.deepEqual(idxs, [1, 2, 3]);
    });

    it("includes a ts (ISO timestamp) on each event", () => {
      const path = rec.start("ts-test");
      createdFiles.push(path);
      rec.append({ type: "send_command", session: "s", params: {} });
      const event = JSON.parse(
        readFileSync(path, "utf8").trim().split("\n")[1],
      );
      assert.ok(event.ts, "must have ts field");
      assert.ok(!isNaN(Date.parse(event.ts)), "ts must be a valid ISO date");
    });

    it("spreads all fields from the event object into the recorded line", () => {
      const path = rec.start("spread-test");
      createdFiles.push(path);
      rec.append({
        type: "LLM_TURN",
        model: "claude-sonnet-4-6",
        prompt: "count users",
        response: "I'll query users",
      });
      const event = JSON.parse(
        readFileSync(path, "utf8").trim().split("\n")[1],
      );
      assert.equal(event.type, "LLM_TURN");
      assert.equal(event.model, "claude-sonnet-4-6");
      assert.equal(event.prompt, "count users");
      assert.equal(event.response, "I'll query users");
    });

    it("preserves nested params and result objects", () => {
      const path = rec.start("nested-test");
      createdFiles.push(path);
      rec.append({
        type: "wait_for_ready",
        session: "s",
        params: { timeout: 60, prompt_pattern: "\\$" },
        result: { ready: true, elapsed: 1.5 },
      });
      const event = JSON.parse(
        readFileSync(path, "utf8").trim().split("\n")[1],
      );
      assert.deepEqual(event.params, { timeout: 60, prompt_pattern: "\\$" });
      assert.deepEqual(event.result, { ready: true, elapsed: 1.5 });
    });
  });

  // --- stop() ---

  describe("stop()", () => {
    it("throws if not recording", () => {
      assert.throws(() => rec.stop(), /No active recording/);
    });

    it("returns filePath, totalEvents, session", () => {
      const path = rec.start("stop-result");
      createdFiles.push(path);
      rec.append({ type: "send_command", session: "s", params: {} });
      rec.append({ type: "send_keys", session: "s", params: {} });
      const result = rec.stop();
      assert.equal(result.filePath, path);
      assert.equal(result.totalEvents, 2);
      assert.equal(result.session, "stop-result");
    });

    it("writes a footer as the last JSONL line", () => {
      const path = rec.start("footer-test");
      createdFiles.push(path);
      rec.append({ type: "send_command", session: "s", params: {} });
      rec.stop();
      const lines = readFileSync(path, "utf8").trim().split("\n");
      const footer = JSON.parse(lines[lines.length - 1]);
      assert.equal(footer.type, "footer");
      assert.equal(footer.session, "footer-test");
      assert.equal(footer.total_events, 1);
      assert.ok(footer.end, "must include end timestamp");
    });

    it("sets isRecording() to false after stop", () => {
      const path = rec.start("reset-test");
      createdFiles.push(path);
      rec.stop();
      assert.equal(rec.isRecording(), false);
    });

    it("resets getFilePath() and getSession() to null after stop", () => {
      const path = rec.start("null-after-stop");
      createdFiles.push(path);
      rec.stop();
      assert.equal(rec.getFilePath(), null);
      assert.equal(rec.getSession(), null);
    });

    it("allows start() again after stop() — idempotent cycle", () => {
      const path1 = rec.start("cycle-1");
      createdFiles.push(path1);
      rec.stop();
      const path2 = rec.start("cycle-2");
      createdFiles.push(path2);
      assert.equal(rec.isRecording(), true);
      assert.equal(rec.getSession(), "cycle-2");
      const { totalEvents } = rec.stop();
      assert.equal(totalEvents, 0);
    });
  });

  // --- full lifecycle ---

  describe("full lifecycle", () => {
    it("produces a well-formed JSONL file: header → events → footer", () => {
      const path = rec.start("lifecycle", { description: "e2e test" });
      createdFiles.push(path);
      rec.append({
        type: "session_create",
        session: "s",
        params: { command: "bash" },
      });
      rec.append({
        type: "send_command",
        session: "s",
        params: { command: "echo hi", enter: true },
      });
      rec.append({ type: "LLM_TURN", model: "claude", prompt: "do it" });
      rec.append({
        type: "wait_for_ready",
        session: "s",
        params: { timeout: 30 },
        result: { ready: true, elapsed: 0.5 },
      });
      rec.append({ type: "session_close", session: "s" });
      const { totalEvents } = rec.stop();

      assert.equal(totalEvents, 5);

      const lines = readFileSync(path, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));

      assert.equal(lines[0].type, "header");
      assert.equal(lines[1].type, "session_create");
      assert.equal(lines[2].type, "send_command");
      assert.equal(lines[3].type, "LLM_TURN");
      assert.equal(lines[4].type, "wait_for_ready");
      assert.equal(lines[5].type, "session_close");
      assert.equal(lines[6].type, "footer");
      assert.equal(lines[6].total_events, 5);
    });

    it("every event line is valid JSON", () => {
      const path = rec.start("valid-json");
      createdFiles.push(path);
      rec.append({
        type: "send_command",
        session: "s",
        params: { command: 'echo "hello world"', enter: true },
      });
      rec.append({ type: "LLM_TURN", prompt: 'say "hello"' });
      rec.stop();
      const lines = readFileSync(path, "utf8").trim().split("\n");
      assert.doesNotThrow(() => lines.forEach((l) => JSON.parse(l)));
    });
  });
});

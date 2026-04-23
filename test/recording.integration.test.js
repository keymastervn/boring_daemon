import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, unlinkSync } from "fs";
import { execFileSync } from "child_process";

import { Recorder } from "../recorder.js";
import { replay } from "../replayer.js";
import { SessionManager } from "../session-manager.js";

let tmuxAvailable = false;
try {
  execFileSync("tmux", ["-V"]);
  tmuxAvailable = true;
} catch {}

describe(
  "Recording + Replay — integration tests (requires tmux)",
  { skip: !tmuxAvailable },
  () => {
    let manager;
    let rec;
    const recordedFiles = [];
    // Each test gets a unique suffix so parallel runs don't collide
    let sessionName;

    beforeEach(() => {
      manager = new SessionManager();
      rec = new Recorder();
      sessionName = `rec-inttest-${Date.now()}`;
    });

    afterEach(async () => {
      if (rec.isRecording()) {
        try {
          rec.stop();
        } catch {}
      }
      for (const f of recordedFiles) {
        try {
          unlinkSync(f);
        } catch {}
      }
      recordedFiles.length = 0;
      // Best-effort cleanup of any sessions created during tests
      try {
        await manager.close(sessionName);
      } catch {}
      try {
        await manager.close(`${sessionName}-replay`);
      } catch {}
    });

    // --- Recorder integration ---

    describe("recorder with real file I/O", () => {
      it("creates a file in ~/.boring_daemon/record_logs/", () => {
        const path = rec.start(sessionName);
        recordedFiles.push(path);
        assert.ok(existsSync(path));
        assert.ok(path.includes(".boring_daemon/record_logs"));
        rec.stop();
      });

      it("filename contains the session name and a timestamp", () => {
        const path = rec.start(sessionName);
        recordedFiles.push(path);
        rec.stop();
        const base = path.split("/").pop();
        assert.ok(
          base.startsWith(sessionName),
          `filename should start with "${sessionName}"`,
        );
        // timestamp segment e.g. 2026-04-22T16-20-00
        assert.match(base, /\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.jsonl$/);
      });

      it("records real session_create + send_command + wait_for_ready + session_close calls", async () => {
        const path = rec.start(sessionName);
        recordedFiles.push(path);

        // Instrument manually (mirrors what server.js does for each tool)
        await manager.create(sessionName);
        rec.append({
          type: "session_create",
          session: sessionName,
          params: {},
        });

        await manager.sendCommand(sessionName, "echo recording-test", true);
        rec.append({
          type: "send_command",
          session: sessionName,
          params: { command: "echo recording-test", enter: true },
        });

        const ready = await manager.waitForReady(sessionName, { timeout: 10 });
        rec.append({
          type: "wait_for_ready",
          session: sessionName,
          params: { timeout: 10 },
          result: { ready: ready.ready, elapsed: ready.elapsed },
        });

        await manager.close(sessionName);
        rec.append({ type: "session_close", session: sessionName });

        const { totalEvents } = rec.stop();
        assert.equal(totalEvents, 4);

        const lines = readFileSync(path, "utf8")
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l));

        assert.equal(lines[0].type, "header");
        assert.equal(lines[1].type, "session_create");
        assert.equal(lines[2].type, "send_command");
        assert.equal(lines[2].params.command, "echo recording-test");
        assert.equal(lines[3].type, "wait_for_ready");
        assert.equal(lines[4].type, "session_close");
        assert.equal(lines[5].type, "footer");
        assert.equal(lines[5].total_events, 4);
      });

      it("captures LLM_TURN events via record_event pattern", () => {
        const path = rec.start(sessionName);
        recordedFiles.push(path);

        rec.append({
          type: "LLM_TURN",
          model: "claude-sonnet-4-6",
          prompt: "count rows in users table",
          response: "I will run SELECT count(*) FROM users",
        });

        const { totalEvents } = rec.stop();
        assert.equal(totalEvents, 1);

        const lines = readFileSync(path, "utf8")
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l));
        const event = lines[1];
        assert.equal(event.type, "LLM_TURN");
        assert.equal(event.model, "claude-sonnet-4-6");
        assert.equal(event.prompt, "count rows in users table");
        assert.ok(event.idx === 1);
        assert.ok(event.ts);
      });

      it("two concurrent Recorder instances write to separate files without interference", () => {
        const rec2 = new Recorder();
        const path1 = rec.start(`${sessionName}-a`);
        const path2 = rec2.start(`${sessionName}-b`);
        recordedFiles.push(path1, path2);

        rec.append({
          type: "send_command",
          session: "a",
          params: { command: "echo a" },
        });
        rec2.append({
          type: "send_command",
          session: "b",
          params: { command: "echo b" },
        });
        rec2.append({
          type: "send_keys",
          session: "b",
          params: { keys: "Enter" },
        });

        const r1 = rec.stop();
        const r2 = rec2.stop();

        assert.equal(r1.totalEvents, 1);
        assert.equal(r2.totalEvents, 2);
        assert.notEqual(path1, path2);
      });
    });

    // --- Replay integration ---

    describe("replay with real tmux sessions", () => {
      it("auto mode: recreates a session and runs a command end-to-end", async () => {
        // Build a recording that creates a session, echoes something, closes it
        const path = rec.start(`${sessionName}-src`);
        recordedFiles.push(path);
        rec.append({
          type: "session_create",
          session: `${sessionName}-replay`,
          params: {},
        });
        rec.append({
          type: "send_command",
          session: `${sessionName}-replay`,
          params: { command: "echo replay-ok", enter: true },
        });
        rec.append({
          type: "wait_for_ready",
          session: `${sessionName}-replay`,
          params: { timeout: 15 },
          result: { ready: true, elapsed: 0.5 },
        });
        rec.append({
          type: "session_close",
          session: `${sessionName}-replay`,
        });
        rec.stop();

        // Replay against real tmux
        const { log } = await replay(path, manager, { mode: "auto" });

        const statuses = log.map((e) => e.status);
        assert.ok(
          statuses.every((s) => s === "ok"),
          `all events should be ok, got: ${JSON.stringify(statuses)}`,
        );

        // Session should have been created and then closed — verify it no longer exists
        const allSessions = await manager.listAll();
        const replaySession = allSessions.find(
          (s) => s.name === `bd-${sessionName}-replay`,
        );
        assert.equal(
          replaySession,
          undefined,
          "session should be closed after replay",
        );
      });

      it("auto mode: skips LLM_TURN events and reports them as skipped in log", async () => {
        const path = rec.start(`${sessionName}-llm`);
        recordedFiles.push(path);
        rec.append({
          type: "session_create",
          session: `${sessionName}-replay`,
          params: {},
        });
        rec.append({
          type: "LLM_TURN",
          model: "claude-sonnet-4-6",
          prompt: "check the output and decide next step",
        });
        rec.append({
          type: "session_close",
          session: `${sessionName}-replay`,
        });
        rec.stop();

        const { log } = await replay(path, manager, { mode: "auto" });

        const llmEntry = log.find((e) => e.type === "LLM_TURN");
        assert.equal(llmEntry.status, "skipped");

        const toolEntries = log.filter((e) => e.type !== "LLM_TURN");
        assert.ok(toolEntries.every((e) => e.status === "ok"));
      });

      it("hybrid mode: surfaces LLM_TURN prompt and still runs tool events", async () => {
        const path = rec.start(`${sessionName}-hybrid`);
        recordedFiles.push(path);
        rec.append({
          type: "session_create",
          session: `${sessionName}-replay`,
          params: {},
        });
        rec.append({
          type: "LLM_TURN",
          model: "claude-sonnet-4-6",
          prompt: "review output and continue",
        });
        rec.append({
          type: "session_close",
          session: `${sessionName}-replay`,
        });
        rec.stop();

        const { log } = await replay(path, manager, { mode: "hybrid" });

        const llmEntry = log.find((e) => e.type === "LLM_TURN");
        assert.equal(llmEntry.status, "llm_turn");
        assert.equal(llmEntry.prompt, "review output and continue");
        assert.ok(llmEntry.hint);

        const toolEntries = log.filter((e) => e.type !== "LLM_TURN");
        assert.ok(toolEntries.every((e) => e.status === "ok"));
      });

      it("replay log entries include idx and type matching the original recording", async () => {
        const path = rec.start(`${sessionName}-idx`);
        recordedFiles.push(path);
        rec.append({
          type: "session_create",
          session: `${sessionName}-replay`,
          params: {},
        });
        rec.append({
          type: "send_command",
          session: `${sessionName}-replay`,
          params: { command: "echo idx-test", enter: true },
        });
        rec.append({
          type: "session_close",
          session: `${sessionName}-replay`,
        });
        rec.stop();

        const { log } = await replay(path, manager, { mode: "auto" });

        assert.equal(log[0].idx, 1);
        assert.equal(log[0].type, "session_create");
        assert.equal(log[1].idx, 2);
        assert.equal(log[1].type, "send_command");
        assert.equal(log[2].idx, 3);
        assert.equal(log[2].type, "session_close");
      });

      it("replay aborts on a bad session name and error entry shows the failure", async () => {
        const path = rec.start(`${sessionName}-err`);
        recordedFiles.push(path);
        // Reference a session that was never created
        rec.append({
          type: "send_command",
          session: "nonexistent-session-xyz",
          params: { command: "echo hi", enter: true },
        });
        rec.stop();

        await assert.rejects(
          () => replay(path, manager, { mode: "auto" }),
          /Replay aborted/,
        );
      });
    });
  },
);

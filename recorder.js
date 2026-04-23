import { writeFileSync, appendFileSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const RECORD_DIR = join(homedir(), ".boring_daemon", "record_logs");

export class Recorder {
  constructor() {
    this._active = false;
    this._session = null;
    this._filePath = null;
    this._idx = 0;
  }

  isRecording() {
    return this._active;
  }

  getFilePath() {
    return this._filePath;
  }

  getSession() {
    return this._session;
  }

  start(session, { description } = {}) {
    if (this._active) {
      throw new Error(
        `Already recording "${this._session}". Call record_stop first.`,
      );
    }
    mkdirSync(RECORD_DIR, { recursive: true });
    const now = new Date();
    // e.g. 2026-04-22T16-20-00
    const stamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
    this._filePath = join(RECORD_DIR, `${session}-${stamp}.jsonl`);
    this._session = session;
    this._idx = 0;
    this._active = true;

    const header = {
      type: "header",
      schema_version: "1.0",
      session,
      start: now.toISOString(),
      recorder: "boring-daemon",
    };
    if (description) header.description = description;
    writeFileSync(this._filePath, JSON.stringify(header) + "\n", "utf8");
    return this._filePath;
  }

  /**
   * Append an event to the recording.
   * Silently no-ops if recording is not active.
   *
   * Event shape (all fields except type are optional):
   *   { type, session, params, result, meta, ...extra }
   *
   * Added automatically: idx, ts
   */
  append(event) {
    if (!this._active) return;
    this._idx++;
    const line = { ...event, idx: this._idx, ts: new Date().toISOString() };
    appendFileSync(this._filePath, JSON.stringify(line) + "\n", "utf8");
  }

  stop() {
    if (!this._active) throw new Error("No active recording to stop.");
    const footer = {
      type: "footer",
      end: new Date().toISOString(),
      total_events: this._idx,
      session: this._session,
    };
    appendFileSync(this._filePath, JSON.stringify(footer) + "\n", "utf8");
    const result = {
      filePath: this._filePath,
      totalEvents: this._idx,
      session: this._session,
    };
    this._active = false;
    this._session = null;
    this._filePath = null;
    this._idx = 0;
    return result;
  }
}

export const recorder = new Recorder();

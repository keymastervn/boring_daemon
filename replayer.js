import { readFileSync } from "fs";

/**
 * Replay a .jsonl recording against a live SessionManager.
 *
 * @param {string} filePath  - absolute path to the .jsonl recording file
 * @param {object} manager   - SessionManager instance (from server.js)
 * @param {object} options
 * @param {'auto'|'hybrid'} options.mode
 *   auto   — executes all tool events verbatim; LLM_TURN events are skipped
 *   hybrid — same as auto, but LLM_TURN prompts are surfaced in the log so
 *             the calling LLM can review them and adjust subsequent actions
 *
 * @returns {{ header, mode, log[] }}
 *   log entries: { idx, type, session?, status, output?, result?, error?, prompt?, hint? }
 *
 * Throws on the first failed event so the caller can decide whether to abort or skip.
 */
export async function replay(filePath, manager, { mode = "auto" } = {}) {
  const content = readFileSync(filePath, "utf8").trim();
  if (!content) throw new Error("Empty recording file");
  const raw = content.split("\n");

  const header = JSON.parse(raw[0]);
  if (header.type !== "header") {
    throw new Error("Invalid recording: missing header on line 1");
  }

  const events = raw
    .slice(1)
    .map((line, i) => {
      try {
        return JSON.parse(line);
      } catch {
        throw new Error(`Invalid JSON at line ${i + 2}: ${line.slice(0, 80)}`);
      }
    })
    .filter((e) => e.type !== "footer");

  const log = [];

  for (const event of events) {
    const { type, session, params = {}, idx } = event;
    const entry = { idx, type, session };

    try {
      switch (type) {
        case "session_create":
          await manager.create(session, {
            command: params.command,
            promptPattern: params.prompt_pattern,
            workingDir: params.working_dir,
          });
          entry.status = "ok";
          break;

        case "session_attach":
          await manager.attach(session, {
            tmuxSession: params.tmux_session,
            promptPattern: params.prompt_pattern,
          });
          entry.status = "ok";
          break;

        case "send_command":
          await manager.sendCommand(
            session,
            params.command,
            params.enter ?? true,
          );
          entry.status = "ok";
          break;

        case "send_keys":
          await manager.sendKeys(session, params.keys);
          entry.status = "ok";
          break;

        case "wait_for_ready": {
          const r = await manager.waitForReady(session, {
            timeout: params.timeout,
            promptPattern: params.prompt_pattern,
          });
          entry.status = "ok";
          entry.ready = r.ready;
          entry.elapsed = r.elapsed;
          entry.output = r.output;
          break;
        }

        case "read_output": {
          const output = await manager.readOutput(session, {
            lines: params.lines,
            sinceLastCommand: params.since_last_command,
          });
          entry.status = "ok";
          entry.output = output;
          break;
        }

        case "session_close":
          await manager.close(session);
          entry.status = "ok";
          break;

        case "LLM_TURN":
          if (mode === "hybrid") {
            entry.status = "llm_turn";
            entry.prompt = event.prompt;
            entry.hint =
              "Hybrid mode: review this prompt and adjust subsequent commands if needed before continuing.";
          } else {
            entry.status = "skipped";
            entry.reason = "auto mode skips LLM_TURN";
          }
          break;

        default:
          entry.status = "skipped";
          entry.reason = `unknown event type: ${type}`;
      }
    } catch (err) {
      entry.status = "error";
      entry.error = err.message;
      log.push(entry);
      throw new Error(`Replay aborted at idx=${idx} (${type}): ${err.message}`);
    }

    log.push(entry);
  }

  return { header, mode, log };
}

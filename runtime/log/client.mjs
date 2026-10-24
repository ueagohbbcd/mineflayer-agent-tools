import http from "node:http";
import { renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Write to the log from a program or module:
 *
 *   const log = new LogClient({ source: "fishing" });
 *   await log.post({ caught: "cod" });                  // one entry
 *   await log.post({ hp: 20 }, { key: "state" });      // newest per key shown
 *   await log.post({ seen: "creeper" }, { urgent: true }); // also wakes
 *
 * `mf log` shows what is new since it was last read, source by source. A
 * source can name a summary module (`summarize(entries) → text`) with
 * `log.summary(file)`; without one, `mf log` lists the entries, keeps the
 * newest per key and folds repeats.
 *
 * Inside `mf run` everything it needs comes from the environment
 * (MF_LOG_SOCKET, MF_LOG_DIR, MF_TASK_ID, MF_CHARACTER).
 */
export class LogClient {
  constructor({
    source = "program",
    socketPath = process.env.MF_LOG_SOCKET,
    dir = process.env.MF_LOG_DIR,
    task = process.env.MF_TASK_ID,
    bot = process.env.MF_CHARACTER,
    timeoutMs = 5000,
  } = {}) {
    if (!socketPath) throw new Error("MF_LOG_SOCKET is not set: run this with `mf run`");
    Object.assign(this, { source, socketPath, dir, task, bot, timeoutMs });
  }
  /** Append one entry. Options: type, key, urgent. Resolves { seq }. */
  post(data, { type, key, urgent = false } = {}) {
    return this.send({
      source: this.source,
      ...(type ? { type } : {}),
      ...(key ? { key } : {}),
      ...(urgent ? { urgent: true } : {}),
      ...(this.bot ? { bot: this.bot } : {}),
      ...(this.task ? { task: this.task } : {}),
      data,
    });
  }
  /**
   * Have `mf log` show this source through `summarize(entries)` exported by
   * `file` (a path or file: URL). Lasts until the state directory is reset.
   */
  summary(file) {
    if (!this.dir) throw new Error("MF_LOG_DIR is not set: run this with `mf run`");
    const path = String(file).startsWith("file:")
      ? fileURLToPath(file)
      : isAbsolute(file)
        ? file
        : resolve(file);
    const target = join(this.dir, `${this.source}.view.json`);
    writeFileSync(`${target}.tmp`, `${JSON.stringify({ summarize: path })}\n`);
    renameSync(`${target}.tmp`, target);
  }
  send(entry) {
    const body = JSON.stringify(entry);
    return new Promise((done, fail) => {
      const req = http.request(
        {
          socketPath: this.socketPath,
          path: "/entries",
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(body),
          },
        },
        (res) => {
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () => {
            let result;
            try {
              result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            } catch (error) {
              return fail(error);
            }
            if (res.statusCode >= 300) fail(new Error(result.error ?? `HTTP ${res.statusCode}`));
            else done(result);
          });
          res.on("error", fail);
        },
      );
      req.setTimeout(this.timeoutMs, () => req.destroy(new Error("Log request timed out")));
      req.on("error", fail);
      req.end(body);
    });
  }
}

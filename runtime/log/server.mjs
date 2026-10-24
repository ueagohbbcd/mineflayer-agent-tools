import http from "node:http";
import { chmod, mkdir, unlink } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * The log's write side for other processes: HTTP over a private Unix socket
 * (mode 0600 in a 0700 directory). `POST /entries` with one entry's fields
 * appends it; `describe(entry)` may add fields the writer cannot set itself
 * (the supervisor adds the program's label and character).
 */
export async function createLogServer({
  store,
  socketPath,
  describe = (entry) => entry,
  maxRequestBytes = 65536,
}) {
  if (!store) throw new Error("store required");
  if (!socketPath) throw new Error("socketPath required");
  const server = http.createServer((req, res) => {
    const reply = (status, body) => {
      if (!res.headersSent) {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      }
    };
    if (!(req.method === "POST" && req.url === "/entries")) {
      req.resume();
      return reply(404, { error: "Use POST /entries" });
    }
    let bytes = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > maxRequestBytes) {
        reply(413, { error: `Entry larger than ${maxRequestBytes} bytes` });
        chunks.length = 0;
      } else if (!res.headersSent) chunks.push(chunk);
    });
    req.on("end", () => {
      if (res.headersSent) return;
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!body || typeof body !== "object" || Array.isArray(body))
          throw new Error("An entry is a JSON object");
        const entry = store.append(describe(body));
        reply(201, { seq: entry.seq });
      } catch (error) {
        reply(400, { error: error.message });
      }
    });
    req.on("error", () => reply(400, { error: "Incomplete request" }));
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.maxConnections = 64;
  await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  try {
    await chmod(socketPath, 0o600);
  } catch (error) {
    server.close();
    throw error;
  }
  return {
    server,
    socketPath,
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
      await unlink(socketPath).catch((e) => {
        if (e.code !== "ENOENT") throw e;
      });
    },
  };
}

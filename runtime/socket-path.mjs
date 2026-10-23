import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Unix socket paths longer than about 107 bytes are cut short by the kernel,
// so a socket under a deep directory would be created under another name.
const MAX_SOCKET_PATH = 100;

/**
 * Where the socket `name` of directory `dir` lives: in `dir` itself, or, when
 * that path is too long for a Unix socket, in a private directory under the
 * system temp directory named after `dir` (the same for every process).
 */
export function socketPath(dir, name) {
  const path = join(dir, name);
  if (Buffer.byteLength(path) <= MAX_SOCKET_PATH) return path;
  const short = join(tmpdir(), `mf-${createHash("sha256").update(dir).digest("hex").slice(0, 16)}`);
  mkdirSync(short, { recursive: true, mode: 0o700 });
  return join(short, name);
}

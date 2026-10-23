/** Start one native Mineflayer process (cli.mjs) for each character. */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { socketPath } from "../socket-path.mjs";

const hostCli = fileURLToPath(new URL("./cli.mjs", import.meta.url));

/** Character names: MF_USERNAMES (comma-separated), else MF_USERNAME. */
export function botNames(env) {
  const names = (env.MF_USERNAMES ?? env.MF_USERNAME ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  if (!names.length) throw new Error("Set MF_USERNAME (or MF_USERNAMES)");
  return names;
}

export function hostEnv(env, { name, runSocket, index, runDir }) {
  return {
    ...env,
    MF_USERNAME: name,
    // Set only inside the character's own process (InboxClient reads it).
    MF_CHARACTER: name,
    ARENA_RUN_SOCKET: runSocket,
    ARENA_BOT_INDEX: String(index),
    // Do not create a history cache by default. Persist only when opted in.
    ...(env.ARENA_WORLD_MEMORY_MODE === "persistent" &&
    !env.ARENA_WORLD_MEMORY_DIR
      ? { ARENA_WORLD_MEMORY_DIR: join(runDir, "world-memory", name) }
      : {}),
  };
}

/** Start a real bot host per character and restart it if its process exits. */
export async function startBotHosts({
  env = process.env,
  names = botNames(env),
  runDir = join(env.TMPDIR || "/tmp", "mf-bots"),
  // A host that exits soon after it started is restarted later each time
  // (up to maxRestartMs), so a server that is down is not hammered.
  restartMs = 2000,
  maxRestartMs = 60000,
  spawnHost = (hostEnvironment) =>
    spawn(process.execPath, [hostCli], {
      env: { ...hostEnvironment, MF_SUPERVISED: "1" },
      // The host exits when this pipe closes, that is when we are gone.
      stdio: ["pipe", "inherit", "inherit"],
    }),
  log = (line) => process.stderr.write(`${line}\n`),
  // Called with (host, { code, signal }) when a host exits and will restart.
  onExit = () => {},
} = {}) {
  await mkdir(runDir, { recursive: true, mode: 0o700 });
  const bots = names.map((name, index) => ({
    name,
    runSocket: socketPath(runDir, `${name}.sock`),
    environment: hostEnv(env, {
      name,
      index,
      runSocket: socketPath(runDir, `${name}.sock`),
      runDir,
    }),
  }));
  const botsFile = join(runDir, "bots.json");
  let persistChain = Promise.resolve();
  const persist = () => {
    const write = persistChain.then(() =>
      writeFile(
        botsFile,
        `${JSON.stringify({ bots: bots.map(({ name, runSocket, pid, generation }) => ({ name, runSocket, ...(pid ? { pid, generation } : {}) })) }, null, 2)}\n`,
        { mode: 0o600 },
      ),
    );
    // One failed write must not stop the later ones.
    persistChain = write.catch(() => {});
    return write;
  };
  await persist();
  let closed = false;
  const children = new Map();
  const timers = new Set();
  const start = (host) => {
    if (closed) return;
    host.generation = randomUUID();
    host.environment.ARENA_BOT_HOST_GENERATION = host.generation;
    const child = spawnHost(host.environment);
    const startedAt = Date.now();
    host.pid = child.pid;
    children.set(host.name, child);
    void persist().catch((error) =>
      log(`Bot host manifest update failed: ${error.message}`),
    );
    child.once("exit", (code, signal) => {
      children.delete(host.name);
      delete host.pid;
      delete host.generation;
      void persist().catch((error) =>
        log(`Bot host manifest update failed: ${error.message}`),
      );
      if (closed) return;
      onExit(host, { code, signal });
      host.failures =
        Date.now() - startedAt < maxRestartMs ? (host.failures ?? 0) + 1 : 1;
      const delay = Math.min(maxRestartMs, restartMs * 2 ** (host.failures - 1));
      log(
        `Bot host ${host.name} exited (${signal ?? code}); restarting in ${delay} ms`,
      );
      const timer = setTimeout(() => {
        timers.delete(timer);
        start(host);
      }, delay);
      timers.add(timer);
    });
    child.once("error", (error) =>
      log(`Bot host ${host.name}: ${error.message}`),
    );
  };
  for (const host of bots) start(host);
  await persist();
  const [main] = bots;
  return {
    bots,
    env: {
      ARENA_BOT: main.name,
      ARENA_BOTS_FILE: botsFile,
      ARENA_RUN_SOCKET: main.runSocket,
    },
    close() {
      closed = true;
      for (const timer of timers) clearTimeout(timer);
      for (const child of children.values()) child.kill("SIGTERM");
    },
  };
}

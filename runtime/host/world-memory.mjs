import { setting } from "../env.mjs";

/** Optional native chunk history. Ordinary Mineflayer queries work without it. */
export function worldMemoryOptions(env = {}, username) {
  const directory = setting("WORLD_MEMORY_DIR", env);
  const mode =
    setting("WORLD_MEMORY_MODE", env) ?? (directory ? "persistent" : "off");
  if (!["off", "session", "persistent"].includes(mode))
    throw new Error("MF_WORLD_MEMORY_MODE must be off, session, or persistent");
  if (mode === "off") return null;
  if (mode === "persistent" && !directory)
    throw new Error("Persistent world memory needs MF_WORLD_MEMORY_DIR");
  return {
    analysis: "lazy",
    ...(mode === "persistent" ? { directory } : {}),
    worldId: JSON.stringify({
      worldId: setting("WORLD_ID", env) ?? "default",
      runId: setting("RUN_ID", env) ?? "default",
      participantId: setting("PARTICIPANT_ID", env) ?? username,
    }),
  };
}

export async function attachWorldMemory(bot, env = process.env, create) {
  const options = worldMemoryOptions(env, bot.username);
  if (!options) return null;
  const factory =
    create ??
    (await import("../../index.js")).default.createWorldMemory;
  const memory = factory(bot, options);
  if (!memory.ready || typeof memory.chunkInfo !== "function")
    throw new Error(
      "Installed world-memory package lacks lazy native memory support",
    );
  await memory.ready;
  bot.worldMemory = memory;
  // The older name, still set.
  bot.arenaMemory = memory;
  return memory;
}

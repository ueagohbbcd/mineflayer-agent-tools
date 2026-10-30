#!/usr/bin/env node
// Background watchdog, off by default (`mf run --keep` this file, or
// MF_DEFAULT_SCRIPTS=chat,watchdog). It watches your character from outside
// your programs and logs long-running trouble (source `watchdog`): no
// progress for minutes, walking in circles, cumulative wall contact (20 s in
// the last 30 s), digging the same block again and again, dying repeatedly
// in one place (urgent) and repeating the same chat message. Each finding is
// logged once until the situation changes. To change the thresholds, copy it
// into your working directory and change what is passed to createTrendWatch.
import { LogClient } from "../log/client.mjs";
import { createTrendWatch } from "../observation/trend-watch.mjs";
import { createPendingWrites } from "../log/pending-writes.mjs";

const MOVES = ["forward", "back", "left", "right"];
const inventoryKey = (bot) =>
  (bot.inventory?.items?.() ?? [])
    .map((item) => `${item.type}:${item.count}`)
    .sort()
    .join(",");

/** Watch one connected bot; returns { close() }. */
export function startTrendWatchdog({
  bot,
  log,
  sampleMs = 1000,
  now = Date.now,
  ...thresholds
}) {
  const watch = createTrendWatch(thresholds);
  const writes = createPendingWrites((error) =>
    console.error(`watchdog: log failed: ${error.message}`),
  );
  const send = (findings) => {
    for (const { type, urgent, message, ...rest } of findings) {
      writes.track(() =>
        log.post({ message, ...rest }, { type, ...(urgent ? { urgent: true } : {}) }),
      );
    }
  };
  const timer = setInterval(() => {
    const entity = bot.entity;
    send(
      watch.sample({
        t: now(),
        position: entity?.position,
        // A held movement key: pressed against a wall, velocity is zero.
        moving: MOVES.some((key) => bot.controlState?.[key]),
        collided: Boolean(entity?.isCollidedHorizontally),
        inventory: inventoryKey(bot),
      }),
    );
  }, sampleMs);
  const onDig = (block) =>
    block?.position && send(watch.dig({ t: now(), position: block.position }));
  const onDeath = () =>
    send(watch.death({ t: now(), position: bot.entity?.position }));
  const onChat = (username, message) => {
    if (username === bot.username)
      send(watch.chat({ t: now(), text: message }));
  };
  bot.on("diggingCompleted", onDig);
  bot.on("death", onDeath);
  bot.on("chat", onChat);
  return {
    flush: writes.flush,
    close() {
      clearInterval(timer);
      bot.off("diggingCompleted", onDig);
      bot.off("death", onDeath);
      bot.off("chat", onChat);
    },
  };
}

// Read-only: cancelling it never stops the character's movement.
export const control = false;

export default async function watchdogProgram(bot, { signal }) {
  const running = startTrendWatchdog({ bot, log: new LogClient({ source: "watchdog" }) });
  if (!signal) return running;
  if (signal.aborted) {
    running.close();
    return;
  }
  await new Promise((resolve) =>
    signal.addEventListener("abort", resolve, { once: true }),
  );
  running.close();
}

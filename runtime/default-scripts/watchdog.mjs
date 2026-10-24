#!/usr/bin/env node
// Default watchdog. The runtime starts this ordinary script at session start
// (it appears in the task list as "default watchdog"). It watches your
// character from outside your programs and reports long-running trouble: no
// progress for minutes, walking in circles, cumulative wall contact (20 s in
// the last 30 s), digging the
// same block again and again, dying repeatedly in one place (urgent) and
// repeating the same chat message. Each finding is reported once until the
// situation changes; all unread findings share one report (`watchdog`). Stop it with mf cancel <taskId>, or copy it into
// your working directory and change the thresholds passed to createTrendWatch.
import { InboxClient, inboxSlot } from "../inbox/index.mjs";
import { createTrendWatch } from "../observation/trend-watch.mjs";

const MOVES = ["forward", "back", "left", "right"];
const inventoryKey = (bot) =>
  (bot.inventory?.items?.() ?? [])
    .map((item) => `${item.type}:${item.count}`)
    .sort()
    .join(",");

/** Watch one connected bot; returns { close() }. */
export function startTrendWatchdog({
  bot,
  inbox,
  sampleMs = 1000,
  now = Date.now,
  ...thresholds
}) {
  const watch = createTrendWatch(thresholds);
  const slot = inboxSlot(inbox, "watchdog", {
    render: (findings, { omitted }) => ({
      type: "watchdog",
      findings,
      ...(omitted ? { omittedOlderFindings: omitted } : {}),
    }),
    onError: (error) => console.error(`watchdog: report failed: ${error.message}`),
  });
  let seq = 0;
  const send = (findings) => {
    for (const finding of findings)
      slot.put(++seq, { at: now(), ...finding }, { urgent: Boolean(finding.urgent) });
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
    flush: () => slot.flush(),
    close() {
      slot.close();
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
  const running = startTrendWatchdog({ bot, inbox: new InboxClient() });
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

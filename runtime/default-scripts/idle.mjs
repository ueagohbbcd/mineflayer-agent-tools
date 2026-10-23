// Built-in idle behaviour. The supervisor runs it whenever no program of the
// model controls the character, and stops it before the next one starts. It
// never sets a pathfinder goal or chases anything: it fights hostile mobs
// within reach, eats when hungry and keeps its head above water. A summary of
// what it did is reported (state key "idle") at most every few seconds.
//
// Replace it with `idle.mjs` in the working directory: the same shape, a
// default export `(bot, { signal, log })`. The supervisor loads the newest
// version each time the character becomes idle, and falls back to this file
// (with a report) when yours fails.
import { InboxClient } from "../inbox/index.mjs";

const REACH = 3.5;
const HUNGRY = 14;
const ATTACK_MS = 650;
const REPORT_MS = 5000;

const weaponRank = (name) =>
  ["netherite", "diamond", "iron", "stone", "golden", "wooden"].findIndex(
    (tier) => name.startsWith(`${tier}_`),
  );

function bestWeapon(bot) {
  let best;
  for (const item of bot.inventory?.items?.() ?? []) {
    if (!/_(sword|axe)$/.test(item.name)) continue;
    const rank = weaponRank(item.name) + (item.name.endsWith("_axe") ? 0.5 : 0);
    if (!best || rank < best.rank) best = { item, rank };
  }
  return best?.item;
}

function food(bot) {
  const foods = bot.registry?.foodsByName ?? {};
  return (bot.inventory?.items?.() ?? [])
    .filter((item) => foods[item.name] && !/rotten|spider_eye|poison/.test(item.name))
    .sort((a, b) => foods[b.name].foodPoints - foods[a.name].foodPoints)[0];
}

function nearestHostile(bot) {
  const me = bot.entity?.position;
  if (!me) return undefined;
  let best;
  for (const entity of Object.values(bot.entities ?? {})) {
    if (entity === bot.entity || entity.type !== "hostile" || !entity.position)
      continue;
    const distance = entity.position.distanceTo(me);
    if (distance <= REACH && (!best || distance < best.distance))
      best = { entity, distance };
  }
  return best?.entity;
}

export async function idle(bot, { signal, report = () => {} } = {}) {
  const summary = { attacks: 0, targets: {}, ate: 0, swam: false };
  let lastAttack = 0;
  let lastReport = 0;
  let changed = false;
  let busy = false;
  const flush = (force = false) => {
    const now = Date.now();
    if (!changed || (!force && now - lastReport < REPORT_MS)) return;
    lastReport = now;
    changed = false;
    report({ type: "idle.summary", ...summary });
  };
  const tick = async () => {
    if (busy || !bot.entity) return;
    busy = true;
    try {
      // Head under water: hold jump to float, release it on land.
      const swim = Boolean(bot.entity.isInWater);
      bot.setControlState("jump", swim);
      if (swim && !summary.swam) {
        summary.swam = true;
        changed = true;
      }
      const target = nearestHostile(bot);
      if (target && Date.now() - lastAttack >= ATTACK_MS) {
        const weapon = bestWeapon(bot);
        if (weapon && bot.heldItem?.name !== weapon.name)
          await bot.equip(weapon, "hand");
        await bot.lookAt(target.position.offset(0, target.height * 0.8, 0), true);
        bot.attack(target);
        lastAttack = Date.now();
        summary.attacks++;
        summary.targets[target.name] = (summary.targets[target.name] ?? 0) + 1;
        changed = true;
      } else if (!target && bot.food < HUNGRY) {
        const meal = food(bot);
        if (meal) {
          await bot.equip(meal, "hand");
          await bot.consume();
          summary.ate++;
          changed = true;
        }
      }
    } catch {
      // A failed equip or meal is retried on the next tick.
    } finally {
      busy = false;
    }
    flush();
  };
  const timer = setInterval(() => void tick(), 250);
  await new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    signal?.addEventListener("abort", resolve, { once: true });
  });
  clearInterval(timer);
  // Let an equip, look or meal in flight finish before the next program
  // starts; returning earlier would leave it acting on the bot. If it never
  // finishes, the host's cancellation grace restarts the character instead.
  while (busy) await new Promise((done) => setTimeout(done, 50));
  bot.setControlState("jump", false);
  flush(true);
}

export default async function idleProgram(bot, { signal }) {
  const inbox = new InboxClient();
  await idle(bot, {
    signal,
    report: (data) =>
      void inbox
        .upsert("idle", data)
        .catch((error) => console.error(`idle: report failed: ${error.message}`)),
  });
}

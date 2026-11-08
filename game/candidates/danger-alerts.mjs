// SPDX-License-Identifier: MIT
// Candidate material (not a routine): the old danger observer. Detects risk
// signs (lit TNT, swelling creeper, moving projectile, a mob targeting you,
// big or repeated health loss) and posts them through a `log` such as
// observers/record.mjs. Kept for its detection logic.
//
// - health_loss (urgent for a large or repeated loss), hurt, critical_health
//   (urgent) from the game's own health and hurt events;
// - alert: a visible entity within 16 blocks with a risk sign (lit TNT, a
//   swelling creeper, a moving projectile, something targeting you), urgent,
//   once per entity until its reasons change;
// - hungry (food at or below 6, again after it was back to 10) and drowning
//   (air at or below 8 of 20, again after it was back to 16): recorded only;
//   the low-air rule in main handles air and notifies when it is not enough.
import { watchObservation } from "../observation/events.mjs";
import { minimalDangerSample } from "../observation/snapshot.mjs";
import { createPendingWrites } from "../observers/support.mjs";

const KEEP = new Set(["health_loss", "hurt", "critical_health"]);
const STAMP = ["observedAt", "sampledAt", "epoch", "sequence"];

/** Watch one bot; `log` has post(data, { type, key, urgent }) (see recordLog). Returns { close(), flush() }. */
export function startDanger({ bot, log, sampleMs = 1000, sample = minimalDangerSample }) {
  const writes = createPendingWrites((error) =>
    console.error(`danger: log failed: ${error.message}`),
  );
  const write = (data, options) => writes.track(() => log.post(data, options));
  const events = watchObservation(bot, {
    lifecycleEvents: false,
    post({ priority, data }) {
      const { type, ...rest } = data;
      const name = String(type).replace(/^observation\./, "");
      if (!KEEP.has(name)) return;
      for (const key of STAMP) delete rest[key];
      write(rest, { type: name, ...(priority === "urgent" ? { urgent: true } : {}) });
    },
  });
  // Per entity id: the reasons last logged.
  const alerted = new Map();
  let hungry = false;
  let drowning = false;
  const timer = setInterval(() => {
    let state;
    try {
      state = sample(bot, { local: false });
    } catch {
      return;
    }
    const alerts = state.radar?.alerts ?? [];
    const present = new Set();
    for (const { id, name, position, distance, reasons } of alerts) {
      present.add(id);
      const why = JSON.stringify(reasons);
      if (alerted.get(id) === why) continue;
      alerted.set(id, why);
      write({ name, position, distance, reasons }, { type: "alert", urgent: true });
    }
    for (const id of alerted.keys()) if (!present.has(id)) alerted.delete(id);
    const position = bot.entity?.position;
    const where = position && { x: Math.round(position.x), y: Math.round(position.y), z: Math.round(position.z) };
    const food = state.self?.food;
    if (Number.isFinite(food)) {
      if (!hungry && food <= 6) {
        hungry = true;
        write({ food, position: where }, { type: "hungry" });
      } else if (food >= 10) hungry = false;
    }
    // The player's own air supply, 0 to 20 (bot.oxygenLevel can be another entity's).
    const air = state.self?.oxygen;
    if (Number.isFinite(air)) {
      if (!drowning && air <= 8) {
        drowning = true;
        write({ air, position: where }, { type: "drowning" });
      } else if (air >= 16) drowning = false;
    }
  }, sampleMs);
  return {
    flush: writes.flush,
    close() {
      clearInterval(timer);
      events.close?.();
    },
  };
}

#!/usr/bin/env node
// Radar, off by default (`mf run --keep` this file, or
// MF_DEFAULT_SCRIPTS=chat,radar). Logs who and what is around the character
// (source `radar`), never urgent:
//
// - appeared / left: a player (within 64 blocks; through walls while its
//   name tag shows), a named entity, with team and relation for players;
// - player: where a player in range is, to the nearest `step` blocks
//   (default 8), newest only;
// - mobs: other entities within 48 blocks that you can see, counted by name,
//   with the nearest distance to the nearest `step` blocks, newest only;
// - drops: item drops in range, grouped, newest only.
//
// `mf log --source radar` shows what came and went since you last read it,
// and the latest positions and counts.
import { sampleObservation } from "../observation/snapshot.mjs";
import { observationOptionsFromSession } from "../observation/session-options.mjs";
import { LogClient } from "../log/client.mjs";

const round = (value, step) => (step > 0 ? Math.round(value / step) * step : Math.round(value));
const at = (p, step) => p && [round(p.x, step), round(p.y, step), round(p.z, step)];

/** What the radar logs, in a form that changes only when something moved a step. */
export function radarState(radar, { step = 8 } = {}) {
  const players = Object.fromEntries(
    (radar?.players ?? []).map((p) => [
      p.username ?? p.name,
      {
        at: at(p.position, step),
        ...(p.team ? { team: p.team } : {}),
        ...(p.relation ? { relation: p.relation } : {}),
        ...(p.visibility ? { visibility: p.visibility } : {}),
      },
    ]),
  );
  const named = Object.fromEntries(
    (radar?.named ?? []).map((e) => [e.customName ?? e.name, { name: e.name, at: at(e.position, step) }]),
  );
  const mobs = {};
  for (const chunk of radar?.entityChunks ?? [])
    for (const [name, count] of Object.entries(chunk.counts ?? {})) {
      const near = round(chunk.nearest ?? 0, step);
      mobs[name] = { count: (mobs[name]?.count ?? 0) + count, nearest: Math.min(mobs[name]?.nearest ?? Infinity, near) };
    }
  const drops = (radar?.drops ?? []).map((d) => ({ at: at(d.center, step), items: d.items }));
  return { players, named, mobs, drops };
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Watch one bot; returns { close(), flush() }. */
export function startRadar({ bot, log, sampleMs = 2000, step = 8, options = {}, sample = sampleObservation }) {
  const writes = new Set();
  const write = (data, opts) => {
    const done = Promise.resolve(log.post(data, opts)).catch((error) =>
      console.error(`radar: log failed: ${error.message}`),
    );
    writes.add(done);
    done.finally(() => writes.delete(done));
  };
  let last = { players: {}, named: {}, mobs: {}, drops: [] };
  const timer = setInterval(() => {
    let state;
    try {
      state = radarState(sample(bot, { ...options, local: false }).radar, { step });
    } catch {
      return;
    }
    for (const kind of ["players", "named"]) {
      for (const [name, value] of Object.entries(state[kind]))
        if (!last[kind][name]) write({ name, ...value }, { type: `appeared` });
        else if (kind === "players" && !same(last[kind][name], value))
          write({ name, ...value }, { type: "player", key: `player:${name}` });
      for (const name of Object.keys(last[kind]))
        if (!state[kind][name]) write({ name }, { type: "left" });
    }
    if (!same(last.mobs, state.mobs)) write(state.mobs, { type: "mobs", key: "mobs" });
    if (!same(last.drops, state.drops)) write(state.drops, { type: "drops", key: "drops" });
    last = state;
  }, sampleMs);
  return {
    flush: () => Promise.all([...writes]),
    close: () => clearInterval(timer),
  };
}

// Read-only: cancelling it never stops the character's movement.
export const control = false;

export default async function radarModule(bot, { signal, args = [] }) {
  const session = await bot.getSessionState?.().catch(() => undefined);
  const step = Number(args[0] ?? 8);
  const radar = startRadar({
    bot,
    log: new LogClient({ source: "radar" }),
    step: Number.isFinite(step) && step >= 0 ? step : 8,
    options: observationOptionsFromSession(session),
  });
  await new Promise((done) => signal.addEventListener("abort", done, { once: true }));
  radar.close();
}

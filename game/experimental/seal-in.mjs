// SPDX-License-Identifier: MIT
// Experimental (see README): close the bot into the two cells it stands in
// with blocks from the inventory, for a night, and check that it is closed.
//
//   const r = await sealIn(bot, ctx)        → { closed, at, placed, out }
//   node game.mjs run <toolkit>/game/experimental/seal-in.mjs    seals, then waits for dawn
import { setTimeout as sleep } from 'node:timers/promises'
import vec3 from 'vec3'
import { fillerBlock, notePlace } from './place-near.mjs'
const { Vec3 } = vec3

const SIDES = [[1, 0], [-1, 0], [0, 1], [0, -1]]
const FACES = [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]].map(([x, y, z]) => new Vec3(x, y, z))
const FILL_LIMIT = 32 // a closed space is found well before this many cells

// Does: fills every open cell around the feet and head (four sides at both
//   levels, above the head, below the feet) with filler blocks (fillerBlock),
//   each against a solid neighbour; above the head in the open it first puts
//   a block on top of a side wall to place against. Then a flood fill from
//   the feet through cells without a full block, stopped at 32 cells, says
//   whether the space is closed. Appends the shelter to notes/places.md.
//   Returns { closed: true, at, placed, out } where `out` says which blocks to
//   dig to leave; throws when a cell cannot be filled or the fill escapes.
// Checked: 2026-11-12, local 1.21.1: open desert at night, 10 blocks placed,
//   closed, no damage for 3 min with 10 undead within 16 blocks (1 run); a
//   cave near dawn, 2 blocks, the job ended at dawn (1 run). Its first cave
//   run began while falling and failed; it now waits to stand.
// Limits: the space is the two cells the bot stands in: no light is placed
//   since no mob fits inside; a block that is not a full cube (a slab, a
//   fence) counts as open.
export async function sealIn (bot, ctx) {
  ctx.signal.throwIfAborted()
  // Seal around where the bot stands, not where it is falling through (a fall
  // into a cave made the server refuse a block above a head that had moved on).
  for (let i = 0; i < 40 && !bot.entity.onGround; i++) await bot.waitForTicks(2)
  ctx.signal.throwIfAborted()
  if (!bot.entity.onGround) throw new Error('not standing on the ground (in water or falling); stand somewhere first')
  const feet = bot.entity.position.floored()
  const targets = [feet.offset(0, -1, 0), ...SIDES.flatMap(([x, z]) => [feet.offset(x, 0, z), feet.offset(x, 1, z)]), feet.offset(0, 2, 0)]
  const placed = []
  for (let pass = 0; pass < 3 && targets.some(t => isOpen(bot, t)); pass++) {
    for (const t of targets) {
      if (!isOpen(bot, t)) continue
      let ref = solidNeighbour(bot, t)
      if (!ref && t.equals(feet.offset(0, 2, 0))) {
        // In the open nothing touches the cell above the head: put a block on a side wall first.
        const prop = feet.offset(1, 2, 0)
        if (isOpen(bot, prop) && !isOpen(bot, feet.offset(1, 1, 0))) placed.push(await place(bot, ctx, prop, bot.blockAt(feet.offset(1, 1, 0)), new Vec3(0, 1, 0)))
        ref = solidNeighbour(bot, t)
      }
      if (ref) placed.push(await place(bot, ctx, t, ref.block, ref.face))
    }
  }
  const space = floodFill(bot, feet)
  const at = `${feet.x} ${feet.y} ${feet.z}`
  if (space.length >= FILL_LIMIT) {
    const gap = targets.find(t => isOpen(bot, t)) ?? space.at(-1)
    throw new Error(`not closed: the space around ${at} goes on past ${FILL_LIMIT} cells (open near ${gap}); add blocks there or move to a narrower spot`)
  }
  // The way out: the two cells on the side with the most room beyond them.
  const [ox, oz] = SIDES.map(([x, z]) => [x, z, [1, 2].filter(d => isOpen(bot, feet.offset(x * 2, d - 1, z * 2))).length]).sort((a, b) => b[2] - a[2])[0]
  const out = `dig ${feet.x + ox} ${feet.y} ${feet.z + oz} and ${feet.x + ox} ${feet.y + 1} ${feet.z + oz}`
  notePlace(`shelter (sealed in, ${space.length} cells) at ${at}; to leave: ${out}`)
  return { closed: true, at, cells: space.length, placed: placed.length, out }
}

// Open: no full block there (air, water, grass, a torch, a slab).
const isOpen = (bot, p) => bot.blockAt(p)?.boundingBox !== 'block'

// A full block next to p to place against, and the face of it that looks at p.
function solidNeighbour (bot, p) {
  for (const f of FACES) {
    const block = bot.blockAt(p.plus(f))
    if (block?.boundingBox === 'block') return { block, face: f.scaled(-1) }
  }
  return null
}

async function place (bot, ctx, p, ref, face) {
  const item = fillerBlock(bot)
  if (!item) throw new Error(`no blocks left to seal ${p} (cobblestone, dirt, …)`)
  await bot.equip(item, 'hand')
  ctx.signal.throwIfAborted() // exit rule: our own await, so check the signal
  await bot.placeBlock(ref, face)
  ctx.signal.throwIfAborted()
  return p
}

// Cells reachable from `from` through cells without a full block, at most FILL_LIMIT.
function floodFill (bot, from) {
  const seen = new Set([from.toString()])
  const cells = [from]
  for (let i = 0; i < cells.length && cells.length < FILL_LIMIT; i++) {
    for (const f of FACES) {
      const q = cells[i].plus(f)
      if (seen.has(q.toString()) || !isOpen(bot, q)) continue
      seen.add(q.toString())
      cells.push(q)
    }
  }
  return cells
}

// As a job: seal in, then wait until dawn. The model hears at once that the
// bot is safe (ctx.wake) while the job goes on waiting.
export default async function task (bot, ctx) {
  const r = await sealIn(bot, ctx)
  ctx.log(`sealed in at ${r.at} (${r.cells} cells, ${r.placed} blocks placed); to leave: ${r.out}`)
  const night = () => bot.time.timeOfDay >= 12500 && bot.time.timeOfDay < 23000
  if (!night()) return r
  // wake: the model's next `wait` returns now; this job keeps the bot until dawn.
  ctx.wake(`sealed in at ${r.at}; night ends in about ${Math.ceil((23000 - bot.time.timeOfDay) / 1200)} min; the job waits for dawn (cancel to leave earlier)`)
  while (night()) {
    // A wait longer than the 5 s exit grace must end on the signal itself; it throws then.
    await sleep(3000, null, { signal: ctx.signal })
  }
  return { ...r, waited: 'until dawn' }
}

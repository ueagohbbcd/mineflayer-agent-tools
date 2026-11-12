// SPDX-License-Identifier: MIT
// Experimental (see README): from underground to open sky by digging a
// staircase upward, one step at a time, reading the world afresh each step.
// Walking-only Pathfinder cannot leave a pit the bot dug (playtest 2026-11-10, 2/3).
//
//   await climbToSurface(bot, ctx)
//   node game.mjs run <toolkit>/game/experimental/climb-to-surface.mjs
import vec3 from 'vec3'
import { fillerBlock } from './place-near.mjs'
import { walkTo } from './walk-to.mjs'
const { Vec3 } = vec3

const FALLING = /^(sand|red_sand|gravel|suspicious_sand|suspicious_gravel|.*concrete_powder|anvil|chipped_anvil|damaged_anvil|pointed_dripstone)$/
const LIQUID = ['water', 'lava', 'bubble_column']
const SIDES = [[1, 0], [0, 1], [-1, 0], [0, -1]]
const MAX_STEPS = 100

// Does: until the feet column is open to the sky: offers a safepoint, picks a
//   direction (the one the bot faces first), digs the cell above the head and
//   the two cells of the next step up, puts a filler block under the step when
//   it has no floor, and walks onto it. Before each dig it checks that no
//   liquid touches the cell and that no sand or gravel sits above the head;
//   sand or gravel above the step is dug again as it falls. When no way up is
//   safe it steps sideways. Returns { at, steps }; throws with the reason per
//   direction when no step is safe, or after 100 steps.
// Checked: 2026-11-12, local 1.21.1, natural terrain: from 20 blocks under a
//   desert (66 s); cancelled at y 55 and run again, going on from there round
//   a gravel layer (74 s); gravel falling into the step dug again (105 s, 34
//   blocks up a hill). 3 runs, no suffocation.
// Limits: digs with whatever tool is best (bare hands are slow); does not
//   bridge over a cave below the step without a filler block; stops at any
//   liquid next to the way, including water that would only wet the bot.
export async function climbToSurface (bot, ctx) {
  for (let step = 0; ; step++) {
    // Safepoint: a reflex that wants the bot takes it here and the job runs
    // again from its entry. That is safe because nothing below is remembered
    // between steps: each step reads where the bot is and what is around.
    await ctx.safepoint({ surfaceForAir: 'restart', eatWhenHungry: 'restart' })
    const feet = bot.entity.position.floored()
    if (openSky(bot, feet)) return { at: [feet.x, feet.y, feet.z], steps: step }
    if (step >= MAX_STEPS) throw new Error(`still under cover after ${MAX_STEPS} steps at ${feet}; run again to go on`)
    const move = chooseMove(bot, feet)
    for (const p of move.dig) await digClear(bot, ctx, p)
    if (move.floor) await placeFloor(bot, ctx, move.floor)
    await walkTo(bot, ctx, [move.to.x, move.to.y, move.to.z], { range: 0, stallMs: 5000 })
    if (step % 5 === 4 || move.side) ctx.log(`${move.side ? 'stepped sideways' : 'up'} to ${move.to} (step ${step + 1})`)
  }
}

// True when nothing solid or liquid is above the head up to the build limit.
function openSky (bot, feet) {
  for (let y = feet.y + 1; y < 320; y++) {
    const b = bot.blockAt(new Vec3(feet.x, y, feet.z))
    if (!b) return true
    if (b.boundingBox === 'block' || isLiquid(b)) return false
  }
  return true
}

// The next move: { to, dig: [cells to clear], floor?: cell to fill, side? }.
function chooseMove (bot, feet) {
  // The four sides, the one the bot faces first: after a step that is the way it climbed.
  const [fx, fz] = [Math.round(-Math.sin(bot.entity.yaw)), Math.round(-Math.cos(bot.entity.yaw))]
  const order = [...SIDES].sort(([ax, az], [bx, bz]) => (bx === fx && bz === fz) - (ax === fx && az === fz))
  const why = []
  const above = feet.offset(0, 2, 0)
  const headClear = cellProblem(bot, above, feet) ?? (FALLING.test(bot.blockAt(feet.offset(0, 3, 0))?.name ?? '') ? `${bot.blockAt(feet.offset(0, 3, 0)).name} above the head` : null)
  for (const [dx, dz] of order) {
    const to = feet.offset(dx, 1, dz)
    const problem = headClear ?? cellProblem(bot, to, feet) ?? cellProblem(bot, to.offset(0, 1, 0), feet) ?? floorProblem(bot, to.offset(0, -1, 0))
    // The step's upper cell before its lower one: gravel falling into the upper cell is dug again there.
    if (!problem) return { to, dig: [above, to.offset(0, 1, 0), to], floor: needsFloor(bot, to.offset(0, -1, 0)) }
    why.push(`${name(dx, dz)} up: ${problem}`)
  }
  for (const [dx, dz] of order) {
    const to = feet.offset(dx, 0, dz)
    const problem = cellProblem(bot, to, feet) ?? cellProblem(bot, to.offset(0, 1, 0), feet) ?? floorProblem(bot, to.offset(0, -1, 0))
    if (!problem) return { to, dig: [to.offset(0, 1, 0), to], floor: needsFloor(bot, to.offset(0, -1, 0)), side: true }
    why.push(`${name(dx, dz)} sideways: ${problem}`)
  }
  throw new Error(`no safe step from ${feet}: ${why.join('; ')}. Look around (a query or a picture) and dig a way yourself`)
}

// Why the cell cannot be dug into safely, or null. Our own cells do not count.
function cellProblem (bot, p, feet) {
  const b = bot.blockAt(p)
  if (!b) return `${p} is not loaded`
  if (isLiquid(b)) return `${b.name} at ${p}`
  if (b.boundingBox === 'block' && !b.diggable) return `${b.name} at ${p} cannot be dug`
  for (const [x, y, z] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0]]) {
    const q = p.offset(x, y, z)
    if (q.equals(feet) || q.equals(feet.offset(0, 1, 0))) continue
    const n = bot.blockAt(q)
    if (n && isLiquid(n)) return `${n.name} next to ${p}`
  }
  return null
}

function floorProblem (bot, p) {
  const b = bot.blockAt(p)
  if (!b) return `${p} is not loaded`
  if (isLiquid(b)) return `${b.name} under the step`
  if (b.boundingBox !== 'block' && !fillerBlock(bot)) return 'no floor under the step and no block to put there'
  if (b.boundingBox !== 'block' && bot.blockAt(p.offset(0, -1, 0))?.boundingBox !== 'block') return 'a drop under the step'
  return null
}

const needsFloor = (bot, p) => (bot.blockAt(p).boundingBox === 'block' ? null : p)

// Digs p until it stays empty: sand or gravel above falls into it.
async function digClear (bot, ctx, p) {
  for (let i = 0; i < 10; i++) {
    const b = bot.blockAt(p)
    if (b.boundingBox !== 'block') return
    await bot.tool.equipForBlock(b, {})
    ctx.signal.throwIfAborted() // exit rule: our own await, so check the signal
    await bot.dig(b)
    ctx.signal.throwIfAborted()
    if (FALLING.test(bot.blockAt(p.offset(0, 1, 0))?.name ?? '')) {
      await bot.waitForTicks(15) // let it fall into the cell
      ctx.signal.throwIfAborted()
    }
  }
  throw new Error(`${p} keeps filling up (sand or gravel above); dig the column from beside it`)
}

async function placeFloor (bot, ctx, p) {
  await bot.equip(fillerBlock(bot), 'hand')
  ctx.signal.throwIfAborted()
  await bot.placeBlock(bot.blockAt(p.offset(0, -1, 0)), new Vec3(0, 1, 0))
  ctx.signal.throwIfAborted()
}

const isLiquid = b => LIQUID.includes(b.name) || b.getProperties?.().waterlogged === true
const name = (dx, dz) => ({ '1,0': 'east', '-1,0': 'west', '0,1': 'south', '0,-1': 'north' })[`${dx},${dz}`]

// As a job: run climb-to-surface.mjs. Safe to run again after a cancel or a
// preempt: it goes on from wherever the bot is.
export default async function task (bot, ctx) {
  const from = bot.entity.position.floored()
  ctx.log(`climbing from ${from}`)
  const r = await climbToSurface(bot, ctx)
  return { ...r, climbed: r.at[1] - from.y }
}

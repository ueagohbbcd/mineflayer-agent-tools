// SPDX-License-Identifier: MIT
// Experimental (see README): gather blocks of given names near the bot without
// mineflayer-collectblock. A building block for tasks, and a job by itself:
//
//   const r = await digNearby(bot, ctx, ['iron_ore', 'deepslate_iron_ore'], 5)
//   const r = await digNearby(bot, ctx, ['*_log'], 8, { dig: true, keep: ['oak_planks'] })
//   node game.mjs run <toolkit>/game/experimental/dig-nearby.mjs NAME[,NAME...] [count=1] [radius=16] [dig]
import pathfinderPkg from 'mineflayer-pathfinder'
import { defaultMovements, walkingMovements } from '../lib/plugins.mjs'
import { blockIds } from '../queries/find-blocks.mjs'
import { headInWater } from './reflexes.mjs'
import { walkTo } from './walk-to.mjs'
const { goals } = pathfinderPkg

// Never dug, and never dug through on the way: what a player builds and keeps
// things in. collectBlock dug a table and a furnace in the 2026-11-10 playtest.
const BUILT = /^(crafting_table|furnace|blast_furnace|smoker|chest|trapped_chest|barrel|ender_chest|.*_bed|.*shulker_box)$/
const REACH = 4.5 // from the eyes to the block's centre
const BLOCK_MS = 30000 // walking to and digging one block
const SEARCH_MS = 3000 // one Pathfinder search (its default is 5000)
const MAX_SKIPS = 5

// Does: digs up to `count` blocks matching `names` (`*` wildcard) within
//   `radius`, nearest first: walks within reach (walking movements, or digging
//   ones with `dig`), equips the right tool (mineflayer-tool), digs, picks up
//   the drop. A block that cannot be reached or dug within 30 s is skipped with
//   the reason in the log; after 5 skips it stops. Returns { dug, wanted, got,
//   skipped }. Throws when nothing matches, when nothing could be dug, when
//   the tool the block needs is missing or broke, or for a name it refuses
//   (tables, furnaces, chests, beds, `keep`). Water coming in after a dig hands
//   the bot to the surfaceForAir reflex and ends the job.
// Checked: 2026-11-12, local 1.21.1, natural terrain: tree trunks 6/6 and
//   10/10 logs walking (up to 8 blocks up); iron ore 5 blocks down 4/4 with
//   digging movements; past its own table and furnace (both kept); an enclosed
//   and a floating target failed with the reason in 4.6 s and 19.4 s; missing
//   pickaxe named at once. main's RSS stayed 200-219 MB (7 runs). Water let
//   in at eye height: preempted by surfaceForAir, job ended (1 run).
// Limits: the search is bounded (3 s per Pathfinder search, radius + 8, 30 s
//   per block) because collectBlock with digging movements ran for minutes or
//   filled main's heap (1.8 GB, 4 crashes, playtest 2026-11-10). With `dig` it
//   digs whatever is in the way except the protected blocks, and never
//   places blocks (no pillaring).
export async function digNearby (bot, ctx, names, count = 1, { radius = 16, dig = false, keep = [] } = {}) {
  ctx.signal.throwIfAborted()
  const keepIds = new Set(keep.length ? blockIds(bot, keep) : [])
  const isKept = b => BUILT.test(b.name) || keepIds.has(b.id)
  const refused = names.filter(n => blockIds(bot, [n]).some(id => isKept(bot.registry.blocks[id])))
  if (refused.length) throw new Error(`digNearby does not dig ${refused.join(', ')} (built or kept blocks); dig it with bot.dig in a task of your own`)
  const ids = new Set(blockIds(bot, names))

  // Movements for this routine only: walking, or digging that leaves built and kept blocks alone.
  const moves = walkingMovements(bot)
  if (dig) {
    moves.canDig = true
    for (const b of Object.values(bot.registry.blocks)) if (isKept(b)) moves.blocksCantBreak.add(b.id)
  }
  bot.pathfinder.setMovements(moves)
  const saved = [bot.pathfinder.thinkTimeout, bot.pathfinder.searchRadius]
  bot.pathfinder.thinkTimeout = SEARCH_MS
  bot.pathfinder.searchRadius = radius + 8
  const restore = () => {
    [bot.pathfinder.thinkTimeout, bot.pathfinder.searchRadius] = saved
    defaultMovements(bot) // the walking-only default back
  }
  // cleanup: runs at once on cancel, even while bot.dig is still pending; `finally` covers our own return.
  ctx.cleanup(restore)

  const before = counts(bot)
  const skipped = []
  let dug = 0
  let broke = null
  try {
    while (dug < count && skipped.length < MAX_SKIPS) {
      const target = nearest(bot, ids, radius, skipped)
      if (!target) break
      const at = `${target.position.x} ${target.position.y} ${target.position.z}`
      const tool = harvestTool(bot, target)
      if (tool === undefined) {
        throw new Error(`${target.name} at ${at} needs one of ${Object.keys(target.harvestTools).map(id => bot.registry.items[id].name).join(', ')}; ` +
          `the inventory has none${broke ? ` (the ${broke} broke)` : ''}. Craft one, then run again`)
      }
      const why = await digOne(bot, ctx, target, tool)
      if (tool && !bot.inventory.items().some(i => i.name === tool.name)) {
        broke = tool.name
        ctx.log(`the ${tool.name} broke`)
      }
      if (why) {
        skipped.push({ at, why })
        ctx.log(`skip ${target.name} at ${at}: ${why}`)
        continue
      }
      dug++
      ctx.log(`dug ${target.name} at ${at} (${dug}/${count})`)

      // Preempt from inside a task: surfaceForAir's own check waits for low air,
      // but we know now that water is pouring in where we dig (a drowning death
      // in the 2026-11-10 playtest). then 'end': a rerun would dig `count` again.
      if (headInWater(bot)) {
        const r = ctx.preempt('surfaceForAir', { then: 'end', reason: `water came in after digging at ${at}` })
        if (!r.ok) throw new Error(`water came in after digging at ${at} and surfaceForAir could not take over (${r.error}); get to air first`)
        ctx.signal.throwIfAborted() // the preempt aborted us: leave now
      }
    }
  } finally {
    restore()
  }

  const got = gained(before, counts(bot))
  if (!dug) {
    if (!skipped.length) throw new Error(`no ${names.join(', ')} within ${radius} blocks of ${bot.entity.position.floored()}; find some with the find-blocks query and walk closer`)
    throw new Error(`dug none of ${count}: ${skipped.map(s => `${s.at}: ${s.why}`).join('; ')}. ${dig ? 'Walk closer or choose other blocks' : 'Try again with digging movements (dig) or walk closer'}`)
  }
  return { dug, wanted: count, got, skipped }
}

// Walks within reach (bounded), digs, picks up the drop. Returns why it was
// skipped, or null when dug. Throws only on abort.
async function digOne (bot, ctx, target, tool) {
  const p = target.position
  // Bounded search: walkTo gives up on noPath or a stall; this limit also ends
  // a search that keeps finding partial paths, and a dig that takes too long.
  const limit = AbortSignal.timeout(BLOCK_MS)
  const stopDigging = () => { try { bot.stopDigging() } catch {} }
  limit.addEventListener('abort', stopDigging)
  try {
    if (!inReach(bot, p)) {
      await walkTo(bot, { ...ctx, signal: AbortSignal.any([ctx.signal, limit]) }, [p.x, p.y, p.z], { goal: new GoalReach(p), stallMs: 10000 })
    }
    const block = bot.blockAt(p)
    if (block?.type !== target.type) return `it is ${block?.name ?? 'unloaded'} now`
    if (!bot.canDigBlock(block)) return 'out of reach'
    if (tool) await bot.equip(tool, 'hand')
    else await bot.tool.equipForBlock(block, {})
    ctx.signal.throwIfAborted() // exit rule: our own await, so check the signal
    await bot.dig(block)
    ctx.signal.throwIfAborted()
  } catch (error) {
    if (ctx.signal.aborted) throw error
    return limit.aborted ? `not reached or dug within ${BLOCK_MS / 1000} s` : String(error.message ?? error).replace(/^Error: /, '')
  } finally {
    limit.removeEventListener('abort', stopDigging)
  }
  await pickUp(bot, ctx, p)
  return null
}

// Walk onto the drops near p, a few seconds at most; a drop left behind is not an error.
async function pickUp (bot, ctx, p) {
  await bot.waitForTicks(10)
  ctx.signal.throwIfAborted()
  const drops = Object.values(bot.entities).filter(e => e.name === 'item' && e.position.distanceTo(p.offset(0.5, 0.5, 0.5)) < 4)
  for (const drop of drops) {
    if (!drop.isValid || drop.position.distanceTo(bot.entity.position) < 1) continue
    const q = drop.position.floored()
    try {
      await walkTo(bot, ctx, [q.x, q.y, q.z], { range: 1, stallMs: 4000 })
    } catch (error) {
      if (ctx.signal.aborted) throw error
    }
  }
  await bot.waitForTicks(5)
  ctx.signal.throwIfAborted()
}

// The nearest matching block not skipped yet; protected blocks never match.
function nearest (bot, ids, radius, skipped) {
  const eyes = bot.entity.position.offset(0, 1.62, 0)
  const skip = new Set(skipped.map(s => s.at))
  return bot.findBlocks({ matching: [...ids], maxDistance: radius, count: 64 })
    .filter(p => !skip.has(`${p.x} ${p.y} ${p.z}`))
    .sort((a, b) => a.offset(0.5, 0.5, 0.5).distanceTo(eyes) - b.offset(0.5, 0.5, 0.5).distanceTo(eyes))
    .map(p => bot.blockAt(p))[0] ?? null
}

// null: no tool needed (mineflayer-tool picks a faster one if there is one);
// the best item that can harvest it; undefined: it needs one and there is none.
function harvestTool (bot, block) {
  if (!block.harvestTools) return null
  const fits = bot.inventory.items().filter(i => block.harvestTools[i.type])
  return fits.sort((a, b) => block.digTime(a.type, false, false, false) - block.digTime(b.type, false, false, false))[0]
}

function inReach (bot, p) {
  return p.offset(0.5, 0.5, 0.5).distanceTo(bot.entity.position.offset(0, 1.62, 0)) <= REACH
}

// Feet cells from which the block's centre is within REACH of the eyes.
class GoalReach extends goals.Goal {
  constructor (p) {
    super()
    this.c = p.offset(0.5, 0.5, 0.5)
  }

  distance (n) { return Math.hypot(n.x + 0.5 - this.c.x, n.y + 1.62 - this.c.y, n.z + 0.5 - this.c.z) }
  heuristic (n) { return Math.max(0, this.distance(n) - REACH) }
  isEnd (n) { return this.distance(n) <= REACH }
}

function counts (bot) {
  const out = {}
  for (const i of bot.inventory.items()) out[i.name] = (out[i.name] ?? 0) + i.count
  return out
}

function gained (before, after) {
  const out = {}
  for (const [name, n] of Object.entries(after)) if (n > (before[name] ?? 0)) out[name] = n - (before[name] ?? 0)
  return out
}

// As a job: run dig-nearby.mjs NAME[,NAME...] [count=1] [radius=16] [dig]
export default async function task (bot, ctx) {
  const [list, count = 1, radius = 16, mode] = ctx.args
  if (!list) throw new Error('usage: run dig-nearby.mjs NAME[,NAME...] [count=1] [radius=16] [dig]   (* is a wildcard: *_log)')
  return digNearby(bot, ctx, list.split(','), Number(count), { radius: Number(radius), dig: mode === 'dig' })
}

// SPDX-License-Identifier: MIT
// Experimental reflexes (see README). Each is { check?(bot), run(bot, ctx) };
// run checks ctx.signal at entry and after every await, and returns or throws
// before any further game action once it has aborted.
import pathfinderPkg from 'mineflayer-pathfinder'
import { isHostile } from '../observers/radar-report.mjs'
import { oxygenOf } from '../observation/snapshot.mjs'
const { goals } = pathfinderPkg

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms)
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason) }, { once: true })
})

// Does: the nearest hostile entity within `range` passing `filter`, as { e, d }, or null.
// Checked: not checked on a server on its own; fightOrFlee, stayAlive and fleePoint use it.
// Limits: hostility is radar-report.mjs's isHostile list.
export function nearestHostile (bot, range = 16, filter = () => true) {
  const me = bot.entity?.position
  let best = null
  for (const e of Object.values(bot.entities ?? {})) {
    if (!isHostile(e) || !e.position || !me || !filter(e)) continue
    const d = e.position.distanceTo(me)
    if (d <= range && (!best || d < best.d)) best = { e, d }
  }
  return best
}

// A creeper is never chased: within CREEPER_RANGE the character keeps away
// from it whatever its health (meleeing one cost 18 health, 3/3 runs).
export const CREEPER_RANGE = 7
// Does: true for a creeper entity.
// Checked: with fightOrFlee, creeper 3/3 without damage (2026-11-10).
// Limits: see fightOrFlee.
export const isCreeper = e => e.name === 'creeper'
// Flee below FLEE_BELOW health; once fleeing, fight again only above
// FIGHT_ABOVE (or when cornered). Kept per bot across fightOrFlee runs, so
// stayAlive starting it again does not turn a fleeing character back too early.
const FLEE_BELOW = 8
const FIGHT_ABOVE = 14
const fleeing = new WeakMap()

// Does: fights back with mineflayer-pvp, flees below 8 health until above 14,
//   keeps 7 blocks from creepers; returns after 3 s with no hostile mob within
//   12 blocks, or 30 s. Emits bot 'flee' (the mob) each time it starts running.
// Checked: 2026-11-10, local 1.21.1, with these flee rules: two zombies 0 deaths
//   in 9 runs (3 setups); creeper 3/3 without damage; job preempt 3 runs.
//   2026-11-12: the 'flee' event counted by upkeepReport (1 run).
// Limits: without regeneration (food below 18) it flees on: 150 s stand-offs,
//   81–87 blocks away; open ground not checked; a creeper is never ended.
export const fightOrFlee = {
  check: bot => {
    const h = nearestHostile(bot, 6)
    return h && bot.health < 14 ? `${h.e.name} ${Math.round(h.d)} blocks away, health ${Math.round(bot.health)}` : null
  },
  async run (bot, { signal }) {
    const started = Date.now()
    let calm = 0
    let target = null
    let running = false // fleeing right now
    try {
      while (Date.now() - started < 30000) {
        signal.throwIfAborted()
        const h = nearestHostile(bot, 12)
        if (!h) {
          if (target) { bot.pvp.forceStop(); target = null }
          if (++calm >= 6) { fleeing.delete(bot); return 'no hostile mob within 12 blocks' }
          await sleep(500, signal)
          continue
        }
        calm = 0
        if (bot.health < FLEE_BELOW) fleeing.set(bot, true)
        else if (bot.health > FIGHT_ABOVE) fleeing.delete(bot)
        const creeper = nearestHostile(bot, CREEPER_RANGE, isCreeper)
        const foe = nearestHostile(bot, 12, e => !isCreeper(e))?.e ?? creeper?.e // a creeper only when cornered
        const away = (fleeing.get(bot) || creeper) && fleePoint(bot)
        if (away) {
          if (!running) bot.emit('flee', (creeper ?? h).e) // for reports (upkeepReport counts it)
          running = true
          if (target) { bot.pvp.forceStop(); target = null }
          bot.pathfinder.setGoal(new goals.GoalNear(away.x, away.y, away.z, 1))
        } else if (foe) {
          running = false
          if (target !== foe) {
            await equipWeapon(bot)
            signal.throwIfAborted()
            target = foe
            bot.pvp.attack(foe) // follows and swings until the target dies or stop
          }
        } else if (target) { bot.pvp.forceStop(); target = null } // only a creeper, farther than CREEPER_RANGE
        await sleep(500, signal)
      }
      return `${nearestHostile(bot, 12)?.e.name ?? 'a threat'} still near after 30 s, giving control back`
    } finally {
      bot.pvp.forceStop()
    }
  }
}

// Does: where to run: of 16 directions, skipping those towards a hostile within
//   6 blocks, the walkable stretch (up to 10 blocks) whose end is farthest from
//   the nearest hostile; null when no end is more than 3 blocks away (cornered).
// Checked: through fightOrFlee, 2026-11-10 (see fightOrFlee).
// Limits: checked only in the walled arena; open ground not checked.
export function fleePoint (bot) {
  const me = bot.entity.position.floored()
  const foes = Object.values(bot.entities ?? {}).filter(e => isHostile(e) && e.position?.distanceTo(bot.entity.position) <= 16)
  let best = null
  for (let i = 0; i < 16; i++) {
    const a = i * Math.PI / 8
    const towards = foes.some(f => {
      const fx = f.position.x - bot.entity.position.x
      const fz = f.position.z - bot.entity.position.z
      const fd = Math.hypot(fx, fz)
      return fd < 6 && (fx * Math.cos(a) + fz * Math.sin(a)) / (fd || 1) > 0.3
    })
    if (towards) continue
    let end = null
    let y = me.y
    for (let d = 1; d <= 10; d++) {
      const x = Math.floor(me.x + 0.5 + Math.cos(a) * d)
      const z = Math.floor(me.z + 0.5 + Math.sin(a) * d)
      const dy = [0, 1, -1].find(k => standable(bot, x, y + k, z))
      if (dy === undefined) break
      y += dy
      end = { x: x + 0.5, y, z: z + 0.5 }
    }
    if (!end) continue
    const score = Math.min(...foes.map(f => Math.hypot(f.position.x - end.x, f.position.z - end.z)))
    if (!best || score > best.score) best = { ...end, score }
  }
  return best && best.score > 3 ? best : null
}

// Feet and head free, solid floor below (fences and walls are not floor).
function standable (bot, x, y, z) {
  const o = bot.entity.position.floored()
  const at = dy => bot.blockAt(o.offset(x - o.x, y + dy - o.y, z - o.z))
  const below = at(-1)
  const feet = at(0)
  const head = at(1)
  return Boolean(below && feet && head && below.boundingBox === 'block' && feet.boundingBox === 'empty' && head.boundingBox === 'empty' &&
    !['lava', 'water', 'fire', 'cactus', 'magma_block', 'sweet_berry_bush', 'powder_snow'].some(n => [below.name, feet.name].includes(n)))
}

const WEAPONS = ['netherite_sword', 'diamond_sword', 'iron_sword', 'netherite_axe', 'diamond_axe', 'iron_axe', 'stone_sword', 'stone_axe', 'golden_sword', 'wooden_sword', 'wooden_axe']

// Does: equips the best sword or axe in the inventory (list WEAPONS); no-op if held.
// Checked: 2026-11-09: fightOrFlee switched to an iron sword (1 run).
// Limits: ignores enchantments and durability.
export async function equipWeapon (bot) {
  const have = bot.inventory.items()
  for (const name of WEAPONS) {
    if (bot.heldItem?.name === name) return
    const item = have.find(i => i.name === name)
    if (item) return bot.equip(item, 'hand')
  }
}

// Does: head inside a solid block: digs it out with the best tool
//   (mineflayer-tool), or steps back; up to 5 tries.
// Checked: dirt at head height dug out: 2026-11-08, 2026-11-09 (iron shovel),
//   2026-11-10 (1 run each).
// Limits: the step-back branch (a block it cannot dig) is not checked on a server.
export const digHeadFree = {
  check: bot => (headBlocked(bot) ? `head inside ${bot.blockAt(bot.entity.position.offset(0, 1.6, 0)).name}` : null),
  async run (bot, { signal }) {
    signal.throwIfAborted()
    for (let i = 0; i < 5 && headBlocked(bot); i++) {
      signal.throwIfAborted()
      const head = bot.blockAt(bot.entity.position.offset(0, 1.6, 0))
      if (head && bot.canDigBlock(head)) {
        await bot.tool?.equipForBlock(head, {}).catch(() => {})
        signal.throwIfAborted()
        await bot.dig(head)
      } else {
        bot.setControlState('back', true)
        await sleep(400, signal)
        bot.setControlState('back', false)
      }
    }
    return headBlocked(bot) ? 'head still inside a block' : 'head free'
  }
}

// Does: true when the block at eye height has a full collision box.
// Checked: through digHeadFree and preemptWhenHurt's in_wall runs (see digHeadFree).
// Limits: see digHeadFree.
export function headBlocked (bot) {
  const head = bot.entity && bot.blockAt(bot.entity.position.offset(0, 1.6, 0))
  return Boolean(head && head.boundingBox === 'block')
}

// Does: something worth eating, by mineflayer-auto-eat's food list and its
//   banned foods, or null when auto-eat is not loaded.
// Checked: 2026-11-09: auto-eat chose bread over rotten flesh (1 run).
// Limits: see eatWhenHungry.
export function foodItem (bot) {
  const ae = bot.autoEat
  if (!ae) return null
  return bot.inventory.items().find(i => ae.foodsByName[i.name] && !ae.opts.bannedFood.includes(i.name))
}

// Does: eats until food is 18 or there is nothing to eat; `check` fires at food
//   14 or lower. mineflayer-auto-eat picks the food and puts the held item back.
// Checked: safepoint restart after eating 2 breads (2026-11-08, 2026-11-10,
//   1 run each); stayAlive eating at night (2026-11-10, 1 run).
// Limits: food lagging after eating was reported in play, not reproduced;
//   it waits up to 2 s for food to change.
export const eatWhenHungry = {
  check: bot => (bot.food <= 14 && foodItem(bot) ? `food ${bot.food}` : null),
  async run (bot, { signal }) {
    signal.throwIfAborted()
    const out = []
    while (bot.food < 18 && foodItem(bot)) {
      signal.throwIfAborted()
      const before = bot.food
      await bot.autoEat.eat()
      signal.throwIfAborted()
      for (let i = 0; i < 20 && bot.food === before; i++) await sleep(100, signal)
      out.push(`${before} → ${bot.food}`)
    }
    return out.length ? `ate, food ${out.join(', ')}` : 'nothing eaten'
  }
}

// Water at eye height: water itself, a bubble column, water plants (always
// waterlogged) or any block with waterlogged=true.
const WATERY = ['water', 'bubble_column', 'kelp', 'kelp_plant', 'seagrass', 'tall_seagrass']

// Does: true when the block at eye height holds water.
// Checked: through surfaceForAir and preemptWhenDrowning (2026-11-12, 4 runs).
// Limits: eye height is taken as 1.62 above the feet (standing, not swimming flat).
export function headInWater (bot) {
  const head = bot.entity && bot.blockAt(bot.entity.position.offset(0, 1.62, 0))
  return Boolean(head && (WATERY.includes(head.name) || head.getProperties?.().waterlogged === true))
}

// Air is 0..20 (oxygenOf); drowning damage starts at 0, about 0.75 s per point.
export const AIR_LOW = 10

// Does: gets the head out of water: swims up (holds jump); digs a solid block
//   right above the head; if it rises no more for 2 s, walks to the nearest
//   water surface within 5 blocks. `check` fires with the head under water and
//   air at AIR_LOW or less.
// Checked: 2026-11-12, preempting a job 7 blocks under water: surfaced in
//   about 2 s without damage (2 runs); under a stone lid it dug through but took
//   14 s and 13.8 health (1 run); under bedrock it failed after 20 s (1 run).
// Limits: digging while swimming is slow (no time under a lid at air 10);
//   the walk to a nearby surface is not checked on a server; gives up after 20 s.
export const surfaceForAir = {
  check: bot => (headInWater(bot) && oxygenOf(bot) <= AIR_LOW ? `air ${oxygenOf(bot)}/20, head under water` : null),
  async run (bot, { signal }) {
    signal.throwIfAborted()
    const started = Date.now()
    let top = bot.entity.position.y
    let risingAt = Date.now()
    try {
      while (headInWater(bot)) {
        if (Date.now() - started > 20000) throw new Error(`head still under water after 20 s at ${bot.entity.position.floored()}, air ${oxygenOf(bot)}/20`)
        const above = bot.blockAt(bot.entity.position.offset(0, 2.62, 0))
        if (above?.boundingBox === 'block' && bot.canDigBlock(above)) {
          await bot.tool?.equipForBlock(above, {}).catch(() => {})
          signal.throwIfAborted()
          await bot.dig(above)
          signal.throwIfAborted()
          continue
        }
        bot.setControlState('jump', true)
        await sleep(250, signal)
        if (bot.entity.position.y > top + 0.2) { top = bot.entity.position.y; risingAt = Date.now() }
        if (Date.now() - risingAt > 2000) {
          const to = waterSurfaceNear(bot)
          if (to) bot.pathfinder.setGoal(new goals.GoalNear(to.x, to.y, to.z, 0))
          risingAt = Date.now()
        }
      }
      return `head above water at ${bot.entity.position.floored()}, air ${oxygenOf(bot)}/20`
    } finally {
      bot.setControlState('jump', false)
      bot.pathfinder.setGoal(null)
    }
  }
}

// The nearest air cell within 5 blocks that has water right below it.
function waterSurfaceNear (bot) {
  const me = bot.entity.position.floored()
  let best = null
  for (let dx = -5; dx <= 5; dx++) {
    for (let dz = -5; dz <= 5; dz++) {
      for (let dy = 0; dy <= 6; dy++) {
        const p = me.offset(dx, dy, dz)
        if (bot.blockAt(p)?.name !== 'air' || bot.blockAt(p.offset(0, -1, 0))?.name !== 'water') continue
        const d = p.distanceTo(me)
        if (!best || d < best.d) best = { x: p.x, y: p.y - 1, z: p.z, d }
        break
      }
    }
  }
  return best
}

// SPDX-License-Identifier: MIT
// Experimental reflexes (see README). Each is { check?(bot), run(bot, ctx) };
// run checks ctx.signal at entry and after every await, and returns or throws
// before any further game action once it has aborted.
import pathfinderPkg from 'mineflayer-pathfinder'
import { isHostile } from '../observers/radar-report.mjs'
const { goals } = pathfinderPkg

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms)
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason) }, { once: true })
})

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
export const isCreeper = e => e.name === 'creeper'
// Flee below FLEE_BELOW health; once fleeing, fight again only above
// FIGHT_ABOVE (or when cornered). Kept per bot across defend runs, so idle
// starting defend again does not turn a fleeing character back too early.
const FLEE_BELOW = 8
const FIGHT_ABOVE = 14
const fleeing = new WeakMap()

/** Fight back with mineflayer-pvp while health allows, otherwise run; keep away from creepers; ends when nothing is near. */
export const defend = {
  check: bot => {
    const h = nearestHostile(bot, 6)
    return h && bot.health < 14 ? `${h.e.name} 在 ${Math.round(h.d)} 格，血 ${Math.round(bot.health)}` : null
  },
  async run (bot, { signal }) {
    const started = Date.now()
    let calm = 0
    let target = null
    try {
      while (Date.now() - started < 30000) {
        signal.throwIfAborted()
        const h = nearestHostile(bot, 12)
        if (!h) {
          if (target) { bot.pvp.forceStop(); target = null }
          if (++calm >= 6) { fleeing.delete(bot); return '周围安全' }
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
          if (target) { bot.pvp.forceStop(); target = null }
          bot.pathfinder.setGoal(new goals.GoalNear(away.x, away.y, away.z, 1))
        } else if (foe) {
          if (target !== foe) {
            await equipWeapon(bot)
            signal.throwIfAborted()
            target = foe
            bot.pvp.attack(foe) // follows and swings until the target dies or stop
          }
        } else if (target) { bot.pvp.forceStop(); target = null } // only a creeper, farther than CREEPER_RANGE
        await sleep(500, signal)
      }
      return `30 秒后仍有 ${nearestHostile(bot, 12)?.e.name ?? '威胁'}，交回`
    } finally {
      bot.pvp.forceStop()
    }
  }
}

/**
 * Where to run: of 16 directions, skipping those towards a hostile within
 * 6 blocks, the walkable stretch (up to 10 blocks, one step up or down at a
 * time) whose end is farthest from the nearest hostile. null when no end is
 * more than 3 blocks from one (cornered: fight).
 */
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

export async function equipWeapon (bot) {
  const have = bot.inventory.items()
  for (const name of WEAPONS) {
    if (bot.heldItem?.name === name) return
    const item = have.find(i => i.name === name)
    if (item) return bot.equip(item, 'hand')
  }
}

/** Head inside a solid block: dig it out, or step to a free neighbour. */
export const escape = {
  check: bot => (headBlocked(bot) ? `头部在 ${bot.blockAt(bot.entity.position.offset(0, 1.6, 0)).name} 里` : null),
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
    return headBlocked(bot) ? '还在方块里' : '头部已经空出'
  }
}

export function headBlocked (bot) {
  const head = bot.entity && bot.blockAt(bot.entity.position.offset(0, 1.6, 0))
  return Boolean(head && head.boundingBox === 'block')
}

/** Something worth eating, by mineflayer-auto-eat's food list and its banned foods. */
export function foodItem (bot) {
  const ae = bot.autoEat
  if (!ae) return null
  return bot.inventory.items().find(i => ae.foodsByName[i.name] && !ae.opts.bannedFood.includes(i.name))
}

export const eat = {
  check: bot => (bot.food <= 14 && foodItem(bot) ? `饥饿 ${bot.food}` : null),
  // mineflayer-auto-eat picks the food, equips it and puts the old item back.
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
    return out.length ? `饥饿 ${out.join('，')}` : '没吃'
  }
}

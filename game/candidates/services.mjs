// SPDX-License-Identifier: MIT
// Candidate services (see README). Each is { check?(bot), run(bot, ctx) };
// run checks ctx.signal at entry and after every await, and returns or throws
// before any further game action once it has aborted.
import pathfinderPkg from 'mineflayer-pathfinder'
import { isHostile } from '../observers/radar-report.mjs'
const { goals } = pathfinderPkg

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms)
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason) }, { once: true })
})

export function nearestHostile (bot, range = 16) {
  const me = bot.entity?.position
  let best = null
  for (const e of Object.values(bot.entities ?? {})) {
    if (!isHostile(e) || !e.position || !me) continue
    const d = e.position.distanceTo(me)
    if (d <= range && (!best || d < best.d)) best = { e, d }
  }
  return best
}

/** Fight back with mineflayer-pvp while health allows, otherwise run; ends when nothing is near. */
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
          if (++calm >= 6) return '周围安全'
          await sleep(500, signal)
          continue
        }
        calm = 0
        if (bot.health > 6) {
          if (target !== h.e) {
            await equipWeapon(bot)
            signal.throwIfAborted()
            target = h.e
            bot.pvp.attack(h.e) // follows and swings until the target dies or stop
          }
        } else {
          if (target) { bot.pvp.forceStop(); target = null }
          // Run directly away for a few blocks.
          const away = bot.entity.position.minus(h.e.position).normalize().scaled(8).plus(bot.entity.position)
          bot.pathfinder.setGoal(new goals.GoalNear(away.x, away.y, away.z, 2))
        }
        await sleep(500, signal)
      }
      return `30 秒后仍有 ${nearestHostile(bot, 12)?.e.name ?? '威胁'}，交回`
    } finally {
      bot.pvp.forceStop()
    }
  }
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

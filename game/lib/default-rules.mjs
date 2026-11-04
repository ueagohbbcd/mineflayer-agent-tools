// SPDX-License-Identifier: MIT
// First-version rules. Each one is small on purpose: copy one into main.mjs
// and edit it when it gets something wrong.
import { heldKeys } from './inputs.mjs'

const TICK_MS = 50

/**
 * Low air: hold jump (everything else released) until air is back.
 * Taking over is only recorded. It notifies when air is nearly gone, which
 * also covers a plugin that keeps the bot under water.
 */
export function lowAir ({ below = 8, recovered = 18, critical = 3 } = {}) {
  return {
    name: 'low-air',
    check (bot, mem) {
      const air = bot.oxygenLevel ?? 20
      if (!mem.active && air <= below) mem.active = true
      else if (mem.active && air >= recovered) mem.active = false
      if (!mem.active) return null
      return {
        inputs: { jump: true },
        notice: air <= critical ? `氧气只剩 ${air}/20，角色仍在水下（手上的键：${heldKeys(bot).join(',') || '无'}）` : null
      }
    }
  }
}

/** Movement keys held but the position barely changes. Notice only. */
export function noProgress ({ seconds = 10, blocks = 1 } = {}) {
  return {
    name: 'no-progress',
    check (bot, mem) {
      const moving = bot.controlState.forward || bot.controlState.back || bot.controlState.left || bot.controlState.right
      const pos = bot.entity.position
      if (!moving || !mem.start) {
        mem.start = moving ? { pos: pos.clone(), at: Date.now() } : null
        return null
      }
      const moved = pos.distanceTo(mem.start.pos)
      if (moved > blocks) {
        mem.start = { pos: pos.clone(), at: Date.now() }
        return null
      }
      const held = (Date.now() - mem.start.at) / 1000
      if (held < seconds) return null
      const blocked = bot.entity.isCollidedHorizontally ? '，水平方向被挡' : ''
      return { notice: `移动键按了 ${held.toFixed(0)} 秒，位置只变了 ${moved.toFixed(1)} 格（朝向 ${facing(bot.entity.yaw)}${blocked}）` }
    }
  }
}

/** Dying again close to the previous death. Notice only. */
export function repeatDeath ({ radius = 4 } = {}) {
  return {
    name: 'repeat-death',
    check (bot, mem, { events }) {
      const deaths = events.deaths
      if (deaths.length === (mem.seen ?? 0)) return null
      mem.seen = deaths.length
      if (deaths.length < 2) return null
      const [a, b] = deaths.slice(-2)
      if (!a.pos || !b.pos || a.pos.distanceTo(b.pos) > radius) return null
      return { notice: `又在同一处死亡（${fmt(b.pos)}，上次 ${fmt(a.pos)}）` }
    }
  }
}

/** Pathfinder keeps reporting noPath. Notice only. */
export function repeatNoPath ({ count = 3, withinSeconds = 30 } = {}) {
  return {
    name: 'repeat-no-path',
    check (bot, mem, { events }) {
      const recent = events.noPath.filter(t => Date.now() - t <= withinSeconds * 1000)
      if (recent.length < count) return null
      return { notice: `寻路 ${withinSeconds} 秒内 ${recent.length} 次报告无路可走` }
    }
  }
}

export function defaultRules () {
  return [lowAir(), noProgress(), repeatDeath(), repeatNoPath()]
}

function facing (yaw) {
  // Mineflayer yaw: 0 = north (-z), increasing counter-clockwise seen from above.
  const names = ['北', '西北', '西', '西南', '南', '东南', '东', '东北']
  const i = Math.round(((yaw % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) / (Math.PI / 4)) % 8
  return names[i]
}

function fmt (pos) {
  return `${Math.floor(pos.x)} ${Math.floor(pos.y)} ${Math.floor(pos.z)}`
}

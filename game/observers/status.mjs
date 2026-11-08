// SPDX-License-Identifier: MIT
// Short self-state report: bars, time of day, place, gear, inventory changes
// and deaths since the last report.
import { oxygenOf } from '../observation/snapshot.mjs'

const NIGHT = 13000
const DAWN = 23000

export function statusReport (bot) {
  let lastInventory = null
  const deaths = []
  const respawns = []
  bot.on('death', () => {
    const p = bot.entity?.position
    deaths.push(p ? [p.x, p.y, p.z].map(Math.floor).join(' ') : '?')
  })
  bot.on('respawn', () => {
    setTimeout(() => {
      const p = bot.entity?.position
      respawns.push(p ? [p.x, p.y, p.z].map(Math.floor).join(' ') : '?')
    }, 500)
  })

  return () => {
    const lines = []
    if (deaths.length) lines.push(`上次报告以来死亡 ${deaths.length} 次：${deaths.join('；')}${respawns.length ? `，重生在 ${respawns.at(-1)}` : ''}（掉落物 5 分钟后消失）`)
    deaths.length = 0
    respawns.length = 0
    const p = bot.entity?.position
    lines.push(`血 ${round(bot.health)}/20 饥饿 ${bot.food}/20 氧气 ${oxygenOf(bot) ?? 20}/20`)
    lines.push(timeLine(bot.time?.timeOfDay))
    if (p) lines.push(`位置 ${[p.x, p.y, p.z].map(n => Math.round(n)).join(' ')}（${String(bot.game?.dimension ?? '').replace('minecraft:', '')}）`)
    const armor = [5, 6, 7, 8].map(s => bot.inventory?.slots?.[s]?.name).filter(Boolean)
    lines.push(`手持 ${bot.heldItem?.name ?? '空'}；护甲 ${armor.join(', ') || '无'}`)
    const now = countItems(bot)
    if (lastInventory) {
      const diff = []
      for (const name of new Set([...Object.keys(now), ...Object.keys(lastInventory)])) {
        const d = (now[name] ?? 0) - (lastInventory[name] ?? 0)
        if (d) diff.push(`${name} ${d > 0 ? '+' : ''}${d}`)
      }
      lines.push(`背包变化：${diff.join(', ') || '无'}`)
    } else {
      lines.push(`背包：${Object.entries(now).map(([n, c]) => `${n} ${c}`).join(', ') || '空'}`)
    }
    lastInventory = now
    return lines.join('\n')
  }
}

function timeLine (t) {
  if (typeof t !== 'number') return '时间未知'
  const minutes = ticks => Math.round(ticks / 20 / 60 * 10) / 10
  if (t < NIGHT) return `白天（${t}），天黑还有约 ${minutes(NIGHT - t)} 分钟`
  if (t < DAWN) return `夜里（${t}），天亮还有约 ${minutes(DAWN - t)} 分钟`
  return `黎明（${t}），太阳出来了，亡灵在阳光下会烧起来`
}

function countItems (bot) {
  const out = {}
  for (const item of bot.inventory?.items?.() ?? []) out[item.name] = (out[item.name] ?? 0) + item.count
  return out
}

const round = n => Math.round((n ?? 0) * 10) / 10

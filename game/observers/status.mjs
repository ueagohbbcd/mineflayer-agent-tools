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
    if (deaths.length) lines.push(`died ${deaths.length} ${deaths.length === 1 ? 'time' : 'times'} since the last report: at ${deaths.join('; at ')}${respawns.length ? `; respawned at ${respawns.at(-1)}` : ''} (dropped items vanish after 5 minutes)`)
    deaths.length = 0
    respawns.length = 0
    const p = bot.entity?.position
    lines.push(`health ${round(bot.health)}/20 food ${bot.food}/20 air ${oxygenOf(bot) ?? 20}/20`)
    lines.push(timeLine(bot.time?.timeOfDay))
    if (p) lines.push(`position ${[p.x, p.y, p.z].map(n => Math.round(n)).join(' ')} (${String(bot.game?.dimension ?? '').replace('minecraft:', '')})`)
    const armor = [5, 6, 7, 8].map(s => bot.inventory?.slots?.[s]?.name).filter(Boolean)
    lines.push(`held ${bot.heldItem?.name ?? 'nothing'}; armor ${armor.join(', ') || 'none'}`)
    const now = countItems(bot)
    if (lastInventory) {
      const diff = []
      for (const name of new Set([...Object.keys(now), ...Object.keys(lastInventory)])) {
        const d = (now[name] ?? 0) - (lastInventory[name] ?? 0)
        if (d) diff.push(`${name} ${d > 0 ? '+' : ''}${d}`)
      }
      lines.push(`inventory changes: ${diff.join(', ') || 'none'}`)
    } else {
      lines.push(`inventory: ${Object.entries(now).map(([n, c]) => `${n} ${c}`).join(', ') || 'empty'}`)
    }
    lastInventory = now
    return lines.join('\n')
  }
}

function timeLine (t) {
  if (typeof t !== 'number') return 'time unknown'
  const minutes = ticks => Math.round(ticks / 20 / 60 * 10) / 10
  if (t < NIGHT) return `day (${t}), night in about ${minutes(NIGHT - t)} min`
  if (t < DAWN) return `night (${t}), dawn in about ${minutes(DAWN - t)} min`
  return `dawn (${t}), the sun is up; undead burn in sunlight`
}

function countItems (bot) {
  const out = {}
  for (const item of bot.inventory?.items?.() ?? []) out[item.name] = (out[item.name] ?? 0) + item.count
  return out
}

const round = n => Math.round((n ?? 0) * 10) / 10

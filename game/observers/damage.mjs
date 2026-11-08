// SPDX-License-Identifier: MIT
// Damage taken, with the game's own damage type (in_wall, fall, drown, mob
// attack, arrow, ...). Call it right after createBot: the type names come in
// the registry data sent before the bot spawns.
//
// const damage = watchDamage(bot); damage.on(fn) gets { type, source, health }
// for each hit; damage.report() lists hits since the last report.
export function watchDamage (bot) {
  let types = []
  const hits = []
  const listeners = []
  bot._client.on('registry_data', packet => {
    if (packet?.id === 'minecraft:damage_type' && Array.isArray(packet.entries)) {
      types = packet.entries.map(e => String(e.key).replace('minecraft:', ''))
    }
  })
  bot._client.on('damage_event', packet => {
    if (!bot.entity || packet.entityId !== bot.entity.id) return
    const source = bot.entities[packet.sourceCauseId - 1] ?? bot.entities[packet.sourceDirectId - 1]
    const hit = {
      at: Date.now(),
      type: types[packet.sourceTypeId] ?? `type#${packet.sourceTypeId}`,
      source: source ? (source.username ?? source.name) : null
    }
    // Health arrives in its own packet right after; read it then.
    setTimeout(() => {
      hit.health = Math.round((bot.health ?? 0) * 10) / 10
      hits.push(hit)
      if (hits.length > 200) hits.shift()
      for (const fn of listeners) {
        try { fn(hit) } catch {}
      }
    }, 100)
  })
  let reportedUpTo = 0
  return {
    on: fn => listeners.push(fn),
    hits,
    report () {
      const recent = hits.filter(h => h.at > reportedUpTo)
      reportedUpTo = Date.now()
      if (!recent.length) return ''
      const groups = new Map()
      for (const h of recent) {
        const key = h.source ? `${h.type}（${h.source}）` : h.type
        groups.set(key, (groups.get(key) ?? 0) + 1)
      }
      return `上次报告以来受伤 ${recent.length} 次：${[...groups].map(([k, n]) => `${k}×${n}`).join(', ')}；最低血量 ${Math.min(...recent.map(h => h.health))}`
    }
  }
}

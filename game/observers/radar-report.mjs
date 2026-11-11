// SPDX-License-Identifier: MIT
// Short radar report: hostile mobs within 24 blocks and players within 64,
// as they are now.
export function radarReport (bot, { hostileRange = 24, playerRange = 64 } = {}) {
  return () => {
    const me = bot.entity?.position
    if (!me) return ''
    const mobs = new Map()
    const players = []
    for (const e of Object.values(bot.entities ?? {})) {
      if (e === bot.entity || !e.position) continue
      const d = e.position.distanceTo(me)
      if (e.type === 'player' && d <= playerRange) players.push(`${e.username} ${Math.round(d)} blocks away`)
      else if (isHostile(e) && d <= hostileRange) {
        const m = mobs.get(e.name) ?? { count: 0, nearest: Infinity }
        m.count++
        m.nearest = Math.min(m.nearest, d)
        mobs.set(e.name, m)
      }
    }
    const list = [...mobs].sort((a, b) => a[1].nearest - b[1].nearest).map(([n, m]) => `${n}×${m.count} (nearest ${Math.round(m.nearest)} blocks away)`)
    return [
      `hostile mobs within ${hostileRange} blocks: ${list.join(', ') || 'none'}`,
      ...(players.length ? [`players within ${playerRange} blocks: ${players.join(', ')}`] : [])
    ].join('\n')
  }
}

export function isHostile (e) {
  return e?.type === 'hostile' || e?.kind === 'Hostile mobs'
}

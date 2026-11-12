// SPDX-License-Identifier: MIT
// Read-only query: the nearest blocks of the given names, one line each, with
// position and distance. Each of three players wrote this first in a playtest.
//
//   node game.mjs query <toolkit>/game/queries/find-blocks.mjs iron_ore,deepslate_iron_ore
//   node game.mjs query <toolkit>/game/queries/find-blocks.mjs '*_log' 5 32     names, count, max distance
//
// A query gets (bot, ctx) like a task, with ctx.args; it must not act. Its
// return value is printed, so a short text is better than a large object.

/**
 * Block ids for names with `*` as a wildcard (`*_log`, `iron_ore`). Throws
 * when a name matches no block, so a typo fails loudly instead of finding nothing.
 */
export function blockIds (bot, names) {
  const ids = []
  for (const name of names) {
    const re = new RegExp(`^${name.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`)
    const found = Object.values(bot.registry.blocksByName).filter(b => re.test(b.name)).map(b => b.id)
    if (!found.length) throw new Error(`no block named ${name}`)
    ids.push(...found)
  }
  return ids
}

export default async function findBlocks (bot, ctx) {
  const [list, count = 10, maxDistance = 64] = ctx.args
  if (!list) throw new Error('usage: query find-blocks.mjs NAME[,NAME...] [count=10] [maxDistance=64]   (* is a wildcard: *_log)')
  const me = bot.entity.position
  const found = bot.findBlocks({ matching: blockIds(bot, list.split(',')), maxDistance: Number(maxDistance), count: Number(count) })
    .map(p => ({ p, d: p.offset(0.5, 0.5, 0.5).distanceTo(me) }))
    .sort((a, b) => a.d - b.d)
  if (!found.length) return `no ${list} within ${maxDistance} blocks of ${me.floored()}`
  const lines = found.map(({ p, d }) => {
    const dy = p.y - Math.floor(me.y)
    return `${bot.blockAt(p)?.name} ${p.x} ${p.y} ${p.z}  ${d.toFixed(1)} blocks${dy ? `, ${Math.abs(dy)} ${dy > 0 ? 'up' : 'down'}` : ''}`
  })
  return [`nearest ${found.length} of ${list} within ${maxDistance} blocks of ${me.floored()}:`, ...lines].join('\n')
}

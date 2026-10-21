'use strict'
const { Vec3 } = require('vec3')

/** Live Mineflayer data wins; optional history is only for unloaded chunks.
 * Read is synchronous: await memory.ready before using restored history.
 * Result.source is 'live', 'historical', or 'unknown'; unknown is NOT air.
 */
function readWorldBlock (bot, position, memory = null) {
  if (!bot || typeof bot !== 'object') throw new TypeError('bot is required')
  const { x, y, z } = position || {}
  if (![x, y, z].every(Number.isSafeInteger)) throw new TypeError('coordinates must be integers')
  const current = String(bot.game?.dimension || 'overworld')
  const dimension = String(position.dimension ?? current)
  const cx = Math.floor(x / 16), cz = Math.floor(z / 16)
  const unknown = loaded => ({ block: null, source: 'unknown', loaded, observedAt: null })
  if (dimension === current) {
    const live = typeof bot.blockAt === 'function' ? bot.blockAt(new Vec3(x, y, z)) : null
    if (live != null) return { block: live, source: 'live', loaded: true, observedAt: null }
    const loaded = typeof bot.world?.getColumn === 'function'
      ? Boolean(bot.world.getColumn(cx, cz))
      : typeof bot.world?.getColumnAt === 'function'
        ? Boolean(bot.world.getColumnAt(new Vec3(x, y, z))) : false
    if (loaded) return unknown(true)
  }
  if (!memory) return unknown(false)
  const info = memory.chunkInfo({ x: cx, z: cz, dimension })
  if (!info || info.loaded !== false) return unknown(Boolean(info?.loaded))
  const block = memory.block({ x, y, z, dimension })
  if (block == null) return unknown(false)
  return { block, source: 'historical', loaded: false,
    observedAt: Number.isFinite(info.observedAt) ? info.observedAt : null }
}
module.exports = { readWorldBlock }

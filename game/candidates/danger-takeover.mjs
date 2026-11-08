// SPDX-License-Identifier: MIT
// Candidate active takeover (see README): asks the host for `defend` when a
// hostile mob hurts the character and health drops below `health`, and for
// `escape` on suffocation. Mode is 'stop': the work ends, idle follows.
import { isHostile } from '../observers/radar-report.mjs'

export function dangerTakeover (bot, host, damage, { health = 12 } = {}) {
  damage.on(hit => {
    if (hit.type === 'in_wall') {
      host.takeover('escape', { mode: 'stop', reason: '窒息（头部在方块里）' })
      return
    }
    const source = Object.values(bot.entities).find(e => (e.username ?? e.name) === hit.source)
    if (hit.health < health && (isHostile(source) || hit.type === 'arrow' || hit.type === 'mob_attack')) {
      host.takeover('defend', { mode: 'stop', reason: `被 ${hit.source ?? hit.type} 打到 ${hit.health} 血` })
    }
  })
}

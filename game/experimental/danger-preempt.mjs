// SPDX-License-Identifier: MIT
// Experimental observer (see README): preempts with `defend` when a hostile
// mob hurts the character and health drops below `health`, and with `escape`
// on suffocation. then 'end': the job ends, idle follows.
import { isHostile } from '../observers/radar-report.mjs'

export function dangerPreempt (bot, host, damage, { health = 12 } = {}) {
  damage.on(hit => {
    if (hit.type === 'in_wall') {
      host.preempt('escape', { then: 'end', reason: '窒息（头部在方块里）' })
      return
    }
    const source = Object.values(bot.entities).find(e => (e.username ?? e.name) === hit.source)
    if (hit.health < health && (isHostile(source) || hit.type === 'arrow' || hit.type === 'mob_attack')) {
      host.preempt('defend', { then: 'end', reason: `被 ${hit.source ?? hit.type} 打到 ${hit.health} 血` })
    }
  })
}

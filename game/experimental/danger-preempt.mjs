// SPDX-License-Identifier: MIT
// Experimental observer (see README): preempts with `defend` when a hostile
// mob hurts the character and health drops below `health`, and with `escape`
// on suffocation. then 'end': the job ends, idle follows.
import { isHostile } from '../observers/radar-report.mjs'

// Does: on each hit from `damage` (watchDamage), preempts with `escape` for
//   in_wall and with `defend` for a hostile hit below `health` (12).
// Checked: 2026-11-08: defend at 8 health, escape on in_wall (1 run each);
//   2026-11-10: a job preempted by defend in 2 of 3 runs, escape in 1 run.
// Limits: explosions and drowning do not preempt (creeper 3/3, playtest
//   2026-11-10 drown death); the 12 threshold is not compared with others.
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

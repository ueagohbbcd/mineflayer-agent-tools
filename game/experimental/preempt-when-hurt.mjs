// SPDX-License-Identifier: MIT
// Experimental observer (see README): preempts with `fightOrFlee` when a
// hostile mob hurts the character and health drops below `health`, and with
// `digHeadFree` on suffocation. then 'end': the job ends, idle follows.
import { isHostile } from '../observers/radar-report.mjs'

// Does: on each hit from `damage` (watchDamage), preempts with `digHeadFree`
//   for in_wall and with `fightOrFlee` for a hostile hit below `health` (12).
// Checked: 2026-11-08: fightOrFlee at 8 health, digHeadFree on in_wall (1 run
//   each); 2026-11-10: a job preempted by fightOrFlee in 2 of 3 runs,
//   digHeadFree in 1 run.
// Limits: explosions do not preempt (creeper 3/3); drowning is
//   preemptWhenDrowning's; the 12 threshold is not compared with others.
export function preemptWhenHurt (bot, host, damage, { health = 12 } = {}) {
  damage.on(hit => {
    if (hit.type === 'in_wall') {
      host.preempt('digHeadFree', { then: 'end', reason: 'suffocating, head inside a block' })
      return
    }
    const source = Object.values(bot.entities).find(e => (e.username ?? e.name) === hit.source)
    if (hit.health < health && (isHostile(source) || hit.type === 'arrow' || hit.type === 'mob_attack')) {
      host.preempt('fightOrFlee', { then: 'end', reason: `hit by ${hit.source ?? hit.type}, health ${hit.health}` })
    }
  })
}

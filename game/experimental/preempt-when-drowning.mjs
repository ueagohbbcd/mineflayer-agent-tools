// SPDX-License-Identifier: MIT
// Experimental observer (see README): preempts with the `surfaceForAir` reflex
// when the character is about to drown, whoever holds it (a task or idle).
// then 'end': the job ends with the reason and idle follows.
//
//   preemptWhenDrowning(bot, host, damage)    in main, after createHost
import { headInWater, surfaceForAir } from './reflexes.mjs'

// Does: asks host.preempt('surfaceForAir') on each `drown` hit (watchDamage),
//   and when surfaceForAir.check fires (head under water, air 10/20 or less),
//   checked every 0.5 s. A refused request (another reflex holds the bot, an
//   exit is in progress) is dropped; the next check asks again.
// Checked: 2026-11-12: a job held 7 blocks under water was preempted at
//   air 10, 4/4 runs (3 survived; 1 drowned under bedrock, where nothing helps).
// Limits: a reflex already in control (fightOrFlee) is not preempted, so a
//   fight under water goes on until it ends.
export function preemptWhenDrowning (bot, host, damage) {
  const ask = reason => host.preempt('surfaceForAir', { then: 'end', reason })
  // The head check drops the lethal hit, which arrives after the respawn.
  damage.on(hit => { if (hit.type === 'drown' && headInWater(bot)) ask(`drowning, health ${hit.health}`) })
  const timer = setInterval(() => {
    const why = bot.entity && surfaceForAir.check(bot)
    if (why && host.controller?.name !== 'surfaceForAir') ask(why)
  }, 500)
  bot.once('end', () => clearInterval(timer))
}

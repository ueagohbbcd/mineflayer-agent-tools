// SPDX-License-Identifier: MIT
// Experimental idle loop (see README): what the character does with no job.
// main passes it as the host's idle: createHost(bot, { idle: stayAlive }).
//
// The shape of an idle: an async function (bot, ctx) like a task, without
// args or log. The host starts it whenever no job runs and aborts ctx.signal
// when a job, a preempt or a death takes the bot, so it loops until the
// signal and keeps each step short. It calls reflexes' run() directly instead
// of preempting (it already holds the bot). If it returns, the host starts it
// again after 1 s; if it throws, the error wakes the model (3 times at most).
import { CREEPER_RANGE, digHeadFree, eatWhenHungry, fightOrFlee, foodItem, headBlocked, isCreeper, nearestHostile } from './reflexes.mjs'

// Does: the no-job loop every 250 ms: digHeadFree when the head is in a block,
//   fightOrFlee when hurt or a creeper is near, jump in water, eatWhenHungry
//   when hungry or hurt below 18 food.
// Checked: 2026-11-10: skeleton, spider, two zombies 3/3 each without death;
//   night on open ground 5 min, 3 runs survived (lowest 5, 14, 20 health).
// Limits: always-jump in water not rechecked since 2026-11-08; a creeper keeps
//   following (alive after 150 s, 3/3); drowning is preemptWhenDrowning's
//   (it preempts idle too).
export async function stayAlive (bot, ctx) {
  const { signal } = ctx
  let lastHurt = 0
  const onHurt = e => { if (e === bot.entity) lastHurt = Date.now() }
  bot.on('entityHurt', onHurt)
  // cleanup: the listener goes on every exit, however the loop ends.
  ctx.cleanup(() => bot.off('entityHurt', onHurt))
  while (!signal.aborted) { // the exit rule as the loop condition
    if (headBlocked(bot)) await digHeadFree.run(bot, ctx)
    else if ((nearestHostile(bot, 4) && (Date.now() - lastHurt < 5000 || bot.health < 20)) || nearestHostile(bot, CREEPER_RANGE, isCreeper)) await fightOrFlee.run(bot, ctx)
    else if (bot.entity.isInWater) bot.setControlState('jump', true) // stay at the surface
    // Hurt and below 18 food: eat too, health only regenerates from 18 up.
    else if (eatWhenHungry.check(bot) || (bot.health < 20 && bot.food < 18 && foodItem(bot))) await eatWhenHungry.run(bot, ctx)
    else bot.setControlState('jump', false)
    await new Promise(resolve => setTimeout(resolve, 250))
  }
}

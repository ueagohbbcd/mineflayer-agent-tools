// SPDX-License-Identifier: MIT
// Experimental idle loop (see README): what the character does with no job.
import { CREEPER_RANGE, defend, eat, escape, foodItem, headBlocked, isCreeper, nearestHostile } from './reflexes.mjs'

export async function idle (bot, ctx) {
  const { signal } = ctx
  let lastHurt = 0
  const onHurt = e => { if (e === bot.entity) lastHurt = Date.now() }
  bot.on('entityHurt', onHurt)
  ctx.cleanup(() => bot.off('entityHurt', onHurt))
  while (!signal.aborted) {
    if (headBlocked(bot)) await escape.run(bot, ctx)
    else if ((nearestHostile(bot, 4) && (Date.now() - lastHurt < 5000 || bot.health < 20)) || nearestHostile(bot, CREEPER_RANGE, isCreeper)) await defend.run(bot, ctx)
    else if (bot.entity.isInWater) bot.setControlState('jump', true) // stay at the surface
    // Hurt and below 18 food: eat too, health only regenerates from 18 up.
    else if (eat.check(bot) || (bot.health < 20 && bot.food < 18 && foodItem(bot))) await eat.run(bot, ctx)
    else bot.setControlState('jump', false)
    await new Promise(resolve => setTimeout(resolve, 250))
  }
}

// SPDX-License-Identifier: MIT
// Candidate idle loop (see README): what the character does with no work.
import { defend, eat, escape, headBlocked, nearestHostile } from './services.mjs'

export async function idle (bot, ctx) {
  const { signal } = ctx
  let lastHurt = 0
  const onHurt = e => { if (e === bot.entity) lastHurt = Date.now() }
  bot.on('entityHurt', onHurt)
  ctx.cleanup(() => bot.off('entityHurt', onHurt))
  while (!signal.aborted) {
    if (headBlocked(bot)) await escape.run(bot, ctx)
    else if (nearestHostile(bot, 4) && (Date.now() - lastHurt < 5000 || bot.health < 20)) await defend.run(bot, ctx)
    else if (bot.entity.isInWater) bot.setControlState('jump', true) // stay at the surface
    else if (eat.check(bot)) await eat.run(bot, ctx)
    else bot.setControlState('jump', false)
    await new Promise(resolve => setTimeout(resolve, 250))
  }
}

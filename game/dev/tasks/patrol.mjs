// A long walk: back and forth between two points with walkTo.
//
//   node game.mjs run tasks/patrol.mjs X1 Y1 Z1 X2 Y2 Z2 [legs=4] [eat]
//
// With the word `eat` at the end, walkTo gets checks { eatWhenHungry: 'restart' }:
// when food is 14 or lower the eatWhenHungry reflex preempts the task, which
// then runs again from its entry (ctx.attempt counts the attempts).
import { walkTo } from 'mineflayer-world-memory/game/experimental/walk-to.mjs'

export default async function task (bot, ctx) {
  const [x1, y1, z1, x2, y2, z2, legs = 4] = ctx.args.slice(0, 7).map(Number)
  const checks = ctx.args.includes('eat') ? { eatWhenHungry: 'restart' } : {}
  ctx.log(`attempt ${ctx.attempt}, food ${bot.food}, checks ${JSON.stringify(checks)}`)
  for (let i = 0; i < legs; i++) {
    const to = i % 2 === 0 ? [x2, y2, z2] : [x1, y1, z1]
    const r = await walkTo(bot, ctx, to, { checks })
    ctx.log(`leg ${i + 1} reached ${r.arrived.join(' ')}, health ${Math.round(bot.health)}, food ${bot.food}`)
  }
  const p = bot.entity.position.floored()
  return { at: [p.x, p.y, p.z], legs, attempt: ctx.attempt }
}

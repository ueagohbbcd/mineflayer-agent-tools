// A long walk: back and forth between two points with goto.
//
//   node game.mjs run tasks/patrol.mjs X1 Y1 Z1 X2 Y2 Z2 [legs=4] [eat]
//
// With the word `eat` at the end, goto gets checks { eat: 'restart' }: when
// food is 14 or lower the eat reflex preempts the task, which then runs again
// from its entry (ctx.attempt counts the attempts).
import { goto } from 'mineflayer-world-memory/game/experimental/goto.mjs'

export default async function task (bot, ctx) {
  const [x1, y1, z1, x2, y2, z2, legs = 4] = ctx.args.slice(0, 7).map(Number)
  const checks = ctx.args.includes('eat') ? { eat: 'restart' } : {}
  ctx.log(`第 ${ctx.attempt} 次运行，food ${bot.food}，checks ${JSON.stringify(checks)}`)
  for (let i = 0; i < legs; i++) {
    const to = i % 2 === 0 ? [x2, y2, z2] : [x1, y1, z1]
    const r = await goto(bot, ctx, to, { checks })
    ctx.log(`第 ${i + 1} 段到 ${r.arrived.join(' ')}，血 ${Math.round(bot.health)}，food ${bot.food}`)
  }
  const p = bot.entity.position.floored()
  return { at: [p.x, p.y, p.z], legs, attempt: ctx.attempt }
}

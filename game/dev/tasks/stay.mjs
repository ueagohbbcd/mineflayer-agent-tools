// Stays where it is for N seconds, logging air every 2 s; ends at once on
// abort. For scenarios that hold the character somewhere during a job
// (under water: surfaceForAir and preemptWhenDrowning).
//
//   node game.mjs run tasks/stay.mjs [seconds=60]
import { oxygenOf } from 'mineflayer-world-memory/game/index.mjs'

export default async function task (bot, ctx) {
  const until = Date.now() + Number(ctx.args[0] ?? 60) * 1000
  for (let i = 0; Date.now() < until; i++) {
    await new Promise(resolve => setTimeout(resolve, 500))
    if (ctx.signal.aborted) return
    if (i % 4 === 0) ctx.log(`air ${oxygenOf(bot)}/20, health ${Math.round(bot.health)}, at ${bot.entity.position.floored()}`)
  }
  return 'stayed'
}

// Walk to X Y Z and return where the character stands.
//
//   node game.mjs run tasks/example.mjs X Y Z
//
// A task is a module whose default export gets the bot and ctx:
//   ctx.args    the words after the file name, as strings
//   ctx.log     a line for the run output and the result
//   ctx.signal  aborts when the work must end (cancel, new work, takeover, death)
// The return value is the result; a thrown error is the failure.
import { goto } from 'mineflayer-world-memory/game/candidates/goto.mjs'

export default async function task (bot, ctx) {
  const [x, y, z] = ctx.args.map(Number)
  if (![x, y, z].every(Number.isFinite)) throw new Error('用法：run tasks/example.mjs X Y Z')
  ctx.log(`from ${bot.entity.position.floored()} to ${x} ${y} ${z}`)

  // goto stops by itself when ctx.signal aborts; nothing to check here.
  await goto(bot, ctx, [x, y, z])

  // The one exit rule, after any await of your own: aborted → return.
  await bot.waitForTicks(10) // let the character come to rest
  if (ctx.signal.aborted) return

  const p = bot.entity.position.floored()
  return { at: [p.x, p.y, p.z] }
}

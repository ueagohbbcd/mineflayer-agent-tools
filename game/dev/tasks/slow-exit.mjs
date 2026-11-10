// Obeys the abort, but slowly: after the signal it takes 3 s (within the 5 s
// grace) before returning. Keeps a preempt or replacement queued for those
// 3 s, long enough to cancel, kill or submit by hand in between.
//
//   node game.mjs run tasks/slow-exit.mjs [seconds=120]
export default async function task (bot, ctx) {
  const until = Date.now() + Number(ctx.args[0] ?? 120) * 1000
  let n = 0
  while (Date.now() < until) {
    await new Promise(resolve => setTimeout(resolve, 500))
    if (ctx.signal.aborted) {
      ctx.log(`收到退出（${ctx.signal.reason?.reason ?? ctx.signal.reason}），3 秒后返回`)
      await new Promise(resolve => setTimeout(resolve, 3000))
      return 'exited slowly'
    }
    if (++n % 10 === 0) ctx.log(`仍在运行，血 ${Math.round(bot.health)}`)
  }
  return 'time up'
}

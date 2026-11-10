// Ignores its signal: logs one line, then waits 12 s no matter what.
export default async function task (bot, ctx) {
  ctx.log('等 12 秒，不看退出信号')
  await new Promise(resolve => setTimeout(resolve, 12000))
  return 'finished anyway'
}

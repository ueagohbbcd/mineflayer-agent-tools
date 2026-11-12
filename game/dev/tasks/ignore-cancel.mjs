// Ignores its signal: logs one line, then waits 12 s no matter what.
export default async function task (bot, ctx) {
  ctx.log('waiting 12 s, ignoring the abort')
  await new Promise(resolve => setTimeout(resolve, 12000))
  return 'finished anyway'
}

export default async function task () {
  await new Promise(resolve => setTimeout(resolve, 1000))
  throw new Error('故意抛错，验证下一项任务能接手')
}

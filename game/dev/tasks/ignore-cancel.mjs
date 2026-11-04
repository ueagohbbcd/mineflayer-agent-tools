// Ignores its signal: waits 12 s no matter what.
export default async function task () {
  await new Promise(resolve => setTimeout(resolve, 12000))
  return 'finished anyway'
}

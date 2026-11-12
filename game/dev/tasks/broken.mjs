export default async function task () {
  await new Promise(resolve => setTimeout(resolve, 1000))
  throw new Error('thrown on purpose, to check that the next job takes over')
}

// A synchronous loop that holds the main thread for BUSY_SECONDS (default 8).
export default async function task () {
  const until = Date.now() + Number(process.env.BUSY_SECONDS ?? 8) * 1000
  while (Date.now() < until) {}
  return 'loop ended'
}

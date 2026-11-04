// SPDX-License-Identifier: MIT
// Minimal RCON client for setting up local test worlds.
import net from 'node:net'

export async function rcon (commands, { host = 'localhost', port = 25575, password = process.env.MC_RCON_PASSWORD ?? 'test' } = {}) {
  const socket = net.connect(port, host)
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject) })
  let buffer = Buffer.alloc(0)
  const waiters = new Map()
  socket.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk])
    while (buffer.length >= 4) {
      const len = buffer.readInt32LE(0)
      if (buffer.length < len + 4) break
      const id = buffer.readInt32LE(4)
      const body = buffer.subarray(12, len + 2).toString('utf8')
      buffer = buffer.subarray(len + 4)
      waiters.get(id)?.(body)
      waiters.delete(id)
    }
  })
  let seq = 1
  const send = (type, body) => new Promise(resolve => {
    const id = seq++
    const payload = Buffer.from(body, 'utf8')
    const packet = Buffer.alloc(14 + payload.length)
    packet.writeInt32LE(10 + payload.length, 0)
    packet.writeInt32LE(id, 4)
    packet.writeInt32LE(type, 8)
    payload.copy(packet, 12)
    waiters.set(id, resolve)
    socket.write(packet)
  })
  await send(3, password)
  const replies = []
  for (const command of commands) replies.push(await send(2, command))
  socket.end()
  return replies
}

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const reply of await rcon(process.argv.slice(2))) console.log(reply)
}

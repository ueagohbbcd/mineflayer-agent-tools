// SPDX-License-Identifier: MIT
// The local entry of a running main: a single-instance lock and a Unix
// socket that takes one JSON request per connection.
//
//   { type: 'task', file }     run a task; the reply comes when it ends. If the
//                              caller disconnects first, the task goes on and
//                              its result is sent with notifyModel instead
//   { type: 'query', file, timeoutMs }   run a read-only module now
//   { type: 'cancel', graceMs }          ask the task to stop
//   { type: 'status' }
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import watchdogModule from '../../watchdog.js'
import { gameDir } from './files.mjs'

const { watchdog } = watchdogModule

export function lockFile (dir) {
  return path.join(gameDir(dir), 'lock')
}

/** Where the socket lives; long project paths go to the temp dir instead. */
export function socketPath (dir) {
  const inProject = path.join(gameDir(dir), 'main.sock')
  if (Buffer.byteLength(inProject) < 100) return inProject
  const hash = crypto.createHash('sha1').update(path.resolve(dir)).digest('hex').slice(0, 12)
  return path.join(os.tmpdir(), `game-${hash}.sock`)
}

export function readLock (dir) {
  try {
    const lock = JSON.parse(fs.readFileSync(lockFile(dir), 'utf8'))
    process.kill(lock.pid, 0)
    return lock
  } catch {
    return null // missing, unreadable or the process is gone
  }
}

/** Take the lock or exit: a second main for the same project must not connect. */
export function takeLock (dir) {
  fs.mkdirSync(gameDir(dir), { recursive: true })
  const held = readLock(dir)
  if (held && held.pid !== process.pid) {
    console.log(`这个项目的 main 已在运行（pid ${held.pid}，${held.since} 启动）。要重启先运行 node game.mjs stop。`)
    process.exit(0)
  }
  fs.writeFileSync(lockFile(dir), JSON.stringify({ pid: process.pid, since: new Date().toISOString() }) + '\n')
  const release = () => {
    try {
      if (JSON.parse(fs.readFileSync(lockFile(dir), 'utf8')).pid === process.pid) fs.rmSync(lockFile(dir))
    } catch {}
  }
  process.on('exit', release)
}

export async function serve (game, { blockedMs = 5000 } = {}) {
  const { dir, bot } = game
  takeLock(dir)
  const sock = socketPath(dir)
  fs.rmSync(sock, { force: true })
  const blockedModule = fileURLToPath(new URL('./blocked-notice.mjs', import.meta.url))
  watchdog(bot, { report: () => {}, stuckMs: Infinity, repeatCount: Infinity, blockedMs, onBlocked: blockedModule, blockedContext: { dir } })

  const server = net.createServer(conn => {
    let buffer = ''
    conn.setEncoding('utf8')
    conn.on('error', () => {})
    conn.on('data', chunk => {
      buffer += chunk
      const nl = buffer.indexOf('\n')
      if (nl < 0) return
      const line = buffer.slice(0, nl)
      buffer = ''
      let request
      try {
        request = JSON.parse(line)
      } catch {
        return reply(conn, { ok: false, error: 'bad request' })
      }
      handle(game, request, conn).catch(error => reply(conn, { ok: false, error: error?.message ?? String(error) }))
    })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(sock, resolve)
  })
  process.on('exit', () => fs.rmSync(sock, { force: true }))
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    process.on(signal, () => {
      try { bot.quit() } catch {}
      process.exit(0)
    })
  }
  return server
}

async function handle (game, request, conn) {
  switch (request.type) {
    case 'task': {
      let attached = true
      conn.on('close', () => { attached = false })
      const summary = await game.runTask(request.file, { notifyResult: () => !attached, args: request.args ?? [] })
      return reply(conn, summary)
    }
    case 'query':
      return reply(conn, await game.runQuery(request.file, { timeoutMs: request.timeoutMs, args: request.args ?? [] }))
    case 'cancel':
      return reply(conn, await game.cancel({ graceMs: request.graceMs }))
    case 'status':
      return reply(conn, { ok: true, ...game.status() })
    default:
      return reply(conn, { ok: false, error: `unknown request type ${request.type}` })
  }
}

function reply (conn, value) {
  if (!conn.destroyed) conn.end(JSON.stringify(value) + '\n')
}

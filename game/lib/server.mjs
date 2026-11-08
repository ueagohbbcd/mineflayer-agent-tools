// SPDX-License-Identifier: MIT
// The local entry of a running main: a single-instance lock and a Unix
// socket that takes one JSON request per connection; replies are JSON lines.
//
//   { type: 'run', file, args }   submit work; streams { type: 'log' | 'event' }
//                                 lines and ends with { type: 'result' }. The
//                                 caller disconnecting only stops the stream
//   { type: 'cancel' }            cancel the current work (exit flow, no restart)
//   { type: 'wait' }              reply with the report once something is pending
//   { type: 'query', file, args, timeoutMs }   run a read-only module now
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

export async function serve (host, { blockedMs = 5000 } = {}) {
  const { dir, bot } = host
  takeLock(dir)
  const sock = socketPath(dir)
  fs.rmSync(sock, { force: true })
  fs.rmSync(blockedFile(dir), { force: true })
  const blockedModule = fileURLToPath(new URL('./blocked-notice.mjs', import.meta.url))
  watchdog(bot, { report: () => {}, stuckMs: Infinity, repeatCount: Infinity, blockedMs, onBlocked: blockedModule, blockedContext: { file: blockedFile(dir) } })

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
        return end(conn, { type: 'error', error: 'bad request' })
      }
      handle(host, request, conn).catch(error => end(conn, { type: 'error', error: error?.message ?? String(error) }))
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

export function blockedFile (dir) {
  return path.join(gameDir(dir), 'blocked.json')
}

async function handle (host, request, conn) {
  switch (request.type) {
    case 'run': {
      let open = true
      const sink = msg => {
        if (!open) return
        send(conn, msg)
        if (msg.type === 'result') { open = false; conn.end() }
      }
      conn.on('close', () => { open = false; host.work?.sinks?.delete(sink) })
      const out = await host.submit(request.file, { args: request.args ?? [], sink })
      if (!out.ok) return end(conn, { type: 'error', error: out.error })
      return send(conn, { type: 'started', id: out.id })
    }
    case 'cancel':
      return end(conn, { type: 'cancel', ...(await host.cancel(request.reason)) })
    case 'wait': {
      const left = new AbortController()
      conn.on('close', () => left.abort())
      const report = await host.waitForReport(left.signal)
      if (report === null) return // the waiter left; nothing was consumed
      if (conn.destroyed) return host.wake('上一次 wait 在报告送达前断开')
      return end(conn, { type: 'report', text: report })
    }
    case 'query':
      return end(conn, { type: 'query', ...(await host.query(request.file, { args: request.args ?? [], timeoutMs: request.timeoutMs })) })
    case 'status':
      return end(conn, { type: 'status', ...host.status() })
    default:
      return end(conn, { type: 'error', error: `unknown request type ${request.type}` })
  }
}

function send (conn, value) {
  if (!conn.destroyed) conn.write(JSON.stringify(value) + '\n')
}

function end (conn, value) {
  if (!conn.destroyed) conn.end(JSON.stringify(value) + '\n')
}

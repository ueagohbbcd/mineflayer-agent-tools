// SPDX-License-Identifier: MIT
// The local entry of a running main: a Unix socket that takes one JSON
// request per connection; replies are JSON lines. Holding the socket is what
// makes main the only one for its project directory.
//
//   const entry = await openEntry(dir)   before connecting: a second main exits here
//   await serve(host, entry)             requests reach the host from now on
//
//   { type: 'run', file, args }   submit a job; streams { type: 'log' | 'event' }
//                                 lines and ends with { type: 'result' }. The
//                                 caller disconnecting only stops the stream
//   { type: 'cancel' }            cancel the job (exit flow, no restart)
//   { type: 'wait' }              reply with the report once something is pending
//   { type: 'query', file, args, timeoutMs }   run a read-only module now
//   { type: 'status' }            includes main's pid and start time
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import watchdogModule from '../../watchdog.js'
import { gameDir } from './files.mjs'
import { runQuery } from './query.mjs'

const { watchdog } = watchdogModule

/** Where the socket lives; long project paths go to the temp dir instead. */
export function socketPath (dir) {
  const inProject = path.join(gameDir(dir), 'main.sock')
  if (Buffer.byteLength(inProject) < 100) return inProject
  const hash = crypto.createHash('sha1').update(path.resolve(dir)).digest('hex').slice(0, 12)
  return path.join(os.tmpdir(), `game-${hash}.sock`)
}

export function blockedFile (dir) {
  return path.join(gameDir(dir), 'blocked.json')
}

/**
 * Bind the project's socket, or exit when another main already answers on it.
 * A socket file nobody listens on (left by a crash) is replaced. Requests
 * that arrive before serve() get a reply that main is still starting.
 */
export async function openEntry (dir) {
  fs.mkdirSync(gameDir(dir), { recursive: true })
  const sock = socketPath(dir)
  const me = { pid: process.pid, since: new Date().toISOString() }
  const entry = { dir, path: sock, me, host: null }
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
      if (!entry.host) return end(conn, { type: 'error', error: 'main is starting and has not joined the game yet', ...me })
      handle(entry, request, conn).catch(error => end(conn, { type: 'error', error: error?.message ?? String(error) }))
    })
  })
  try {
    await listen(server, sock)
  } catch (error) {
    if (error.code !== 'EADDRINUSE') throw error
    const other = await probe(sock)
    if (other) {
      const who = other.pid ? ` (pid ${other.pid}, started ${other.since})` : ''
      console.log(`main is already running for this project${who}. To restart it, run node game.mjs stop first.`)
      process.exit(0)
    }
    fs.rmSync(sock, { force: true })
    await listen(server, sock)
  }
  process.on('exit', () => fs.rmSync(sock, { force: true }))
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    process.on(signal, () => {
      try { entry.host?.bot.quit() } catch {}
      process.exit(0)
    })
  }
  entry.server = server
  return entry
}

function listen (server, sock) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(sock, () => { server.off('error', reject); resolve() })
  })
}

/**
 * Whether something answers on the socket: null when the connection is
 * refused (a stale file), else the other main's status reply, or {} when it
 * accepts but does not reply in time (its main thread may be blocked).
 */
function probe (sock) {
  return new Promise(resolve => {
    const conn = net.connect(sock)
    let buffer = ''
    conn.setEncoding('utf8')
    conn.setTimeout(2000, () => { conn.destroy(); resolve({}) })
    conn.on('connect', () => conn.write(JSON.stringify({ type: 'status' }) + '\n'))
    conn.on('data', chunk => {
      buffer += chunk
      const nl = buffer.indexOf('\n')
      if (nl < 0) return
      conn.destroy()
      try { resolve(JSON.parse(buffer.slice(0, nl))) } catch { resolve({}) }
    })
    conn.on('error', error => resolve(error.code === 'ECONNREFUSED' || error.code === 'ENOENT' ? null : {}))
  })
}

/** Hand requests on the entry to the host; starts the blocked-thread watchdog. */
export async function serve (host, entry, { blockedMs = 5000 } = {}) {
  const { dir, bot } = host
  fs.rmSync(blockedFile(dir), { force: true })
  const blockedModule = fileURLToPath(new URL('./blocked-notice.mjs', import.meta.url))
  watchdog(bot, { report: () => {}, stuckMs: Infinity, repeatCount: Infinity, blockedMs, onBlocked: blockedModule, blockedContext: { file: blockedFile(dir), pid: process.pid } })
  entry.host = host
  return entry.server
}

async function handle ({ host, me }, request, conn) {
  switch (request.type) {
    case 'run': {
      let open = true
      const sink = msg => {
        if (!open) return
        send(conn, msg)
        if (msg.type === 'result') { open = false; conn.end() }
      }
      conn.on('close', () => { open = false; host.job?.sinks?.delete(sink) })
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
      if (conn.destroyed) return host.wake('the last wait disconnected before its report arrived')
      return end(conn, { type: 'report', text: report })
    }
    case 'query':
      return end(conn, { type: 'query', ...(await runQuery(host.bot, request.file, { args: request.args ?? [], timeoutMs: request.timeoutMs })) })
    case 'status':
      return end(conn, { type: 'status', ...me, ...host.status() })
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

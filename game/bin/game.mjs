#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Commands for a running main. Run them in the project directory (or set
// GAME_DIR).
//
//   node game.mjs run <file> [args...]   submit a job and follow it to the end;
//                                        killing this command does not cancel it
//   node game.mjs cancel                 cancel the job
//   node game.mjs wait                   return with the report when something
//                                        happens (at once if something already has)
//   node game.mjs query <file> [args...] run a read-only module now
//   node game.mjs status
//   node game.mjs stop                   end main (then start it again)
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { formatSummary } from '../lib/describe.mjs'
import { blockedFile, socketPath } from '../lib/server.mjs'

const dir = path.resolve(process.env.GAME_DIR ?? '.')
const [command, arg, ...rest] = process.argv.slice(2)
const NOT_RUNNING = 'main is not running (start node main.mjs in the background first)'
const notRunning = error => error.code === 'ENOENT' || error.code === 'ECONNREFUSED'

function fail (message) {
  console.log(message)
  process.exit(1)
}

/** One request; onMessage gets every reply line. Resolves when main closes. */
function request (body, onMessage, { timeoutMs = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const conn = net.connect(socketPath(dir))
    if (timeoutMs) {
      conn.setTimeout(timeoutMs, () => {
        conn.destroy()
        reject(new Error(`main did not reply within ${timeoutMs / 1000} s (its main thread may be blocked; node game.mjs stop, then start main again)`))
      })
    }
    let buffer = ''
    conn.setEncoding('utf8')
    conn.on('connect', () => conn.write(JSON.stringify(body) + '\n'))
    conn.on('data', chunk => {
      buffer += chunk
      let nl
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl)
        buffer = buffer.slice(nl + 1)
        if (line) onMessage(JSON.parse(line))
      }
    })
    conn.on('close', () => resolve())
    conn.on('error', error => {
      if (notRunning(error)) reject(Object.assign(new Error(NOT_RUNNING), { code: error.code }))
      else reject(error)
    })
  })
}

function alive (pid) {
  try { process.kill(pid, 0); return true } catch { return false }
}

/**
 * main's pid from its status reply; null when nothing listens on the socket.
 * A main whose thread is blocked cannot reply: its pid is then in the file
 * the watchdog worker writes once the block has lasted a few seconds.
 */
async function mainPid () {
  let out
  try {
    await request({ type: 'status' }, msg => { out = msg }, { timeoutMs: 3000 })
    if (out?.pid) return out.pid
  } catch (error) {
    if (error.code) return null
  }
  for (let i = 0; i < 100; i++) {
    const pid = blockedSince(0)?.pid
    if (pid && alive(pid)) return pid
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  fail('main does not reply and left no pid (.game/blocked.json); end the main process by hand')
}

function blockedSince (startedAt) {
  try {
    const b = JSON.parse(fs.readFileSync(blockedFile(dir), 'utf8'))
    return Date.parse(b.at) >= startedAt ? b : null
  } catch {
    return null
  }
}

try {
  switch (command) {
    case 'run': {
      if (!arg) fail('usage: node game.mjs run <file> [args...]')
      let result = null
      let error = null
      await request({ type: 'run', file: path.resolve(arg), args: rest }, msg => {
        if (msg.type === 'started') console.log(`job ${msg.id} started`)
        else if (msg.type === 'log') console.log(msg.line)
        else if (msg.type === 'event') console.log(msg.text)
        else if (msg.type === 'result') result = msg.summary
        else if (msg.type === 'error') error = msg.error
      })
      if (error) fail(error)
      if (!result) fail('main disconnected before the job ended (it exited or was restarted)')
      console.log(formatSummary(result))
      process.exit(result.ok ? 0 : 1)
      break
    }
    case 'cancel': {
      let out
      await request({ type: 'cancel' }, msg => { out = msg }, { timeoutMs: 20000 })
      if (!out?.ok) fail(out?.error ?? 'main did not reply')
      console.log(out.summary ? formatSummary(out.summary) : out.note)
      break
    }
    case 'wait': {
      const startedAt = Date.now()
      const timer = setInterval(() => {
        const b = blockedSince(startedAt)
        if (b) {
          console.log(`main's thread has not returned to its event loop for ${b.seconds} s (a synchronous endless loop?), so it cannot handle anything. End it with node game.mjs stop, then start main again.`)
          process.exit(1)
        }
      }, 1000)
      let out
      await request({ type: 'wait' }, msg => { out = msg })
      clearInterval(timer)
      if (out?.type !== 'report') fail(out?.error ?? 'main disconnected before the report (it exited or was restarted)')
      console.log(out.text)
      break
    }
    case 'query': {
      if (!arg) fail('usage: node game.mjs query <file> [args...]')
      const seconds = Number(process.env.GAME_QUERY_TIMEOUT) || 10
      let out
      await request({ type: 'query', file: path.resolve(arg), args: rest, timeoutMs: seconds * 1000 }, msg => { out = msg }, { timeoutMs: (seconds + 5) * 1000 })
      for (const line of out?.log ?? []) console.log(line)
      if (!out?.ok) fail(`query failed: ${out?.error ?? 'main did not reply'}`)
      if (out.result !== undefined) console.log(typeof out.result === 'string' ? out.result : JSON.stringify(out.result, null, 2))
      break
    }
    case 'status': {
      let out
      await request({ type: 'status' }, msg => { out = msg }, { timeoutMs: 5000 })
      if (out?.type !== 'status') fail(out?.error ?? 'main did not reply')
      const c = out.controller
      console.log(`main: pid ${out.pid}, started ${out.since}`)
      console.log(out.alive ? 'character: alive' : 'character: dead')
      console.log(`controller: ${c ? `${c.kind === c.name ? c.kind : `${c.kind} ${c.name}`}${{ exiting: ' (exiting)', stuck: ' (will not exit; main needs a restart)' }[c.phase] ?? ''}` : 'none'}`)
      if (out.job) console.log(`${out.job.status === 'running' ? 'current job' : 'last job'}: ${formatSummary(out.job).split('\n')[0]}`)
      if (out.pending) console.log('a report is waiting: node game.mjs wait returns at once')
      break
    }
    case 'stop': {
      const pid = await mainPid()
      if (!pid) fail('main is not running')
      process.kill(pid, 'SIGTERM')
      for (let i = 0; i < 50 && alive(pid); i++) await new Promise(resolve => setTimeout(resolve, 100))
      if (alive(pid)) {
        process.kill(pid, 'SIGKILL')
        console.log(`main (pid ${pid}) did not exit within 5 s; killed it`)
      } else {
        console.log(`main (pid ${pid}) exited`)
      }
      break
    }
    default:
      fail('usage: node game.mjs run|cancel|wait|query|status|stop')
  }
} catch (error) {
  fail(error.message)
}

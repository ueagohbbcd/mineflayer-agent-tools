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
const NOT_RUNNING = 'main 没有在运行（先在后台启动 node main.mjs）'
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
        reject(new Error(`main ${timeoutMs / 1000} 秒没有回复（主线程可能卡住；可以 node game.mjs stop 后重启 main）`))
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
  fail('main 没有回复，也没有留下 pid（.game/blocked.json）；请手动结束 main 进程')
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
      if (!arg) fail('用法：node game.mjs run <file> [参数...]')
      let result = null
      let error = null
      await request({ type: 'run', file: path.resolve(arg), args: rest }, msg => {
        if (msg.type === 'started') console.log(`作业 ${msg.id} 开始`)
        else if (msg.type === 'log') console.log(msg.line)
        else if (msg.type === 'event') console.log(msg.text)
        else if (msg.type === 'result') result = msg.summary
        else if (msg.type === 'error') error = msg.error
      })
      if (error) fail(error)
      if (!result) fail('main 在作业结束前断开了（进程退出或被重启）')
      console.log(formatSummary(result))
      process.exit(result.ok ? 0 : 1)
      break
    }
    case 'cancel': {
      let out
      await request({ type: 'cancel' }, msg => { out = msg }, { timeoutMs: 20000 })
      if (!out?.ok) fail(out?.error ?? 'main 没有回复')
      console.log(out.summary ? formatSummary(out.summary) : out.note)
      break
    }
    case 'wait': {
      const startedAt = Date.now()
      const timer = setInterval(() => {
        const b = blockedSince(startedAt)
        if (b) {
          console.log(`main 的主线程 ${b.seconds} 秒没有回到事件循环（同步死循环？），什么都处理不了。用 node game.mjs stop 结束后重新启动 main。`)
          process.exit(1)
        }
      }, 1000)
      let out
      await request({ type: 'wait' }, msg => { out = msg })
      clearInterval(timer)
      if (out?.type !== 'report') fail(out?.error ?? 'main 在报告前断开了（进程退出或被重启）')
      console.log(out.text)
      break
    }
    case 'query': {
      if (!arg) fail('用法：node game.mjs query <file> [参数...]')
      const seconds = Number(process.env.GAME_QUERY_TIMEOUT) || 10
      let out
      await request({ type: 'query', file: path.resolve(arg), args: rest, timeoutMs: seconds * 1000 }, msg => { out = msg }, { timeoutMs: (seconds + 5) * 1000 })
      for (const line of out?.log ?? []) console.log(line)
      if (!out?.ok) fail(`查询失败：${out?.error ?? 'main 没有回复'}`)
      if (out.result !== undefined) console.log(typeof out.result === 'string' ? out.result : JSON.stringify(out.result, null, 2))
      break
    }
    case 'status': {
      let out
      await request({ type: 'status' }, msg => { out = msg }, { timeoutMs: 5000 })
      if (out?.type !== 'status') fail(out?.error ?? 'main 没有回复')
      const c = out.controller
      console.log(`main：pid ${out.pid}，${out.since} 启动`)
      console.log(out.alive ? '角色活着' : '角色已死亡')
      console.log(`控制者：${c ? `${c.kind} ${c.name}${{ exiting: '（正在退出）', stuck: '（不肯退出，需要重启进程）' }[c.phase] ?? ''}` : '无'}`)
      if (out.job) console.log(`${out.job.status === 'running' ? '当前作业' : '上一项作业'}：${formatSummary(out.job).split('\n')[0]}`)
      if (out.pending) console.log('有未取的报告：node game.mjs wait 会立即返回')
      break
    }
    case 'stop': {
      const pid = await mainPid()
      if (!pid) fail('main 没有在运行')
      process.kill(pid, 'SIGTERM')
      for (let i = 0; i < 50 && alive(pid); i++) await new Promise(resolve => setTimeout(resolve, 100))
      if (alive(pid)) {
        process.kill(pid, 'SIGKILL')
        console.log(`main（pid ${pid}）5 秒内没有退出，已强制结束`)
      } else {
        console.log(`main（pid ${pid}）已退出`)
      }
      break
    }
    default:
      fail('用法：node game.mjs run|cancel|wait|query|status|stop')
  }
} catch (error) {
  fail(error.message)
}

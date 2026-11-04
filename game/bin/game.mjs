#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Commands for a running main.mjs. Run them in the project directory (or set
// GAME_DIR).
//
//   node game.mjs task <file>          run a task; prints the result when it ends
//   node game.mjs query <file> [sec]   run a read-only module now (default 10 s)
//   node game.mjs cancel               ask the running task to stop
//   node game.mjs status
//   node game.mjs stop                 end main (then start it again)
import net from 'node:net'
import path from 'node:path'
import { formatResult } from '../lib/game.mjs'
import { readLock, socketPath } from '../lib/server.mjs'

const dir = path.resolve(process.env.GAME_DIR ?? '.')
const [command, arg, extra] = process.argv.slice(2)

function request (body, { timeoutMs = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const conn = net.connect(socketPath(dir))
    if (timeoutMs) {
      conn.setTimeout(timeoutMs, () => {
        conn.destroy()
        reject(new Error(`main ${timeoutMs / 1000} 秒没有回复（主线程可能卡在同步代码里；可以用 node game.mjs stop 结束后重启）`))
      })
    }
    let data = ''
    conn.setEncoding('utf8')
    conn.on('connect', () => conn.write(JSON.stringify(body) + '\n'))
    conn.on('data', chunk => { data += chunk })
    conn.on('end', () => {
      try {
        resolve(JSON.parse(data))
      } catch {
        reject(new Error('main 没有给出回复就断开了'))
      }
    })
    conn.on('error', error => {
      if (error.code === 'ENOENT' || error.code === 'ECONNREFUSED') reject(new Error('main 没有在运行（先在后台启动 node main.mjs）'))
      else reject(error)
    })
  })
}

function fail (message) {
  console.log(message)
  process.exit(1)
}

try {
  switch (command) {
    case 'task': {
      if (!arg) fail('用法：node game.mjs task <file>')
      const summary = await request({ type: 'task', file: path.resolve(arg) })
      if (summary.busy) fail(`${summary.error}。等它结束，或运行 node game.mjs cancel。`)
      console.log(formatResult(summary))
      process.exit(summary.ok ? 0 : 1)
      break
    }
    case 'query': {
      if (!arg) fail('用法：node game.mjs query <file> [超时秒数]')
      const seconds = Number(extra) || 10
      const out = await request({ type: 'query', file: path.resolve(arg), timeoutMs: seconds * 1000 }, { timeoutMs: (seconds + 5) * 1000 })
      if (!out.ok) fail(`查询失败：${out.error}`)
      console.log(typeof out.result === 'string' ? out.result : JSON.stringify(out.result, null, 2))
      break
    }
    case 'cancel': {
      const out = await request({ type: 'cancel' }, { timeoutMs: 10000 })
      if (!out.ok) fail(out.error)
      console.log(out.cancelled ? formatResult(out.summary) : out.note)
      break
    }
    case 'status': {
      const out = await request({ type: 'status' }, { timeoutMs: 5000 })
      console.log(out.task ? `任务 ${out.task} 在运行${out.inSteps ? '（steps 中）' : ''}` : '没有任务，角色闲置')
      if (out.rule) console.log(`规则 ${out.rule} 正在接管`)
      console.log(`手上的键：${out.keys.join(',') || '无'}`)
      break
    }
    case 'stop': {
      const lock = readLock(dir)
      if (!lock) fail('main 没有在运行')
      process.kill(lock.pid, 'SIGTERM')
      for (let i = 0; i < 50 && readLock(dir); i++) await new Promise(resolve => setTimeout(resolve, 100))
      if (readLock(dir)) {
        process.kill(lock.pid, 'SIGKILL')
        console.log(`main（pid ${lock.pid}）5 秒内没有退出，已强制结束`)
      } else {
        console.log(`main（pid ${lock.pid}）已退出`)
      }
      break
    }
    default:
      fail('用法：node game.mjs task|query|cancel|status|stop')
  }
} catch (error) {
  fail(error.message)
}

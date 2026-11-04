// SPDX-License-Identifier: MIT
// A minimal harness stand-in: foreground bash calls (with a timeout that
// promotes to background), background jobs, and "job finished" messages that
// start the next model turn. A scripted model plays the turns. The output is
// what a model would see, in order.
//
//   node harness-sim.mjs <project-dir> [main args...]
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const project = path.resolve(process.argv[2])
const tasks = process.argv.slice(3)
const waitCmd = `node ${path.resolve(import.meta.dirname, '../bin/wait.mjs')} .`

const jobs = new Map()
let jobSeq = 0
const finished = [] // background jobs that ended and were not yet reported

function out (text) {
  process.stdout.write(text + '\n')
}

function start (command) {
  const id = ++jobSeq
  const child = spawn('/bin/bash', ['-c', command], { cwd: project, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const job = { id, command, output: '', code: null, background: false, done: false }
  child.stdout.on('data', chunk => { job.output += chunk })
  child.stderr.on('data', chunk => { job.output += chunk })
  job.exited = new Promise(resolve => child.on('close', code => {
    job.code = code
    job.done = true
    if (job.background) finished.push(job)
    resolve()
  }))
  job.child = child
  jobs.set(id, job)
  return job
}

async function bash (command, { background = false, timeoutMs = 30000 } = {}) {
  out(`\n> 模型调用 bash${background ? '（后台）' : ''}：${command}`)
  const job = start(command)
  if (background) {
    job.background = true
    out(`< 后台任务 #${job.id} 已启动`)
    return job
  }
  const timer = new Promise(resolve => setTimeout(resolve, timeoutMs, 'timeout'))
  if (await Promise.race([job.exited, timer]) === 'timeout') {
    job.background = true
    out(`< 超过 ${timeoutMs / 1000} 秒，已转为后台任务 #${job.id}。目前的输出：\n${indent(job.output)}`)
    return job
  }
  out(`< 退出码 ${job.code}\n${indent(job.output)}`)
  return job
}

function kill (job) {
  out(`\n> 模型结束后台任务 #${job.id}`)
  try { process.kill(-job.child.pid, 'SIGTERM') } catch {}
  job.background = false
}

/** End the turn: block until a background job ends, then hand it back. */
async function endTurn (limitMs = 240000) {
  out('\n—— 模型结束回合 ——')
  const deadline = Date.now() + limitMs
  while (finished.length === 0) {
    if (Date.now() > deadline) {
      out(`（${limitMs / 1000} 秒内没有后台任务结束，模拟结束）`)
      return null
    }
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  const job = finished.shift()
  out(`\n【harness → 模型】后台任务 #${job.id}（${job.command}）已结束，退出码 ${job.code}。输出：\n${indent(job.output)}`)
  return job
}

function indent (text) {
  const t = text.trimEnd()
  return t ? t.split('\n').map(line => `  ${line}`).join('\n') : '  （无输出）'
}

function resultCount () {
  try { return fs.readdirSync(path.join(project, '.game/results')).length } catch { return 0 }
}

// ---- scripted model -----------------------------------------------------------
out(`模拟 harness，项目目录 ${project}`)
const main = await bash(`node main.mjs ${tasks.join(' ')}`, { background: true })
await bash(waitCmd, { background: true })
let turns = 0
let detoured = false
while (turns++ < 20) {
  const woke = await endTurn()
  if (!woke) break
  if (woke === main) break
  if (resultCount() >= tasks.length) {
    await bash('ls .game/results && grep -c . records/rules.jsonl && grep keys-after-takeover records/rules.jsonl | head -3')
    break
  }
  if (!detoured && resultCount() >= 1) {
    // The model does something else first; notices arriving now must wait
    // for the next `wait` and must not be lost.
    detoured = true
    await bash('sleep 15; echo 先看看别的')
  }
  await bash(waitCmd, { background: true })
}
kill(main)
for (const job of jobs.values()) if (!job.done && job !== main) kill(job)
await new Promise(resolve => setTimeout(resolve, 500))
process.exit(0)

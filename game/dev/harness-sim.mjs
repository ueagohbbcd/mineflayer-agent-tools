// SPDX-License-Identifier: MIT
// A minimal harness stand-in: foreground bash calls (a timeout promotes the
// call to a background job), background jobs, and "job finished" messages
// that start the next model turn. A scenario plays the model. The output is
// what a model would see, in order.
//
//   node harness-sim.mjs <scenario.mjs> <project-dir>
import { spawn } from 'node:child_process'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export function createHarness (project, { print = text => process.stdout.write(text + '\n') } = {}) {
  const jobs = new Map()
  const finished = []
  let seq = 0

  function start (command) {
    const id = ++seq
    const child = spawn('/bin/bash', ['-c', command], { cwd: project, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const job = { id, command, output: '', code: null, background: false, done: false, child }
    child.stdout.on('data', chunk => { job.output += chunk })
    child.stderr.on('data', chunk => { job.output += chunk })
    job.exited = new Promise(resolve => child.on('close', code => {
      job.code = code
      job.done = true
      if (job.background) finished.push(job)
      resolve()
    }))
    jobs.set(id, job)
    return job
  }

  return {
    /** A model tool call. Returns the job; `.output` holds what was shown. */
    async bash (command, { background = false, timeoutMs = 60000 } = {}) {
      print(`\n> 模型调用 bash${background ? '（后台）' : ''}：${command}`)
      const job = start(command)
      if (background) {
        job.background = true
        print(`< 后台任务 #${job.id} 已启动`)
        return job
      }
      const timer = new Promise(resolve => setTimeout(resolve, timeoutMs, 'timeout'))
      if (await Promise.race([job.exited, timer]) === 'timeout') {
        job.background = true
        print(`< 超过 ${timeoutMs / 1000} 秒，已转为后台任务 #${job.id}。目前的输出：\n${indent(job.output)}`)
        return job
      }
      print(`< 退出码 ${job.code}\n${indent(job.output)}`)
      return job
    },
    kill (job) {
      print(`\n> 模型结束后台任务 #${job.id}`)
      job.background = false
      try { process.kill(-job.child.pid, 'SIGTERM') } catch {}
    },
    /** End the turn: block until a background job ends, then hand it back. */
    async endTurn (limitMs = 120000) {
      print('\n—— 模型结束回合 ——')
      const deadline = Date.now() + limitMs
      while (finished.length === 0) {
        if (Date.now() > deadline) {
          print(`（${limitMs / 1000} 秒内没有后台任务结束）`)
          return null
        }
        await new Promise(resolve => setTimeout(resolve, 200))
      }
      const job = finished.shift()
      print(`\n【harness → 模型】后台任务 #${job.id}（${job.command}）已结束，退出码 ${job.code}。输出：\n${indent(job.output)}`)
      return job
    },
    note (text) {
      print(`\n# ${text}`)
    },
    cleanup () {
      for (const job of jobs.values()) {
        if (!job.done) try { process.kill(-job.child.pid, 'SIGKILL') } catch {}
      }
    }
  }
}

function indent (text) {
  const t = text.trimEnd()
  return t ? t.split('\n').map(line => `  ${line}`).join('\n') : '  （无输出）'
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [scenarioFile, projectArg] = process.argv.slice(2)
  const project = path.resolve(projectArg)
  const harness = createHarness(project)
  const { default: scenario } = await import(pathToFileURL(path.resolve(scenarioFile)).href)
  process.stdout.write(`模拟 harness，项目目录 ${project}\n`)
  try {
    await scenario(harness, { project, bin: path.resolve(import.meta.dirname, '../bin') })
  } finally {
    harness.cleanup()
  }
  process.exit(0)
}

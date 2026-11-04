// SPDX-License-Identifier: MIT
// The resident part of main.mjs: one bot, one rule table, one task at a time.
//
// Who controls the bot:
//   no task          idle: rule inputs, otherwise main's idle(bot)
//   task, no steps   the task (native code / plugins); rules only notify
//   task in steps    the prebuilt loop: rules first, then the task's step
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { appendLine, recordsDir, resultsDir, writeJsonAtomic } from './files.mjs'
import { applyInputs, checkInputs, heldKeys, releaseAll } from './inputs.mjs'
import { createNotifier } from './notify.mjs'
import { createRuleTable, summarizeTakeovers } from './rules.mjs'

export function createGame (bot, { dir, rules = [], idle = () => null, log = console.log } = {}) {
  if (!dir) throw new Error('createGame needs { dir }')
  const notify = createNotifier(dir)
  const record = (source, entry) => appendLine(path.join(recordsDir(dir), `${source}.jsonl`), { at: new Date().toISOString(), ...entry })
  const events = { deaths: [], noPath: [] }
  const table = createRuleTable(rules, { record, notify, events })

  let task = null // { id, file, controller, inSteps }
  let taskSeq = 0

  bot.on('death', () => {
    const pos = bot.entity?.position?.clone?.()
    events.deaths.push({ at: Date.now(), pos })
    record('events', { type: 'death', pos: pos && [pos.x, pos.y, pos.z].map(Math.floor) })
  })
  bot.on('path_update', result => {
    if (result?.status === 'noPath') events.noPath.push(Date.now())
  })

  // Rules in the plugin and idle periods. Steps evaluates its own tick.
  bot.on('physicsTick', () => {
    if (task?.inSteps) return
    if (task) {
      table.evaluate(bot, 'plugin')
      return
    }
    const ruled = table.evaluate(bot, 'idle')
    try {
      applyInputs(bot, ruled ? ruled.inputs : checkInputs(idle(bot), 'idle(bot)'))
    } catch (error) {
      releaseAll(bot)
      record('events', { type: 'idle-error', error: String(error?.stack ?? error) })
    }
  })

  function steps (fn, signal) {
    if (!task) throw new Error('steps() can only be used inside a task')
    if (task.inSteps) throw new Error('steps() is already running')
    const owner = task
    return new Promise((resolve, reject) => {
      owner.inSteps = true
      let slowWarned = false
      let lastRule = null
      const finish = (error, value) => {
        bot.removeListener('physicsTick', onTick)
        signal?.removeEventListener('abort', onAbort)
        owner.inSteps = false
        releaseAll(bot)
        if (error) reject(error)
        else resolve(value)
      }
      const onAbort = () => finish(signal.reason ?? new Error('task cancelled'))
      const onTick = () => {
        try {
          const ruled = table.evaluate(bot, 'steps')
          if (ruled) {
            applyInputs(bot, ruled.inputs)
            if (ruled.rule !== lastRule) record('rules', { type: 'keys-after-takeover', rule: ruled.rule, task: owner.id, keys: heldKeys(bot) })
            lastRule = ruled.rule
            return
          }
          lastRule = null
          const started = performance.now()
          const out = checkInputs(fn(), 'step')
          const took = performance.now() - started
          if (took > 20 && !slowWarned) {
            slowWarned = true
            record('events', { type: 'slow-step', task: owner.id, ms: Math.round(took) })
          }
          if (out.done) finish(null, out.result)
          else applyInputs(bot, out)
        } catch (error) {
          finish(error)
        }
      }
      if (signal?.aborted) return onAbort()
      signal?.addEventListener('abort', onAbort, { once: true })
      bot.on('physicsTick', onTick)
    })
  }

  /** Load a task file fresh (mtime cache-bust) and run it to the end. */
  async function runTask (file, { notifyResult = true } = {}) {
    if (task) return { ok: false, busy: true, error: `已有任务 ${task.id} 在运行` }
    const abs = path.resolve(file)
    const id = `t${++taskSeq}-${path.basename(abs, path.extname(abs))}`
    const controller = new AbortController()
    const listeners = []
    let settle
    task = { id, file: abs, controller, inSteps: false, done: new Promise(resolve => { settle = resolve }) }
    releaseAll(bot)
    const started = Date.now()
    record('tasks', { type: 'start', task: id, file: abs })
    log(`任务 ${id} 开始`)
    const ctx = {
      signal: controller.signal,
      steps: fn => steps(fn, controller.signal),
      rules: { disable: name => table.disable(name), names: () => table.names() },
      notify,
      record,
      on (emitter, event, listener) {
        emitter.on(event, listener)
        listeners.push([emitter, event, listener])
      }
    }
    let result
    try {
      const mtime = fs.statSync(abs).mtimeMs
      const mod = await import(`${pathToFileURL(abs).href}?v=${mtime}`)
      if (typeof mod.default !== 'function') throw new Error(`${file} 没有 export default async function task(bot, ctx)`)
      const value = await mod.default(bot, ctx)
      result = { ok: true, result: value }
    } catch (error) {
      result = { ok: false, error: error?.message ?? String(error), stack: error?.stack }
    }
    if (controller.signal.aborted) result.cancelled = true
    for (const [emitter, event, listener] of listeners) emitter.removeListener(event, listener)
    let pathfinderLeftRunning = false
    if (bot.pathfinder?.goal) {
      // setGoal(null) clears at once; pathfinder.stop() is deferred and would
      // abort the next task's first goto.
      pathfinderLeftRunning = result.ok
      bot.pathfinder.setGoal(null)
    }
    releaseAll(bot)
    const { takeovers, disabled } = table.endTask()
    task = null
    const p = bot.entity?.position
    const summary = {
      task: id,
      file: abs,
      ...result,
      seconds: Math.round((Date.now() - started) / 100) / 10,
      position: p ? [p.x, p.y, p.z].map(n => Math.round(n * 10) / 10) : null,
      takeovers: summarizeTakeovers(takeovers),
      ...(disabled.length ? { disabledRules: disabled } : {}),
      ...(pathfinderLeftRunning ? { note: '任务结束时寻路还有目标，已停止' } : {})
    }
    writeJsonAtomic(path.join(resultsDir(dir), `${id}.json`), summary)
    record('tasks', { type: 'end', task: id, ok: summary.ok, seconds: summary.seconds })
    log(`任务 ${id} ${summary.ok ? '完成' : '失败'}`)
    if (typeof notifyResult === 'function' ? notifyResult() : notifyResult) notify(formatResult(summary), { task: id })
    settle(summary)
    return summary
  }

  /** Run a read-only module against the live bot, alongside any task. */
  async function runQuery (file, { timeoutMs = 10000 } = {}) {
    const abs = path.resolve(file)
    const controller = new AbortController()
    const listeners = []
    const ctx = {
      signal: controller.signal,
      record,
      on (emitter, event, listener) {
        emitter.on(event, listener)
        listeners.push([emitter, event, listener])
      }
    }
    let timer
    const timeout = new Promise(resolve => {
      timer = setTimeout(() => {
        controller.abort(new Error('query timed out'))
        resolve({ ok: false, timedOut: true, error: `查询 ${timeoutMs / 1000} 秒没有返回；调用方不再等待，查询代码不一定已停下` })
      }, timeoutMs)
    })
    const run = (async () => {
      try {
        const mtime = fs.statSync(abs).mtimeMs
        const mod = await import(`${pathToFileURL(abs).href}?v=${mtime}`)
        if (typeof mod.default !== 'function') throw new Error(`${file} 没有 export default async function query(bot, ctx)`)
        return { ok: true, result: await mod.default(bot, ctx) }
      } catch (error) {
        return { ok: false, error: error?.message ?? String(error) }
      }
    })()
    const out = await Promise.race([run, timeout])
    clearTimeout(timer)
    for (const [emitter, event, listener] of listeners) emitter.removeListener(event, listener)
    return out
  }

  return {
    bot,
    dir,
    notify,
    record,
    runTask,
    runQuery,
    /**
     * Ask the task to stop: abort its signal (steps ends at once), clear the
     * pathfinder goal and stop pvp, which main loaded. The bot is handed to
     * idle only when the task's promise has settled.
     */
    async cancel ({ graceMs = 5000, reason = '已取消' } = {}) {
      if (!task) return { ok: true, cancelled: null, note: '没有在运行的任务' }
      const current = task
      current.controller.abort(new Error(reason))
      if (bot.pathfinder?.goal) bot.pathfinder.setGoal(null)
      try { bot.pvp?.stop?.() } catch {}
      const timer = new Promise(resolve => setTimeout(resolve, graceMs, null))
      const summary = await Promise.race([current.done, timer])
      if (summary) return { ok: true, cancelled: current.id, summary }
      return { ok: false, cancelled: current.id, error: `任务 ${current.id} 收到取消后 ${graceMs / 1000} 秒仍未退出，角色没有交出去。可以再等等，或用 node game.mjs stop 重启 main。` }
    },
    status: () => ({ task: task?.id ?? null, inSteps: Boolean(task?.inSteps), rule: table.takingRule(), keys: heldKeys(bot) })
  }
}

export function formatResult (summary) {
  const state = summary.cancelled ? (summary.ok ? '收到取消后仍正常完成' : '已取消') : (summary.ok ? '完成' : '失败')
  const lines = [`任务 ${summary.task} ${state}（${summary.seconds} 秒）`]
  if (summary.ok && summary.result !== undefined) lines.push(`结果：${JSON.stringify(summary.result)}`)
  if (!summary.ok) lines.push(`${summary.cancelled ? '退出时的错误' : '错误'}：${summary.error}`)
  if (summary.position) lines.push(`位置：${summary.position.join(' ')}`)
  if (summary.takeovers.length) lines.push(`规则接管：${summary.takeovers.join('；')}`)
  if (summary.disabledRules) lines.push(`本任务关闭的规则：${summary.disabledRules.join(', ')}`)
  if (summary.note) lines.push(summary.note)
  return lines.join('\n')
}

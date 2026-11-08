// SPDX-License-Identifier: MIT
// The resident core: one bot, one current piece of work, one controller at a
// time (task, service or idle), the exit flow, wake and reports.
//
//   const host = createHost(bot, { dir, services, idle })
//
// services: { name: { check?(bot) → reason|null, run(bot, ctx) } }. A task
// offers checkpoints with ctx.checkpoint({ name: 'pause' | 'stop' }); a module
// asks for a takeover with host.takeover(name, { mode, reason }).
//
// Exit flow, shared by every way a controller ends (pause, stop, replace,
// cancel, death): request exit (abort the signal) → block further task steps
// (checkpoint throws) → stop current actions and clean up → confirm the run has
// settled. Nothing else takes the bot before the confirmation. A run that has
// not settled within graceMs stays the controller; the host wakes the model,
// and the fallback is restarting the process.
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { stopGameActions } from './cleanup.mjs'

export class ExitRequested extends Error {
  constructor (reason) {
    super(`退出：${reason}`)
    this.name = 'ExitRequested'
    this.reason = reason
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const text = value => (typeof value === 'string' ? value : JSON.stringify(value))

export function createHost (bot, {
  dir,
  services = {},
  idle = null,
  cleanup = stopGameActions,
  graceMs = 5000,
  reportTimeoutMs = 3000,
  log = console.log
} = {}) {
  if (!dir) throw new Error('createHost needs { dir }')
  const reports = [] // [name, fn]
  let controller = null // { kind, name, ac, cleanups, done, exiting, stuck }
  let work = null // the current piece of work, or the last one
  let workSeq = 0
  let handoff = null // a takeover in progress
  let endSeq = 0 // works that have ended
  let alive = true

  // ---- wake ----------------------------------------------------------------
  let wakeGen = 0
  let consumedGen = 0
  let reportedEndSeq = 0
  let reasons = []
  const waiters = new Set()
  let collecting = null

  function wake (reason) {
    wakeGen++
    if (reason) {
      const line = `[${new Date().toISOString().slice(11, 19)}] ${reason}`
      if (!reasons.some(r => r.slice(11) === line.slice(11))) reasons.push(line)
      if (reasons.length > 8) reasons = reasons.slice(-8)
    }
    if (waiters.size) serveWaiters()
  }

  function pending () {
    return wakeGen > consumedGen || endSeq > reportedEndSeq
  }

  async function collect () {
    const gen = wakeGen
    const ends = endSeq
    const why = reasons
    reasons = []
    const lines = []
    lines.push(why.length ? `唤醒原因：\n${why.map(r => `  ${r}`).join('\n')}` : '唤醒原因：无新唤醒')
    lines.push(`现在：${describeNow()}`)
    if (ends > reportedEndSeq && work?.status === 'ended') lines.push(`最近结束的工作：${formatWork(work)}`)
    for (const [name, fn] of reports) {
      try {
        const out = await Promise.race([
          Promise.resolve().then(() => fn(bot)),
          sleep(reportTimeoutMs).then(() => { throw new Error(`${reportTimeoutMs / 1000} 秒没有返回`) })
        ])
        if (out) lines.push(`== ${name} ==\n${text(out).trimEnd()}`)
      } catch (error) {
        lines.push(`== ${name} ==\n报告出错：${error?.message ?? error}`)
      }
    }
    consumedGen = Math.max(consumedGen, gen)
    reportedEndSeq = Math.max(reportedEndSeq, ends)
    return lines.join('\n')
  }

  function serveWaiters () {
    if (collecting) return
    collecting = (async () => {
      while (waiters.size && pending()) {
        const batch = [...waiters]
        waiters.clear()
        const report = await collect()
        for (const w of batch) w(report)
      }
    })().finally(() => {
      collecting = null
      if (waiters.size && pending()) serveWaiters()
    })
  }

  /** Resolves with the report text once something is pending. */
  function waitForReport (signal) {
    return new Promise(resolve => {
      const waiter = report => resolve(report)
      waiters.add(waiter)
      signal?.addEventListener('abort', () => { if (waiters.delete(waiter)) resolve(null) }, { once: true })
      if (pending()) serveWaiters()
    })
  }

  // ---- controllers -----------------------------------------------------------
  function makeController (kind, name) {
    return { kind, name, ac: new AbortController(), cleanups: [], done: null, exiting: null, stuck: false }
  }

  async function runCleanups (ctrl) {
    for (const fn of ctrl.cleanups.splice(0).reverse()) {
      try { await fn() } catch (error) { log(`清理出错（${ctrl.name}）：${error?.message ?? error}`) }
    }
    try { await cleanup(bot) } catch (error) { log(`游戏清理出错：${error?.message ?? error}`) }
  }

  /** The exit flow. Idempotent: every caller gets the same promise. */
  function exitFlow (ctrl, reason) {
    if (ctrl.exiting) return ctrl.exiting
    ctrl.exiting = (async () => {
      ctrl.exitReason = reason
      ctrl.ac.abort(new ExitRequested(reason))
      await runCleanups(ctrl)
      const settled = await Promise.race([ctrl.done.then(() => true), sleep(graceMs).then(() => false)])
      if (!settled) {
        ctrl.stuck = true
        const msg = `${describeController(ctrl)} 收到退出请求（${reason}）后 ${graceMs / 1000} 秒没有退出，仍占着角色。需要重启游戏进程：node game.mjs stop，然后重新启动 main。`
        log(msg)
        emitWork('event', msg)
        wake(msg)
        ctrl.done.then(async () => { // it did exit in the end
          ctrl.stuck = false
          await runCleanups(ctrl)
          if (controller === ctrl) controller = null
          if (ctrl.work?.status === 'running') finishWork(ctrl.work, { ok: false, ended: 'late-exit', reason: ctrl.exitReason })
          wake(`${describeController(ctrl)} 终于退出了`)
          startIdle()
        })
        return false
      }
      await runCleanups(ctrl) // whatever the run started while unwinding
      if (controller === ctrl) controller = null
      return true
    })()
    return ctrl.exiting
  }

  /** Ends the current controller, if any. False when it would not exit. */
  async function release (reason) {
    const ctrl = controller
    if (!ctrl) return true
    return exitFlow(ctrl, reason)
  }

  // ---- idle ----------------------------------------------------------------
  let idleErrors = 0
  function startIdle () {
    if (!idle || controller || handoff || !alive || work?.status === 'running') return
    const ctrl = makeController('idle', 'idle')
    controller = ctrl
    ctrl.done = Promise.resolve()
      .then(() => idle(bot, controllerCtx(ctrl)))
      .then(() => ({ ok: true }), error => ({ ok: false, error }))
    ctrl.done.then(async outcome => {
      if (ctrl.exiting) return
      await runCleanups(ctrl)
      if (controller === ctrl) controller = null
      if (!outcome.ok && !(outcome.error instanceof ExitRequested)) {
        idleErrors++
        const msg = `idle 出错：${outcome.error?.message ?? outcome.error}`
        log(msg)
        if (idleErrors <= 3) wake(msg)
        setTimeout(startIdle, 2000)
      } else {
        setTimeout(startIdle, 1000)
      }
    })
  }

  function controllerCtx (ctrl) {
    return {
      signal: ctrl.ac.signal,
      cleanup: fn => { ctrl.cleanups.push(fn) },
      wake,
      takeover: (name, opts) => takeover(name, opts),
      get exiting () { return ctrl.ac.signal.aborted }
    }
  }

  // ---- work and tasks -------------------------------------------------------
  function emitWork (type, value, w = work) {
    if (!w) return
    const msg = { type, ...(typeof value === 'object' && value !== null ? value : { text: value }) }
    for (const sink of w.sinks) {
      try { sink(msg) } catch {}
    }
  }

  function finishWork (w, result) {
    if (w.status === 'ended') return
    w.status = 'ended'
    w.endedAt = Date.now()
    w.result = result
    endSeq++
    const p = bot.entity?.position
    // After a death the bot may already stand at its respawn point; the death
    // position is in the end word instead.
    w.position = p && result.ended !== 'death' ? [p.x, p.y, p.z].map(n => Math.round(n * 10) / 10) : null
    writeResult(w)
    emitWork('result', { summary: summarizeWork(w) }, w)
    w.sinks.clear()
    wake(`工作 ${w.id} ${endWord(w)}`)
  }

  function startAttempt (w) {
    w.attempts++
    const ctrl = makeController('task', w.id)
    ctrl.work = w
    controller = ctrl
    const base = controllerCtx(ctrl)
    const ctx = {
      ...base,
      args: w.args,
      attempt: w.attempts,
      log: (...parts) => {
        const line = parts.map(text).join(' ')
        w.log.push(line)
        if (w.log.length > 30) w.log.shift()
        emitWork('log', { line }, w)
      },
      checkpoint: spec => checkpoint(ctrl, spec),
      get exiting () { return ctrl.ac.signal.aborted }
    }
    ctrl.done = (async () => {
      const mtime = fs.statSync(w.file).mtimeMs
      const mod = await import(`${pathToFileURL(w.file).href}?v=${mtime}`)
      if (typeof mod.default !== 'function') throw new Error(`${w.file} 没有 export default async function (bot, ctx)`)
      return mod.default(bot, ctx)
    })().then(value => ({ ok: true, value }), error => ({ ok: false, error }))
    ctrl.done.then(async outcome => {
      if (ctrl.exiting) return // whoever asked for the exit decides what comes next
      await runCleanups(ctrl)
      if (controller === ctrl) controller = null
      if (w.status === 'running') {
        finishWork(w, outcome.ok
          ? { ok: true, value: outcome.value }
          : { ok: false, error: outcome.error?.message ?? String(outcome.error) })
      }
      startIdle()
    })
  }

  /** A checkpoint offered by the running task. Throws ExitRequested on handoff. */
  async function checkpoint (ctrl, spec = {}) {
    if (ctrl.ac.signal.aborted) throw ctrl.ac.signal.reason
    for (const [name, mode] of Object.entries(spec)) {
      const service = services[name]
      if (!service) throw new Error(`没有名为 ${name} 的服务（已有：${Object.keys(services).join(', ') || '无'}）`)
      if (typeof service.check !== 'function') continue
      let reason
      try { reason = await service.check(bot) } catch (error) { reason = null; log(`服务 ${name} 检查出错：${error?.message ?? error}`) }
      if (reason) {
        takeover(name, { mode, reason: text(reason), by: 'checkpoint' })
        throw new ExitRequested(`介入：${name}`)
      }
    }
  }

  /**
   * Hand the bot to a service. From a task checkpoint, or asked by a module.
   * mode 'pause' restarts the task from its entry afterwards; 'stop' (the
   * default for module requests) ends the work and goes to idle.
   */
  function takeover (name, { mode = 'stop', reason = '', by = 'module' } = {}) {
    const service = services[name]
    if (!service) return { ok: false, error: `没有名为 ${name} 的服务` }
    if (handoff) return { ok: false, error: `交接进行中（${handoff.name}）` }
    if (controller?.kind === 'service') return { ok: false, error: `服务 ${controller.name} 正在控制` }
    if (!alive) return { ok: false, error: '角色已死亡' }
    handoff = { name, mode, reason }
    const w = work?.status === 'running' ? work : null
    const prev = controller
    const done = (async () => {
      try {
        const modeWord = !w ? '' : mode === 'pause' ? '，结束后从入口重新运行任务' : '，结束后转 idle'
        const msg = `${name} 接管（${reason || '无原因'}）${modeWord}`
        log(msg)
        emitWork('event', `[介入] ${msg}`, w)
        wake(msg)
        if (prev && !(await exitFlow(prev, `介入：${name}`))) return
        if (w && w.status !== 'running') return // ended while exiting (death, cancel)
        if (!alive) return
        const ctrl = makeController('service', name)
        ctrl.work = w
        controller = ctrl
        ctrl.done = Promise.resolve()
          .then(() => service.run(bot, { ...controllerCtx(ctrl), reason }))
          .then(value => ({ ok: true, value }), error => ({ ok: false, error }))
        const outcome = await ctrl.done
        if (ctrl.exiting) return // cancelled meanwhile; late completion restarts nothing
        await runCleanups(ctrl)
        if (controller === ctrl) controller = null
        const after = outcome.ok ? `结束：${text(outcome.value ?? '完成')}` : `出错：${outcome.error?.message ?? outcome.error}`
        emitWork('event', `[介入] ${name} ${after}`, w)
        if (w && w.status === 'running' && !w.cancelled) {
          if (mode === 'pause' && prev?.kind === 'task') {
            emitWork('event', `[重启] 第 ${w.attempts + 1} 次从入口运行`, w)
            handoff = null
            startAttempt(w)
            return
          }
          finishWork(w, { ok: false, stoppedBy: name, reason, service: after })
        } else if (!w) {
          wake(`${name} ${after}`)
        }
      } catch (error) {
        log(`交接出错：${error?.stack ?? error}`)
      } finally {
        if (handoff?.name === name) handoff = null
        startIdle()
      }
    })()
    return { ok: true, done }
  }

  /** Submit a task file as the current work. A running work is replaced. */
  async function submit (file, { args = [], sink } = {}) {
    if (!alive) return { ok: false, error: '角色已死亡，等重生后再提交' }
    if (handoff) return { ok: false, error: `交接进行中（${handoff.name}），稍后再提交` }
    const abs = path.resolve(file)
    if (!fs.existsSync(abs)) return { ok: false, error: `找不到文件 ${abs}` }
    if (work?.status === 'running') {
      const old = work
      old.cancelled = true
      if (!(await release(`被新工作替换`))) return { ok: false, error: `${describeController(controller)} 不肯退出，需要重启游戏进程` }
      finishWork(old, { ok: false, ended: 'replaced' })
    } else if (!(await release('开始新工作'))) {
      return { ok: false, error: `${describeController(controller)} 不肯退出，需要重启游戏进程` }
    }
    const w = {
      id: `w${++workSeq}-${path.basename(abs, path.extname(abs))}`,
      file: abs,
      args,
      attempts: 0,
      status: 'running',
      startedAt: Date.now(),
      log: [],
      sinks: new Set(sink ? [sink] : []),
      cancelled: false
    }
    work = w
    startAttempt(w)
    return { ok: true, id: w.id, work: w }
  }

  /** Explicit cancel: exit flow plus no restart. */
  async function cancel (reason = '已取消') {
    const w = work?.status === 'running' ? work : null
    if (!w) return { ok: true, note: '没有正在进行的工作' }
    w.cancelled = true
    const ok = await release(reason)
    if (!ok) return { ok: false, error: `${describeController(controller)} 不肯退出，需要重启游戏进程` }
    finishWork(w, { ok: false, ended: 'cancelled', reason })
    startIdle()
    return { ok: true, summary: summarizeWork(w) }
  }

  // ---- death and respawn ----------------------------------------------------
  bot.on('death', () => {
    alive = false
    const p = bot.entity?.position
    const where = p ? [p.x, p.y, p.z].map(Math.floor).join(' ') : '?'
    const w = work?.status === 'running' ? work : null
    if (w) w.cancelled = true
    const ctrl = controller
    ;(async () => {
      if (ctrl) await exitFlow(ctrl, '死亡')
      if (w) finishWork(w, { ok: false, ended: 'death', where })
    })()
    wake(`死亡，位置 ${where}`)
  })
  bot.on('spawn', () => {
    if (alive) return
    if ((bot.health ?? 20) <= 0) return
    alive = true
    const p = bot.entity?.position
    wake(`重生，位置 ${p ? [p.x, p.y, p.z].map(Math.floor).join(' ') : '?'}`)
    setTimeout(startIdle, 500)
  })

  // ---- read-only queries -----------------------------------------------------
  async function query (file, { args = [], timeoutMs = 10000 } = {}) {
    const abs = path.resolve(file)
    const lines = []
    const ac = new AbortController()
    const run = (async () => {
      try {
        const mtime = fs.statSync(abs).mtimeMs
        const mod = await import(`${pathToFileURL(abs).href}?v=${mtime}`)
        if (typeof mod.default !== 'function') throw new Error(`${file} 没有 export default async function (bot, ctx)`)
        return { ok: true, result: await mod.default(bot, { args, signal: ac.signal, log: (...p) => lines.push(p.map(text).join(' ')) }) }
      } catch (error) {
        return { ok: false, error: error?.message ?? String(error) }
      }
    })()
    let timer
    const out = await Promise.race([run, new Promise(resolve => { timer = setTimeout(() => { ac.abort(); resolve({ ok: false, error: `查询 ${timeoutMs / 1000} 秒没有返回` }) }, timeoutMs) })])
    clearTimeout(timer)
    return { ...out, log: lines }
  }

  // ---- descriptions -----------------------------------------------------------
  function describeController (ctrl) {
    if (!ctrl) return '无'
    return { task: `任务 ${ctrl.name}`, service: `服务 ${ctrl.name}`, idle: 'idle' }[ctrl.kind] ?? ctrl.name
  }

  function describeNow () {
    if (!alive) return '角色已死亡，等待重生'
    const parts = []
    if (work?.status === 'running') parts.push(`工作 ${work.id} 进行中（第 ${work.attempts} 次运行）`)
    else parts.push('没有工作在进行')
    parts.push(`控制者：${describeController(controller)}${controller?.stuck ? '（不肯退出，需要重启进程）' : ''}`)
    return parts.join('；')
  }

  function writeResult (w) {
    try {
      const file = path.join(dir, '.game', 'results', `${w.id}.json`)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, JSON.stringify(summarizeWork(w), null, 2) + '\n')
    } catch {}
  }

  // Created after spawn (the usual case): idle starts now.
  if (bot.entity) setTimeout(startIdle, 0)

  return {
    bot,
    dir,
    wake,
    pending,
    waitForReport,
    collect,
    submit,
    cancel,
    takeover,
    query,
    addReport: (name, fn) => { reports.push([name, fn]) },
    status: () => ({
      alive,
      controller: controller && { kind: controller.kind, name: controller.name, stuck: controller.stuck },
      work: work && summarizeWork(work),
      pending: pending(),
      handoff
    }),
    get controller () { return controller },
    get work () { return work }
  }
}

function endWord (w) {
  const r = w.result ?? {}
  if (r.ok) return '完成'
  if (r.ended === 'death') return `因死亡结束（${r.where}）`
  if (r.ended === 'cancelled') return '已取消'
  if (r.ended === 'replaced') return '被新工作替换'
  if (r.ended === 'late-exit') return `收到退出请求（${r.reason}）后很久才退出`
  if (r.stoppedBy) return `被 ${r.stoppedBy} 接管后结束（${r.reason}）`
  return `失败：${r.error}`
}

export function summarizeWork (w) {
  return {
    id: w.id,
    file: w.file,
    args: w.args,
    status: w.status,
    attempts: w.attempts,
    seconds: Math.round(((w.endedAt ?? Date.now()) - w.startedAt) / 100) / 10,
    ...(w.result ?? {}),
    end: w.status === 'ended' ? endWord(w) : undefined,
    position: w.position ?? undefined,
    log: w.log.length ? w.log : undefined
  }
}

export function formatWork (w) {
  return formatSummary(summarizeWork(w))
}

export function formatSummary (s) {
  const lines = [`${s.id} ${s.end ?? '进行中'}（${s.seconds} 秒，运行 ${s.attempts} 次）`]
  if (s.ok && s.value !== undefined) lines.push(`结果：${text(s.value)}`)
  if (s.service) lines.push(`接管服务：${s.service}`)
  if (s.position) lines.push(`位置：${s.position.join(' ')}`)
  if (s.log) lines.push(`任务输出（最后 ${s.log.length} 行）：`, ...s.log.map(l => `  ${l}`))
  return lines.join('\n')
}

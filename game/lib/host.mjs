// SPDX-License-Identifier: MIT
// The resident core: one bot, one current piece of work, one controller at a
// time (task, service or idle), one exit flow, wake and reports. It knows
// nothing about the game; stopping the bot's own actions is the injected
// `cleanup`.
//
//   const host = createHost(bot, { dir, services, idle, cleanup })
//
// services: { name: { check?(bot) → reason|null, run(bot, ctx) } }. A task
// offers checkpoints with ctx.checkpoint({ name: 'pause' | 'stop' }); a module
// asks for a takeover with host.takeover(name, { mode, reason }).
//
// Exit flow, shared by cancel, replace, takeover and death: the requester
// records what comes next (`next`) and the controller's signal aborts → its
// cleanups and the game cleanup run → the controller's promise settles →
// settle() carries out `next`. Nothing else takes the bot before that. A later
// request overrides an earlier one by rank: death > cancel = replace >
// takeover. A controller still running graceMs after the request keeps the bot
// (phase 'stuck') and the model is woken; when it settles at last, settle()
// proceeds as usual. The fallback for one that never settles is restarting the
// process.
import fs from 'node:fs'
import path from 'node:path'
import { describeController, describeNow, endWord, errorText, formatWork, summarizeWork, text } from './describe.mjs'
import { loadDefault } from './query.mjs'

export class ExitRequested extends Error {
  constructor (reason) {
    super(`退出：${reason}`)
    this.name = 'ExitRequested'
    this.reason = reason
  }
}

const RANK = { takeover: 1, cancel: 2, replace: 2, death: 3 }
const EXIT_RULE = '每次 await 之后检查 ctx.signal.aborted，为真就返回'
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

export function createHost (bot, {
  dir,
  services = {},
  idle = null,
  cleanup = () => {},
  graceMs = 5000,
  reportTimeoutMs = 3000,
  log = console.log
} = {}) {
  if (!dir) throw new Error('createHost needs { dir }')
  const reports = [] // [name, fn]
  // The controller: { kind: 'task'|'service'|'idle', name, work, ac, cleanups,
  // phase: 'running'|'exiting'|'stuck'|'done', why, confirms, mode, reason }
  let controller = null
  // What follows the current controller's exit, set by whoever asked for it:
  // { kind, why, end?: result for its work, service?: { name, mode, reason }, start?: new work }
  let next = null
  let work = null // the current piece of work, or the last one
  let workSeq = 0
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
    lines.push(`现在：${describeNow({ alive, work, controller })}`)
    if (ends > reportedEndSeq && work?.status === 'ended') lines.push(`最近结束的工作：${formatWork(work)}`)
    for (const [name, fn] of reports) {
      try {
        const out = await Promise.race([
          Promise.resolve().then(() => fn(bot)),
          sleep(reportTimeoutMs).then(() => { throw new Error(`${reportTimeoutMs / 1000} 秒没有返回`) })
        ])
        if (out) lines.push(`== ${name} ==\n${text(out).trimEnd()}`)
      } catch (error) {
        lines.push(`== ${name} ==\n报告出错：${errorText(error)}`)
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

  /** Resolves with the report text once something is pending; null if the signal aborts first. */
  function waitForReport (signal) {
    return new Promise(resolve => {
      const waiter = report => resolve(report)
      waiters.add(waiter)
      signal?.addEventListener('abort', () => { if (waiters.delete(waiter)) resolve(null) }, { once: true })
      if (pending()) serveWaiters()
    })
  }

  // ---- work ----------------------------------------------------------------
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
    emitWork('result', { summary: summarizeWork(w) }, w)
    w.sinks.clear()
    wake(`工作 ${w.id} ${endWord(w)}`)
  }

  // ---- controllers ---------------------------------------------------------
  async function runCleanups (ctrl) {
    for (const fn of ctrl.cleanups.splice(0).reverse()) {
      try { await fn() } catch (error) { log(`清理出错（${ctrl.name}）：${errorText(error)}`) }
    }
    try { await cleanup(bot) } catch (error) { log(`游戏清理出错：${errorText(error)}`) }
  }

  /** Make `run(ctx, ctrl)` the controller; settle() runs when it settles. */
  function start (kind, name, w, run, extra = {}) {
    const ctrl = { kind, name, work: w, ac: new AbortController(), cleanups: [], phase: 'running', confirms: [], ...extra }
    controller = ctrl
    const ctx = {
      signal: ctrl.ac.signal,
      cleanup: fn => { ctrl.cleanups.push(fn) },
      wake,
      takeover: (service, opts) => takeover(service, opts)
    }
    Promise.resolve()
      .then(() => run(ctx, ctrl))
      .then(value => ({ ok: true, value }), error => ({ ok: false, error }))
      .then(outcome => settle(ctrl, outcome))
      .catch(error => log(`交接出错：${error?.stack ?? error}`))
  }

  /**
   * The exit flow. Records `intent` as what comes next (unless a higher-ranked
   * one is already recorded) and asks the controller to exit once. Resolves
   * true when it has exited and the intent was carried out, false when it has
   * not exited within graceMs.
   */
  function requestExit (intent) {
    if (!next || RANK[intent.kind] >= RANK[next.kind]) next = intent
    const ctrl = controller
    if (!ctrl) {
      proceed(null, null)
      return Promise.resolve(true)
    }
    if (ctrl.phase === 'stuck') return Promise.resolve(false)
    const confirmed = new Promise(resolve => ctrl.confirms.push(resolve))
    if (ctrl.phase === 'running') {
      ctrl.phase = 'exiting'
      ctrl.why = intent.why
      ctrl.ac.abort(new ExitRequested(intent.why))
      runCleanups(ctrl) // stop what it is doing now; again after it settles
      setTimeout(() => markStuck(ctrl), graceMs)
    }
    return confirmed
  }

  function markStuck (ctrl) {
    if (controller !== ctrl || ctrl.phase !== 'exiting') return
    ctrl.phase = 'stuck'
    const last = ctrl.work?.log.at(-1)
    const msg = `${describeController(ctrl)} 收到退出请求（${ctrl.why}）后 ${graceMs / 1000} 秒没有退出，仍占着角色` +
      `${last ? `；它最后输出的一行：${last}` : ''}。任务要做到：${EXIT_RULE}。` +
      '现在要恢复就重启游戏进程：node game.mjs stop，然后重新启动 main。'
    log(msg)
    emitWork('event', msg, ctrl.work)
    wake(msg)
    for (const resolve of ctrl.confirms.splice(0)) resolve(false)
  }

  /** Runs once whenever a controller's promise settles, whether or not an exit was requested. */
  async function settle (ctrl, outcome) {
    const asked = ctrl.phase !== 'running'
    const wasStuck = ctrl.phase === 'stuck'
    ctrl.phase = 'done'
    await runCleanups(ctrl)
    controller = null
    if (wasStuck) wake(`${describeController(ctrl)} 终于退出了`)
    // After an exit request the controller's own outcome (usually the abort)
    // does not matter: the recorded intent decides.
    proceed(ctrl, asked ? null : outcome)
    for (const resolve of ctrl.confirms.splice(0)) resolve(true)
  }

  /**
   * Decides what follows `ctrl` (null when there was no controller): a queued
   * service, else a restart of the task, else the end of the work; then the
   * replacing work or idle.
   */
  function proceed (ctrl, outcome) {
    const intent = next
    next = null
    const w = ctrl ? ctrl.work : (work?.status === 'running' ? work : null)
    let end = intent?.end ?? null
    let restart = false
    if (ctrl?.kind === 'task' && outcome) {
      end = outcome.ok ? { ok: true, value: outcome.value } : { ok: false, error: errorText(outcome.error) }
    }
    if (ctrl?.kind === 'service' && outcome) {
      const after = outcome.ok ? `结束：${text(outcome.value ?? '完成')}` : `出错：${errorText(outcome.error)}`
      emitWork('event', `[介入] ${ctrl.name} ${after}`, w)
      if (!w) wake(`${ctrl.name} ${after}`)
      restart = ctrl.mode === 'pause'
      end = { ok: false, stoppedBy: ctrl.name, reason: ctrl.reason, service: after }
    }
    const running = w?.status === 'running'

    if (alive && intent?.service) return startService(intent.service, running ? w : null)
    if (alive && restart && running) {
      emitWork('event', `[重启] 第 ${w.attempts + 1} 次从入口运行`, w)
      return startAttempt(w)
    }
    if (running && end) finishWork(w, end)
    if (alive && intent?.start) {
      work = intent.start
      return startAttempt(work)
    }
    if (ctrl?.kind === 'idle' && outcome) return idleEnded(outcome)
    startIdle()
  }

  // ---- tasks, services, idle -------------------------------------------------
  function startAttempt (w) {
    w.attempts++
    start('task', w.id, w, async (ctx, ctrl) => {
      const task = await loadDefault(w.file)
      return task(bot, {
        ...ctx,
        args: w.args,
        attempt: w.attempts,
        log: (...parts) => {
          const line = parts.map(text).join(' ')
          w.log.push(line)
          if (w.log.length > 30) w.log.shift()
          emitWork('log', { line }, w)
        },
        checkpoint: spec => checkpoint(ctrl, spec)
      })
    })
  }

  function startService ({ name, mode, reason }, w) {
    start('service', name, w, ctx => services[name].run(bot, { ...ctx, reason }), { mode, reason })
  }

  function startIdle () {
    if (!idle || controller || !alive || work?.status === 'running') return
    start('idle', 'idle', null, ctx => idle(bot, ctx))
  }

  // idle returned or threw by itself: start it again after a pause.
  let idleErrors = 0
  function idleEnded (outcome) {
    if (outcome.ok) return setTimeout(startIdle, 1000)
    idleErrors++
    const msg = `idle 出错：${errorText(outcome.error)}`
    log(msg)
    if (idleErrors <= 3) wake(msg)
    setTimeout(startIdle, 2000)
  }

  /** A checkpoint offered by the running task. Throws ExitRequested when a service takes over. */
  async function checkpoint (ctrl, spec = {}) {
    if (ctrl.ac.signal.aborted) throw ctrl.ac.signal.reason
    for (const [name, mode] of Object.entries(spec)) {
      const service = services[name]
      if (!service) throw new Error(`没有名为 ${name} 的服务（已有：${Object.keys(services).join(', ') || '无'}）`)
      if (typeof service.check !== 'function') continue
      let reason
      try { reason = await service.check(bot) } catch (error) { reason = null; log(`服务 ${name} 检查出错：${errorText(error)}`) }
      if (reason) {
        takeover(name, { mode, reason: text(reason) })
        throw new ExitRequested(`介入：${name}`)
      }
    }
  }

  /**
   * Hand the bot to a service. mode 'pause' restarts the task from its entry
   * afterwards; 'stop' (the default) ends the work and goes to idle.
   */
  function takeover (name, { mode = 'stop', reason = '' } = {}) {
    if (!services[name]) return { ok: false, error: `没有名为 ${name} 的服务` }
    if (!alive) return { ok: false, error: '角色已死亡' }
    if (next) return { ok: false, error: `退出进行中（${next.why}）` }
    if (controller?.kind === 'service') return { ok: false, error: `服务 ${controller.name} 正在控制` }
    const w = controller?.kind === 'task' ? controller.work : null
    const modeWord = !w ? '' : mode === 'pause' ? '，结束后从入口重新运行任务' : '，结束后转 idle'
    const msg = `${name} 接管（${reason || '无原因'}）${modeWord}`
    log(msg)
    emitWork('event', `[介入] ${msg}`, w)
    wake(msg)
    const done = requestExit({ kind: 'takeover', why: `介入：${name}`, service: { name, mode, reason } })
    return { ok: true, done }
  }

  /** Submit a task file as the current work. A running work is replaced. */
  async function submit (file, { args = [], sink } = {}) {
    if (!alive) return { ok: false, error: '角色已死亡，等重生后再提交' }
    const abs = path.resolve(file)
    if (!fs.existsSync(abs)) return { ok: false, error: `找不到文件 ${abs}` }
    const w = {
      id: `w${++workSeq}-${path.basename(abs, path.extname(abs))}`,
      file: abs,
      args,
      attempts: 0,
      status: 'running',
      startedAt: Date.now(),
      log: [],
      sinks: new Set(sink ? [sink] : [])
    }
    const replacing = work?.status === 'running'
    const intent = { kind: 'replace', why: replacing ? '被新工作替换' : '开始新工作', end: { ok: false, ended: 'replaced' }, start: w }
    if (!(await requestExit(intent))) {
      // The new work will not start; the old one ends as cancelled whenever it exits.
      if (next === intent) next = { kind: 'cancel', why: intent.why, end: { ok: false, ended: 'cancelled', reason: '换工作时不肯退出' } }
      return { ok: false, error: `${describeController(controller)} 不肯退出，需要重启游戏进程` }
    }
    if (work !== w) return { ok: false, error: alive ? '这次提交被之后的提交或取消取代，没有开始' : '角色已死亡，工作没有开始' }
    return { ok: true, id: w.id, work: w }
  }

  /** Explicit cancel: the exit flow, and nothing queued runs afterwards. */
  async function cancel (reason = '已取消') {
    const w = work?.status === 'running' ? work : null
    if (!w) return { ok: true, note: '没有正在进行的工作' }
    if (!(await requestExit({ kind: 'cancel', why: reason, end: { ok: false, ended: 'cancelled', reason } }))) {
      return { ok: false, error: `${describeController(controller)} 不肯退出，需要重启游戏进程` }
    }
    return { ok: true, summary: summarizeWork(w) }
  }

  // ---- death and respawn ----------------------------------------------------
  const here = () => {
    const p = bot.entity?.position
    return p ? [p.x, p.y, p.z].map(Math.floor).join(' ') : '?'
  }
  bot.on('death', () => {
    alive = false
    const where = here()
    if (controller || work?.status === 'running') {
      requestExit({ kind: 'death', why: '死亡', end: { ok: false, ended: 'death', where } })
    }
    wake(`死亡，位置 ${where}`)
  })
  bot.on('spawn', () => {
    if (alive || (bot.health ?? 20) <= 0) return
    alive = true
    wake(`重生，位置 ${here()}`)
    setTimeout(startIdle, 500)
  })

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
    addReport: (name, fn) => { reports.push([name, fn]) },
    status: () => ({
      alive,
      controller: controller && { kind: controller.kind, name: controller.name, phase: controller.phase },
      work: work && summarizeWork(work),
      pending: pending(),
      next: next?.kind ?? null
    }),
    get controller () { return controller },
    get work () { return work }
  }
}

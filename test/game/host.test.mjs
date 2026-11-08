// Execution-logic tests for game/lib/host.mjs with a stand-in bot (an
// EventEmitter). They check ordering and lifecycle only; whether Pathfinder
// really stops, deaths and real harness behaviour are checked on a server.
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createHost } from '../../game/lib/host.mjs'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function setup (opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-test-'))
  const bot = new EventEmitter()
  bot.health = 20
  bot.entity = { position: { x: 0, y: 64, z: 0 } }
  const events = []
  const cleanupCalls = []
  const host = createHost(bot, {
    dir,
    graceMs: 300,
    log: () => {},
    cleanup: () => { cleanupCalls.push(Date.now()) },
    ...opts
  })
  const file = (name, source) => {
    const p = path.join(dir, `${name}.mjs`)
    fs.writeFileSync(p, source)
    return p
  }
  const run = async (f, args = []) => {
    const msgs = []
    const out = await host.submit(f, { args, sink: m => msgs.push(m) })
    return { out, msgs, result: () => msgs.find(m => m.type === 'result')?.summary }
  }
  return { dir, bot, host, file, run, events, cleanupCalls }
}

const until = async (fn, ms = 3000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (fn()) return
    await sleep(10)
  }
  throw new Error('timed out waiting for condition')
}

test('a task that finishes ends the work, wakes, and wait returns at once', async () => {
  const { host, file, run } = setup()
  const r = await run(file('ok', 'export default async () => 42'))
  await until(() => r.result())
  assert.equal(r.result().ok, true)
  assert.equal(r.result().value, 42)
  assert.equal(host.pending(), true)
  const report = await host.waitForReport()
  assert.match(report, /最近结束的工作：w1-ok 完成/)
  assert.equal(host.pending(), false)
})

test('the work having ended is pending even after its wake flag was consumed', async () => {
  const { host, file, run } = setup()
  const r = await run(file('slow', 'export default async () => { await new Promise(r => setTimeout(r, 100)); return 1 }'))
  host.wake('something else')
  await host.collect() // consumes the wake while the task still runs
  assert.equal(host.pending(), false)
  await until(() => r.result())
  assert.equal(host.pending(), true)
})

test('a wake with no waiter is kept; several wakes merge into one report', async () => {
  const { host } = setup()
  host.wake('chat: hello')
  host.wake('chat: hello again')
  const report = await host.waitForReport()
  assert.match(report, /chat: hello\n/)
  assert.match(report, /chat: hello again/)
  assert.equal(host.pending(), false)
})

test('a wake during report collection is kept for the next wait', async () => {
  const { host } = setup()
  let first = true
  host.addReport('slow', async () => {
    if (first) { first = false; await sleep(50); host.wake('late') }
    return 'x'
  })
  host.wake('early')
  const a = await host.waitForReport()
  assert.match(a, /early/)
  assert.equal(host.pending(), true)
  const b = await host.waitForReport()
  assert.match(b, /late/)
})

test('a waiter that leaves consumes nothing', async () => {
  const { host } = setup()
  const left = new AbortController()
  const p = host.waitForReport(left.signal)
  left.abort()
  assert.equal(await p, null)
  host.wake('after')
  assert.equal(host.pending(), true)
})

test('report functions: a failing one is reported and the others still run', async () => {
  const { host } = setup()
  host.addReport('bad', () => { throw new Error('boom') })
  host.addReport('good', () => 'fine')
  host.wake('x')
  const report = await host.waitForReport()
  assert.match(report, /== bad ==\n报告出错：boom/)
  assert.match(report, /== good ==\nfine/)
})

test('pause-mode checkpoint: task exits, service runs, task restarts from entry; one work, one result', async () => {
  const order = []
  let hungry = true
  const services = {
    eat: {
      check: () => (hungry ? 'food 6' : null),
      run: async () => { order.push('eat'); hungry = false; return 'ate' }
    }
  }
  const { host, file, run } = setup({ services })
  globalThis.__order = order
  const r = await run(file('trip', `export default async (bot, ctx) => {
    globalThis.__order.push('start ' + ctx.attempt)
    try { await ctx.checkpoint({ eat: 'pause' }) } finally { globalThis.__order.push('finally ' + ctx.attempt) }
    return 'done'
  }`))
  await until(() => r.result())
  assert.deepEqual(order, ['start 1', 'finally 1', 'eat', 'start 2', 'finally 2'])
  assert.equal(r.result().ok, true)
  assert.equal(r.result().attempts, 2)
  assert.equal(r.msgs.filter(m => m.type === 'result').length, 1)
  assert.ok(r.msgs.some(m => m.type === 'event' && /重启/.test(m.text)))
  assert.equal(host.work.status, 'ended')
})

test('stop-mode takeover from a module: work ends after the service, then idle', async () => {
  const order = []
  const services = { defend: { run: async () => { order.push('defend'); await sleep(30); return 'safe' } } }
  const idle = async (bot, ctx) => { order.push('idle'); await new Promise(resolve => ctx.signal.addEventListener('abort', resolve)) }
  const { host, file, run } = setup({ services, idle })
  const r = await run(file('mine', `export default async (bot, ctx) => {
    await new Promise((resolve, reject) => ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason)))
  }`))
  await sleep(20)
  assert.equal(host.takeover('defend', { reason: 'skeleton' }).ok, true)
  assert.equal(r.result(), undefined, 'submit still follows while the service runs')
  await until(() => r.result())
  assert.equal(r.result().stoppedBy, 'defend')
  assert.match(r.result().service, /safe/)
  await until(() => host.controller?.kind === 'idle')
  assert.deepEqual(order, ['defend', 'idle'])
})

test('a second takeover while one is running is refused', async () => {
  const services = {
    a: { run: async () => sleep(80) },
    b: { run: async () => {} }
  }
  const { host } = setup({ services })
  assert.equal(host.takeover('a').ok, true)
  assert.equal(host.takeover('b').ok, false)
})

test('the exit flow runs once even when requested twice', async () => {
  let cleanups = 0
  const { host, file, run } = setup()
  globalThis.__count = () => cleanups++
  const r = await run(file('c', `export default async (bot, ctx) => {
    ctx.cleanup(() => globalThis.__count())
    await new Promise((resolve, reject) => ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason)))
  }`))
  await sleep(20)
  const [a, b] = await Promise.all([host.cancel(), host.cancel()])
  assert.equal(a.ok, true)
  assert.equal(b.ok, true)
  await until(() => r.result())
  assert.equal(cleanups, 1)
  assert.equal(r.result().ended, 'cancelled')
})

test('a task that ignores the exit keeps control: nothing else starts, the model is woken', async () => {
  const services = { defend: { run: async () => 'ran' } }
  const { host, file, run } = setup({ services })
  const r = await run(file('stubborn', 'export default async () => { await new Promise(r => setTimeout(r, 1500)); return "late" }'))
  await sleep(20)
  const t = host.takeover('defend', { reason: 'x' })
  await t.done
  assert.equal(host.controller.kind, 'task')
  assert.equal(host.controller.stuck, true)
  const report = await host.waitForReport()
  assert.match(report, /没有退出，仍占着角色/)
  assert.equal(r.result(), undefined)
  // When it finally returns, control is released and the model hears of it.
  await until(() => host.controller === null || host.controller?.kind === 'idle', 3000)
  assert.match(await host.waitForReport(), /终于退出了/)
  await until(() => r.result())
  assert.equal(r.result().ended, 'late-exit')
})

test('client leaving does not cancel; explicit cancel does', async () => {
  const { host, file } = setup()
  const msgs = []
  const sink = m => msgs.push(m)
  await host.submit(file('long', `export default async (bot, ctx) => {
    await new Promise((resolve, reject) => ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason)))
  }`), { sink })
  host.work.sinks.delete(sink) // what the socket server does when the client goes
  await sleep(30)
  assert.equal(host.work.status, 'running')
  await host.cancel()
  assert.equal(host.work.status, 'ended')
  assert.equal(host.work.result.ended, 'cancelled')
})

test('submitting new work replaces the running one through the exit flow', async () => {
  const { host, file, run } = setup()
  const a = await run(file('a', `export default async (bot, ctx) => {
    await new Promise((resolve, reject) => ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason)))
  }`))
  await sleep(10)
  const b = await run(file('b', 'export default async () => "b"'))
  await until(() => b.result())
  assert.equal(a.result().ended, 'replaced')
  assert.equal(b.result().ok, true)
})

test('death ends the work, cancels a pending restart, and a late service end restarts nothing', async () => {
  const services = {
    eat: {
      check: () => 'hungry',
      // Finishes a moment after its exit is requested: a late completion.
      run: (bot, ctx) => new Promise(resolve => ctx.signal.addEventListener('abort', () => setTimeout(() => resolve('ate late'), 50)))
    }
  }
  const idle = async (bot, ctx) => new Promise(resolve => ctx.signal.addEventListener('abort', resolve))
  const { host, bot, file, run } = setup({ services, idle })
  globalThis.__starts = 0
  const r = await run(file('d', `export default async (bot, ctx) => {
    globalThis.__starts++
    await ctx.checkpoint({ eat: 'pause' })
  }`))
  await until(() => host.controller?.kind === 'service')
  bot.health = 0
  bot.emit('death')
  await until(() => r.result())
  assert.equal(r.result().ended, 'death')
  await sleep(100)
  assert.equal(globalThis.__starts, 1)
  assert.equal(host.controller, null, 'no idle before respawn')
  bot.health = 20
  bot.emit('spawn')
  await until(() => host.controller?.kind === 'idle')
  assert.match(await host.waitForReport(), /重生/)
})

test('a task that throws ends the work with the error and returns to idle', async () => {
  const idle = async (bot, ctx) => new Promise(resolve => ctx.signal.addEventListener('abort', resolve))
  const { host, file, run } = setup({ idle })
  const r = await run(file('bad', 'export default async () => { throw new Error("oops") }'))
  await until(() => r.result())
  assert.equal(r.result().ok, false)
  assert.match(r.result().error, /oops/)
  await until(() => host.controller?.kind === 'idle')
})

test('a host created after spawn starts idle by itself', async () => {
  const idle = async (bot, ctx) => new Promise(resolve => ctx.signal.addEventListener('abort', resolve))
  const { host } = setup({ idle })
  await until(() => host.controller?.kind === 'idle')
})

// Cross-process tests: a main (stand-in bot) behind the Unix socket and the
// real game.mjs commands as separate processes.
import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const cli = path.join(here, '../../game/bin/game.mjs')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const fakeMain = path.join(here, 'fixtures/fake-main.mjs')

function startMain (dir, { until = 'ready', env = {} } = {}) {
  const child = spawn(process.execPath, [fakeMain], { env: { ...process.env, GAME_DIR: dir, ...env }, stdio: ['ignore', 'pipe', 'inherit'] })
  return new Promise((resolve, reject) => {
    child.stdout.on('data', d => { if (String(d).includes(until)) resolve(child) })
    child.on('exit', code => reject(new Error(`main exited ${code}`)))
  })
}

/** A main that may refuse to start: its exit code and output. */
function runMain (dir) {
  return new Promise(resolve => {
    execFile(process.execPath, [fakeMain], { env: { ...process.env, GAME_DIR: dir }, timeout: 10000 }, (error, stdout) => resolve({ code: error?.code ?? 0, stdout }))
  })
}

function cmd (dir, args, { timeout = 10000 } = {}) {
  return new Promise(resolve => {
    execFile(process.execPath, [cli, ...args], { env: { ...process.env, GAME_DIR: dir }, timeout }, (error, stdout) => resolve({ code: error?.code ?? 0, stdout, killed: error?.killed }))
  })
}

function bg (dir, args) {
  const child = spawn(process.execPath, [cli, ...args], { env: { ...process.env, GAME_DIR: dir } })
  let out = ''
  child.stdout.on('data', d => { out += d })
  const done = new Promise(resolve => child.on('exit', code => resolve(code)))
  return { child, done, out: () => out }
}

test('run, wait, wake from another point, client loss, cancel, blocked main', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'game-x-'))
  const main = await startMain(dir)
  t.after(() => main.kill('SIGKILL'))
  const task = (name, src) => { const p = path.join(dir, name); fs.writeFileSync(p, src); return p }

  // A short task: run prints the result and exits 0; wait returns at once after.
  const ok = await cmd(dir, ['run', task('ok.mjs', 'export default async (bot, ctx) => { ctx.log("step 1"); return 7 }')])
  assert.equal(ok.code, 0)
  assert.match(ok.stdout, /step 1/)
  assert.match(ok.stdout, /result: 7/)
  const w1 = await cmd(dir, ['wait'], { timeout: 3000 })
  assert.match(w1.stdout, /Last job: j1-ok done/)
  assert.match(w1.stdout, /== status ==\nhp 20/)

  // Nothing pending now: wait blocks until a running task wakes it; the task goes on.
  const long = bg(dir, ['run', task('long.mjs', `export default async (bot, ctx) => {
    await new Promise(r => setTimeout(r, 300)); ctx.wake('halfway')
    await new Promise((resolve, reject) => ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason)))
  }`)])
  const w2 = await cmd(dir, ['wait'], { timeout: 5000 })
  assert.match(w2.stdout, /halfway/)
  assert.match(w2.stdout, /j2-long running/)

  // Killing the run command does not cancel the job.
  long.child.kill('SIGKILL')
  await long.done
  await sleep(100)
  const st = await cmd(dir, ['status'])
  assert.match(st.stdout, /current job: j2-long/)
  assert.match(st.stdout, new RegExp(`pid ${main.pid}`))

  // Cancel does.
  const c = await cmd(dir, ['cancel'])
  assert.equal(c.code, 0)
  assert.match(c.stdout, /cancelled/)

  // A wake while nobody waits is kept for the next wait.
  await cmd(dir, ['wait'], { timeout: 3000 }) // takes the cancel
  await cmd(dir, ['run', task('wake.mjs', 'export default async (bot, ctx) => { ctx.wake("nobody listening") }')])
  const w3 = await cmd(dir, ['wait'], { timeout: 3000 })
  assert.match(w3.stdout, /nobody listening/)

  // A main stuck in synchronous code: wait says so instead of hanging.
  const waiting = bg(dir, ['wait'])
  await sleep(200)
  bg(dir, ['run', task('busy.mjs', 'export default async () => { const t = Date.now() + 4000; while (Date.now() < t) {} }')])
  assert.equal(await waiting.done, 1)
  assert.match(waiting.out(), /main's thread/)
})

test('one main per project: a second one exits with a message; a stale socket is replaced', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'game-y-'))
  const first = await startMain(dir)
  t.after(() => first.kill('SIGKILL'))
  const second = await runMain(dir)
  assert.equal(second.code, 0)
  assert.match(second.stdout, new RegExp(`main is already running for this project \\(pid ${first.pid}, `))
  assert.match((await cmd(dir, ['status'])).stdout, /character: alive/)

  // A main killed outright leaves its socket file behind; nothing answers on it.
  first.kill('SIGKILL')
  await new Promise(resolve => first.once('exit', resolve))
  assert.ok(fs.existsSync(path.join(dir, '.game/main.sock')))
  assert.match((await cmd(dir, ['status'])).stdout, /main is not running/)

  // The next main takes the socket over; until it has a host it says it is starting.
  const next = await startMain(dir, { until: 'entry open', env: { START_DELAY_MS: '1500' } })
  t.after(() => next.kill('SIGKILL'))
  const early = await cmd(dir, ['status'])
  assert.equal(early.code, 1)
  assert.match(early.stdout, /main is starting/)
  await new Promise(resolve => next.stdout.on('data', d => { if (String(d).includes('ready')) resolve() }))
  fs.writeFileSync(path.join(dir, 'ok.mjs'), 'export default async () => 1')
  assert.equal((await cmd(dir, ['run', path.join(dir, 'ok.mjs')])).code, 0)

  // stop ends it by the pid from its status reply.
  const stop = await cmd(dir, ['stop'])
  assert.match(stop.stdout, new RegExp(`main \\(pid ${next.pid}\\) exited`))
})

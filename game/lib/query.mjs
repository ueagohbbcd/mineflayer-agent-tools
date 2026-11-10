// SPDX-License-Identifier: MIT
// Loading a task or query module afresh (edits apply on the next run; modules
// it imports stay cached until main restarts), and running a read-only query
// beside the job. Read-only is a convention; the timeout only stops waiting.
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { errorText, text } from './describe.mjs'

export async function loadDefault (file) {
  const mtime = fs.statSync(file).mtimeMs
  const mod = await import(`${pathToFileURL(file).href}?v=${mtime}`)
  if (typeof mod.default !== 'function') throw new Error(`${file} 没有 export default async function (bot, ctx)`)
  return mod.default
}

export async function runQuery (bot, file, { args = [], timeoutMs = 10000 } = {}) {
  const lines = []
  const ac = new AbortController()
  const run = loadDefault(path.resolve(file))
    .then(fn => fn(bot, { args, signal: ac.signal, log: (...p) => lines.push(p.map(text).join(' ')) }))
    .then(result => ({ ok: true, result }), error => ({ ok: false, error: errorText(error) }))
  let timer
  const late = new Promise(resolve => {
    timer = setTimeout(() => { ac.abort(); resolve({ ok: false, error: `查询 ${timeoutMs / 1000} 秒没有返回` }) }, timeoutMs)
  })
  const out = await Promise.race([run, late])
  clearTimeout(timer)
  return { ...out, log: lines }
}

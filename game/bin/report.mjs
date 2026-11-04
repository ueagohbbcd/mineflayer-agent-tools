#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Show what the observers recorded. Reads files only: works with main
// stopped, never changes anything, safe to pipe into grep.
//
//   node report.mjs                      one line per source: entries, time span
//   node report.mjs <source> [minutes]   that source over the last N minutes (default 10)
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { recordsDir } from '../lib/files.mjs'
import { clock } from '../observers/support.mjs'
import { genericLines } from '../observers/view.mjs'

const dir = path.resolve(process.env.GAME_DIR ?? '.')
const [source, minutesArg] = process.argv.slice(2)
const records = recordsDir(dir)

function read (name) {
  const file = path.join(records, `${name}.jsonl`)
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap(line => {
    try {
      return [JSON.parse(line)]
    } catch {
      return []
    }
  })
}

const sources = fs.existsSync(records) ? fs.readdirSync(records).filter(f => f.endsWith('.jsonl')).map(f => f.slice(0, -6)).sort() : []

if (!source) {
  if (!sources.length) console.log(`还没有记录（${records}）。main 启动后观察器才开始写。`)
  for (const name of sources) {
    const entries = read(name)
    const urgent = entries.filter(e => e.urgent).length
    const span = entries.length ? `${clock(entries[0].at)}–${clock(entries.at(-1).at)}` : ''
    console.log(`${name}: ${entries.length} 条${urgent ? `（${urgent} 条 urgent）` : ''} ${span}`)
  }
  console.log('看某一项：node report.mjs <名称> [分钟]')
  process.exit(0)
}

const minutes = Number(minutesArg) || 10
const since = Date.now() - minutes * 60000
const entries = read(source).filter(e => Date.parse(e.at) >= since)
if (!sources.includes(source)) {
  console.log(`没有 ${source} 的记录；有：${sources.join(', ') || '无'}`)
  process.exit(1)
}
console.log(`== ${source}：最近 ${minutes} 分钟 ${entries.length} 条 ==`)
if (!entries.length) process.exit(0)
let lines
const observer = new URL(`../observers/${source}.mjs`, import.meta.url)
if (fs.existsSync(observer)) {
  const mod = await import(pathToFileURL(observer.pathname).href)
  if (typeof mod.summarize === 'function') lines = mod.summarize(entries)
}
lines ??= genericLines(entries)
for (const line of (Array.isArray(lines) ? lines : String(lines).split('\n'))) console.log(line)

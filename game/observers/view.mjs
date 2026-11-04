// SPDX-License-Identifier: MIT
// The generic way to show an observer's entries: an entry with a key is shown
// only in its newest version; repeats in a row fold into one line with a count.
import { clock } from './support.mjs'

const json = value => {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export function entryLine (entry, { count = 1, lastAt } = {}) {
  const { at, type, urgent, key, data: own, ...fields } = entry
  const data = own ?? fields
  const text = typeof data === 'string' ? data : data && Object.keys(data).length ? json(data) : ''
  return [
    clock(entry.at),
    entry.urgent ? '!' : '-',
    ...(entry.type ? [entry.type] : []),
    ...(text ? [text] : []),
    ...(count > 1 ? [`×${count}, last ${clock(lastAt)}`] : [])
  ].join(' ')
}

export function genericLines (entries) {
  const newest = new Map()
  for (const entry of entries) if (entry.key) newest.set(entry.key, entry)
  const kept = entries.filter(entry => !entry.key || newest.get(entry.key) === entry)
  const lines = []
  let run = null
  const flush = () => {
    if (run) lines.push(entryLine(run.first, { count: run.count, lastAt: run.lastAt }))
    run = null
  }
  for (const entry of kept) {
    const { at, ...rest } = entry
    const same = json(rest)
    if (run && run.same === same) {
      run.count += 1
      run.lastAt = entry.at
      continue
    }
    flush()
    run = { same, first: entry, count: 1, lastAt: entry.at }
  }
  flush()
  return lines
}

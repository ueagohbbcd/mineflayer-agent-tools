// SPDX-License-Identifier: MIT
// notifyModel appends to .game/notices.jsonl. Only the `wait` command marks
// notices delivered; reading or grepping the file never changes that.
import fs from 'node:fs'
import { appendLine, deliveredFile, noticesFile } from './files.mjs'

export function notifyModel (dir, text, data) {
  const notice = { at: new Date().toISOString(), text: String(text) }
  if (data !== undefined) notice.data = data
  appendLine(noticesFile(dir), notice)
  return notice
}

export function createNotifier (dir) {
  return (text, data) => notifyModel(dir, text, data)
}

/** Complete notice lines after the delivered offset. */
export function readUndelivered (dir) {
  let buffer
  try {
    buffer = fs.readFileSync(noticesFile(dir))
  } catch (error) {
    if (error.code === 'ENOENT') return { notices: [], end: 0 }
    throw error
  }
  let offset = 0
  try {
    offset = Number(fs.readFileSync(deliveredFile(dir), 'utf8').trim()) || 0
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  if (offset > buffer.length) offset = 0 // file was reset by hand
  const lastNewline = buffer.lastIndexOf(0x0a)
  if (lastNewline < offset) return { notices: [], end: offset }
  const text = buffer.subarray(offset, lastNewline + 1).toString('utf8')
  const notices = text.split('\n').filter(Boolean).map(line => {
    try {
      return JSON.parse(line)
    } catch {
      return { at: null, text: line }
    }
  })
  return { notices, end: lastNewline + 1 }
}

export function markDelivered (dir, end) {
  const file = deliveredFile(dir)
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, `${end}\n`)
  fs.renameSync(tmp, file)
}

export function formatNotice (notice) {
  const time = notice.at ? notice.at.slice(11, 19) : '--:--:--'
  return `[${time}] ${notice.text}`
}

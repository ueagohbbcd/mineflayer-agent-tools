#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Blocks until the game project has undelivered notices, prints them, marks
// them delivered and exits. Its exit is what brings the model back.
//
//   node wait.mjs [project-dir]
import path from 'node:path'
import { formatNotice, markDelivered, readUndelivered } from '../lib/notify.mjs'

const dir = path.resolve(process.argv[2] ?? process.env.GAME_DIR ?? '.')
const pollMs = 300

for (;;) {
  const { notices, end } = readUndelivered(dir)
  if (notices.length > 0) {
    process.stdout.write(`${notices.length} 条新通知：\n`)
    for (const notice of notices) process.stdout.write(formatNotice(notice) + '\n')
    markDelivered(dir, end)
    break
  }
  await new Promise(resolve => setTimeout(resolve, pollMs))
}

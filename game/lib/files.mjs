// SPDX-License-Identifier: MIT
// Project-directory files: records and run files live under the
// game project so every shell command can read them, online or offline.
import fs from 'node:fs'
import path from 'node:path'

export function gameDir (dir) {
  return path.join(dir, '.game')
}

export function recordsDir (dir) {
  return path.join(dir, 'records')
}

export function appendLine (file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  // One write per line with O_APPEND, so concurrent writers (main thread,
  // watchdog worker, report scripts) never interleave inside a line.
  fs.appendFileSync(file, JSON.stringify(value) + '\n')
}

export function writeJsonAtomic (file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n')
  fs.renameSync(tmp, file)
}

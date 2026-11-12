// SPDX-License-Identifier: MIT
// Runs inside the watchdog worker while the main thread is stuck in
// synchronous code. Main cannot answer anything then, so the worker writes a
// file that waiting clients check, with main's pid for `stop`.
import fs from 'node:fs'

export default function onBlocked (event, { file, pid }) {
  fs.writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), seconds: event.seconds, pid }) + '\n')
}

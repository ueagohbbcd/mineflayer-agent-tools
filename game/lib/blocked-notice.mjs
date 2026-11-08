// SPDX-License-Identifier: MIT
// Runs inside the watchdog worker while the main thread is stuck in
// synchronous code. Main cannot answer anything then, so the worker writes a
// file that waiting clients check.
import fs from 'node:fs'

export default function onBlocked (event, { file }) {
  fs.writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), seconds: event.seconds }) + '\n')
}

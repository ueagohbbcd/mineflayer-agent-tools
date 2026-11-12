// SPDX-License-Identifier: MIT
// A `log` for the recording observers (explore, radar): post(data, opts)
// appends to records/<source>.jsonl; `node report.mjs <source>` reads them.
//
//   startExplore({ bot, log: recordLog(dir, 'explore') })
import path from 'node:path'
import { appendLine, recordsDir } from '../lib/files.mjs'

export function recordLog (dir, source, { wake } = {}) {
  return {
    post (data, { type, key, urgent = false } = {}) {
      appendLine(path.join(recordsDir(dir), `${source}.jsonl`), { at: new Date().toISOString(), ...(type ? { type } : {}), ...(key ? { key } : {}), data })
      if (urgent) wake?.(`[${source}] ${type ?? ''}`)
      return Promise.resolve()
    }
  }
}

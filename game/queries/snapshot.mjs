// SPDX-License-Identifier: MIT
// One state sample of the live bot, as JSON:
//
//   node game.mjs query <toolkit>/game/queries/snapshot.mjs [--full-entities] [--full-local] [--full-items]
import { observe } from '../observation/observe.mjs'

const flags = {
  '--full-entities': 'fullEntities',
  '--full-local': 'fullLocal',
  '--full-items': 'fullItems'
}

export function observeArgs (args) {
  const options = {}
  for (const arg of args) {
    if (!flags[arg]) throw new Error(`Unknown option ${arg}; use ${Object.keys(flags).join(', ')}`)
    options[flags[arg]] = true
  }
  return options
}

export default async function snapshot (bot, { args = [] }) {
  return await observe(bot, observeArgs(args))
}

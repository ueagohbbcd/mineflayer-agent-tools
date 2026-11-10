// SPDX-License-Identifier: MIT
// The game's public entry: the core, the socket, plugin wiring, the observers
// and reports that game/template/main.mjs imports in one line. Experimental
// control logic is imported from game/experimental/ directly.
export { createHost, ExitRequested } from './lib/host.mjs'
export { summarizeJob, formatJob, formatSummary } from './lib/describe.mjs'
export { runQuery } from './lib/query.mjs'
export { openEntry, serve, socketPath, blockedFile } from './lib/server.mjs'
export { loadPlugins, walkingMovements, defaultMovements, stopGameActions } from './lib/plugins.mjs'
export { compatibleMinecraftOptions } from './lib/minecraft-compat.mjs'
export { statusReport } from './observers/status.mjs'
export { radarReport, isHostile } from './observers/radar-report.mjs'
export { watchDamage } from './observers/damage.mjs'
export { watchChat } from './observers/chat-report.mjs'
export { recordLog } from './observers/record.mjs'
export { startJournal } from './observers/journal.mjs'
export { startExplore } from './observers/explore.mjs'
export { startRadar } from './observers/radar.mjs'
export { oxygenOf } from './observation/snapshot.mjs'
export { fixCrafting, tidy } from './lib/crafting-fix.mjs'

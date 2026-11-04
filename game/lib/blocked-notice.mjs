// SPDX-License-Identifier: MIT
// Runs inside the watchdog worker while the main thread is stuck in
// synchronous code: it writes the notice itself, since main cannot.
import { notifyModel } from './notify.mjs'

export default function onBlocked (event, { dir }) {
  notifyModel(dir, `主线程 ${event.seconds} 秒没有回到事件循环（同步死循环？）。卡住期间 task、query、cancel 都无法处理；用 \`node game.mjs stop\` 结束后重新启动 main。`, { type: 'blocked', seconds: event.seconds })
}

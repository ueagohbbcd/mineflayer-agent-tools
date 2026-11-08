// SPDX-License-Identifier: MIT
// Chat lines from other players since the last report. A whisper, or a line
// that names the bot, wakes the model.
export function watchChat (bot, { wake } = {}) {
  const lines = []
  bot.on('chat', (username, message) => {
    if (username === bot.username) return
    lines.push(`<${username}> ${message}`)
    if (lines.length > 50) lines.shift()
    if (new RegExp(`\\b${escape(bot.username)}\\b`, 'i').test(message)) wake?.(`${username} 提到你：${message}`)
  })
  bot.on('whisper', (username, message) => {
    if (username === bot.username) return
    lines.push(`<${username} 私聊> ${message}`)
    wake?.(`${username} 私聊：${message}`)
  })
  return {
    report () {
      if (!lines.length) return ''
      const out = lines.splice(0)
      return out.join('\n')
    }
  }
}

const escape = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

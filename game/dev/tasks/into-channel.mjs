// Dev only: put the bot back into the middle of the channel (bot is op).
export default async function task (bot) {
  bot.chat('/tp @s 20.5 -61 0.5')
  await new Promise(resolve => setTimeout(resolve, 1500))
  return { at: bot.entity.position.toString(), block: bot.blockAt(bot.entity.position)?.name }
}

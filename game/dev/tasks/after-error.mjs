export default async function task (bot) {
  return { health: bot.health, food: bot.food, onGround: bot.entity.onGround }
}

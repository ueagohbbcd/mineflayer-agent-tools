// SPDX-License-Identifier: MIT
// The only inputs the prebuilt loop applies: setControlState keys and look.
export const CONTROL_KEYS = ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak']

export function checkInputs (inputs, where) {
  if (inputs == null) return {}
  if (typeof inputs !== 'object') throw new TypeError(`${where} must return an object, got ${typeof inputs}`)
  for (const key of Object.keys(inputs)) {
    if (key === 'look' || key === 'done' || key === 'result') continue
    if (!CONTROL_KEYS.includes(key)) {
      throw new TypeError(`${where} returned unknown input "${key}"; allowed: ${CONTROL_KEYS.join(', ')}, look, done, result`)
    }
  }
  return inputs
}

/** Set every control key: keys missing from `inputs` are released. */
export function applyInputs (bot, inputs = {}) {
  for (const key of CONTROL_KEYS) {
    const want = Boolean(inputs[key])
    if (bot.controlState[key] !== want) bot.setControlState(key, want)
  }
  if (inputs.look) {
    const { yaw = bot.entity.yaw, pitch = bot.entity.pitch } = inputs.look
    bot.look(yaw, pitch, true).catch(() => {})
  }
}

export function releaseAll (bot) {
  applyInputs(bot, {})
}

export function heldKeys (bot) {
  return CONTROL_KEYS.filter(key => bot.controlState[key])
}

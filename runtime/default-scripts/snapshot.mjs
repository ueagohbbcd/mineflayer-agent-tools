/**
 * One state sample, printed as JSON:
 *
 *   mf snapshot [--full-entities] [--full-local] [--full-items]
 *
 * Uses the public session facts (teams, goal items) when there is a session.
 * Programs can import `observe`.
 */
import { observe } from "../observation/observe.mjs";
import { observationOptionsFromSession } from "../observation/session-options.mjs";
export { observe };

const flags = {
  "--full-entities": "fullEntities",
  "--full-local": "fullLocal",
  "--full-items": "fullItems",
};

export function observeArgs(args) {
  const options = {};
  for (const arg of args) {
    if (!flags[arg])
      throw new Error(
        `Unknown option ${arg}; use ${Object.keys(flags).join(", ")}`,
      );
    options[flags[arg]] = true;
  }
  return options;
}

// Read-only: never stops the character's movement.
export const control = false;

export default async function observeProgram(bot, { args = [] }) {
  const options = observeArgs(args);
  const session = await bot.getSessionState?.().catch(() => undefined);
  const result = await observe(bot, {
    ...observationOptionsFromSession(session),
    ...options,
  });
  return result;
}

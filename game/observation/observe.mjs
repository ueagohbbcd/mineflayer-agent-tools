/** Sample current game state on demand as `{state, metadata}`; game/queries/snapshot.mjs prints it. */
import { sampleObservation } from "./index.mjs";
export async function observe(bot, options = {}) {
  return {
    state: sampleObservation(bot, options),
    metadata: {
      epoch: bot?.epoch ?? null,
      sequence: bot?.sequence ?? null,
      sampledAt: bot?.sampledAt ?? null,
      source: "on-demand observation",
    },
  };
}

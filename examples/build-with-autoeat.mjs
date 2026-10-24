/** Build an explicit placement plan while coordinating background meals.
 * Usage: mf run "$MF_TOOLKIT_ROOT/examples/build-with-autoeat.mjs" plan.json
 * Plan: {"material":"cobblestone","steps":[{"against":{"x":0,"y":64,"z":0},"face":{"x":0,"y":1,"z":0}}]}
 * Plan positions must be reachable from the current location. Health events
 * trigger meals; a shared hand Promise serializes equip/place/use-item.
 * Reports go through `reporter.post(data, { key, urgent })`: run as a program,
 * meals are JSON lines in its own output and "no food" also goes to the log
 * as urgent, which wakes the model while the build goes on.
 */
import { readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { LogClient } from "../runtime/log/index.mjs";
import { Vec3 } from "vec3";

const foods = new Set([
  "bread",
  "cooked_beef",
  "cooked_porkchop",
  "baked_potato",
  "cooked_chicken",
]);

export async function buildWithAutoeat(
  bot,
  reporter,
  plan,
  { signal, pause = sleep, now = Date.now } = {},
) {
  if (typeof plan?.material !== "string" || !Array.isArray(plan.steps))
    throw new Error("Plan requires material and steps");
  let placed = 0,
    hand = Promise.resolve(),
    backgroundFood = Promise.resolve(),
    feeding = false,
    closed = false,
    pendingResume = 0,
    reportedNoFood = false;
  const food = {
    attempts: 0,
    observedChange: 0,
    unconfirmed: 0,
    failed: 0,
    cancelled: 0,
    resumed: 0,
    noFoodWarnings: 0,
    reportErrors: 0,
    recent: [],
    omitted: 0,
  };
  const checkAbort = () => signal?.throwIfAborted();
  const snapshot = (name) => ({
    health: bot.health,
    food: bot.food,
    itemCount: bot.inventory
      .items()
      .filter((item) => item.name === name)
      .reduce((count, item) => count + (item.count ?? 0), 0),
  });
  const withHand = (fn) => {
    const next = hand.then(() => {
      checkAbort();
      return fn();
    });
    hand = next.catch(() => {});
    return next;
  };
  function resumeBuild() {
    food.resumed += pendingResume;
    pendingResume = 0;
    for (const report of food.recent) {
      if (report.resume.status === "pending")
        report.resume = {
          status: "resumed",
          at: now(),
          nextStep: placed + 1,
          activity: "build hand control restored; placement not yet confirmed",
        };
    }
  }
  async function reportFood(report) {
    food[report.outcome]++;
    pendingResume++;
    // Keep the latest 16 meal reports for the final result.
    food.recent.push(report);
    if (food.recent.length > 16) {
      food.recent.shift();
      food.omitted++;
    }
    try {
      // Resume is still pending; the final result updates it when building
      // takes the hand again.
      await reporter.post(report);
    } catch (error) {
      food.reportErrors++;
      report.deliveryError = error.message;
    }
  }
  async function checkFood() {
    if (closed || feeding || bot.food >= 14) return;
    feeding = true;
    try {
      const item = bot.inventory.items().find((item) => foods.has(item.name));
      if (!item) {
        if (!reportedNoFood) {
          reportedNoFood = true;
          food.noFoodWarnings++;
          await reporter.post(
            {
              reason: "No food available",
              food: bot.food,
              health: bot.health,
              construction: "continues unless you cancel or change the program",
            },
            { urgent: true },
          );
        }
        return;
      }
      reportedNoFood = false;
      await withHand(async () => {
        const report = {
          type: "food.action",
          attempt: ++food.attempts,
          item: item.name,
          reason: "food_below_14",
          startedAt: now(),
          before: snapshot(item.name),
          pausedBuild: {
            placed,
            total: plan.steps.length,
            nextStep: placed + 1,
          },
          resume: { status: "pending" },
        };
        try {
          await bot.equip(item, "hand");
          checkAbort();
          try {
            bot.activateItem();

            await pause(1800, undefined, { signal });
          } finally {
            // Release only this program's item use, never independent movement.
            bot.deactivateItem();
          }
          checkAbort();
          const after = snapshot(item.name);
          // Holding use-item is only an attempt. Report an unconfirmed result
          // if the game/mirror has not shown any relevant state change.
          report.outcome =
            after.food > report.before.food ||
            after.itemCount < report.before.itemCount
              ? "observedChange"
              : "unconfirmed";
        } catch (error) {
          report.outcome = signal?.aborted ? "cancelled" : "failed";
          report.error = error.message;
          throw error;
        } finally {
          report.endedAt = now();
          report.after = snapshot(item.name);
          await reportFood(report);
        }
      });
    } finally {
      feeding = false;
    }
  }
  const healthListener = () => {
    if (closed || feeding || bot.food >= 14) return;
    backgroundFood = checkFood().catch((error) => {
      // The food.action already records an attempted action's failure. Keep
      // other background errors in the final result instead of duplicating it.
      if (!signal?.aborted) food.backgroundError = error.message;
    });
  };
  bot.on("health", healthListener);
  healthListener();

  let status = "completed",
    error;
  try {
    for (const step of plan.steps) {
      await withHand(async () => {
        const material = bot.inventory
          .items()
          .find((item) => item.name === plan.material);
        if (!material) throw new Error(`Missing material: ${plan.material}`);
        const against = bot.blockAt(
          new Vec3(step.against.x, step.against.y, step.against.z),
        );
        if (!against) throw new Error("Placement reference is unknown");
        await bot.equip(material, "hand");
        checkAbort();
        resumeBuild();
        await bot.placeBlock(
          against,
          new Vec3(step.face.x, step.face.y, step.face.z),
        );
      });
      placed++;
      checkAbort();
      await reporter.post(
        { placed, total: plan.steps.length },
        { key: "build.progress" },
      );
      // Health events also trigger this independently; no model polling.
      await checkFood();
    }
  } catch (cause) {
    status = signal?.aborted ? "cancelled" : "failed";
    error = cause.message;
  } finally {
    closed = true;
    bot.off("health", healthListener);
    await hand;
    await backgroundFood;
    if (signal?.aborted) {
      status = "cancelled";
      error ??= signal.reason?.message ?? "Program cancelled";
    }
    for (const report of food.recent) {
      if (report.resume.status === "pending")
        report.resume = {
          status: "not_resumed",
          at: now(),
          reason: error ?? "build finished without another hand action",
        };
    }
  }
  // Include cumulative outcomes in the program's final result.
  return {
    status,
    built: placed,
    total: plan.steps.length,
    food,
    ...(error ? { error } : {}),
  };
}

export default async function buildWithAutoeatProgram(
  bot,
  { args = [], signal, log = console.log },
) {
  if (!args[0]) throw new Error("Pass a JSON placement plan");
  const plan = JSON.parse(await readFile(args[0], "utf8"));
  const urgent = new LogClient({ source: "build" });
  // Meals and warnings as output lines; per-block progress (keyed) is left
  // out; a warning that needs you also goes to the log as urgent.
  const reporter = {
    async post(data, { key, urgent: wake } = {}) {
      if (!key) log(JSON.stringify(data));
      if (wake) await urgent.post(data, { type: "warning", urgent: true });
    },
  };
  try {
    const result = await buildWithAutoeat(bot, reporter, plan, { signal });
    log(JSON.stringify(result));
    if (result.error) throw new Error(result.error);
  } finally {
    bot.clearControlStates();
    bot.deactivateItem();
  }
}

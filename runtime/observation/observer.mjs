import { sampleObservation, watchObservation } from "./index.mjs";
import {
  RECENT_BLOCK_DEFAULTS,
  projectRecentBlocks,
  startNearbyScan,
} from "./nearby-scan.mjs";
import { createSectionDiff } from "./section-diff.mjs";
import { observationOptionsFromSession } from "./session-options.mjs";
import { observerOptions, readObserverConfig } from "./observer-config.mjs";
import { createReportPolicy } from "./report-policy.mjs";
import { inboxSlot } from "../inbox/slot.mjs";

// The default observer: createDefaultObserver is the sampling and event
// policy; startObserver runs it against a bot and reports through an inbox
// client. runtime/default-scripts/observer.mjs is the script that calls it.

/** Observation policy over a supplied bot; it owns no inbox or connection. */
export function createDefaultObserver({
  getBot,
  connectionStatus,
  now = Date.now,
  post = () => ({ accepted: true }),
  onError = () => {},
  options = {},
  recentBlocks = RECENT_BLOCK_DEFAULTS,
  // Which of the interval reports to send (see report-policy.mjs).
  report = { recentBlocks: true, signs: true },
  watch = watchObservation,
  sample = sampleObservation,
}) {
  let watcher;
  const scanning =
    recentBlocks.enabled !== false && (report.recentBlocks || report.signs);
  const recent = startNearbyScan({
    getBot,
    connectionStatus,
    now,
    options: { ...recentBlocks, enabled: scanning },
    postReport: (data, { onDelivered, onLost, minDeliveryDelayMs }) =>
      !report.recentBlocks
        ? (onDelivered(), { accepted: true }) // Scanned for signs only.
        : post(
            {
              kind: "state",
              key: "observation.recent_blocks",
              minDeliveryDelayMs,
              priority: "normal",
              data: { type: "observation.recent_blocks", ...data },
            },
            { onDelivered, onLost },
          ),
    postSigns: !report.signs
      ? undefined
      : (data, { key, onDelivered, onLost }) =>
          post(
            {
              kind: "state",
              key,
              priority: "normal",
              data: { type: "observation.nearby_signs", ...data },
            },
            { onDelivered, onLost },
          ),
  });
  return {
    attachBot(bot) {
      watcher?.close();
      watcher = bot
        ? watch(bot, { ...options, now, post, onError })
        : undefined;
      if (bot) recent.sampleNow();
    },
    /** Game state only; recent blocks and signs have their own reports. */
    sampleState(overrides = {}) {
      const settings = { ...options, ...overrides, now };
      return watcher ? watcher.sample(settings) : sample(null, settings);
    },
    currentSigns: () => recent.currentSigns(),
    sample(overrides = {}) {
      return {
        ...this.sampleState(overrides),
        nearbySigns: recent.currentSigns(),
        ...(!scanning || !report.recentBlocks
          ? {}
          : { recentBlocks: projectRecentBlocks(recent.snapshot(), now()) }),
      };
    },
    close() {
      watcher?.close();
      watcher = undefined;
      recent.close();
    },
  };
}

/**
 * Run the default observation policy against one connected bot and report
 * through an inbox client (InboxClient or anything with send/delivery).
 *
 * - Events (damage, items, respawn...) since the model last read them share
 *   one `observation.events` report, urgent while it holds an urgent one.
 * - Interval block summaries (`observation.recent_blocks`) keep accumulating
 *   until a delivery receipt says the model has seen them.
 * - Sign sets seen since the last read share one `observation.nearby_signs`
 *   report.
 * - Changed state sections are posted as one replaceable
 *   `observation.current` report, diffed against what was last delivered;
 *   when the state returns to that, the pending report is taken back.
 * - A "full" signal from the reader (`mf inbox --full`) sends the whole
 *   state and the signs in view again, as after a fresh start.
 */
export async function startObserver({
  bot,
  inbox,
  cwd = process.cwd(),
  env = process.env,
  // Defaults to observer.json's intervalMs, else 1000.
  intervalMs,
  now = Date.now,
  // Event thresholds for watchObservation, e.g. { urgentDamageLoss: 2 };
  // they override the "events" object of observer.json.
  events = {},
  // Test seams for the sampling functions; defaults are the toolkit's own.
  watch,
  sample,
  onError = (error) =>
    console.error(`observer: ${error?.message ?? String(error)}`),
}) {
  const config = await readObserverConfig(cwd, env);
  intervalMs ??=
    Number.isSafeInteger(config.intervalMs) && config.intervalMs > 0
      ? config.intervalMs
      : 1000;
  let match;
  try {
    match = await bot.getSessionState?.();
  } catch (error) {
    onError(error);
  }
  const options = {
    // Deaths and disconnects are the mf supervisor's stops: not twice.
    lifecycleEvents: false,
    ...observationOptionsFromSession(match),
    ...observerOptions(config),
    ...events,
  };
  let closed = false;
  let status = "connected";
  const listeners = [];
  const listen = (name, fn) => {
    bot.on(name, fn);
    listeners.push([name, fn]);
  };
  listen("spawn", () => (status = "connected"));
  listen("end", () => (status = "disconnected"));
  listen("kicked", () => (status = "disconnected"));

  const report = (error) => !closed && onError(error);
  const eventsSlot = inboxSlot(inbox, "observation.events", {
    render: (events, { omitted }) => ({
      type: "observation.events",
      events,
      ...(omitted ? { omittedOlderEvents: omitted } : {}),
    }),
    onError: report,
  });
  const signsSlot = inboxSlot(inbox, "observation.nearby_signs", {
    render: (sets) => ({ type: "observation.nearby_signs", sets }),
    maxEntries: 16,
    onError: report,
  });
  let eventSeq = 0;

  /**
   * Accept now; confirm through the receipt. `onLost` runs when the message
   * will never reach the model (send failed, or it expired or was dropped), so
   * the producer can post it again; a replaced or retracted message is not
   * lost. `onSent` gets the queued message's id.
   */
  function post(message, { onDelivered, onLost, onSent } = {}) {
    if (message.kind === "event") {
      eventsSlot.put(++eventSeq, message.data, {
        urgent: message.priority === "urgent",
      });
      return { accepted: true };
    }
    if (message.key?.startsWith("observation.nearby_signs:")) {
      const { type: _, ...set } = message.data;
      signsSlot.put(message.key, set, { onDelivered });
      return { accepted: true };
    }
    const lost = () => !closed && onLost?.();
    inbox
      .send(message)
      .then(async (result) => {
        if (!result?.accepted) return lost();
        onSent?.(result.id);
        if (!onDelivered && !onLost) return;
        const { outcome } = await inbox.delivery(result.id, {
          timeoutMs: Infinity,
        });
        if (closed) return;
        if (outcome === "delivered") onDelivered?.();
        else if (outcome !== "replaced" && outcome !== "retracted") lost();
      })
      .catch((error) => {
        if (closed) return;
        onError(error);
        lost();
      });
    return { accepted: true };
  }

  const policy = createReportPolicy(config.report);
  const core = createDefaultObserver({
    getBot: () => bot,
    connectionStatus: () => status,
    now,
    post,
    onError,
    options,
    recentBlocks: { ...RECENT_BLOCK_DEFAULTS, ...config.recentBlocks },
    report: policy.options,
    ...(watch ? { watch } : {}),
    ...(sample ? { sample } : {}),
  });
  core.attachBot(bot);

  const connection = () =>
    status === "connected" ? {} : { connectionStatus: status };
  let changes = createSectionDiff();
  let posted = null; // { signature, sequence, retract() } of the pending report
  let sequence = 0;
  let deliveredSequence = 0;
  function publish() {
    if (closed) return;
    let snapshot;
    try {
      // Signs in loaded columns are reported by the nearby scan, not here.
      // The local cube is on request only (observe.mjs --full-local, reach-map.mjs).
      snapshot = policy.project(
        core.sampleState({
          ...connection(),
          loadedSigns: false,
          local: false,
        }),
      );
    } catch (error) {
      onError(error);
      return;
    }
    const diff = changes;
    const delivery = diff.prepare(snapshot);
    if (!delivery) {
      // Everything returned to what the model last saw: the pending report
      // describes a state that no longer holds, so take it back.
      posted?.retract();
      posted = null;
      return;
    }
    const message = delivery.message;
    const signature = JSON.stringify(message.changes);
    if (signature === posted?.signature) return;
    const pending = {
      signature,
      sequence: ++sequence,
      id: null,
      retracted: false,
      retract() {
        pending.retracted = true;
        if (pending.id) inbox.retract?.(pending.id).catch(report);
      },
    };
    posted = pending;
    post(
      {
        kind: "state",
        key: "observation.current",
        priority: "normal",
        data: message,
      },
      {
        onSent(id) {
          pending.id = id;
          if (pending.retracted) pending.retract();
        },
        onDelivered() {
          // A report from before a full resend no longer sets the baseline.
          if (pending.sequence > deliveredSequence && diff === changes) {
            delivery.onDelivered();
            deliveredSequence = pending.sequence;
          }
          if (posted === pending) posted = null;
        },
        onLost() {
          // Retry on the next sample, without erasing a newer pending report.
          if (posted === pending) posted = null;
        },
      },
    );
  }
  publish();
  const timer = setInterval(publish, intervalMs);

  /** Everything again: a new baseline, and the signs in view. */
  function sendFull() {
    changes = createSectionDiff();
    posted = null; // The full report replaces the pending one (same key).
    publish();
    const signs = core.currentSigns();
    if (signs?.signs?.length) signsSlot.put("in view", { ...signs, inView: true });
  }
  async function listenForSignals() {
    if (typeof inbox.signals !== "function") return;
    let after;
    while (!closed) {
      try {
        // Signals sent before this observer started are not for it.
        if (after === undefined) ({ last: after } = await inbox.signals(0));
        const { signals, last } = await inbox.signals(after, { waitMs: 4000 });
        after = last;
        if (!closed && signals.some((signal) => signal.type === "full")) sendFull();
      } catch (error) {
        report(error);
        await new Promise((done) => setTimeout(done, 1000));
      }
    }
  }
  void listenForSignals();
  return {
    publish,
    /** One full sample, including accumulated interval blocks and signs. */
    sample: () => core.sample(connection()),
    close() {
      closed = true;
      eventsSlot.close();
      signsSlot.close();
      clearInterval(timer);
      for (const [name, fn] of listeners) bot.off(name, fn);
      core.close();
    },
  };
}

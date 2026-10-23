/**
 * One inbox position kept by one producer: everything it has to say goes
 * into a single state report that replaces the unread copy, and the slot
 * starts empty again once the model has read it.
 *
 *   const slot = inboxSlot(inbox, "game.chat", {
 *     render: (lines) => ({ type: "game.chat", lines }),
 *   });
 *   slot.put(id, line, { urgent, onDelivered });   // add or replace an entry
 *   slot.delete(id);                  // take one back; the last one retracts
 *
 * Entries added after the version the model read stay for the next one.
 * Works with InboxClient or localInboxClient.
 */
export function inboxSlot(
  inbox,
  key,
  {
    render = (values) => values,
    // Entries kept at most; the oldest go first and are counted.
    maxEntries = 64,
    onError = (error) => console.error(`inbox slot ${key}: ${error.message}`),
  } = {},
) {
  const entries = new Map(); // id -> { value, urgent, version }
  let version = 0;
  let omitted = 0;
  let pending = null; // { id, version } of the report in the queue
  let closed = false;
  let sending = Promise.resolve();

  function publish() {
    if (closed) return;
    const at = ++version;
    const values = [...entries.values()];
    // Queue order: a newer publish waits for the older send to settle, so
    // the newest version is what stays queued.
    sending = sending.then(async () => {
      if (closed || at !== version) return;
      try {
        if (!values.length) {
          const old = pending;
          pending = null;
          if (old?.id) await inbox.retract(old.id);
          return;
        }
        const urgent = values.some((entry) => entry.urgent);
        const data = render(
          values.map((entry) => entry.value),
          { omitted },
        );
        const result = await inbox.upsert(key, data, {
          priority: urgent ? "urgent" : "normal",
        });
        if (!result?.accepted) throw new Error(result?.reason ?? "not accepted");
        const sent = { id: result.id, version: at };
        pending = sent;
        void watch(sent);
      } catch (error) {
        onError(error);
      }
    });
  }

  async function watch(sent) {
    let outcome;
    try {
      ({ outcome } = await inbox.delivery(sent.id, { timeoutMs: Infinity }));
    } catch (error) {
      if (!closed) onError(error);
      return;
    }
    if (closed || pending !== sent) return;
    pending = null;
    if (outcome === "delivered") {
      for (const [id, entry] of entries)
        if (entry.version <= sent.version) {
          entries.delete(id);
          try {
            entry.onDelivered?.();
          } catch (error) {
            onError(error);
          }
        }
      omitted = 0;
      if (entries.size) publish();
    } else if (outcome !== "replaced" && outcome !== "retracted" && entries.size)
      publish(); // Lost (dropped, expired): say it again.
  }

  return {
    put(id, value, { urgent = false, onDelivered } = {}) {
      entries.delete(id);
      entries.set(id, { value, urgent, onDelivered, version: version + 1 });
      while (entries.size > maxEntries) {
        entries.delete(entries.keys().next().value);
        omitted++;
      }
      publish();
    },
    delete(id) {
      if (entries.delete(id)) publish();
    },
    has: (id) => entries.has(id),
    get size() {
      return entries.size;
    },
    /** Wait until the latest change has been sent. */
    flush: () => sending,
    close() {
      closed = true;
    },
  };
}

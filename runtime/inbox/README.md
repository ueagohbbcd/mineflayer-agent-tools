# Inbox: reporting from your programs

Programs report to you through `InboxClient`. The default observer, chat and watchdog use the same client. Reports wait in the supervisor's queue until you read them with `mf inbox`; nothing reaches you on its own.

## InboxClient

```js
const { InboxClient } = await import(
  `${process.env.MF_TOOLKIT_ROOT}/runtime/inbox/index.mjs`
);
const inbox = new InboxClient();

await inbox.post({ type: "ore.found", block: "iron_ore", position: [12, 64, -8] });
await inbox.upsert("route", { waypoint: 2, of: 5, status: "continuing" });
await inbox.setStatus("build", { step: 3, activity: "placing blocks" });
const { id } = await inbox.requestJudgment({ question: "Food is gone. Retreat?", health: 8 });
const { outcome } = await inbox.delivery(id, { timeoutMs: 60000 });
```

| Call | What it sends | Use it for |
| --- | --- | --- |
| `post(data, options?)` | An event (`kind: "event"`) | Something that happened and should be seen once, such as a step finished |
| `upsert(key, data, options?)` | A replaceable report (`kind: "state"`) | Progress: a newer report with the same key replaces the older one if it has not been read yet |
| `setStatus(key, data, options?)` | Program status (`kind: "current"`) | The program's current value, shown by `mf status` until replaced, cleared with `null`, or expired |
| `requestJudgment(data, options?)` | An urgent message (`kind: "judgment"`) | Something you should look at first. It is listed first in `mf inbox`, and an `mf run` that is waiting returns early (the program keeps running) |
| `retract(id)` | Nothing; takes an unread message back | A report that no longer holds; resolves `{id, retracted}` (`false` once read or gone) |
| `delivery(id, { timeoutMs })` | Nothing; waits for a receipt | Finding out whether the report was read |
| `signals(after, { waitMs })` | Nothing; waits for a request from the reader | `mf inbox --full` sends `{type: "full"}`: send your whole state again, not a difference |

Any report with `stop: "reason"` in its data is a stop: it ends the character's controlling program, and no new one starts until `mf inbox` has shown it (see [../README.md](../README.md)). Use it only when the plan the model made no longer holds.

A program that reports often should keep one place in the inbox rather than many messages: put everything unread into one `upsert` and start again once it was read. `inboxSlot` does that:

```js
const { InboxClient, inboxSlot } = await import(`${process.env.MF_TOOLKIT_ROOT}/runtime/inbox/index.mjs`);
const slot = inboxSlot(new InboxClient(), "ore", { render: (finds) => ({ type: "ore", finds }) });
slot.put("12,64,-8", { block: "iron_ore", position: [12, 64, -8] });         // add or replace an entry
slot.put("3,60,1", { block: "diamond_ore", position: [3, 60, 1] }, { urgent: true });
slot.delete("12,64,-8");                                                    // take one back
```

The report is urgent while it holds an urgent entry; entries added after the version that was read stay for the next one; taking back the last entry takes the report back.

Send the complete current state with `upsert`, not a difference. Say what happened and whether the program goes on or has stopped; that a program ended is already in its own result.

| Option | Meaning |
| --- | --- |
| `ttlMs` | Drop the message if it is still unread after this long. Under `mf` messages do not expire unless you set this |
| `taskId` | Correlation id; set from `MC_INBOX_TASK_ID`, which every program gets |
| `minDeliveryDelayMs` | `upsert` only: hold the report at least this long after its first unread version, so frequent updates come as one. An update with a shorter delay (0) makes it readable sooner, never later |

A send resolves to `{accepted: true, id}` once queued, which is not delivery, and rejects on failure. `data` is any JSON value; it is copied when accepted. The constructor reads `MC_INBOX_SOCKET` and `MC_INBOX_SESSION` (set for every program `mf` runs); each report also names its character and that character's process.

## Reading them: `mf inbox`

`mf inbox` prints the queued reports, urgent ones first, as many whole reports as fit in `MF_REPORT_BYTES` (16000); the rest wait for the next read. Stops such as a death come first, as `! stop:` lines, all of them whatever the budget. Delayed reports not readable yet are named in a `(still accumulating, shown later: …)` line. A report counts as read once `mf` has printed it; `mf inbox --again` shows the last batch again.

Replaceable reports with the same key replace each other only while unread, and only within one program on one character's process (two programs, two characters, or a character before and after a restart, keep their own).

## Delivery receipts

`await inbox.delivery(id, { timeoutMs })` resolves `{id, outcome}` once the message leaves the queue (`timeoutMs` default 30000; `Infinity` waits indefinitely):

| `outcome` | Meaning |
| --- | --- |
| `delivered` | Printed by `mf inbox` |
| `replaced` | A newer `upsert` with the same key took its place |
| `retracted` | Its sender took it back |
| `expired` | Its `ttlMs` ran out first |
| `overflow` | Evicted because the queue was full |
| `removed` | Removed for another reason |
| `pending` | Still queued when `timeoutMs` passed |
| `unknown` | Never queued or forgotten; program status always returns `unknown` |

A program that accumulates data until it has been read keeps it until `delivered` and carries it into the next report otherwise; the default observer does this for recent blocks.

## Command line and raw HTTP

```sh
inbox="$MF_TOOLKIT_ROOT/runtime/inbox/cli.mjs"
node "$inbox" post '{"type":"path.clear"}'
node "$inbox" upsert health '{"value":8}'
node "$inbox" status build '{"step":3}'
node "$inbox" urgent '{"question":"Retreat?"}'
node "$inbox" retract MESSAGE_ID
```

Any language can post over the Unix socket in `MC_INBOX_SOCKET`:

```sh
curl --unix-socket "$MC_INBOX_SOCKET" -H 'Content-Type: application/json' \
  --data "{\"sessionId\":\"$MC_INBOX_SESSION\",\"kind\":\"event\",\"data\":{\"type\":\"ready\"}}" \
  http://localhost/messages
```

`POST /messages` takes `{sessionId, kind, key?, data, priority?, ttlMs?, taskId?, minDeliveryDelayMs?}` and answers `202 {accepted: true, id}` (`413` too large, `400` invalid). `kind` is `event`, `state`, `judgment` or `current`; `state` and `current` need a `key`; `priority` is `normal` or `urgent`. `GET /messages/{id}/delivery?waitMs=N` answers the receipt, `DELETE /messages/{id}` retracts, and `GET /signals?after=N&waitMs=M` answers `{signals: [{seq, type, at}], last}`.

## Limits

| Limit | Value |
| --- | --- |
| Queue | 256 messages and 256 KiB; when full, the oldest that is not a stop is evicted (`overflow`) |
| One request | 64 KiB body, 5 s |
| Program status | 256 values and 256 KiB |

The queue lives in the supervisor's memory: unread reports are lost when it stops.

## Internals

`queue.mjs` is the queue (`Inbox`: `post`, `select`/`commit` for budgeted reads, receipts, program status); `ipc.mjs` is the socket server and `InboxClient`; `cli.mjs` the command line. `Inbox` emits `message` for every queued message. Tests: `test/runtime/inbox*.test.mjs`.

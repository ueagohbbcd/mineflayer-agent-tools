import test from "node:test";
import assert from "node:assert/strict";
import { createPendingWrites } from "../../runtime/log/pending-writes.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((yes) => (resolve = yes));
  return { promise, resolve };
}

test("flush waits for writes that were already pending", async () => {
  const writes = createPendingWrites();
  const pending = deferred();
  let flushed = false;

  writes.track(() => pending.promise.then(() => "saved"));
  const flushing = writes.flush().then((results) => {
    flushed = true;
    return results;
  });
  await Promise.resolve();
  assert.equal(flushed, false);

  pending.resolve();
  assert.deepEqual(await flushing, ["saved"]);
  assert.equal(flushed, true);
  await writes.flush();
});

test("sync and async failures are reported, flush settles, and later writes still track", async () => {
  const failures = [];
  const writes = createPendingWrites((error) => failures.push(error.message));
  const asyncFailure = deferred();
  const laterWrite = deferred();
  const seen = [];

  writes.track(() => {
    seen.push("sync call");
    throw new Error("sync failure");
  });
  assert.deepEqual(seen, ["sync call"]);
  writes.track(() => asyncFailure.promise);
  asyncFailure.resolve(Promise.reject(new Error("async failure")));
  await writes.flush();

  assert.deepEqual(failures, ["sync failure", "async failure"]);

  writes.track(() => laterWrite.promise);
  let flushed = false;
  const flushing = writes.flush().then(() => (flushed = true));
  await Promise.resolve();
  assert.equal(flushed, false);
  laterWrite.resolve();
  await flushing;
  assert.equal(flushed, true);
  await writes.flush();
});

test("a throwing failure callback does not reject flush", async () => {
  const writes = createPendingWrites(() => {
    throw new Error("diagnostic failed");
  });

  writes.track(() => Promise.reject(new Error("write failed")));
  await assert.doesNotReject(writes.flush());
});

/** Track log writes and report failures without letting one reject a flush. */
export function createPendingWrites(onFailure = () => {}) {
  const pending = new Set();

  function report(error) {
    try {
      onFailure(error);
    } catch {
      // A diagnostic callback must not turn a handled write failure into one.
    }
  }

  function track(start) {
    let result;
    try {
      // Invoke synchronously so log.post keeps the caller's existing timing.
      result = start();
    } catch (error) {
      report(error);
      return Promise.resolve();
    }

    let done;
    done = Promise.resolve(result).then(
      (value) => {
        pending.delete(done);
        return value;
      },
      (error) => {
        report(error);
        pending.delete(done);
      },
    );
    pending.add(done);
    return done;
  }

  function flush() {
    return Promise.all([...pending]);
  }

  return { track, flush };
}

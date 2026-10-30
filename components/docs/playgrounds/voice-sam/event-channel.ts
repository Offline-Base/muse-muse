/**
 * An async iterable fed by pushes: the docs proxy's server-sent events arrive through a callback, and Meta's
 * @meta-sam/parser reads an AsyncIterable of Responses events (sam/client-libraries, "Parse a segmentation stream").
 * This bridges the two without buffering the whole stream first, so snapshots appear while SAM is still segmenting.
 * One consumer, like the parser it feeds.
 */
export interface EventChannel<T> {
  push(value: T): void;
  /** No more values: the consumer's loop ends after what's queued. */
  end(): void;
  /** The source failed: the consumer's next read throws `error`. */
  fail(error: unknown): void;
  readonly iterable: AsyncIterable<T>;
}

export function createEventChannel<T>(): EventChannel<T> {
  const queue: T[] = [];
  let ended = false;
  let failure: { error: unknown } | null = null;
  let wake: (() => void) | null = null;
  const notify = () => {
    const w = wake;
    wake = null;
    w?.();
  };
  let taken = false;

  async function* read(): AsyncGenerator<T> {
    for (;;) {
      if (queue.length) {
        yield queue.shift() as T;
        continue;
      }
      if (failure) throw failure.error;
      if (ended) return;
      await new Promise<void>((resolve) => (wake = resolve));
    }
  }

  return {
    push(value) {
      if (ended || failure) return;
      queue.push(value);
      notify();
    },
    end() {
      ended = true;
      notify();
    },
    fail(error) {
      failure = { error };
      notify();
    },
    iterable: {
      [Symbol.asyncIterator]() {
        if (taken) throw new Error("This event channel has one reader.");
        taken = true;
        return read();
      },
    },
  };
}

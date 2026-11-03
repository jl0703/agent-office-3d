/** A small queue that can be read as an async iterable. Used for the messages sent to a session. */
export function createChannel<T>() {
  const queue: T[] = [];
  let wake: (() => void) | null = null;
  let closed = false;

  const iterable: AsyncIterable<T> = {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<T>> {
          for (;;) {
            if (queue.length > 0) return { value: queue.shift() as T, done: false };
            if (closed) return { value: undefined, done: true };
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
          }
        },
        async return(): Promise<IteratorResult<T>> {
          closed = true;
          return { value: undefined, done: true };
        },
      };
    },
  };

  const release = () => {
    const w = wake;
    wake = null;
    w?.();
  };

  return {
    iterable,
    push(item: T) {
      if (closed) return;
      queue.push(item);
      release();
    },
    close() {
      closed = true;
      release();
    },
  };
}

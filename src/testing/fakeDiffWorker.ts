import { vi } from 'vitest';

export interface FakeDiffWorkerRecord {
  url: string | URL;
  terminate: ReturnType<typeof vi.fn>;
  emitError(event?: unknown): void;
}

export function createFakeDiffWorkerClass(
  created: FakeDiffWorkerRecord[],
  options?: { failInitialize?: boolean }
) {
  return class FakeDiffWorker {
    listeners = new Map<string, Set<(event: unknown) => void>>();
    terminated = false;
    terminate = vi.fn(() => {
      this.terminated = true;
    });
    url: string | URL;
    constructor(url: string | URL) {
      this.url = url;
      created.push(this);
    }
    addEventListener(type: string, listener: (event: unknown) => void) {
      const set = this.listeners.get(type) ?? new Set();
      set.add(listener);
      this.listeners.set(type, set);
    }
    emitError(event: unknown = new Event('error')) {
      if (this.terminated) return;
      for (const listener of this.listeners.get('error') ?? []) {
        listener(event);
      }
    }
    postMessage(request: { id?: string; type?: string }) {
      if (this.terminated) return;
      if (request.type === 'initialize') {
        queueMicrotask(() => {
          if (this.terminated) return;
          if (options?.failInitialize) {
            this.emitError(new Event('error'));
            return;
          }
          for (const listener of this.listeners.get('message') ?? []) {
            listener({
              data: {
                type: 'success',
                requestType: 'initialize',
                id: request.id,
                sentAt: Date.now(),
              },
            });
          }
        });
      }
    }
  };
}

export async function withMockedCreateObjectURL(
  value: (blob: Blob) => string,
  run: () => Promise<void>
) {
  const original = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    writable: true,
    value,
  });
  try {
    await run();
  } finally {
    if (original) {
      Object.defineProperty(URL, 'createObjectURL', original);
    } else {
      delete (URL as Partial<typeof URL>).createObjectURL;
    }
  }
}

import os from "node:os";
import type { ClawdbotConfig } from "openclaw/plugin-sdk/feishu";

type DebounceParams<T> = {
  debounceMs: number;
  buildKey: (item: T) => string | null;
  shouldDebounce: (item: T) => boolean;
  onFlush: (items: T[]) => Promise<void>;
};

export function resolveTestTmpRoot(): string {
  return process.env.OPENCLAW_TMPDIR?.trim() || os.tmpdir();
}

export function hasControlCommand(_text: string, _cfg: ClawdbotConfig): boolean {
  return false;
}

export function resolveInboundDebounceMs(params: {
  cfg: ClawdbotConfig;
  channel: string;
}): number {
  const byChannel = params.cfg?.messages?.inbound?.byChannel as Record<string, number> | undefined;
  if (typeof byChannel?.[params.channel] === "number") {
    return byChannel[params.channel];
  }
  const globalValue = params.cfg?.messages?.inbound?.debounceMs;
  return typeof globalValue === "number" ? globalValue : 0;
}

export function createInboundDebouncer<T>(params: DebounceParams<T>): {
  enqueue: (item: T) => Promise<void>;
  flushKey: (key: string) => Promise<void>;
} {
  const batches = new Map<string, T[]>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  const flush = async (key: string): Promise<void> => {
    const timer = timers.get(key);
    if (timer) {
      clearTimeout(timer);
      timers.delete(key);
    }
    const items = batches.get(key) ?? [];
    batches.delete(key);
    if (items.length > 0) {
      await params.onFlush(items);
    }
  };

  return {
    enqueue: async (item: T) => {
      const key = params.buildKey(item);
      if (!key || !params.shouldDebounce(item) || params.debounceMs <= 0) {
        await params.onFlush([item]);
        return;
      }
      const nextBatch = batches.get(key) ?? [];
      nextBatch.push(item);
      batches.set(key, nextBatch);
      const prev = timers.get(key);
      if (prev) {
        clearTimeout(prev);
      }
      timers.set(
        key,
        setTimeout(() => {
          void flush(key);
        }, params.debounceMs),
      );
    },
    flushKey: async (key: string) => {
      await flush(key);
    },
  };
}

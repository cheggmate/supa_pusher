import PusherModule from "pusher-js";
import { z } from "zod";
import type { CallContext } from "./config.js";
import { recordTicks, type Tick } from "./tools.js";

const PricePayload = z.object({
  symbol: z.string().regex(/^[A-Za-z0-9.\-]{1,12}$/),
  price: z.number().positive(),
  volume: z.number().nonnegative().optional(),
  source: z.string().max(64).optional(),
  timestamp: z.union([z.string().datetime({ offset: true }), z.number()]).optional(),
});

/** The small slice of the pusher-js API used here. */
interface PusherLike {
  subscribe(channel: string): { bind(event: string, cb: (data: unknown) => void): void };
  connection: { bind(event: string, cb: (s: { current: string }) => void): void };
  disconnect(): void;
}

export interface IngestOptions {
  key: string;
  cluster: string;
  symbols: string[];
  /** Context carrying the ingest agent's profile (needs the market:write scope). */
  ctx: CallContext;
  /** Channel naming: `${channelPrefix}${SYMBOL}`. Default "market-". */
  channelPrefix?: string;
  /** Event name published when a price changes. Default "price-updated". */
  eventName?: string;
  flushMs?: number;
}

/**
 * Subscribes to one public Channels channel per symbol and writes price updates to
 * Supabase. Updates are coalesced (latest tick per symbol per flush window) so a
 * fast feed does not translate 1:1 into database writes.
 */
export function startTickerIngest(opts: IngestOptions) {
  const prefix = opts.channelPrefix ?? "market-";
  const eventName = opts.eventName ?? "price-updated";
  const flushMs = opts.flushMs ?? 500;

  // pusher-js ships CJS; under NodeNext the constructor may sit on `.default`.
  const Pusher = ((PusherModule as any).default ?? PusherModule) as new (
    key: string,
    o: { cluster: string },
  ) => PusherLike;
  const pusher = new Pusher(opts.key, { cluster: opts.cluster });
  const buffer = new Map<string, Tick>();

  for (const sym of opts.symbols) {
    const symbol = sym.trim().toUpperCase();
    pusher.subscribe(`${prefix}${symbol}`).bind(eventName, (data: unknown) => {
      const parsed = PricePayload.safeParse(typeof data === "string" ? safeJson(data) : data);
      if (!parsed.success) {
        console.warn(`[ingest] dropped malformed payload on ${symbol}:`, parsed.error.issues[0]?.message);
        return;
      }
      // The channel decides the symbol, so a payload can't write to another ticker.
      const tick: Tick = { ...parsed.data, symbol, timestamp: parsed.data.timestamp ?? Date.now() };
      const prev = buffer.get(symbol);
      if (!prev || ts(tick) >= ts(prev)) buffer.set(symbol, tick);
    });
  }

  let flushing = false;
  const timer = setInterval(async () => {
    if (flushing || buffer.size === 0) return;
    flushing = true;
    const batch = [...buffer.values()];
    buffer.clear();
    try {
      await recordTicks(opts.ctx, batch);
    } catch (err) {
      console.error("[ingest] flush failed, re-queuing:", (err as Error).message);
      for (const t of batch) if (!buffer.has(t.symbol)) buffer.set(t.symbol, t);
    } finally {
      flushing = false;
    }
  }, flushMs);

  pusher.connection.bind("state_change", (s) => console.log(`[ingest] pusher ${s.current}`));

  return () => {
    clearInterval(timer);
    pusher.disconnect();
  };
}

const ts = (t: Tick) => new Date(t.timestamp ?? 0).getTime();
const safeJson = (s: string) => {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};

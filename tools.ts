import { z } from "zod";
import type { PostgrestError } from "@supabase/supabase-js";
import { IntegrationError, type CallContext } from "./config.js";
import { assertTableAllowed, clientFor } from "./supabase.js";

export interface Tool<S extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  input: S;
  run(ctx: CallContext, input: z.infer<S>): Promise<unknown>;
}

const ident = z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, "invalid identifier");
const columnList = z
  .string()
  .regex(/^[a-zA-Z_][a-zA-Z0-9_]*(\s*,\s*[a-zA-Z_][a-zA-Z0-9_]*)*$|^\*$/, "comma-separated column names or *");

const Filter = z.object({
  column: ident,
  op: z.enum(["eq", "neq", "gt", "gte", "lt", "lte", "like", "ilike", "is", "in"]),
  value: z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.union([z.string(), z.number()]))]),
});
type Filter = z.infer<typeof Filter>;

const MAX_ROWS = 500;

function applyFilter(q: any, f: Filter) {
  switch (f.op) {
    case "in":
      if (!Array.isArray(f.value)) throw new IntegrationError("bad_filter", `"in" needs an array value`);
      return q.in(f.column, f.value);
    case "is":
      return q.is(f.column, f.value as null | boolean);
    default:
      return q[f.op](f.column, f.value);
  }
}

/** Turns a PostgREST error into a stable, agent-readable error. */
function unwrap<T>(res: { data: T; error: PostgrestError | null }): T {
  if (!res.error) return res.data;
  const { code, message } = res.error;
  if (code === "42501") {
    throw new IntegrationError("rls_denied", "Row-level security denied this operation", 403);
  }
  throw new IntegrationError(code || "db_error", message, 400);
}

// ---------------------------------------------------------------------------
// Generic table tools (restricted by the per-project table allowlist, then RLS)
// ---------------------------------------------------------------------------

const dbSelect: Tool = {
  name: "db_select",
  description:
    "Read rows from a table. Results are limited by row-level security: rows you cannot access are simply not returned.",
  input: z.object({
    table: ident,
    columns: columnList.default("*"),
    filters: z.array(Filter).max(10).default([]),
    order: z.object({ column: ident, ascending: z.boolean().default(true) }).optional(),
    limit: z.number().int().min(1).max(MAX_ROWS).default(50),
  }),
  async run(ctx, i) {
    assertTableAllowed(ctx, i.table, "select");
    const sb = await clientFor(ctx);
    let q: any = sb.from(i.table).select(i.columns, { count: "exact" });
    for (const f of i.filters) q = applyFilter(q, f);
    if (i.order) q = q.order(i.order.column, { ascending: i.order.ascending });
    const res = await q.limit(i.limit);
    const rows = unwrap(res) as unknown[];
    return { rows, count: res.count ?? rows.length };
  },
};

const dbInsert: Tool = {
  name: "db_insert",
  description: "Insert one or more rows. Fails with rls_denied if the table's RLS policy does not allow it.",
  input: z.object({
    table: ident,
    rows: z.array(z.record(z.unknown())).min(1).max(MAX_ROWS),
    returning: z.boolean().default(false).describe("Return inserted rows (needs a SELECT policy)"),
  }),
  async run(ctx, i) {
    assertTableAllowed(ctx, i.table, "insert");
    const sb = await clientFor(ctx);
    const q = sb.from(i.table).insert(i.rows);
    const data = unwrap(i.returning ? await q.select() : await q);
    return { inserted: i.rows.length, rows: data ?? undefined };
  },
};

const dbUpsert: Tool = {
  name: "db_upsert",
  description: "Insert rows, or update them when they conflict on the given unique column(s).",
  input: z.object({
    table: ident,
    rows: z.array(z.record(z.unknown())).min(1).max(MAX_ROWS),
    on_conflict: columnList,
  }),
  async run(ctx, i) {
    assertTableAllowed(ctx, i.table, "upsert");
    assertTableAllowed(ctx, i.table, "insert");
    assertTableAllowed(ctx, i.table, "update");
    const sb = await clientFor(ctx);
    unwrap(await sb.from(i.table).upsert(i.rows, { onConflict: i.on_conflict }));
    return { upserted: i.rows.length };
  },
};

const dbUpdate: Tool = {
  name: "db_update",
  description:
    "Update rows matching the filters (at least one required). Returns how many rows changed; 0 can mean no match OR that RLS hid the rows.",
  input: z.object({
    table: ident,
    values: z.record(z.unknown()),
    filters: z.array(Filter).min(1).max(10),
  }),
  async run(ctx, i) {
    assertTableAllowed(ctx, i.table, "update");
    const sb = await clientFor(ctx);
    let q: any = sb.from(i.table).update(i.values);
    for (const f of i.filters) q = applyFilter(q, f);
    const rows = unwrap(await q.select()) as unknown[];
    return { updated: rows.length };
  },
};

// ---------------------------------------------------------------------------
// Domain tools
// ---------------------------------------------------------------------------

const Tick = z.object({
  symbol: z.string().regex(/^[A-Za-z0-9.\-]{1,12}$/),
  price: z.number().positive(),
  volume: z.number().nonnegative().optional(),
  source: z.string().max(64).optional(),
  /** ISO string or epoch ms. Defaults to now. */
  timestamp: z.union([z.string().datetime({ offset: true }), z.number()]).optional(),
});
export type Tick = z.infer<typeof Tick>;

export function toUpdateRow(t: Tick) {
  return {
    symbol: t.symbol.toUpperCase(),
    price: t.price,
    volume: t.volume ?? null,
    source: t.source ?? "unknown",
    price_ts: new Date(t.timestamp ?? Date.now()).toISOString(),
  };
}

/** Shared by the tool and by the Pusher ingest. Runs under the caller's RLS. */
export async function recordTicks(ctx: CallContext, ticks: Tick[]): Promise<number> {
  const sb = await clientFor(ctx);
  const res = await sb.rpc("record_ticker_prices", { p_updates: ticks.map(toUpdateRow) });
  return unwrap(res) as number;
}

const recordTickerPrice: Tool = {
  name: "record_ticker_price",
  description:
    "Store a price update for a stock ticker: appends to history and updates the latest price. Requires the market:write scope. Stale (older) timestamps never overwrite a newer latest price.",
  input: Tick,
  async run(ctx, i) {
    const latestUpdated = await recordTicks(ctx, [i]);
    return { symbol: i.symbol.toUpperCase(), latest_updated: latestUpdated > 0 };
  },
};

const getTicker: Tool = {
  name: "get_ticker",
  description: "Get the latest stored price for a ticker symbol, optionally with recent history.",
  input: z.object({
    symbol: Tick.shape.symbol,
    history_limit: z.number().int().min(0).max(200).default(0),
  }),
  async run(ctx, i) {
    const sb = await clientFor(ctx);
    const symbol = i.symbol.toUpperCase();
    const latest = unwrap(await sb.from("ticker_prices").select("*").eq("symbol", symbol).maybeSingle());
    let history: unknown[] | undefined;
    if (i.history_limit > 0) {
      history = unwrap(
        await sb
          .from("ticker_price_history")
          .select("price, volume, source, price_ts")
          .eq("symbol", symbol)
          .order("price_ts", { ascending: false })
          .limit(i.history_limit),
      ) as unknown[];
    }
    return { latest, history };
  },
};

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

const getContact: Tool = {
  name: "get_contact",
  description:
    "Find a contact by id, exact email, or name search. Only contacts visible to the acting user (RLS) are returned.",
  input: z
    .object({
      id: z.string().uuid().optional(),
      email: z.string().email().optional(),
      name: z.string().min(2).max(100).optional(),
      limit: z.number().int().min(1).max(25).default(5),
    })
    .refine((v) => v.id || v.email || v.name, "Provide id, email, or name"),
  async run(ctx, i) {
    const sb = await clientFor(ctx);
    let q = sb.from("contacts").select("id, full_name, email, phone, company, notes");
    if (i.id) q = q.eq("id", i.id);
    else if (i.email) q = q.ilike("email", escapeLike(i.email));
    else q = q.ilike("full_name", `%${escapeLike(i.name!)}%`);
    const rows = unwrap(await q.limit(i.limit)) as unknown[];
    return { contacts: rows, found: rows.length };
  },
};

export const tools: Tool[] = [dbSelect, dbInsert, dbUpsert, dbUpdate, recordTickerPrice, getTicker, getContact];
export const toolsByName = new Map(tools.map((t) => [t.name, t]));

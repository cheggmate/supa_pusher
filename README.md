# Pusher ↔ Supabase integration

A small service that lets agents read and write Supabase data as tools, and stores market ticks arriving over Pusher Channels. **RLS is the access control**: every query runs as the `authenticated` role under a JWT. The service-role key is never used.

```
Pusher Channels ──price-updated──▶ ingest ─┐
                                           ├─▶ Supabase (RLS enforced)
Agent ── POST /v1/tools/:name ─────────────┘
```

## Setup

1. Run `supabase/migrations/001_schema.sql` in each project (SQL editor or `supabase db push`).
2. `cp .env.example .env`, then fill in `SUPABASE_PROJECTS` and `INTEGRATION_AGENTS`.
3. `npm install && npm run dev`

## How access is decided

| Layer | Purpose |
|---|---|
| `INTEGRATION_AGENTS` | API key → agent id, **scopes**, allowed projects. Scopes are set server-side only. |
| Minted JWT | `sub` = `user_id` (or the agent id), `app_metadata.scopes` = agent scopes, 5-minute expiry. |
| RLS policies | The real gate. Example: `contacts` is owner-only; `ticker_*` writes need `market:write`. |
| `tables` allowlist | Defense in depth for the generic `db_*` tools. Domain tools bypass it but not RLS. |

Two ways to supply identity per call:
- **Mint** (default): requires `jwtSecret` for the project. Pass `user_id` to act as that user, so `auth.uid()` in your policies resolves to them.
- **Pass-through**: send `access_token` (a real Supabase user JWT) and nothing is minted.

> If your project uses asymmetric JWT signing keys instead of the legacy shared secret, minting with `jwtSecret` won't work. Use pass-through tokens, or adapt `mintToken` to your signing setup.

Per project, add your own policies using `auth.uid()` and `public.has_scope('your:scope')`.

## Tools

`GET /v1/tools` returns JSON schemas for all of them.

| Tool | Use |
|---|---|
| `record_ticker_price` | Store a tick (history + latest, out-of-order safe). Needs `market:write`. |
| `get_ticker` | Latest price, optional recent history. |
| `get_contact` | Look up a contact by `id`, `email` or `name`. |
| `db_select` / `db_insert` / `db_upsert` / `db_update` | Generic table access, allowlisted per project. No delete by design. |

```bash
# Agent retrieves a contact on behalf of a user
curl -X POST localhost:8787/v1/tools/get_contact \
  -H "Authorization: Bearer pk_agent_research_123" -H "Content-Type: application/json" \
  -d '{"user_id":"<user uuid>","input":{"name":"Ada Lovelace"}}'

# Agent stores a price
curl -X POST localhost:8787/v1/tools/record_ticker_price \
  -H "Authorization: Bearer pk_ingest_456" -H "Content-Type: application/json" \
  -d '{"input":{"symbol":"AAPL","price":231.42,"volume":1200}}'
```

Responses are `{ok:true,result}` or `{ok:false,error:{code,message}}`. `rls_denied` means a write was blocked by policy. A read blocked by RLS returns **no rows**, not an error, so agents should treat an empty result as "not found or not allowed".

## Pusher market feed

With `PUSHER_KEY` set, the service subscribes to `market-<SYMBOL>` for each entry in `TICKER_SYMBOLS` and listens for `price-updated`:

```json
{ "price": 231.42, "volume": 1200, "timestamp": "2026-11-06T09:30:01Z" }
```

The channel name fixes the symbol, so a payload can't write to another ticker. Ticks are coalesced to the latest per symbol every 500 ms and written in one RPC call. Channel prefix, event name and flush interval are options on `startTickerIngest`.

## Assumptions to check

- Market updates are published to **public** Channels channels. For private channels, add an auth endpoint and pass `channelAuthorization` to the `Pusher` constructor.
- The ingest agent's `agentId` isn't a real `auth.users` row. That's fine for the ticker tables, but any table with an FK to `auth.users` needs a real user id.
- Agent API keys are looked up from env; swap for a secrets store or hashed keys in production.

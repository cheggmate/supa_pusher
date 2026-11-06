-- ============================================================
-- Helpers
-- ============================================================
-- Scopes are minted into the JWT by the integration (app_metadata.scopes).
create or replace function public.has_scope(s text)
returns boolean language sql stable as $$
  select coalesce((auth.jwt() -> 'app_metadata' -> 'scopes') ? s, false)
$$;

-- ============================================================
-- Contacts: owner-only access (the agent acts with the user's identity)
-- ============================================================
create table public.contacts (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  full_name   text not null,
  email       text,
  phone       text,
  company     text,
  notes       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index on public.contacts (owner_id, lower(email));
create index on public.contacts (owner_id, lower(full_name));

alter table public.contacts enable row level security;

create policy contacts_select on public.contacts for select to authenticated
  using (owner_id = auth.uid());
create policy contacts_insert on public.contacts for insert to authenticated
  with check (owner_id = auth.uid());
create policy contacts_update on public.contacts for update to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy contacts_delete on public.contacts for delete to authenticated
  using (owner_id = auth.uid());

-- ============================================================
-- Market data: readable by any signed-in caller, writable only
-- by callers holding the market:write scope
-- ============================================================
create table public.ticker_prices (            -- latest price per symbol
  symbol      text primary key check (symbol = upper(symbol)),
  price       numeric(18,6) not null,
  volume      numeric,
  source      text not null default 'unknown',
  price_ts    timestamptz not null,
  updated_at  timestamptz not null default now()
);

create table public.ticker_price_history (     -- append-only tick log
  id          bigint generated always as identity primary key,
  symbol      text not null check (symbol = upper(symbol)),
  price       numeric(18,6) not null,
  volume      numeric,
  source      text not null default 'unknown',
  price_ts    timestamptz not null,
  unique (symbol, price_ts, source)
);
create index on public.ticker_price_history (symbol, price_ts desc);

alter table public.ticker_prices        enable row level security;
alter table public.ticker_price_history enable row level security;

create policy tp_select on public.ticker_prices for select to authenticated using (true);
create policy tp_insert on public.ticker_prices for insert to authenticated
  with check (public.has_scope('market:write'));
create policy tp_update on public.ticker_prices for update to authenticated
  using (public.has_scope('market:write')) with check (public.has_scope('market:write'));

create policy tph_select on public.ticker_price_history for select to authenticated using (true);
create policy tph_insert on public.ticker_price_history for insert to authenticated
  with check (public.has_scope('market:write'));

-- Batch upsert. SECURITY INVOKER so the policies above still apply.
-- Out-of-order ticks are logged to history but never overwrite a newer "latest".
create or replace function public.record_ticker_prices(p_updates jsonb)
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare n integer;
begin
  insert into ticker_price_history (symbol, price, volume, source, price_ts)
  select upper(u.symbol), u.price, u.volume, coalesce(u.source, 'unknown'), u.price_ts
  from jsonb_to_recordset(p_updates)
       as u(symbol text, price numeric, volume numeric, source text, price_ts timestamptz)
  on conflict (symbol, price_ts, source) do nothing;

  insert into ticker_prices (symbol, price, volume, source, price_ts)
  select distinct on (upper(u.symbol))
         upper(u.symbol), u.price, u.volume, coalesce(u.source, 'unknown'), u.price_ts
  from jsonb_to_recordset(p_updates)
       as u(symbol text, price numeric, volume numeric, source text, price_ts timestamptz)
  order by upper(u.symbol), u.price_ts desc
  on conflict (symbol) do update
    set price = excluded.price, volume = excluded.volume, source = excluded.source,
        price_ts = excluded.price_ts, updated_at = now()
    where ticker_prices.price_ts < excluded.price_ts;

  get diagnostics n = row_count;
  return n;
end $$;

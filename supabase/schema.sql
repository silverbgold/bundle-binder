-- Bundle Binder (hosted) — database schema for Supabase
-- Run this whole file once in the Supabase SQL editor (Project → SQL → New query).
-- It is safe to run again: everything uses "if not exists" / "or replace".

-- ───────────────────────────── tables ─────────────────────────────

create table if not exists settings (
  id               int primary key default 1 check (id = 1),
  shop_name        text not null default 'My Card Shop',
  tagline          text not null default 'Choose a bundle, then fill it with any cards you like up to its card value.',
  contact          text not null default '',
  currency_symbol  text not null default '$',
  hold_minutes     int  not null default 15 check (hold_minutes between 1 and 240),   -- how long a cart holds its cards
  order_hold_hours int  not null default 24 check (order_hold_hours between 1 and 336), -- unpaid "pay later" orders keep cards this long
  card_hold_minutes int not null default 35 check (card_hold_minutes between 31 and 120), -- cards stay held while a buyer is on Stripe
  max_cart_cards   int  not null default 60 check (max_cart_cards between 1 and 500),
  pay              jsonb not null default '{}'::jsonb,  -- {cashapp, venmo, paypal, zelle, other}
  card_payments    boolean not null default false        -- true once Stripe is set up
);
insert into settings (id) values (1) on conflict (id) do nothing;

create table if not exists admins (
  user_id uuid primary key
);

create table if not exists cards (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  set_name    text not null default '',
  number      text not null default '',
  game        text not null default '',
  condition   text not null default 'NM' check (condition in ('M','NM','LP','MP','HP','DMG','GR')),
  price_cents int  not null default 100 check (price_cents >= 0),
  qty         int  not null default 1 check (qty >= 0),
  status      text not null default 'available' check (status in ('available','hidden','sold')),
  image_path  text not null default '',
  box         text not null default '',
  created_at  timestamptz not null default now()
);

create table if not exists bundles (
  id             text primary key,
  name           text not null,
  price_cents    int  not null check (price_cents >= 0),
  value_cents    int  not null check (value_cents >= 0),
  max_cards      int  not null default 0 check (max_cards >= 0),
  shipping_cents int  not null default 0 check (shipping_cents >= 0),
  note           text not null default '',
  sort           int  not null default 0,
  active         boolean not null default true
);

create table if not exists addons (
  id          text primary key,
  name        text not null,
  price_cents int  not null check (price_cents >= 0),
  description text not null default '',
  max_qty     int  not null default 10 check (max_qty between 1 and 99),
  sort        int  not null default 0,
  active      boolean not null default true
);

create table if not exists orders (
  id                 uuid primary key default gen_random_uuid(),
  code               text not null unique,
  holder             uuid not null,
  status             text not null default 'awaiting_payment' check (status in ('awaiting_payment','paid','shipped','cancelled','expired')),
  pay_method         text not null default '',
  bundle_id          text,
  bundle_name        text not null default '',
  bundle_price_cents int  not null default 0,
  shipping_cents     int  not null default 0,
  card_value_cents   int  not null default 0,
  addons             jsonb not null default '[]'::jsonb,
  addons_cents       int  not null default 0,
  total_cents        int  not null default 0,
  delivery           text not null default 'ship' check (delivery in ('ship','stack')),
  buyer_name         text not null default '',
  contact            text not null default '',
  address            text not null default '',
  note               text not null default '',
  stripe_session     text not null default '',
  created_at         timestamptz not null default now(),
  paid_at            timestamptz,
  shipped_at         timestamptz
);

create table if not exists order_items (
  order_id    uuid not null references orders(id) on delete cascade,
  card_id     uuid references cards(id) on delete set null,
  name        text not null,
  set_name    text not null default '',
  number      text not null default '',
  condition   text not null default '',
  box         text not null default '',
  price_cents int  not null,
  qty         int  not null check (qty > 0)
);

-- A hold reserves copies of a card for one buyer until expires_at.
-- order_id is null while the card sits in the buyer's cart; it is set once an order is placed.
create table if not exists holds (
  id         uuid primary key default gen_random_uuid(),
  card_id    uuid not null references cards(id) on delete cascade,
  holder     uuid not null,
  qty        int  not null check (qty > 0),
  expires_at timestamptz not null,
  order_id   uuid references orders(id) on delete cascade,
  created_at timestamptz not null default now()
);
create index if not exists holds_card_idx   on holds (card_id);
create index if not exists holds_holder_idx on holds (holder);
create index if not exists holds_order_idx  on holds (order_id);
create index if not exists orders_holder_idx on orders (holder);

-- ───────────────────────────── helpers ─────────────────────────────

create or replace function is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from admins where user_id = auth.uid());
$$;

create or replace function is_service() returns boolean
language sql stable as $$
  select coalesce(auth.role(), '') = 'service_role';
$$;

create or replace function new_order_code() returns text
language plpgsql volatile set search_path = public as $$
declare
  alphabet text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  c text;
begin
  loop
    c := 'BB-';
    for i in 1..5 loop
      c := c || substr(alphabet, 1 + floor(random() * 32)::int, 1);
    end loop;
    exit when not exists (select 1 from orders where code = c);
  end loop;
  return c;
end $$;

-- Unpaid orders whose holds have all run out become "expired" (their cards are already back in the shop).
create or replace function expire_orders() returns void
language sql volatile security definer set search_path = public as $$
  update orders o set status = 'expired'
   where o.status = 'awaiting_payment'
     and not exists (select 1 from holds h where h.order_id = o.id and h.expires_at > now());
$$;

-- ───────────────────────── buyer functions ─────────────────────────

-- Cards for the shop, with how many copies other buyers are holding right now.
create or replace function shop_cards()
returns table (id uuid, name text, set_name text, number text, game text, condition text,
               price_cents int, image_path text, qty int, held_by_others int, mine int, created_at timestamptz)
language sql stable security definer set search_path = public as $$
  select c.id, c.name, c.set_name, c.number, c.game, c.condition, c.price_cents, c.image_path, c.qty,
         coalesce(sum(h.qty) filter (where h.holder is distinct from auth.uid()), 0)::int as held_by_others,
         coalesce(sum(h.qty) filter (where h.holder = auth.uid() and h.order_id is null), 0)::int as mine,
         c.created_at
    from cards c
    left join holds h on h.card_id = c.id and h.expires_at > now()
   where c.status = 'available' and c.qty > 0
   group by c.id
   order by c.created_at desc;
$$;

-- The current buyer's cart (cards held but not ordered yet).
create or replace function my_cart()
returns table (card_id uuid, qty int, expires_at timestamptz)
language sql stable security definer set search_path = public as $$
  select h.card_id, h.qty, h.expires_at
    from holds h
   where h.holder = auth.uid() and h.order_id is null and h.expires_at > now()
   order by h.created_at;
$$;

-- Put one copy of a card in the buyer's cart. Fails with 'held' if every copy is in someone's cart.
-- The whole cart shares one timer: the first card starts it, later cards join it.
create or replace function hold_card(p_card uuid)
returns json
language plpgsql volatile security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  s settings;
  c cards;
  used int;
  cart_count int;
  exp timestamptz;
  mine holds;
begin
  if me is null then raise exception 'not_signed_in'; end if;
  select * into s from settings where id = 1;
  select * into c from cards where id = p_card for update;          -- one buyer at a time per card
  if not found or c.status <> 'available' or c.qty <= 0 then raise exception 'not_available'; end if;

  delete from holds where card_id = p_card and expires_at <= now();
  select coalesce(sum(qty), 0) into used from holds where card_id = p_card;
  if used >= c.qty then raise exception 'held'; end if;

  select coalesce(sum(qty), 0), min(expires_at) into cart_count, exp
    from holds where holder = me and order_id is null and expires_at > now();
  if cart_count >= s.max_cart_cards then raise exception 'cart_full'; end if;
  if exp is null then exp := now() + make_interval(mins => s.hold_minutes); end if;

  select * into mine from holds where holder = me and card_id = p_card and order_id is null and expires_at > now() limit 1;
  if found then
    update holds set qty = qty + 1, expires_at = exp where id = mine.id;
  else
    insert into holds (card_id, holder, qty, expires_at) values (p_card, me, 1, exp);
  end if;
  return json_build_object('expires_at', exp, 'server_now', now());
end $$;

-- Take one copy (or all, with p_all) of a card out of the buyer's cart.
create or replace function release_card(p_card uuid, p_all boolean default false)
returns void
language plpgsql volatile security definer set search_path = public as $$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'not_signed_in'; end if;
  if p_all then
    delete from holds where holder = me and card_id = p_card and order_id is null;
  else
    update holds set qty = qty - 1 where holder = me and card_id = p_card and order_id is null and qty > 1;
    if not found then
      delete from holds where holder = me and card_id = p_card and order_id is null;
    end if;
  end if;
end $$;

create or replace function release_cart()
returns void
language sql volatile security definer set search_path = public as $$
  delete from holds where holder = auth.uid() and order_id is null;
$$;

-- Turn the cart into an order. Totals are always worked out here, never trusted from the browser.
-- p_addons: [{"id":"mystery","qty":2}]   p_method: 'card' (Stripe) or a manual method name.
create or replace function place_order(p_bundle text, p_addons jsonb, p_delivery text,
                                       p_name text, p_contact text, p_address text, p_note text, p_method text)
returns json
language plpgsql volatile security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  s settings;
  b bundles;
  have_bundles boolean;
  n_cards int := 0;
  card_value int := 0;
  addons_total int := 0;
  addons_out jsonb := '[]'::jsonb;
  a record;
  ad addons;
  ship int := 0;
  total int := 0;
  o orders;
  stale int;
begin
  if me is null then raise exception 'not_signed_in'; end if;
  if p_delivery not in ('ship','stack') then raise exception 'bad_delivery'; end if;
  if coalesce(trim(p_name), '') = '' then raise exception 'name_required'; end if;
  select * into s from settings where id = 1;
  perform expire_orders();

  -- lock this buyer's cart holds and the cards behind them
  perform 1 from holds h join cards c on c.id = h.card_id
    where h.holder = me and h.order_id is null for update of h, c;
  select count(*) into stale from holds where holder = me and order_id is null and expires_at <= now();
  if stale > 0 then
    delete from holds where holder = me and order_id is null;
    raise exception 'cart_expired';
  end if;
  select coalesce(sum(h.qty), 0), coalesce(sum(h.qty * c.price_cents), 0) into n_cards, card_value
    from holds h join cards c on c.id = h.card_id
   where h.holder = me and h.order_id is null;

  -- add-ons
  for a in select (x->>'id') as id, greatest(0, coalesce((x->>'qty')::int, 0)) as qty
             from jsonb_array_elements(coalesce(p_addons, '[]'::jsonb)) x loop
    if a.qty = 0 then continue; end if;
    select * into ad from addons where id = a.id and active;
    if not found then raise exception 'bad_addon'; end if;
    if a.qty > ad.max_qty then raise exception 'addon_limit'; end if;
    addons_total := addons_total + a.qty * ad.price_cents;
    addons_out := addons_out || jsonb_build_object('id', ad.id, 'name', ad.name, 'qty', a.qty, 'price_cents', ad.price_cents);
  end loop;

  if n_cards = 0 and addons_total = 0 then raise exception 'empty'; end if;
  if n_cards > 0 and p_delivery = 'ship' and coalesce(trim(p_address), '') = '' then raise exception 'address_required'; end if;

  -- bundle rules
  select exists (select 1 from bundles where active) into have_bundles;
  if n_cards > 0 and have_bundles then
    select * into b from bundles where id = p_bundle and active;
    if not found then raise exception 'bundle_required'; end if;
    if card_value > b.value_cents then raise exception 'over_bundle_value'; end if;
    if b.max_cards > 0 and n_cards > b.max_cards then raise exception 'too_many_cards'; end if;
    ship := case when p_delivery = 'ship' then b.shipping_cents else 0 end;
    total := b.price_cents + ship + addons_total;
  else
    total := (case when have_bundles then 0 else card_value end) + addons_total;
  end if;

  insert into orders (code, holder, pay_method, bundle_id, bundle_name, bundle_price_cents, shipping_cents,
                      card_value_cents, addons, addons_cents, total_cents, delivery,
                      buyer_name, contact, address, note)
  values (new_order_code(), me, left(coalesce(p_method, ''), 30),
          case when b.id is not null then b.id end, coalesce(b.name, ''), coalesce(b.price_cents, 0), ship,
          card_value, addons_out, addons_total, total, p_delivery,
          left(trim(p_name), 80), left(coalesce(trim(p_contact), ''), 120), left(coalesce(trim(p_address), ''), 400), left(coalesce(trim(p_note), ''), 300))
  returning * into o;

  insert into order_items (order_id, card_id, name, set_name, number, condition, box, price_cents, qty)
  select o.id, c.id, c.name, c.set_name, c.number, c.condition, c.box, c.price_cents, h.qty
    from holds h join cards c on c.id = h.card_id
   where h.holder = me and h.order_id is null;

  update holds set order_id = o.id,
         expires_at = now() + case when p_method = 'card' then make_interval(mins => s.card_hold_minutes)
                                   else make_interval(hours => s.order_hold_hours) end
   where holder = me and order_id is null;

  return json_build_object('order_id', o.id, 'code', o.code, 'total_cents', o.total_cents);
end $$;

-- A buyer backs out of an unpaid order (e.g. closes Stripe): the cards go back into their cart.
create or replace function cancel_my_order(p_order uuid)
returns void
language plpgsql volatile security definer set search_path = public as $$
declare me uuid := auth.uid(); s settings; o orders;
begin
  select * into s from settings where id = 1;
  select * into o from orders where id = p_order and holder = me for update;
  if not found or o.status <> 'awaiting_payment' then return; end if;
  update orders set status = 'cancelled' where id = p_order;
  update holds set order_id = null, expires_at = now() + make_interval(mins => s.hold_minutes)
   where order_id = p_order and expires_at > now();
end $$;

-- ───────────────────── seller / payment functions ─────────────────────

-- Mark an order paid: copies come off the shelf and the holds are cleared.
-- Fails with 'no_longer_available:<card>' if a hold ran out and someone else bought the card,
-- unless p_force is true (then quantities just go down as far as they can).
create or replace function mark_order_paid(p_order uuid, p_method text default null, p_force boolean default false)
returns void
language plpgsql volatile security definer set search_path = public as $$
declare o orders; it record; c cards; others int;
begin
  if not (is_admin() or is_service()) then raise exception 'not_allowed'; end if;
  select * into o from orders where id = p_order for update;
  if not found then raise exception 'no_order'; end if;
  if o.status in ('paid','shipped') then return; end if;
  if o.status = 'cancelled' and not p_force then raise exception 'order_cancelled'; end if;
  for it in select * from order_items where order_id = p_order and card_id is not null loop
    select * into c from cards where id = it.card_id for update;
    select coalesce(sum(qty), 0) into others from holds
     where card_id = it.card_id and expires_at > now() and order_id is distinct from p_order;
    if c.qty - others < it.qty and not p_force then
      raise exception 'no_longer_available:%', it.name;
    end if;
    update cards set qty = greatest(0, qty - it.qty),
                     status = case when qty - it.qty <= 0 then 'sold' else status end
     where id = it.card_id;
  end loop;
  delete from holds where order_id = p_order;
  update orders set status = 'paid', paid_at = now(),
                    pay_method = coalesce(nullif(p_method, ''), pay_method)
   where id = p_order;
end $$;

create or replace function cancel_order(p_order uuid)
returns void
language plpgsql volatile security definer set search_path = public as $$
begin
  if not (is_admin() or is_service()) then raise exception 'not_allowed'; end if;
  update orders set status = 'cancelled' where id = p_order and status = 'awaiting_payment';
  delete from holds where order_id = p_order;
end $$;

create or replace function mark_order_shipped(p_order uuid)
returns void
language plpgsql volatile security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'not_allowed'; end if;
  update orders set status = 'shipped', shipped_at = now() where id = p_order and status = 'paid';
end $$;

-- ───────────────────────────── security ─────────────────────────────

alter table settings    enable row level security;
alter table admins      enable row level security;
alter table cards       enable row level security;
alter table bundles     enable row level security;
alter table addons      enable row level security;
alter table orders      enable row level security;
alter table order_items enable row level security;
alter table holds       enable row level security;

drop policy if exists settings_read  on settings;  create policy settings_read  on settings  for select using (true);
drop policy if exists settings_write on settings;  create policy settings_write on settings  for update using (is_admin()) with check (is_admin());
drop policy if exists admins_self    on admins;    create policy admins_self    on admins    for select using (user_id = auth.uid());
drop policy if exists cards_read     on cards;     create policy cards_read     on cards     for select using (status = 'available' or is_admin());
drop policy if exists cards_write    on cards;     create policy cards_write    on cards     for all using (is_admin()) with check (is_admin());
drop policy if exists bundles_read   on bundles;   create policy bundles_read   on bundles   for select using (active or is_admin());
drop policy if exists bundles_write  on bundles;   create policy bundles_write  on bundles   for all using (is_admin()) with check (is_admin());
drop policy if exists addons_read    on addons;    create policy addons_read    on addons    for select using (active or is_admin());
drop policy if exists addons_write   on addons;    create policy addons_write   on addons    for all using (is_admin()) with check (is_admin());
drop policy if exists orders_read    on orders;    create policy orders_read    on orders    for select using (holder = auth.uid() or is_admin());
drop policy if exists items_read     on order_items; create policy items_read   on order_items for select using (is_admin() or exists (select 1 from orders o where o.id = order_id and o.holder = auth.uid()));
drop policy if exists holds_admin    on holds;     create policy holds_admin    on holds     for select using (is_admin());
-- (no insert/update policies on orders, order_items or holds: they only change through the functions above)

revoke all on function mark_order_paid(uuid, text, boolean) from public;
revoke all on function cancel_order(uuid) from public;
revoke all on function mark_order_shipped(uuid) from public;
grant execute on function mark_order_paid(uuid, text, boolean) to authenticated, service_role;
grant execute on function cancel_order(uuid) to authenticated, service_role;
grant execute on function mark_order_shipped(uuid) to authenticated;
grant execute on function shop_cards(), my_cart(), hold_card(uuid), release_card(uuid, boolean), release_cart(),
  place_order(text, jsonb, text, text, text, text, text, text), cancel_my_order(uuid), is_admin(), expire_orders() to anon, authenticated;

-- ───────────────────────────── photo storage ─────────────────────────────
-- A public bucket for card photos; only the seller can upload or delete.
do $$
begin
  if exists (select 1 from information_schema.schemata where schema_name = 'storage') then
    insert into storage.buckets (id, name, public) values ('card-photos', 'card-photos', true)
      on conflict (id) do nothing;
    execute 'drop policy if exists card_photos_read on storage.objects';
    execute 'create policy card_photos_read on storage.objects for select using (bucket_id = ''card-photos'')';
    execute 'drop policy if exists card_photos_write on storage.objects';
    execute 'create policy card_photos_write on storage.objects for insert with check (bucket_id = ''card-photos'' and public.is_admin())';
    execute 'drop policy if exists card_photos_update on storage.objects';
    execute 'create policy card_photos_update on storage.objects for update using (bucket_id = ''card-photos'' and public.is_admin())';
    execute 'drop policy if exists card_photos_delete on storage.objects';
    execute 'create policy card_photos_delete on storage.objects for delete using (bucket_id = ''card-photos'' and public.is_admin())';
  end if;
end $$;

-- ───────────────────────────── starter data ─────────────────────────────
insert into bundles (id, name, price_cents, value_cents, shipping_cents, note, sort) values
  ('b6',   'Mini Bundle',      600,   500,   0, 'Standard shipping. Buyer assumes risk.', 1),
  ('b10',  'Standard Bundle',  1000,  1000,  0, 'Standard shipping. Buyer assumes risk.', 2),
  ('b30',  'Big Bundle',       2500,  3000,  600, '', 3),
  ('b100', 'Mega Bundle',      6500,  10000, 0, '', 4),
  ('b200', 'Ultimate Bundle',  11000, 20000, 0, '', 5)
on conflict (id) do nothing;
insert into addons (id, name, price_cents, description, max_qty) values
  ('mystery', 'Mystery Mailer', 1000, '25 cards plus one hit: an autograph, a graded card or a game-used card.', 10)
on conflict (id) do nothing;

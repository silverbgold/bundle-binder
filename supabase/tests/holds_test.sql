-- Hold and order rules, checked as different buyers. Run after stubs.sql and schema.sql.
\set ON_ERROR_STOP on
grant select on all tables in schema public to anon, authenticated;

-- test fixtures (as the database owner)
insert into admins values ('00000000-0000-0000-0000-00000000000a') on conflict do nothing;
insert into cards (id, name, price_cents, qty) values
  ('11111111-0000-0000-0000-000000000001', 'Charizard ex', 550, 1),
  ('11111111-0000-0000-0000-000000000002', 'Lightning Bolt', 100, 3),
  ('11111111-0000-0000-0000-000000000003', 'Dark Magician', 4675, 1);

create or replace function pg_temp.as_user(u text) returns void language sql as $$
  select set_config('request.jwt.claim.sub', u, false), set_config('request.jwt.claim.role', 'authenticated', false);
$$;
create or replace function pg_temp.expect_error(q text, want text) returns void language plpgsql as $$
begin
  execute q;
  raise exception 'FAIL: expected error % from: %', want, q;
exception when others then
  if sqlerrm not like want || '%' then raise exception 'FAIL: expected % but got % (%)', want, sqlerrm, q; end if;
  raise notice 'ok  error %', want;
end $$;
create or replace function pg_temp.check(cond boolean, label text) returns void language plpgsql as $$
begin
  if not cond then raise exception 'FAIL: %', label; end if;
  raise notice 'ok  %', label;
end $$;

-- 1. Buyer A holds the only Charizard; buyer B can't, and sees it as held
select pg_temp.as_user('aaaaaaaa-0000-0000-0000-00000000000a');
select hold_card('11111111-0000-0000-0000-000000000001');
select pg_temp.check((select mine from shop_cards() where name = 'Charizard ex') = 1, 'A has Charizard in cart');
select pg_temp.as_user('bbbbbbbb-0000-0000-0000-00000000000b');
select pg_temp.check((select held_by_others from shop_cards() where name = 'Charizard ex') = 1, 'B sees Charizard held by someone else');
select pg_temp.expect_error($q$select hold_card('11111111-0000-0000-0000-000000000001')$q$, 'held');

-- 2. Multi-copy card: 3 Lightning Bolts, A takes 2, B gets the last, C is refused
select pg_temp.as_user('aaaaaaaa-0000-0000-0000-00000000000a');
select hold_card('11111111-0000-0000-0000-000000000002');
select hold_card('11111111-0000-0000-0000-000000000002');
select pg_temp.as_user('bbbbbbbb-0000-0000-0000-00000000000b');
select hold_card('11111111-0000-0000-0000-000000000002');
select pg_temp.as_user('cccccccc-0000-0000-0000-00000000000c');
select pg_temp.expect_error($q$select hold_card('11111111-0000-0000-0000-000000000002')$q$, 'held');

-- 3. The whole cart shares one timer
select pg_temp.as_user('aaaaaaaa-0000-0000-0000-00000000000a');
select pg_temp.check((select count(distinct expires_at) from my_cart()) = 1, 'A''s cart items share one expiry time');
select pg_temp.check((select min(expires_at) from my_cart()) between now() + interval '14 minutes' and now() + interval '16 minutes', 'cart timer is about 15 minutes');

-- 4. Releasing a card puts it back for others
select release_card('11111111-0000-0000-0000-000000000002');   -- A drops one Bolt
select pg_temp.as_user('cccccccc-0000-0000-0000-00000000000c');
select hold_card('11111111-0000-0000-0000-000000000002');
select pg_temp.check(true, 'C can take the Bolt A put back');

-- 5. When A's timer runs out, Charizard comes back for B
reset role;
update holds set expires_at = now() - interval '1 second' where holder = 'aaaaaaaa-0000-0000-0000-00000000000a';
select pg_temp.as_user('bbbbbbbb-0000-0000-0000-00000000000b');
select pg_temp.check((select held_by_others from shop_cards() where name = 'Charizard ex') = 0, 'expired hold no longer blocks B');
select hold_card('11111111-0000-0000-0000-000000000001');
select pg_temp.check((select mine from shop_cards() where name = 'Charizard ex') = 1, 'B now holds Charizard');
select pg_temp.as_user('aaaaaaaa-0000-0000-0000-00000000000a');
select pg_temp.check((select count(*) from my_cart()) = 0, 'A''s expired cart is empty');

-- 6. Placing an order: bundle rules are checked on the server
select pg_temp.as_user('bbbbbbbb-0000-0000-0000-00000000000b');   -- B holds Charizard (550) + 1 Bolt (100)
select pg_temp.expect_error($q$select place_order(null, '[]', 'ship', 'B', '', '1 Main St', '', 'venmo')$q$, 'bundle_required');
select pg_temp.expect_error($q$select place_order('b6', '[]', 'ship', 'B', '', '1 Main St', '', 'venmo')$q$, 'over_bundle_value');
select pg_temp.expect_error($q$select place_order('b30', '[]', 'ship', 'B', '', '', '', 'venmo')$q$, 'address_required');
select pg_temp.expect_error($q$select place_order('b30', '[]', 'ship', '', '', '1 Main', '', 'venmo')$q$, 'name_required');
select pg_temp.expect_error($q$select place_order('b30', '[{"id":"mystery","qty":11}]', 'ship', 'B', '', '1 Main', '', 'venmo')$q$, 'addon_limit');
select (place_order('b30', '[{"id":"mystery","qty":2}]', 'ship', 'Buyer B', 'b@example.com', '1 Main St', '', 'venmo'))::jsonb as placed \gset
select pg_temp.check((:'placed'::jsonb->>'total_cents')::int = 2500 + 600 + 2000, 'total = $25 bundle + $6 shipping + 2 × $10 mailers');
select pg_temp.check((select count(*) from my_cart()) = 0, 'cart is empty after ordering');
select pg_temp.check((select count(*) from order_items oi join orders o on o.id = oi.order_id where o.code = :'placed'::jsonb->>'code') = 2, 'order has 2 card lines');

-- 7. Ordered cards stay held for others (pay-later hold of 24h)
select pg_temp.as_user('cccccccc-0000-0000-0000-00000000000c');
select pg_temp.expect_error($q$select hold_card('11111111-0000-0000-0000-000000000001')$q$, 'held');

-- 8. Stack delivery skips shipping; an expired cart can't be ordered
select pg_temp.as_user('cccccccc-0000-0000-0000-00000000000c');   -- C holds 1 Bolt
reset role;
update holds set expires_at = now() - interval '1 second' where holder = 'cccccccc-0000-0000-0000-00000000000c' and order_id is null;
select pg_temp.as_user('cccccccc-0000-0000-0000-00000000000c');
select pg_temp.expect_error($q$select place_order('b6', '[]', 'stack', 'C', '', '', '', 'cashapp')$q$, 'cart_expired');
select hold_card('11111111-0000-0000-0000-000000000002');
select pg_temp.check((place_order('b6', '[]', 'stack', 'C', '', '', '', 'cashapp')->>'total_cents')::int = 600, 'stack order of Mini Bundle is $6 with no shipping');

-- 9. Buyers can't mark their own order paid; the seller can
select pg_temp.as_user('bbbbbbbb-0000-0000-0000-00000000000b');
select pg_temp.expect_error(format($q$select mark_order_paid(%L)$q$, :'placed'::jsonb->>'order_id'), 'not_allowed');
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
select mark_order_paid((:'placed'::jsonb->>'order_id')::uuid, 'venmo');
reset role;
select pg_temp.check((select status from cards where name = 'Charizard ex') = 'sold' and (select qty from cards where name = 'Charizard ex') = 0, 'Charizard is sold after payment');
select pg_temp.check((select qty from cards where name = 'Lightning Bolt') = 2, 'Lightning Bolt went from 3 to 2');
select pg_temp.check((select status from orders where id = (:'placed'::jsonb->>'order_id')::uuid) = 'paid', 'order is paid');
select pg_temp.check(not exists (select 1 from holds where order_id = (:'placed'::jsonb->>'order_id')::uuid), 'paid order released its holds');

-- 10. Cancelling a buyer's own unpaid order puts the cards back in their cart
select pg_temp.as_user('aaaaaaaa-0000-0000-0000-00000000000a');
select hold_card('11111111-0000-0000-0000-000000000003');
select (place_order('b100', '[]', 'ship', 'A', '', '2 Oak Ave', '', 'card'))::jsonb as a_order \gset
select cancel_my_order((:'a_order'::jsonb->>'order_id')::uuid);
select pg_temp.check((select count(*) from my_cart()) = 1, 'Dark Magician is back in A''s cart after backing out of card payment');

-- 11. A late payment for a card someone else bought is refused unless forced
select (place_order('b100', '[]', 'ship', 'A', '', '2 Oak Ave', '', 'cashapp'))::jsonb as a2 \gset
reset role;
update holds set expires_at = now() - interval '1 second' where order_id = (:'a2'::jsonb->>'order_id')::uuid;
select pg_temp.as_user('bbbbbbbb-0000-0000-0000-00000000000b');
select hold_card('11111111-0000-0000-0000-000000000003');
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
select pg_temp.expect_error(format($q$select mark_order_paid(%L)$q$, :'a2'::jsonb->>'order_id'), 'no_longer_available:Dark Magician');
select expire_orders();
reset role;
select pg_temp.check((select status from orders where id = (:'a2'::jsonb->>'order_id')::uuid) = 'expired', 'unpaid order with run-out holds is marked expired');

-- 12. Signed-out visitors can browse but not hold
select set_config('request.jwt.claim.sub', '', false);
select pg_temp.check((select count(*) from shop_cards()) >= 2, 'signed-out visitor can list cards');
select pg_temp.expect_error($q$select hold_card('11111111-0000-0000-0000-000000000002')$q$, 'not_signed_in');

\echo ALL HOLD TESTS PASSED

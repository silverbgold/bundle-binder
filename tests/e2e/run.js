// End-to-end test: the real shop and dashboard pages, driven in a browser, against a real Postgres with schema.sql.
// Only the network layer to Supabase is replaced (mock-supabase.js), so holds, totals and permissions are the real thing.
// Usage: PGHOST=<socket dir> PGPORT=<port> node run.js
const { chromium } = require("playwright");
const { Pool } = require("pg");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "../..");
const WEB = path.join(ROOT, "web");
const DB = "bb_e2e";
const ADMIN = "00000000-0000-0000-0000-00000000000a";
const SERVICE = "service";
let failures = 0;
const ok = (cond, label) => { if (cond) console.log("ok   " + label); else { failures++; console.log("FAIL " + label); } };

function psql(args, input) { return execFileSync("psql", ["-v", "ON_ERROR_STOP=1", "-q", ...args], { input, encoding: "utf8" }); }

async function setupDb() {
  psql(["-d", "postgres", "-c", `drop database if exists ${DB}`, "-c", `create database ${DB}`]);
  psql(["-d", DB, "-f", path.join(ROOT, "supabase/tests/stubs.sql")]);
  psql(["-d", DB], "grant all on all tables in schema public to anon, authenticated, service_role; alter default privileges in schema public grant all on tables to anon, authenticated, service_role;");
  psql(["-d", DB, "-f", path.join(ROOT, "supabase/schema.sql")]);
  psql(["-d", DB], `
    insert into admins values ('${ADMIN}');
    update settings set pay = '{"venmo":"sample-shop","cashapp":"sampleshop"}', card_payments = true, shop_name = 'Test Card Shop';
    insert into cards (id, name, set_name, number, game, price_cents, qty, box, created_at) values
      ('11111111-0000-0000-0000-000000000001', 'Charizard ex', 'Obsidian Flames', '125', 'Pokémon', 550, 1, 'RC Box', now()),
      ('11111111-0000-0000-0000-000000000002', 'Lightning Bolt', 'Magic 2010', '146', 'Magic', 100, 3, 'Binder A', now() - interval '1 minute'),
      ('11111111-0000-0000-0000-000000000003', 'Dark Magician', 'LOB', '005', 'Yu-Gi-Oh!', 4675, 1, '', now() - interval '2 minutes');`);
}

const pool = new Pool({ database: DB, max: 8 });
const ident = (s) => { if (!/^[a-z_][a-z0-9_]*$/i.test(s)) throw new Error("bad identifier " + s); return s; };
const val = (v) => (v !== null && typeof v === "object" ? JSON.stringify(v) : v);
function splitTop(s) { const out = []; let d = 0, cur = ""; for (const ch of s) { if (ch === "(") d++; if (ch === ")") d--; if (ch === "," && d === 0) { out.push(cur.trim()); cur = ""; } else cur += ch; } if (cur.trim()) out.push(cur.trim()); return out; }

async function asUser(uid, fn) {
  const c = await pool.connect();
  try {
    await c.query("begin");
    if (uid === SERVICE) { await c.query("select set_config('request.jwt.claim.role','service_role',true)"); await c.query("set local role service_role"); }
    else if (uid) { await c.query("select set_config('request.jwt.claim.sub',$1,true), set_config('request.jwt.claim.role','authenticated',true)", [uid]); await c.query("set local role authenticated"); }
    else await c.query("set local role anon");
    const out = await fn(c);
    await c.query("commit");
    return { data: out, error: null };
  } catch (e) { await c.query("rollback").catch(() => {}); return { data: null, error: { message: e.message } }; }
  finally { c.release(); }
}
async function rpc(c, name, args) {
  const keys = Object.keys(args || {}), params = keys.map((k) => val(args[k]));
  const call = `public.${ident(name)}(${keys.map((k, i) => `${ident(k)} => $${i + 1}`).join(", ")})`;
  if (name === "shop_cards" || name === "my_cart") return (await c.query(`select * from ${call}`, params)).rows;
  return (await c.query(`select ${call} as r`, params)).rows[0].r;
}
async function table(c, q) {
  const t = ident(q.table), params = [];
  const cond = (f) => f.op === "is" ? `${ident(f.col)} is null`
    : f.op === "in" ? (params.push(f.val), `${ident(f.col)}::text = any($${params.length}::text[])`)
    : (params.push(val(f.val)), `${ident(f.col)} ${f.op === "gt" ? ">" : "="} $${params.length}`);
  const whereSql = () => { const w = q.filters.map(cond); return w.length ? " where " + w.join(" and ") : ""; };
  const W = q.action === "select" || q.action === "delete" ? whereSql() : "";
  let rows;
  if (q.action === "select") {
    const parts = splitTop(q.columns || "*"), base = [], nested = [];
    parts.forEach((p) => { const m = p.match(/^(\w+)\((.*)\)$/); if (m) nested.push({ rel: m[1], cols: m[2] }); else base.push(p === "*" ? "*" : ident(p)); });
    if (!base.length) base.push("*");
    if (!base.includes("*")) { if (nested.some((n) => n.rel === "order_items")) base.push("id"); if (nested.some((n) => n.rel === "cards")) base.push("card_id"); }
    let sql = `select ${base.join(", ")} from public.${t}${W}`;
    if (q.order) sql += ` order by ${ident(q.order.col)} ${q.order.asc ? "asc" : "desc"}`;
    if (q.limit) sql += ` limit ${parseInt(q.limit, 10)}`;
    rows = (await c.query(sql, params)).rows;
    for (const r of rows) for (const n of nested) {
      const cols = n.cols.trim() === "*" ? "*" : splitTop(n.cols).map(ident).join(", ");
      if (n.rel === "order_items") r.order_items = (await c.query(`select ${cols} from public.order_items where order_id = $1`, [r.id])).rows;
      if (n.rel === "cards") r.cards = (await c.query(`select ${cols} from public.cards where id = $1`, [r.card_id])).rows[0] || null;
    }
  } else if (q.action === "update") {
    const keys = Object.keys(q.values), set = keys.map((k) => (params.push(val(q.values[k])), `${ident(k)} = $${params.length}`));
    const W2 = q.filters.map(cond).join(" and ");
    rows = (await c.query(`update public.${t} set ${set.join(", ")}${W2 ? " where " + W2 : ""} returning *`, params)).rows;
  } else if (q.action === "insert") {
    const list = Array.isArray(q.values) ? q.values : [q.values], keys = [...new Set(list.flatMap(Object.keys))];
    const tuples = list.map((r) => "(" + keys.map((k) => (params.push(val(r[k] === undefined ? null : r[k])), `$${params.length}`)).join(", ") + ")");
    const cols = keys.map(ident).join(", ");
    rows = (await c.query(`insert into public.${t} (${cols}) values ${tuples.join(", ")} returning *`, params)).rows;
  } else if (q.action === "delete") {
    rows = (await c.query(`delete from public.${t}${W} returning *`, params)).rows;
  }
  if (q.single) { if (rows.length !== 1) throw new Error("JSON object requested, multiple (or no) rows returned"); return rows[0]; }
  return rows;
}
async function handle(p) {
  if (p.kind === "rpc") return asUser(p.uid, (c) => rpc(c, p.name, p.args));
  if (p.kind === "from") return asUser(p.uid, (c) => table(c, p));
  if (p.kind === "fn" && p.name === "create-checkout") {
    const { return_url, ...orderArgs } = p.args;
    const r = await asUser(p.uid, (c) => rpc(c, "place_order", { ...orderArgs, p_method: "card" }));
    if (r.error) return { data: { error: r.error.message }, error: null };
    return { data: { url: "/index.html?paid=" + r.data.code, code: r.data.code }, error: null };
  }
  return { data: null, error: { message: "unknown call" } };
}

function serve() {
  const mock = fs.readFileSync(path.join(__dirname, "mock-supabase.js"), "utf8");
  return new Promise((res) => {
    const srv = http.createServer((req, resp) => {
      const u = new URL(req.url, "http://x");
      if (u.pathname === "/config.js") { resp.writeHead(200, { "Content-Type": "text/javascript" }); return resp.end('window.BB_CONFIG={supabaseUrl:"http://127.0.0.1:9",supabaseAnonKey:"test"};'); }
      const f = path.join(WEB, path.normalize(u.pathname === "/" ? "/index.html" : u.pathname));
      if (!f.startsWith(WEB) || !fs.existsSync(f)) { resp.writeHead(404); return resp.end(); }
      resp.writeHead(200, { "Content-Type": f.endsWith(".js") ? "text/javascript" : f.endsWith(".css") ? "text/css" : "text/html" });
      fs.createReadStream(f).pipe(resp);
    }).listen(0, () => res({ srv, port: srv.address().port, mock }));
  });
}
async function newBuyer(browser, base, mock) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  await ctx.exposeFunction("__sb", handle);
  await ctx.route("https://cdn.jsdelivr.net/**", (r) => r.fulfill({ contentType: "text/javascript", body: mock }));
  await ctx.route("https://fonts.googleapis.com/**", (r) => r.fulfill({ contentType: "text/css", body: "" }));
  const page = await ctx.newPage();
  page.on("pageerror", (e) => { failures++; console.log("FAIL page error: " + e.message); });
  await page.goto(base + "/index.html");
  return page;
}
const tileButton = (page, name) => page.locator(".tile", { hasText: name }).locator(".foot button").first();
const q1 = async (sql) => (await pool.query(sql)).rows[0];

(async () => {
  await setupDb();
  const { srv, port, mock } = await serve();
  const base = "http://127.0.0.1:" + port;
  const browser = await chromium.launch();

  const A = await newBuyer(browser, base, mock);
  const B = await newBuyer(browser, base, mock);
  await A.waitForSelector(".pkg"); await B.waitForSelector(".pkg");
  ok((await A.title()) === "Test Card Shop", "shop loads with the seller's name");

  // A picks the Big Bundle and puts the only Charizard in the cart
  await A.click('.pkg:has-text("Big Bundle")');
  await tileButton(A, "Charizard ex").click();
  await A.waitForSelector("#timer");
  ok(/1[45]:\d\d/.test(await A.textContent("#timer-t")), "A's cart shows a ~15 minute hold timer");

  // B, without reloading, sees Charizard become held within one refresh
  await B.waitForSelector('.tile:has-text("Charizard ex") .badge', { timeout: 12000 });
  ok((await tileButton(B, "Charizard ex").isDisabled()), "B sees Charizard as 'In someone's cart' and can't add it (live, no reload)");

  // B can still take a Lightning Bolt
  await B.click('.pkg:has-text("Standard Bundle")');
  await tileButton(B, "Lightning Bolt").click();
  await B.waitForSelector("#timer");
  ok((await q1("select count(*)::int n from holds where card_id = '11111111-0000-0000-0000-000000000002'")).n === 1, "B holds a Lightning Bolt");

  // A's hold runs out → Charizard comes back for B
  await pool.query("update holds set expires_at = now() + interval '2 seconds' where card_id = '11111111-0000-0000-0000-000000000001'");
  await A.reload(); await A.waitForSelector("#timer");
  await A.waitForSelector(".toast:not([hidden])", { timeout: 15000 });
  ok(/timed out/.test(await A.textContent(".toast")), "A is told the cart timed out");
  await B.reload(); await B.waitForSelector(".tile");
  ok(!(await tileButton(B, "Charizard ex").isDisabled()), "after A's timer ends, Charizard is available to B again");

  // A takes it again and checks out with Venmo (ship now)
  await A.reload(); await A.waitForSelector(".tile");
  await tileButton(A, "Charizard ex").click(); await A.waitForSelector("#timer");
  await A.click('[data-act="checkout"]');
  await A.click('[data-act="step"][data-step="2"]');
  await A.click('[data-act="step"][data-step="3"]');
  ok(await A.isVisible("#f-err"), "checkout asks for a name and address before payment");
  await A.fill("#f-name", "Buyer A"); await A.fill("#f-contact", "a@example.com"); await A.fill("#f-addr", "12 Sample St\nTestville, CA 90000");
  await A.click('[data-act="step"][data-step="3"]');
  await A.click('.method:has-text("Venmo")');
  await A.click('[data-act="place"]');
  await A.waitForSelector("div.done");
  const code = (await A.textContent(".done h2")).match(/BB-\w+/)[0];
  const order = await q1(`select * from orders where code = '${code}'`);
  ok(order && order.total_cents === 3100 && order.status === "awaiting_payment" && order.address.includes("Testville"), "order " + code + " saved: $31.00 (Big Bundle $25 + $6 shipping), awaiting payment");
  ok(/venmo\.com\/sample-shop\?txn=pay&amount=31\.00/.test(await A.getAttribute(".done .paybtns a", "href")), "confirmation offers a Venmo button for exactly $31.00");

  // Seller sees it, marks it paid
  const S = await newBuyer(browser, base, mock);
  await S.goto(base + "/admin.html");
  await S.fill("#l-email", "seller@example.com"); await S.fill("#l-pass", "test-password"); await S.click('#login button[type="submit"]');
  await S.waitForSelector(".ocard");
  ok((await S.textContent(".ocard")).includes(code) && (await S.textContent(".ocard")).includes("box: RC Box"), "seller dashboard shows the order with the pull-list box");
  ok((await S.textContent(".holdlist")).includes("Lightning Bolt"), "seller sees B's Lightning Bolt in 'In carts right now'");
  await S.click(`.ocard:has-text("${code}") [data-act="paid"]`);
  await S.waitForSelector(`.ocard:has-text("${code}") .chip.ok`);
  const cz = await q1("select qty, status from cards where name = 'Charizard ex'");
  ok(cz.qty === 0 && cz.status === "sold", "marking paid takes Charizard off the shelf");
  await S.click('[data-act="tab"][data-tab="inventory"]'); await S.waitForSelector(".irow");
  ok((await S.locator(".irow").count()) === 3, "inventory tab lists the cards");
  await S.fill('.irow:has(input[value="Dark Magician"]) input[data-f="price_cents"]', "40.00");
  await S.waitForTimeout(1500);
  const pr = (await q1("select price_cents from cards where name = 'Dark Magician'")).price_cents;
  ok(pr === 4000, "editing a price in the dashboard saves it" + (pr === 4000 ? "" : " (got " + pr + "; toast: " + (await S.evaluate(() => (document.getElementById("toast") || {}).textContent)) + ")"));

  // select all + bulk actions
  await S.check("#selall");
  ok((await S.locator(".irow.sel").count()) === 3 && (await S.textContent(".bulkbar")).includes("3 selected"), "Select all ticks every card and shows the bulk bar");
  await S.emulateMedia({ colorScheme: "dark" }); await S.screenshot({ path: path.join(__dirname, "shot-inventory.png") }); await S.emulateMedia({ colorScheme: "light" });
  await S.fill("#bk-box", "Shelf 9"); await S.click('[data-act="bulk"][data-k="box"]'); await S.waitForTimeout(800);
  ok((await q1("select count(*)::int n from cards where box = 'Shelf 9'")).n === 3, "Set box changes all selected cards");
  await S.click('[data-act="selnone"]');
  ok((await S.locator(".irow.sel").count()) === 0 && (await S.locator(".bulkbar").count()) === 0, "Clear unselects everything");
  await S.click('[data-act="addblank"]'); await S.waitForSelector('.irow input[value="New card"]');
  await S.fill("#iq", "New card"); await S.check("#selall");
  ok((await S.textContent(".selall")).includes("(1)") && (await S.textContent(".bulkbar")).includes("1 selected"), "Select all with a filter only picks the matching cards");
  await S.selectOption("#bk-status", "hidden"); await S.waitForTimeout(800);
  ok((await q1("select status from cards where name = 'New card'")).status === "hidden", "bulk status change saves");
  await S.click('[data-act="bulkdel"]'); await S.click('[data-act="bulkdel"]'); await S.waitForTimeout(1000);
  ok((await q1("select count(*)::int n from cards")).n === 3 && (await q1("select count(*)::int n from cards where name = 'New card'")).n === 0, "bulk delete (after confirm) removes only the selected card");
  await S.fill("#iq", "");
  await S.click('[data-act="tab"][data-tab="settings"]'); await S.waitForSelector('[data-s="hold_minutes"]');
  await S.fill('[data-s="hold_minutes"]', "20"); await S.waitForTimeout(900);
  ok((await q1("select hold_minutes from settings")).hold_minutes === 20, "seller can change the hold time");

  // B pays by card: order placed, Stripe returns, webhook marks it paid
  await B.reload(); await B.waitForSelector(".tile");
  ok((await B.locator('.tile:has-text("Charizard ex")').count()) === 0, "sold Charizard has left B's shop");
  await B.click('[data-act="checkout"]');
  await B.click('[data-act="step"][data-step="2"]');
  await B.fill("#f-name", "Buyer B"); await B.fill("#f-addr", "9 Elm Rd");
  await B.click('[data-act="step"][data-step="3"]');
  await B.click('.method:has-text("Pay with card")');
  await B.click('[data-act="place"]');
  await B.waitForSelector("div.done");
  const backText = await B.textContent("div.done");
  ok(backText.includes("Confirming your card payment"), "after Stripe, B sees 'Confirming your card payment'" + (backText.includes("Confirming") ? "" : " (saw: " + backText.slice(0, 120) + ")"));
  const bcode = (await B.textContent(".done h2")).match(/BB-\w+/)[0];
  const bo = await q1(`select id, total_cents from orders where code = '${bcode}'`);
  ok(bo.total_cents === 1000, "card order total is $10.00 (Standard Bundle, free shipping)");
  const wh = await asUser(SERVICE, (c) => rpc(c, "mark_order_paid", { p_order: bo.id, p_method: "card", p_force: true }));
  ok(!wh.error, "Stripe webhook (as the server) marks the order paid");
  await B.waitForSelector('.done:has-text("Payment received")', { timeout: 12000 });
  ok(true, "B's page updates to 'Payment received'");
  await B.click('[data-act="view"][data-view="orders"]'); await B.waitForSelector(".order");
  ok((await B.textContent(".orders")).includes(bcode), "B's My orders lists the paid order");

  // phone layout
  await B.setViewportSize({ width: 400, height: 860 }); await B.click('[data-act="view"][data-view="shop"]'); await B.waitForSelector(".tile");
  ok((await B.evaluate(() => document.documentElement.scrollWidth)) <= 400, "shop fits a phone screen");
  await A.screenshot({ path: path.join(__dirname, "shot-confirmation.png") });

  await browser.close(); srv.close(); await pool.end();
  console.log(failures ? `\n${failures} FAILED` : "\nALL END-TO-END TESTS PASSED");
  process.exit(failures ? 1 : 0);
})().catch(async (e) => { console.error(e); process.exit(1); });

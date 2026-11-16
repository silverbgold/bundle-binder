/* Bundle Binder — seller dashboard: orders, live holds, inventory, settings. */
(function () {
  "use strict";
  var cfg = window.BB_CONFIG || {};
  var app = document.getElementById("app");
  if (!window.supabase || !cfg.supabaseUrl || /YOUR-PROJECT/.test(cfg.supabaseUrl)) {
    app.innerHTML = '<div class="wrap"><div class="panel" style="margin-top:40px"><h2>Almost there</h2><p class="note">Add your Supabase URL and anon key to config.js first.</p></div></div>';
    return;
  }
  var sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
  var CONDS = [["M", "Mint"], ["NM", "Near Mint"], ["LP", "Lightly Played"], ["MP", "Moderately Played"], ["HP", "Heavily Played"], ["DMG", "Damaged"], ["GR", "Graded"]];
  var STATUS = { awaiting_payment: ["Awaiting payment", "warn"], paid: ["Paid · ship it", "ok"], shipped: ["Shipped", "acc"], cancelled: ["Cancelled", ""], expired: ["Expired", "bad"] };
  var A = { tab: "orders", filter: "open", orders: [], holds: [], cards: [], settings: null, bundles: [], addons: [], q: "", limit: 100, sel: {}, msg: "", up: "" };

  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function money(c) { var sym = (A.settings && A.settings.currency_symbol) || "$"; c = Math.round(c || 0); return sym + (Math.floor(c / 100)).toLocaleString("en-US") + "." + String(c % 100).padStart(2, "0"); }
  function toCents(v) { var n = parseFloat(String(v).replace(/[^0-9.]/g, "")); return isFinite(n) ? Math.round(n * 100) : 0; }
  function imgUrl(p) { if (!p) return ""; if (/^https?:\/\//.test(p)) return p; return cfg.supabaseUrl + "/storage/v1/object/public/card-photos/" + p.split("/").map(encodeURIComponent).join("/"); }
  function toast(m) { var t = document.getElementById("toast"); if (!t) { t = document.createElement("div"); t.id = "toast"; t.className = "toast"; document.body.appendChild(t); } t.textContent = m; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(function () { t.hidden = true; }, 4500); }
  function condOpts(sel) { return CONDS.map(function (c) { return '<option value="' + c[0] + '"' + (sel === c[0] ? ' selected' : '') + '>' + c[0] + ' · ' + c[1] + '</option>'; }).join(""); }

  /* ---------- sign in ---------- */
  async function boot() {
    var s = await sb.auth.getSession();
    var user = s.data && s.data.session && s.data.session.user;
    if (!user || user.is_anonymous) return loginView();
    var r = await sb.rpc("is_admin");
    if (!r.data) {
      app.innerHTML = '<div class="wrap"><div class="panel" style="margin-top:40px;display:flex;flex-direction:column;gap:10px"><h2>Not a seller account</h2><p class="note">You’re signed in as ' + esc(user.email || "a buyer") + ', but this account isn’t set up as a seller. In Supabase, run:<br><code>insert into admins values (\'' + esc(user.id) + '\');</code></p><button class="btn" data-act="signout">Sign out</button></div></div>';
      return;
    }
    await loadAll(); render();
    setInterval(async function () { if (document.hidden) return; if (A.tab === "orders" && !busy()) { await loadOrders(); renderOrders(); } }, 20000);
  }
  function loginView() {
    app.innerHTML = '<div class="wrap"><form class="panel" id="login" style="margin:60px auto;max-width:380px;display:flex;flex-direction:column;gap:12px"><h2>Seller sign in</h2>'
      + '<label class="field">Email<input id="l-email" type="email" autocomplete="username" required></label><label class="field">Password<input id="l-pass" type="password" autocomplete="current-password" required></label>'
      + '<button class="btn primary" type="submit">Sign in</button><p class="warn" id="l-err" hidden></p><p class="note">Seller accounts are created in Supabase (Authentication → Users). See the setup guide.</p></form></div>';
    document.getElementById("login").addEventListener("submit", async function (e) {
      e.preventDefault();
      var r = await sb.auth.signInWithPassword({ email: document.getElementById("l-email").value.trim(), password: document.getElementById("l-pass").value });
      if (r.error) { var el = document.getElementById("l-err"); el.textContent = "Couldn’t sign in: " + r.error.message; el.hidden = false; return; }
      boot();
    });
  }

  /* ---------- data ---------- */
  async function loadAll() {
    var res = await Promise.all([
      sb.from("settings").select("*").eq("id", 1).single(),
      sb.from("bundles").select("*").order("sort"),
      sb.from("addons").select("*").order("sort")
    ]);
    A.settings = res[0].data; A.bundles = res[1].data || []; A.addons = res[2].data || [];
    await Promise.all([loadOrders(), loadCards()]);
  }
  async function loadOrders() {
    await sb.rpc("expire_orders").then(function () {}, function () {});
    var res = await Promise.all([
      sb.from("orders").select("*, order_items(*)").order("created_at", { ascending: false }).limit(300),
      sb.from("holds").select("qty, expires_at, order_id, cards(name)").is("order_id", null).gt("expires_at", new Date().toISOString())
    ]);
    A.orders = res[0].data || []; A.holds = res[1].data || [];
  }
  async function loadCards() {
    var r = await sb.from("cards").select("*").order("created_at", { ascending: false }).limit(5000);
    A.cards = r.data || [];
  }
  function busy() { var a = document.activeElement; return a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName); }

  /* ---------- render ---------- */
  function render() {
    var open = A.orders.filter(function (o) { return o.status === "awaiting_payment" || o.status === "paid"; }).length;
    app.innerHTML = '<div class="wrap"><header class="top"><div><div class="eyebrow">Seller dashboard</div><h1>' + esc(A.settings.shop_name) + '</h1></div>'
      + '<div class="tabs"><button data-act="tab" data-tab="orders" aria-pressed="' + (A.tab === "orders") + '">Orders' + (open ? ' (' + open + ')' : '') + '</button><button data-act="tab" data-tab="inventory" aria-pressed="' + (A.tab === "inventory") + '">Inventory</button><button data-act="tab" data-tab="settings" aria-pressed="' + (A.tab === "settings") + '">Settings</button><button data-act="signout">Sign out</button></div></header>'
      + '<div class="adm" id="main"></div></div>';
    if (A.tab === "orders") renderOrders(); else if (A.tab === "inventory") renderInventory(); else renderSettings();
  }
  function renderOrders() {
    var el = document.getElementById("main"); if (!el || A.tab !== "orders") return;
    var f = A.filter, list = A.orders.filter(function (o) { return f === "all" || (f === "open" ? (o.status === "awaiting_payment" || o.status === "paid") : o.status === f); });
    var paidSum = A.orders.filter(function (o) { return o.status === "paid" || o.status === "shipped"; }).reduce(function (t, o) { return t + o.total_cents; }, 0);
    var h = '<div class="row2"><div class="toolbar" style="margin:0">' + [["open", "To do"], ["awaiting_payment", "Awaiting payment"], ["paid", "Paid · to ship"], ["shipped", "Shipped"], ["all", "All"]].map(function (x) { return '<button class="btn sm' + (A.filter === x[0] ? ' primary' : '') + '" data-act="filter" data-f="' + x[0] + '">' + x[1] + '</button>'; }).join("") + '</div><span class="note">' + money(paidSum) + ' paid in total</span></div>';
    h += '<section class="panel"><h2>In carts right now</h2>' + (A.holds.length ? '<ul class="holdlist">' + A.holds.map(function (x) { var m = Math.max(0, Math.round((Date.parse(x.expires_at) - Date.now()) / 60000)); return '<li><span>' + (x.qty > 1 ? x.qty + '× ' : '') + esc(x.cards && x.cards.name) + '</span><span class="note">' + m + ' min left</span></li>'; }).join("") + '</ul>' : '<p class="note">No cards are being held in carts.</p>') + '</section>';
    h += '<div class="olist">' + (list.length ? list.map(orderCard).join("") : '<p class="empty">No orders here.</p>') + '</div>';
    el.innerHTML = h;
  }
  function orderCard(o) {
    var s = STATUS[o.status] || [o.status, ""], items = o.order_items || [];
    var addons = (o.addons || []).map(function (a) { return a.qty + '× ' + esc(a.name); }).join(", ");
    return '<article class="ocard"><div><div class="row2"><h3>' + esc(o.code) + ' · ' + esc(o.buyer_name) + '</h3><span class="chip ' + s[1] + '">' + esc(s[0]) + '</span></div>'
      + '<p class="note">' + new Date(o.created_at).toLocaleString() + ' · ' + esc(o.pay_method || "—") + (o.contact ? ' · ' + esc(o.contact) : '') + '</p>'
      + '<ul>' + items.map(function (i) { return '<li>' + (i.qty > 1 ? i.qty + '× ' : '') + esc(i.name) + (i.set_name ? ' <span class="note" style="display:inline">(' + esc(i.set_name) + (i.number ? ' #' + esc(i.number) : '') + ')</span>' : '') + ' · ' + esc(i.condition) + (i.box ? ' · <b>box: ' + esc(i.box) + '</b>' : '') + '</li>'; }).join("") + (addons ? '<li>Add-ons: ' + addons + '</li>' : '') + '</ul>'
      + (o.note ? '<p class="note">Note: ' + esc(o.note) + '</p>' : '') + '</div>'
      + '<div><p class="note">' + (o.delivery === "stack" ? '<b>Add to stack</b> (ship later)' : '<b>Ship to:</b><br>' + esc(o.address).replace(/\n/g, "<br>")) + '</p>'
      + '<div class="line"><span>' + esc(o.bundle_name || "Cards") + '</span><span class="price">' + money(o.bundle_price_cents || o.card_value_cents) + '</span></div>' + (o.shipping_cents ? '<div class="line"><span>Shipping</span><span class="price">' + money(o.shipping_cents) + '</span></div>' : '') + (o.addons_cents ? '<div class="line"><span>Add-ons</span><span class="price">' + money(o.addons_cents) + '</span></div>' : '')
      + '<div class="total"><span>Total</span><strong class="price" style="font-size:20px">' + money(o.total_cents) + '</strong></div></div>'
      + '<div class="oacts">' + (o.status === "awaiting_payment" || o.status === "expired" ? '<button class="btn primary sm" data-act="paid" data-id="' + o.id + '">Mark paid</button>' : '')
      + (o.status === "paid" ? '<button class="btn primary sm" data-act="shipped" data-id="' + o.id + '">Mark shipped</button>' : '')
      + (o.address && o.delivery === "ship" ? '<button class="btn sm" data-act="copyaddr" data-id="' + o.id + '">Copy address</button>' : '')
      + (o.status === "awaiting_payment" ? '<button class="btn sm danger" data-act="cancel" data-id="' + o.id + '">Cancel order</button>' : '') + '</div></article>';
  }
  function renderInventory() {
    var el = document.getElementById("main"); if (!el || A.tab !== "inventory") return;
    var forSale = A.cards.filter(function (c) { return c.status === "available"; }).length;
    el.innerHTML = '<section class="panel" style="display:flex;flex-direction:column;gap:12px"><h2>Add cards</h2>'
      + '<div class="cols"><label class="field">Default price<input id="d-price" value="1.00" inputmode="decimal"></label><label class="field">Default game<input id="d-game" placeholder="e.g. Lorcana"></label><label class="field">Default condition<select id="d-cond">' + condOpts("NM") + '</select></label><label class="field">Box / location<input id="d-box" placeholder="e.g. 50 MLB #3"></label></div>'
      + '<div class="drop" id="drop" tabindex="0" role="button"><b>Drop card photos here</b><br><span class="note">or click to choose. Each photo becomes a listing named after its file; edit names below.</span></div><input type="file" id="files" accept="image/*" multiple hidden>'
      + '<details><summary class="note" style="cursor:pointer">Import from a spreadsheet (CSV)</summary><p class="note">Columns: name (required), set, number, game, condition, price, qty, box, photo (a web address). Paste from Excel or Google Sheets, or choose a file.</p><textarea id="csv" rows="5" style="width:100%"></textarea><div class="toolbar"><button class="btn sm" data-act="csv">Import rows</button><input type="file" id="csvfile" accept=".csv,.tsv,.txt"></div></details>'
      + '<button class="btn sm" data-act="addblank" style="align-self:flex-start">Add a card without a photo</button><p class="note" id="upmsg" role="status">' + esc(A.up) + '</p></section>'
      + '<section class="panel"><div class="row2"><h2>Inventory <span class="note" style="display:inline">(' + A.cards.length + ' listings, ' + forSale + ' for sale)</span></h2><input id="iq" type="search" placeholder="Filter" value="' + esc(A.q) + '" style="padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--surface)"></div><div id="ibulk" class="ibulk"></div><div class="ilist" id="ilist"></div></section>'
      + '<input type="file" id="onefile" accept="image/*" hidden>';
    renderRows();
  }
  function filtered() { var q = A.q.trim().toLowerCase(); return A.cards.filter(function (c) { return !q || (c.name + " " + c.set_name + " " + c.number + " " + c.game + " " + c.box).toLowerCase().indexOf(q) >= 0; }); }
  function selIds() { var have = {}; A.cards.forEach(function (c) { have[c.id] = 1; }); return Object.keys(A.sel).filter(function (id) { return A.sel[id] && have[id]; }); }
  function renderBulk() {
    var el = document.getElementById("ibulk"); if (!el) return;
    var list = filtered(), ids = selIds(), n = ids.length, inView = list.filter(function (c) { return A.sel[c.id]; }).length;
    var all = list.length > 0 && inView === list.length;
    var h = '<label class="selall"><input type="checkbox" id="selall"' + (all ? ' checked' : '') + (list.length ? '' : ' disabled') + '> Select all' + (A.q.trim() ? ' matching' : '') + ' (' + list.length + ')</label>';
    if (n) h += '<div class="bulkbar" role="region" aria-label="Change selected cards"><b>' + n + ' selected</b>'
      + '<span class="bk"><input id="bk-price" inputmode="decimal" placeholder="Price" aria-label="New price"><button class="btn sm" data-act="bulk" data-k="price_cents">Set price</button></span>'
      + '<span class="bk"><select id="bk-status" aria-label="New status"><option value="">Status…</option><option value="available">For sale</option><option value="hidden">Hidden</option><option value="sold">Sold</option></select></span>'
      + '<span class="bk"><select id="bk-condition" aria-label="New condition"><option value="">Condition…</option>' + condOpts("") + '</select></span>'
      + '<span class="bk"><input id="bk-game" placeholder="Game" aria-label="New game"><button class="btn sm" data-act="bulk" data-k="game">Set game</button></span>'
      + '<span class="bk"><input id="bk-box" placeholder="Box" aria-label="New box"><button class="btn sm" data-act="bulk" data-k="box">Set box</button></span>'
      + '<span class="bk"><input id="bk-qty" type="number" min="0" placeholder="Qty" aria-label="New quantity" style="width:70px"><button class="btn sm" data-act="bulk" data-k="qty">Set qty</button></span>'
      + '<button class="btn sm danger" data-act="bulkdel">Delete ' + n + '</button><button class="btn sm ghost" data-act="selnone">Clear</button></div>';
    el.innerHTML = h;
    var sa = document.getElementById("selall"); if (sa) sa.indeterminate = inView > 0 && !all;
  }
  async function bulkUpdate(patch, label) {
    var ids = selIds(); if (!ids.length) return;
    for (var i = 0; i < ids.length; i += 150) {
      var chunk = ids.slice(i, i + 150), r = await sb.from("cards").update(patch).in("id", chunk);
      if (r.error) { toast("Didn’t save: " + r.error.message); break; }
    }
    A.cards.forEach(function (c) { if (A.sel[c.id]) Object.assign(c, patch); });
    toast(label + " for " + ids.length + " card" + (ids.length === 1 ? "" : "s") + "."); renderRows();
  }
  function renderRows() {
    var el = document.getElementById("ilist"); if (!el) return;
    var list = filtered();
    renderBulk();
    el.innerHTML = list.slice(0, A.limit).map(function (c) {
      var f = function (k, label, input) { return '<label class="field">' + label + input + '</label>'; };
      return '<div class="irow' + (A.sel[c.id] ? ' sel' : '') + '" data-id="' + c.id + '"><input type="checkbox" class="rowsel" aria-label="Select ' + esc(c.name) + '"' + (A.sel[c.id] ? ' checked' : '') + '><button class="thumbbtn" data-act="photo" data-id="' + c.id + '">' + (c.image_path ? '<img src="' + esc(imgUrl(c.image_path)) + '" alt="" loading="lazy">' : 'Add photo') + '</button><div class="ifields">'
        + f("name", "Name", '<input data-f="name" value="' + esc(c.name) + '">') + f("set_name", "Set", '<input data-f="set_name" value="' + esc(c.set_name) + '">') + f("number", "No.", '<input data-f="number" value="' + esc(c.number) + '">')
        + f("game", "Game", '<input data-f="game" value="' + esc(c.game) + '">') + f("condition", "Condition", '<select data-f="condition">' + condOpts(c.condition) + '</select>')
        + f("price", "Price", '<input data-f="price_cents" inputmode="decimal" value="' + (c.price_cents / 100).toFixed(2) + '">') + f("qty", "Qty", '<input data-f="qty" type="number" min="0" value="' + c.qty + '">')
        + f("status", "Status", '<select data-f="status"><option value="available"' + (c.status === "available" ? ' selected' : '') + '>For sale</option><option value="hidden"' + (c.status === "hidden" ? ' selected' : '') + '>Hidden</option><option value="sold"' + (c.status === "sold" ? ' selected' : '') + '>Sold</option></select>')
        + f("box", "Box", '<input data-f="box" value="' + esc(c.box) + '">') + '</div><button class="btn sm danger" data-act="del" data-id="' + c.id + '">Delete</button></div>';
    }).join("") + (list.length > A.limit ? '<div class="more"><button class="btn" data-act="more">Show more (' + (list.length - A.limit) + ')</button></div>' : '') + (!list.length ? '<p class="empty">No cards yet.</p>' : '');
  }
  function renderSettings() {
    var el = document.getElementById("main"); if (!el || A.tab !== "settings") return;
    var s = A.settings, p = s.pay || {};
    el.innerHTML = '<section class="panel" style="display:flex;flex-direction:column;gap:12px"><h2>Shop</h2><div class="cols">'
      + '<label class="field">Shop name<input data-s="shop_name" value="' + esc(s.shop_name) + '"></label><label class="field">Currency symbol<input data-s="currency_symbol" value="' + esc(s.currency_symbol) + '" maxlength="4"></label>'
      + '<label class="field wide">Note under the shop name<input data-s="tagline" value="' + esc(s.tagline) + '"></label><label class="field wide">How buyers reach you<input data-s="contact" value="' + esc(s.contact) + '"></label></div></section>'
      + '<section class="panel" style="display:flex;flex-direction:column;gap:12px"><h2>Holds</h2><p class="note">How long cards stay reserved for one buyer. Other buyers can’t add a held card.</p><div class="cols">'
      + '<label class="field">Cart holds cards for (minutes)<input data-s="hold_minutes" data-num="1" type="number" min="1" max="240" value="' + s.hold_minutes + '"></label>'
      + '<label class="field">Unpaid “pay later” orders hold cards for (hours)<input data-s="order_hold_hours" data-num="1" type="number" min="1" max="336" value="' + s.order_hold_hours + '"></label>'
      + '<label class="field">Most cards in one cart<input data-s="max_cart_cards" data-num="1" type="number" min="1" max="500" value="' + s.max_cart_cards + '"></label></div></section>'
      + '<section class="panel" style="display:flex;flex-direction:column;gap:12px"><h2>Payment</h2><label class="field" style="flex-direction:row;align-items:center;gap:8px;color:var(--ink)"><input type="checkbox" data-s="card_payments"' + (s.card_payments ? ' checked' : '') + '> Card payments through Stripe (turn on after finishing the Stripe steps in the setup guide)</label><div class="cols">'
      + ["cashapp:Cash App $cashtag", "venmo:Venmo username", "paypal:PayPal.me username", "zelle:Zelle email or phone", "other:Other instructions (e.g. cash at pickup)"].map(function (x) { var k = x.split(":")[0]; return '<label class="field">' + esc(x.split(":")[1]) + '<input data-pay="' + k + '" value="' + esc(p[k] || "") + '"></label>'; }).join("") + '</div></section>'
      + '<section class="panel" style="display:flex;flex-direction:column;gap:10px"><h2>Bundles</h2><p class="note">Buyers pick one, then fill it with cards up to its card value. Shipping 0 means free.</p>' + A.bundles.map(function (b) {
        return '<div class="brow" data-bid="' + esc(b.id) + '"><label class="field">Name<input data-b="name" value="' + esc(b.name) + '"></label><label class="field">Buyer pays<input data-b="price_cents" data-money="1" value="' + (b.price_cents / 100).toFixed(2) + '"></label><label class="field">Card value<input data-b="value_cents" data-money="1" value="' + (b.value_cents / 100).toFixed(2) + '"></label><label class="field">Shipping<input data-b="shipping_cents" data-money="1" value="' + (b.shipping_cents / 100).toFixed(2) + '"></label><label class="field">Max cards (0 = any)<input data-b="max_cards" type="number" min="0" value="' + b.max_cards + '"></label><label class="field">Showing<select data-b="active"><option value="true"' + (b.active ? ' selected' : '') + '>Yes</option><option value="false"' + (!b.active ? ' selected' : '') + '>No</option></select></label><button class="btn sm danger" data-act="delbundle" data-id="' + esc(b.id) + '">Remove</button><label class="field" style="grid-column:1/-1">Note<input data-b="note" value="' + esc(b.note) + '"></label></div>';
      }).join("") + '<button class="btn sm" data-act="addbundle" style="align-self:flex-start">Add a bundle</button></section>'
      + '<section class="panel" style="display:flex;flex-direction:column;gap:10px"><h2>Add-ons</h2>' + A.addons.map(function (a) {
        return '<div class="brow" data-aid="' + esc(a.id) + '" style="grid-template-columns:1.6fr 1fr 1fr .8fr auto"><label class="field">Name<input data-a="name" value="' + esc(a.name) + '"></label><label class="field">Price<input data-a="price_cents" data-money="1" value="' + (a.price_cents / 100).toFixed(2) + '"></label><label class="field">Most per order<input data-a="max_qty" type="number" min="1" max="99" value="' + a.max_qty + '"></label><label class="field">Showing<select data-a="active"><option value="true"' + (a.active ? ' selected' : '') + '>Yes</option><option value="false"' + (!a.active ? ' selected' : '') + '>No</option></select></label><button class="btn sm danger" data-act="deladdon" data-id="' + esc(a.id) + '">Remove</button><label class="field" style="grid-column:1/-1">What buyers get<input data-a="description" value="' + esc(a.description) + '"></label></div>';
      }).join("") + '<button class="btn sm" data-act="addaddon" style="align-self:flex-start">Add an add-on</button></section><p class="note">Changes save as you type.</p>';
  }

  /* ---------- saving ---------- */
  var timers = {};
  function later(key, fn) { clearTimeout(timers[key]); timers[key] = setTimeout(fn, 500); }
  async function saveCard(id, patch) { var r = await sb.from("cards").update(patch).eq("id", id); if (r.error) toast("Didn’t save: " + r.error.message); }
  async function saveSettings(patch) { Object.assign(A.settings, patch); var r = await sb.from("settings").update(patch).eq("id", 1); if (r.error) toast("Didn’t save: " + r.error.message); }

  async function resize(file, max) {
    var url = URL.createObjectURL(file), im = new Image();
    await new Promise(function (res, rej) { im.onload = res; im.onerror = rej; im.src = url; });
    var sc = Math.min(1, max / Math.max(im.naturalWidth, im.naturalHeight)), cv = document.createElement("canvas");
    cv.width = Math.round(im.naturalWidth * sc); cv.height = Math.round(im.naturalHeight * sc); cv.getContext("2d").drawImage(im, 0, 0, cv.width, cv.height);
    URL.revokeObjectURL(url);
    return await new Promise(function (r) { cv.toBlob(r, "image/jpeg", 0.88); });
  }
  async function uploadPhoto(file) {
    var blob = await resize(file, 1100), path = "cards/" + (crypto.randomUUID ? crypto.randomUUID() : Date.now() + "-" + Math.random().toString(36).slice(2)) + ".jpg";
    var r = await sb.storage.from("card-photos").upload(path, blob, { contentType: "image/jpeg", upsert: false });
    if (r.error) throw r.error;
    return path;
  }
  function defaults() { return { price_cents: toCents(document.getElementById("d-price").value || "1"), game: document.getElementById("d-game").value.trim(), condition: document.getElementById("d-cond").value, box: document.getElementById("d-box").value.trim() }; }
  async function addPhotos(files) {
    files = Array.prototype.filter.call(files, function (f) { return /^image\//.test(f.type); }).sort(function (a, b) { return a.name.localeCompare(b.name, undefined, { numeric: true }); });
    if (!files.length) return;
    var d = defaults(), done = 0, failed = 0, rows = [];
    for (var i = 0; i < files.length; i++) {
      A.up = "Uploading " + (i + 1) + " of " + files.length + "…"; var m = document.getElementById("upmsg"); if (m) m.textContent = A.up;
      try { var path = await uploadPhoto(files[i]); rows.push(Object.assign({ name: files[i].name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim() || "New card", image_path: path, qty: 1 }, d)); done++; }
      catch (e) { failed++; }
    }
    if (rows.length) { var r = await sb.from("cards").insert(rows); if (r.error) { toast("Couldn’t save the cards: " + r.error.message); failed += rows.length; done = 0; } }
    A.up = "Added " + done + " card" + (done === 1 ? "" : "s") + (failed ? ", " + failed + " failed" : "") + ". Fill in names and prices below.";
    await loadCards(); renderInventory();
  }
  function parseCSV(text) {
    text = String(text || "").replace(/^﻿/, "");
    var first = text.split(/\r?\n/)[0] || "", delim = first.split("\t").length > first.split(",").length ? "\t" : ",";
    var rows = [], row = [], f = "", q = false;
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      if (q) { if (ch === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += ch; continue; }
      if (ch === '"' && f === "") { q = true; continue; }
      if (ch === delim) { row.push(f); f = ""; continue; }
      if (ch === "\n" || ch === "\r") { if (ch === "\r" && text[i + 1] === "\n") i++; row.push(f); f = ""; if (row.some(function (x) { return x.trim(); })) rows.push(row); row = []; continue; }
      f += ch;
    }
    row.push(f); if (row.some(function (x) { return x.trim(); })) rows.push(row);
    return rows;
  }
  function mapCond(v) { var t = String(v || "").trim().toLowerCase(); if (!t) return ""; if (/psa|bgs|cgc|sgc|graded|^\d+(\.\d)?$/.test(t)) return "GR"; if (/^(nm|near)/.test(t)) return "NM"; if (/^(m|mint|gem)/.test(t)) return "M"; if (/^(lp|light|ex)/.test(t)) return "LP"; if (/^(mp|mod|vg|good)/.test(t)) return "MP"; if (/^(hp|heav)/.test(t)) return "HP"; if (/^(dmg|dam|poor)/.test(t)) return "DMG"; return ""; }
  async function importCSV(text) {
    var rows = parseCSV(text); if (rows.length < 2) { toast("Paste a header row (name, price…) and at least one card."); return; }
    var head = rows[0].map(function (h) { return h.trim().toLowerCase().replace(/[^a-z0-9#]/g, ""); });
    var col = function (names) { for (var i = 0; i < head.length; i++) if (names.indexOf(head[i]) >= 0) return i; return -1; };
    var ix = { name: col(["name", "card", "cardname", "player", "title"]), set: col(["set", "series", "setname", "product"]), number: col(["number", "no", "num", "cardnumber", "#", "card#"]), game: col(["game", "sport", "category"]), cond: col(["condition", "cond", "grade"]), price: col(["price", "value", "askingprice"]), qty: col(["qty", "quantity", "count"]), box: col(["box", "location", "bin"]), photo: col(["photo", "image", "imageurl", "picture"]) };
    if (ix.name < 0) { toast("Couldn’t find a name column."); return; }
    var d = defaults(), get = function (r, k) { return ix[k] >= 0 ? String(r[ix[k]] || "").trim() : ""; };
    var out = rows.slice(1).filter(function (r) { return get(r, "name"); }).map(function (r) {
      return { name: get(r, "name").slice(0, 140), set_name: get(r, "set"), number: get(r, "number").replace(/^#/, ""), game: get(r, "game") || d.game, condition: mapCond(get(r, "cond")) || d.condition, price_cents: get(r, "price") ? toCents(get(r, "price")) : d.price_cents, qty: Math.max(1, parseInt(get(r, "qty"), 10) || 1), box: get(r, "box") || d.box, image_path: /^https?:\/\//.test(get(r, "photo")) ? get(r, "photo") : "" };
    });
    for (var i = 0; i < out.length; i += 500) { var r = await sb.from("cards").insert(out.slice(i, i + 500)); if (r.error) { toast("Import stopped: " + r.error.message); break; } }
    A.up = "Imported " + out.length + " cards."; await loadCards(); renderInventory();
  }

  /* ---------- events ---------- */
  app.addEventListener("click", async function (e) {
    var t = e.target.closest("[data-act]"); if (!t) { if (e.target.closest("#drop")) document.getElementById("files").click(); return; }
    var a = t.getAttribute("data-act"), id = t.getAttribute("data-id");
    if (a === "tab") { A.tab = t.getAttribute("data-tab"); if (A.tab === "orders") await loadOrders(); render(); }
    else if (a === "signout") { await sb.auth.signOut(); location.reload(); }
    else if (a === "filter") { A.filter = t.getAttribute("data-f"); renderOrders(); }
    else if (a === "paid") {
      t.disabled = true;
      var r = await sb.rpc("mark_order_paid", { p_order: id, p_method: null, p_force: false });
      if (r.error && /no_longer_available/.test(r.error.message)) {
        var card = r.error.message.split("no_longer_available:")[1] || "a card";
        if (t.getAttribute("data-force") === "1") r = await sb.rpc("mark_order_paid", { p_order: id, p_method: null, p_force: true });
        else { t.disabled = false; t.setAttribute("data-force", "1"); t.textContent = "Mark paid anyway"; toast("This order’s hold ran out and " + card + " went to someone else. Refund that card, or tap again to mark paid anyway."); return; }
      }
      if (r.error) toast("Couldn’t mark paid: " + r.error.message);
      await loadOrders(); renderOrders();
    }
    else if (a === "shipped") { await sb.rpc("mark_order_shipped", { p_order: id }); await loadOrders(); renderOrders(); }
    else if (a === "cancel") {
      if (t.getAttribute("data-armed") !== "1") { t.setAttribute("data-armed", "1"); t.textContent = "Confirm cancel"; return; }
      await sb.rpc("cancel_order", { p_order: id }); await loadOrders(); renderOrders();
    }
    else if (a === "copyaddr") { var o = A.orders.find(function (x) { return x.id === id; }); try { await navigator.clipboard.writeText(o.buyer_name + "\n" + o.address); toast("Address copied."); } catch (er) { toast(o.address); } }
    else if (a === "more") { A.limit += 200; renderRows(); }
    else if (a === "addblank") { var d = defaults(); var r2 = await sb.from("cards").insert(Object.assign({ name: "New card", qty: 1 }, d)); if (r2.error) toast(r2.error.message); await loadCards(); renderRows(); }
    else if (a === "del") {
      if (t.getAttribute("data-armed") !== "1") { t.setAttribute("data-armed", "1"); t.textContent = "Confirm"; return; }
      var r3 = await sb.from("cards").delete().eq("id", id); if (r3.error) toast(r3.error.message); await loadCards(); renderRows();
    }
    else if (a === "selnone") { A.sel = {}; renderRows(); }
    else if (a === "bulk") {
      var k = t.getAttribute("data-k"), inp = document.getElementById("bk-" + (k === "price_cents" ? "price" : k)), raw = inp.value.trim();
      if (k === "price_cents") { if (!raw || toCents(raw) <= 0 && raw.replace(/[^0-9]/g, "") === "") { toast("Type a price first."); inp.focus(); return; } bulkUpdate({ price_cents: toCents(raw) }, "Price set to " + money(toCents(raw))); }
      else if (k === "qty") { if (raw === "") { toast("Type a quantity first."); inp.focus(); return; } bulkUpdate({ qty: Math.max(0, parseInt(raw, 10) || 0) }, "Quantity set"); }
      else bulkUpdate((function () { var p = {}; p[k] = raw; return p; })(), (k === "game" ? "Game" : "Box") + (raw ? " set" : " cleared"));
    }
    else if (a === "bulkdel") {
      var ids = selIds();
      if (t.getAttribute("data-armed") !== "1") { t.setAttribute("data-armed", "1"); t.textContent = "Confirm delete " + ids.length; return; }
      t.disabled = true;
      for (var i = 0; i < ids.length; i += 150) { var rd = await sb.from("cards").delete().in("id", ids.slice(i, i + 150)); if (rd.error) { toast(rd.error.message); break; } }
      toast("Deleted " + ids.length + " card" + (ids.length === 1 ? "" : "s") + "."); A.sel = {}; await loadCards(); renderInventory();
    }
    else if (a === "photo") { var of = document.getElementById("onefile"); of.dataset.id = id; of.value = ""; of.click(); }
    else if (a === "csv") { importCSV(document.getElementById("csv").value); }
    else if (a === "addbundle") { var nb = { id: "b" + Date.now().toString(36), name: "New Bundle", price_cents: 2000, value_cents: 2000, sort: A.bundles.length + 1 }; var r4 = await sb.from("bundles").insert(nb).select().single(); if (r4.data) A.bundles.push(r4.data); renderSettings(); }
    else if (a === "delbundle") { await sb.from("bundles").delete().eq("id", id); A.bundles = A.bundles.filter(function (b) { return b.id !== id; }); renderSettings(); }
    else if (a === "addaddon") { var na = { id: "a" + Date.now().toString(36), name: "New add-on", price_cents: 500, sort: A.addons.length + 1 }; var r5 = await sb.from("addons").insert(na).select().single(); if (r5.data) A.addons.push(r5.data); renderSettings(); }
    else if (a === "deladdon") { await sb.from("addons").delete().eq("id", id); A.addons = A.addons.filter(function (x) { return x.id !== id; }); renderSettings(); }
  });
  app.addEventListener("input", function (e) {
    var t = e.target;
    if (t.id === "iq") { A.q = t.value; A.limit = 100; renderRows(); return; }
    var f = t.getAttribute("data-f");
    if (f) {
      var id = t.closest(".irow").getAttribute("data-id"), c = A.cards.find(function (x) { return x.id === id; });
      var v = f === "price_cents" ? toCents(t.value) : f === "qty" ? Math.max(0, parseInt(t.value, 10) || 0) : t.value;
      c[f] = v; later("c" + id + f, function () { var p = {}; p[f] = v; saveCard(id, p); }); return;
    }
    var sk = t.getAttribute("data-s");
    if (sk && t.type !== "checkbox") { var sv = t.getAttribute("data-num") ? parseInt(t.value, 10) || 1 : t.value; later("s" + sk, function () { var p = {}; p[sk] = sv; saveSettings(p); }); return; }
    var pk = t.getAttribute("data-pay");
    if (pk) { later("pay", function () { var pay = Object.assign({}, A.settings.pay || {}); pay[pk] = t.value.trim(); saveSettings({ pay: pay }); }); return; }
    var bk = t.getAttribute("data-b"), ak = t.getAttribute("data-a");
    if (bk || ak) {
      var tbl = bk ? "bundles" : "addons", key = bk || ak, rid = t.closest(bk ? "[data-bid]" : "[data-aid]").getAttribute(bk ? "data-bid" : "data-aid");
      var val = t.getAttribute("data-money") ? toCents(t.value) : t.type === "number" ? parseInt(t.value, 10) || 0 : t.value;
      later(tbl + rid + key, async function () { var p = {}; p[key] = val; var r = await sb.from(tbl).update(p).eq("id", rid); if (r.error) toast("Didn’t save: " + r.error.message); });
    }
  });
  app.addEventListener("change", async function (e) {
    var t = e.target;
    if (t.tagName === "SELECT" && t.getAttribute("data-f")) { var id = t.closest(".irow").getAttribute("data-id"); var p = {}; p[t.getAttribute("data-f")] = t.value; saveCard(id, p); }
    if (t.type === "checkbox" && t.getAttribute("data-s")) saveSettings({ card_payments: t.checked });
    if (t.tagName === "SELECT" && (t.getAttribute("data-b") || t.getAttribute("data-a"))) { var bk = t.getAttribute("data-b"), tbl = bk ? "bundles" : "addons", rid = t.closest(bk ? "[data-bid]" : "[data-aid]").getAttribute(bk ? "data-bid" : "data-aid"); await sb.from(tbl).update({ active: t.value === "true" }).eq("id", rid); }
    if (t.id === "selall") { var vis = filtered(); vis.forEach(function (c) { if (t.checked) A.sel[c.id] = true; else delete A.sel[c.id]; }); renderRows(); return; }
    if (t.classList && t.classList.contains("rowsel")) { var row = t.closest(".irow"), rid2 = row.getAttribute("data-id"); if (t.checked) A.sel[rid2] = true; else delete A.sel[rid2]; row.classList.toggle("sel", t.checked); renderBulk(); return; }
    if ((t.id === "bk-status" || t.id === "bk-condition") && t.value) { var key = t.id.slice(3), pv = {}; pv[key] = t.value; var lab = t.options[t.selectedIndex].text; bulkUpdate(pv, (key === "status" ? "Status" : "Condition") + " set to " + lab); return; }
    if (t.id === "files") { addPhotos(t.files); }
    if (t.id === "csvfile" && t.files[0]) { var fr = new FileReader(); fr.onload = function () { importCSV(String(fr.result)); }; fr.readAsText(t.files[0]); }
    if (t.id === "onefile" && t.files[0]) { try { var path = await uploadPhoto(t.files[0]); await saveCard(t.dataset.id, { image_path: path }); await loadCards(); renderRows(); } catch (er) { toast("Photo upload failed: " + (er.message || er)); } }
  });
  app.addEventListener("dragover", function (e) { var d = e.target.closest && e.target.closest("#drop"); if (d) { e.preventDefault(); d.classList.add("over"); } });
  app.addEventListener("dragleave", function (e) { var d = e.target.closest && e.target.closest("#drop"); if (d) d.classList.remove("over"); });
  app.addEventListener("drop", function (e) { var d = e.target.closest && e.target.closest("#drop"); if (d) { e.preventDefault(); d.classList.remove("over"); addPhotos(e.dataTransfer.files); } });

  boot();
})();

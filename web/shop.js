/* Bundle Binder — buyer shop. Talks to Supabase; every rule that matters (holds, totals) is enforced in the database. */
(function () {
  "use strict";
  var cfg = window.BB_CONFIG || {};
  var app = document.getElementById("app");
  if (!window.supabase || !cfg.supabaseUrl || /YOUR-PROJECT/.test(cfg.supabaseUrl)) {
    app.innerHTML = '<div class="wrap"><div class="panel" style="margin-top:40px"><h2>Almost there</h2><p class="note">Add your Supabase URL and anon key to <b>config.js</b>, then reload. See the setup guide in README.md.</p></div></div>';
    return;
  }
  var sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
  var COND = { M: "Mint", NM: "Near Mint", LP: "Lightly Played", MP: "Moderately Played", HP: "Heavily Played", DMG: "Damaged", GR: "Graded" };
  var ERR = {
    held: "Someone just put that card in their cart.",
    not_available: "That card isn’t for sale anymore.",
    cart_full: "Your cart is full.",
    cart_expired: "Your cart timed out, so the cards went back to the shop. Add them again to check out.",
    bundle_required: "Choose a bundle first.",
    over_bundle_value: "Your cards are worth more than your bundle allows.",
    too_many_cards: "Your bundle doesn’t allow that many cards.",
    address_required: "Enter a shipping address, or choose Add to my stack.",
    name_required: "Enter your name or handle.",
    addon_limit: "That’s more of that add-on than one order allows.",
    bad_addon: "That add-on isn’t available anymore.",
    empty: "Your cart is empty.",
    not_signed_in: "Your shopping session didn’t start. Reload the page and try again."
  };

  /* ---------- small helpers ---------- */
  function ls(k, v) { try { if (v === undefined) return localStorage.getItem(k); if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { return null; } }
  function lsj(k) { try { return JSON.parse(ls(k) || "null"); } catch (e) { return null; } }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function money(c) { var sym = (S.settings && S.settings.currency_symbol) || "$"; c = Math.round(c || 0); return (c < 0 ? "-" : "") + sym + (Math.floor(Math.abs(c) / 100)).toLocaleString("en-US") + "." + String(Math.abs(c) % 100).padStart(2, "0"); }
  function imgUrl(p) { if (!p) return ""; if (/^https?:\/\//.test(p)) return p; return cfg.supabaseUrl + "/storage/v1/object/public/card-photos/" + p.split("/").map(encodeURIComponent).join("/"); }
  function img(p, alt) { var u = imgUrl(p); return u ? '<img src="' + esc(u) + '" alt="' + esc(alt || "") + '" loading="lazy">' : ""; }
  function errText(e) { var m = (e && (e.message || e.error_description || e.msg)) || String(e || ""); for (var k in ERR) if (m.indexOf(k) >= 0) return ERR[k]; return "Something went wrong. Try again."; }
  var toastTimer;
  function toast(msg) { var t = document.getElementById("toast"); if (!t) { t = document.createElement("div"); t.id = "toast"; t.className = "toast"; t.setAttribute("role", "status"); document.body.appendChild(t); } t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.hidden = true; }, 4200); }

  /* ---------- state ---------- */
  var S = {
    settings: null, bundles: [], addons: [], cards: [], cart: {}, cartExp: 0, offset: 0,
    pkg: ls("bbh-pkg") || "", addonSel: lsj("bbh-addons") || {}, delivery: ls("bbh-deliv") === "stack" ? "stack" : "ship",
    view: "shop", step: 1, search: "", game: "all", sort: "new", limit: 60, sheet: false, signedIn: false, banner: "",
    me: lsj("bbh-buyer") || { name: "", contact: "", addr: "" }, note: "", method: "", order: null, orders: [], busy: false
  };
  function now() { return Date.now() + S.offset; }

  /* ---------- data ---------- */
  async function startSession() {
    var r = await sb.auth.getSession();
    if (r.data && r.data.session) { S.signedIn = true; return; }
    var a = await sb.auth.signInAnonymously();
    if (a.error) { S.banner = "Carts aren’t switched on yet, so you can browse but not add cards. (Seller: turn on anonymous sign-ins in Supabase.)"; return; }
    S.signedIn = true;
  }
  async function loadStatic() {
    var res = await Promise.all([
      sb.from("settings").select("*").eq("id", 1).single(),
      sb.from("bundles").select("*").eq("active", true).order("sort"),
      sb.from("addons").select("*").eq("active", true).order("sort")
    ]);
    if (res[0].error) throw res[0].error;
    S.settings = res[0].data; S.bundles = res[1].data || []; S.addons = res[2].data || [];
    document.title = S.settings.shop_name || "Card Shop";
    if (!S.bundles.some(function (b) { return b.id === S.pkg; })) S.pkg = "";
  }
  async function refresh() {
    var res = await Promise.all([sb.rpc("shop_cards"), S.signedIn ? sb.rpc("my_cart") : Promise.resolve({ data: [] })]);
    if (!res[0].error) S.cards = res[0].data || [];
    var had = Object.keys(S.cart).length;
    S.cart = {}; S.cartExp = 0;
    (res[1].data || []).forEach(function (r) { S.cart[r.card_id] = r.qty; var e = Date.parse(r.expires_at); if (!S.cartExp || e < S.cartExp) S.cartExp = e; });
    return had && !Object.keys(S.cart).length;
  }

  /* ---------- derived ---------- */
  function cardById(id) { return S.cards.find(function (c) { return c.id === id; }); }
  function lines() { return Object.keys(S.cart).map(function (id) { return { card: cardById(id), n: S.cart[id] }; }).filter(function (l) { return l.card; }); }
  function addonLines() { return S.addons.map(function (a) { return { a: a, n: Math.min(+S.addonSel[a.id] || 0, a.max_qty) }; }).filter(function (l) { return l.n > 0; }); }
  function pkgMode() { return S.bundles.length > 0; }
  function curPkg() { return S.bundles.find(function (b) { return b.id === S.pkg; }) || null; }
  function status() {
    var ls_ = lines(), p = curPkg(), used = 0, count = 0;
    ls_.forEach(function (l) { used += l.card.price_cents * l.n; count += l.n; });
    var al = addonLines(), addT = al.reduce(function (t, l) { return t + l.a.price_cents * l.n; }, 0);
    var ship = p && S.delivery === "ship" && count ? p.shipping_cents : 0;
    var due = pkgMode() ? (p && count ? p.price_cents + ship : 0) + addT : used + addT;
    var over = !!(p && used > p.value_cents), tooMany = !!(p && p.max_cards && count > p.max_cards);
    return { lines: ls_, al: al, p: p, used: used, count: count, addT: addT, ship: ship, due: due, over: over, tooMany: tooMany,
      left: p ? p.value_cents - used : 0, block: pkgMode() && count > 0 && (!p || over || tooMany), empty: !count && !al.length };
  }
  function availFor(c) { return c.qty - c.held_by_others - (S.cart[c.id] || 0); }
  function canAdd(c, st) {
    if (availFor(c) <= 0) return c.held_by_others > 0 ? "held" : "max";
    if (!pkgMode()) return "ok";
    if (!st.p) return "nopkg";
    if (st.p.max_cards && st.count >= st.p.max_cards) return "full";
    if (c.price_cents > st.left) return "over";
    return "ok";
  }

  /* ---------- render ---------- */
  function render() {
    var s = S.settings || {};
    var h = '<div class="wrap"><header class="top"><div><div class="eyebrow">Singles · build-a-bundle</div><h1>' + esc(s.shop_name) + '</h1>' + (s.tagline ? '<p class="tagline">' + esc(s.tagline) + '</p>' : '') + '</div>'
      + '<div class="tabs" role="group" aria-label="View"><button data-act="view" data-view="shop" aria-pressed="' + (S.view === "shop") + '">Shop</button>'
      + (S.signedIn ? '<button data-act="view" data-view="orders" aria-pressed="' + (S.view === "orders") + '">My orders</button>' : '') + '</div></header>';
    if (S.banner) h += '<div class="banner">' + esc(S.banner) + '</div>';
    if (S.view === "checkout") h += checkoutHTML();
    else if (S.view === "orders") h += ordersHTML();
    else h += '<div class="shop"><section aria-label="Cards" style="min-width:0"><div id="pkgs"></div>' + (pkgMode() ? '<h2 style="margin:0 0 12px">Step 2 · Pick your cards</h2>' : '')
      + '<div class="toolbar"><input id="q" type="search" placeholder="Search name, set or number" aria-label="Search cards" value="' + esc(S.search) + '"><select id="sort" aria-label="Sort"><option value="new">Newest</option><option value="low">Price: low to high</option><option value="high">Price: high to low</option><option value="name">Name A–Z</option></select></div>'
      + '<div id="chips"></div><div class="grid" id="grid"></div></section><aside class="panel cart' + (S.sheet ? ' open' : '') + '" id="cart" aria-label="Your cart"></aside></div><div class="mobilebar" id="mbar"></div>';
    h += '</div>';
    app.innerHTML = h;
    var so = document.getElementById("sort"); if (so) so.value = S.sort;
    if (S.view === "shop") { renderPkgs(); renderGrid(); renderCart(); }
  }
  function renderPkgs() {
    var el = document.getElementById("pkgs"); if (!el) return;
    if (!pkgMode()) { el.innerHTML = ""; return; }
    var st = status(), p = st.p;
    if (p && !S.picking) {
      var pct = p.value_cents ? Math.min(100, Math.round(st.used / p.value_cents * 100)) : 100;
      el.innerHTML = '<div class="pkgbar"><div class="row2"><div><div class="eyebrow">Your bundle</div><b style="font-size:17px">' + esc(p.name) + ' · ' + money(p.price_cents) + (p.shipping_cents ? ' + ' + money(p.shipping_cents) + ' shipping' : '') + '</b></div><button class="btn sm" data-act="pick-change">Change bundle</button></div>'
        + '<div class="meter"><i style="width:' + pct + '%"></i></div><div class="row2 note"><span>' + money(st.used) + ' of ' + money(p.value_cents) + ' in cards picked</span><b>' + (st.over ? 'Over by ' + money(-st.left) : money(st.left) + ' left to spend') + '</b></div></div>';
      return;
    }
    el.innerHTML = '<div class="pkgpick"><h2>Step 1 · Choose your bundle</h2><p class="note">Pick a bundle, then fill it with any cards up to its card value.</p><div class="pkglist">'
      + S.bundles.map(function (b) {
        return '<button class="pkg' + (b.id === S.pkg ? ' on' : '') + '" data-act="pick" data-id="' + esc(b.id) + '"><span class="pkg-name">' + esc(b.name) + '</span><span class="pkg-price">' + money(b.price_cents) + '</span><small>Pick ' + money(b.value_cents) + ' of cards' + (b.max_cards ? ' · up to ' + b.max_cards : '') + '</small><small><b>' + (b.shipping_cents ? '+ ' + money(b.shipping_cents) + ' shipping' : 'Free shipping') + '</b></small>' + (b.note ? '<small>' + esc(b.note) + '</small>' : '') + (b.value_cents > b.price_cents ? '<span class="deal">+' + money(b.value_cents - b.price_cents) + ' bonus value</span>' : '') + '</button>';
      }).join("") + '</div></div>';
  }
  function visible() {
    var q = S.search.trim().toLowerCase();
    var list = S.cards.filter(function (c) { return (S.game === "all" || c.game === S.game) && (!q || (c.name + " " + c.set_name + " " + c.number + " " + c.game).toLowerCase().indexOf(q) >= 0); });
    var by = { new: function (a, b) { return Date.parse(b.created_at) - Date.parse(a.created_at); }, low: function (a, b) { return a.price_cents - b.price_cents; }, high: function (a, b) { return b.price_cents - a.price_cents; }, name: function (a, b) { return a.name.localeCompare(b.name); } }[S.sort];
    return list.sort(by);
  }
  function renderGrid() {
    var grid = document.getElementById("grid"); if (!grid) return;
    var games = []; S.cards.forEach(function (c) { if (c.game && games.indexOf(c.game) < 0) games.push(c.game); }); games.sort();
    var chips = document.getElementById("chips");
    if (chips) chips.innerHTML = games.length > 1 ? '<div class="toolbar">' + ["all"].concat(games).map(function (g) { return '<button class="btn sm' + (S.game === g ? ' primary' : '') + '" data-act="game" data-game="' + esc(g) + '">' + (g === "all" ? "All" : esc(g)) + '</button>'; }).join("") + '</div>' : "";
    if (!S.cards.length) { grid.innerHTML = '<p class="empty" style="grid-column:1/-1">No cards listed yet. Check back soon.</p>'; return; }
    var list = visible(), shown = list.slice(0, S.limit), st = status();
    if (!list.length) { grid.innerHTML = '<p class="empty" style="grid-column:1/-1">No cards match that search.</p>'; return; }
    grid.innerHTML = shown.map(function (c) {
      var n = S.cart[c.id] || 0, why = canAdd(c, st), heldOut = availFor(c) <= 0 && !n && c.held_by_others > 0;
      var act;
      if (heldOut) act = '<button class="btn sm" disabled>Held</button>';
      else if (n && c.qty > 1) act = '<span class="stepper"><button data-act="dec" data-id="' + c.id + '" aria-label="Remove one">−</button><span>' + n + '</span><button data-act="inc" data-id="' + c.id + '" aria-label="Add one"' + (why !== "ok" ? ' disabled' : '') + '>+</button></span>';
      else if (n) act = '<button class="btn sm" data-act="dec" data-id="' + c.id + '">Remove</button>';
      else if (why === "over") act = '<button class="btn sm" disabled>Over budget</button>';
      else if (why === "full") act = '<button class="btn sm" disabled>Bundle full</button>';
      else act = '<button class="btn sm primary" data-act="inc" data-id="' + c.id + '">Add</button>';
      var bits = [c.set_name, c.number ? "#" + c.number : ""].filter(Boolean).join(" · ");
      return '<article class="tile' + (n ? ' in' : '') + (heldOut ? ' held' : '') + '"><div class="art">' + (c.image_path ? img(c.image_path, c.name) : '<div class="ph">' + esc(c.name) + '</div>') + (heldOut ? '<span class="badge">In someone’s cart</span>' : '') + '</div>'
        + '<div class="tile-body"><div><span class="chip ' + (c.condition === "NM" || c.condition === "M" ? "ok" : c.condition === "GR" ? "acc" : "") + '" title="' + esc(COND[c.condition] || "") + '">' + esc(c.condition) + '</span> <span class="note" style="display:inline">' + esc(c.game) + '</span></div><h3>' + esc(c.name) + '</h3>' + (bits ? '<p class="set">' + esc(bits) + '</p>' : '')
        + '<div class="foot"><span class="price">' + money(c.price_cents) + '</span>' + act + '</div></div></article>';
    }).join("") + (list.length > shown.length ? '<div class="more"><button class="btn" data-act="more">Show more (' + (list.length - shown.length) + ' more)</button></div>' : '');
  }
  function timerText() { var left = Math.max(0, S.cartExp - now()), m = Math.floor(left / 60000), sec = Math.floor(left % 60000 / 1000); return m + ":" + String(sec).padStart(2, "0"); }
  function renderCart() {
    var el = document.getElementById("cart"); if (!el) return;
    var st = status(), h = '<div class="row2"><h2>Your cart</h2><button class="btn ghost sm" data-act="sheet" data-open="0">Close</button></div>';
    if (st.count) h += '<div class="timer' + (S.cartExp - now() < 120000 ? ' low' : '') + '" id="timer"><span>Cards held for you</span><b id="timer-t">' + timerText() + '</b></div><p class="note">Other buyers can’t take these while the timer runs. Check out before it ends or they go back to the shop.</p>';
    if (!st.count && !st.al.length) h += '<p class="empty">' + (pkgMode() && !st.p ? 'Choose a bundle, then tap Add on the cards you want.' : 'Tap Add on any card. It’s held just for you while you shop.') + '</p>';
    else h += '<ul class="clist">' + st.lines.map(function (l) { var c = l.card; return '<li><div class="thumb">' + img(c.image_path) + '</div><span>' + (l.n > 1 ? l.n + '× ' : '') + esc(c.name) + '<small>' + esc([c.set_name, c.condition].filter(Boolean).join(" · ")) + '</small></span><span class="price">' + money(c.price_cents * l.n) + '</span><button class="x" data-act="remove" data-id="' + c.id + '" aria-label="Remove ' + esc(c.name) + '">×</button></li>'; }).join("") + '</ul>';
    S.addons.forEach(function (a) {
      var n = Math.min(+S.addonSel[a.id] || 0, a.max_qty);
      h += '<div class="addon"><div><b>' + esc(a.name) + ' <span class="price">' + money(a.price_cents) + '</span></b><small>' + esc(a.description) + '</small></div>' + (n ? '<span class="stepper"><button data-act="addon" data-id="' + esc(a.id) + '" data-d="-1">−</button><span>' + n + '</span><button data-act="addon" data-id="' + esc(a.id) + '" data-d="1"' + (n >= a.max_qty ? ' disabled' : '') + '>+</button></span>' : '<button class="btn sm primary" data-act="addon" data-id="' + esc(a.id) + '" data-d="1">Add</button>') + '</div>';
    });
    if (st.p && st.count) h += '<div class="line"><span>' + esc(st.p.name) + '</span><span class="price">' + money(st.p.price_cents) + '</span></div>' + (st.p.shipping_cents ? '<div class="line"><span>Shipping</span><span class="price">' + (st.ship ? money(st.ship) : 'When your stack ships') + '</span></div>' : '');
    if (st.addT) h += '<div class="line"><span>Add-ons</span><span class="price">' + money(st.addT) + '</span></div>';
    if (st.over) h += '<p class="warn">Your cards are ' + money(-st.left) + ' over your bundle. Remove a card or choose a bigger bundle.</p>';
    if (st.tooMany) h += '<p class="warn">Your bundle allows ' + st.p.max_cards + ' cards.</p>';
    h += '<div class="total"><span>Total</span><strong class="price">' + money(st.due) + '</strong></div>';
    if (!st.empty) h += '<button class="btn primary big" data-act="checkout"' + (st.block ? ' disabled' : '') + '>Checkout · ' + money(st.due) + '</button><button class="btn ghost sm" data-act="clear">Empty cart</button>';
    el.innerHTML = h;
    var bar = document.getElementById("mbar");
    if (bar) bar.innerHTML = '<div><div class="note">' + st.count + ' card' + (st.count === 1 ? '' : 's') + (st.count ? ' · held ' + timerText() : '') + '</div><span class="price">' + money(st.due) + '</span></div><button class="btn primary" data-act="sheet" data-open="1">View cart</button>';
  }

  /* ---------- checkout ---------- */
  function stepsHTML(step) { return '<ol class="steps">' + ["Order", "Details", "Pay", "Done"].map(function (n, i) { return '<li class="' + (i + 1 === step ? 'on' : i + 1 < step ? 'done' : '') + '">' + (i + 1) + '. ' + n + '</li>'; }).join("") + '</ol>'; }
  function summaryHTML(st) {
    var h = '<aside class="panel" style="display:flex;flex-direction:column;gap:10px"><h2>Order summary</h2>';
    if (S.order) h += '<p class="note">Order <b>' + esc(S.order.code) + '</b></p>';
    h += '<ul class="clist">' + st.lines.map(function (l) { var c = l.card; return '<li style="grid-template-columns:34px minmax(0,1fr) auto"><div class="thumb">' + img(c.image_path) + '</div><span>' + (l.n > 1 ? l.n + '× ' : '') + esc(c.name) + '<small>' + esc(c.condition) + '</small></span><span class="price">' + money(c.price_cents * l.n) + '</span></li>'; }).join("")
      + st.al.map(function (l) { return '<li style="grid-template-columns:34px minmax(0,1fr) auto"><div class="thumb"></div><span>' + l.n + '× ' + esc(l.a.name) + '</span><span class="price">' + money(l.a.price_cents * l.n) + '</span></li>'; }).join("") + '</ul>';
    if (st.p && st.count) h += '<div class="line"><span>' + esc(st.p.name) + '</span><span class="price">' + money(st.p.price_cents) + '</span></div><div class="line"><span>Shipping</span><span class="price">' + (st.p.shipping_cents ? (st.ship ? money(st.ship) : 'When your stack ships') : 'Free') + '</span></div>';
    if (st.addT) h += '<div class="line"><span>Add-ons</span><span class="price">' + money(st.addT) + '</span></div>';
    return h + '<div class="total"><span>Total</span><strong class="price">' + money(S.order ? S.order.total_cents : st.due) + '</strong></div></aside>';
  }
  function payLinks(method, cents, code) {
    var p = (S.settings && S.settings.pay) || {}, amt = (cents / 100).toFixed(2), clean = function (v) { return String(v || "").replace(/^[@$]/, "").trim(); };
    if (method === "cashapp" && p.cashapp) return '<a class="btn primary big" href="https://cash.app/$' + encodeURIComponent(clean(p.cashapp)) + '/' + amt + '" target="_blank" rel="noopener">Pay ' + money(cents) + ' with Cash App</a>';
    if (method === "venmo" && p.venmo) return '<a class="btn primary big" href="https://venmo.com/' + encodeURIComponent(clean(p.venmo)) + '?txn=pay&amount=' + amt + '&note=' + encodeURIComponent(code) + '" target="_blank" rel="noopener">Pay ' + money(cents) + ' with Venmo</a>';
    if (method === "paypal" && p.paypal) return '<a class="btn primary big" href="https://www.paypal.com/paypalme/' + encodeURIComponent(clean(p.paypal)) + '/' + amt + '" target="_blank" rel="noopener">Pay ' + money(cents) + ' with PayPal</a>';
    if (method === "zelle" && p.zelle) return '<p>Send <b>' + money(cents) + '</b> by Zelle to <b>' + esc(p.zelle) + '</b>.</p>';
    if (method === "other" && p.other) return '<p>' + esc(p.other) + '</p>';
    return "";
  }
  function methodsList() {
    var p = (S.settings && S.settings.pay) || {}, m = [];
    if (S.settings && S.settings.card_payments) m.push(["card", "Pay with card", "Debit or credit card through secure Stripe checkout"]);
    if (p.cashapp) m.push(["cashapp", "Cash App", "$" + String(p.cashapp).replace(/^\$/, "")]);
    if (p.venmo) m.push(["venmo", "Venmo", "@" + String(p.venmo).replace(/^@/, "")]);
    if (p.paypal) m.push(["paypal", "PayPal", "paypal.me/" + String(p.paypal).replace(/^@/, "")]);
    if (p.zelle) m.push(["zelle", "Zelle", p.zelle]);
    if (p.other) m.push(["other", "Other", p.other]);
    if (!m.length) m.push(["later", "Pay later", "The seller will tell you how to pay"]);
    return m;
  }
  function checkoutHTML() {
    var st = status(), step = S.step;
    if (step < 4 && st.empty) return '<div class="panel"><h2>Your cart is empty</h2><p class="note">' + (S.expired ? ERR.cart_expired : 'Add some cards first.') + '</p><p><button class="btn primary" data-act="view" data-view="shop">Back to the shop</button></p></div>';
    var h = stepsHTML(step) + '<div class="cogrid"><section class="panel comain">';
    if (step < 4 && st.count) h += '<div class="timer' + (S.cartExp - now() < 120000 ? ' low' : '') + '"><span>Your cards are held for</span><b id="timer-t">' + timerText() + '</b></div>';
    if (step === 1) {
      h += '<h2>Review your order</h2>' + (st.block ? '<p class="warn">Your cards don’t fit your bundle. Go back and fix it.</p>' : '')
        + (st.count ? '<fieldset class="deliv"><legend>When it’s paid</legend><label><input type="radio" name="deliv" value="ship"' + (S.delivery === "ship" ? ' checked' : '') + '> Ship it now</label><label><input type="radio" name="deliv" value="stack"' + (S.delivery === "stack" ? ' checked' : '') + '> Add to my stack and ship later</label></fieldset>' : '')
        + '<div class="acts"><button class="btn ghost" data-act="view" data-view="shop">Keep shopping</button><button class="btn primary" data-act="step" data-step="2"' + (st.block ? ' disabled' : '') + '>Continue to details</button></div>';
    } else if (step === 2) {
      var needAddr = st.count && S.delivery === "ship";
      h += '<h2>Your details</h2><div class="fields"><label class="field">Name or handle *<input id="f-name" autocomplete="name" value="' + esc(S.me.name) + '"></label><label class="field">Email or phone<input id="f-contact" autocomplete="email" value="' + esc(S.me.contact) + '"></label>'
        + '<label class="field wide">' + (needAddr ? 'Shipping address *' : 'Shipping address (optional)') + '<textarea id="f-addr" rows="3" autocomplete="street-address" placeholder="Name, street, city, state, ZIP">' + esc(S.me.addr) + '</textarea></label><label class="field wide">Note for the seller<input id="f-note" value="' + esc(S.note) + '"></label></div>'
        + '<p class="warn" id="f-err" hidden></p><div class="acts"><button class="btn ghost" data-act="step" data-step="1">Back</button><button class="btn primary" data-act="step" data-step="3">Continue to payment</button></div>';
    } else if (step === 3) {
      var ms = methodsList();
      if (!S.method || !ms.some(function (m) { return m[0] === S.method; })) S.method = ms[0][0];
      h += '<h2>How do you want to pay?</h2><div class="methods">' + ms.map(function (m) { return '<button class="method' + (S.method === m[0] ? ' on' : '') + '" data-act="method" data-m="' + m[0] + '"><b>' + esc(m[1]) + '</b><span>' + esc(m[2]) + '</span><span class="price">' + money(st.due) + '</span></button>'; }).join("") + '</div>'
        + '<div class="acts"><button class="btn ghost" data-act="step" data-step="2">Back</button><button class="btn primary big" data-act="place"' + (S.busy ? ' disabled' : '') + '>' + (S.busy ? 'Working…' : S.method === "card" ? 'Pay ' + money(st.due) + ' by card' : 'Place order') + '</button></div>'
        + (S.method !== "card" ? '<p class="note">Your order goes straight to the seller. You’ll get payment details on the next screen, and your cards stay held for ' + ((S.settings && S.settings.order_hold_hours) || 24) + ' hours while the seller confirms.</p>' : '<p class="note">You’ll go to Stripe’s secure page to pay, then come back here.</p>');
    } else {
      var o = S.order || {};
      var paid = o.status === "paid" || o.status === "shipped";
      h += '<div class="done"><div class="check">✓</div><h2>Order ' + esc(o.code) + ' placed</h2>'
        + (paid ? '<p>Payment received. The seller has your order.</p>' : o.pay_method === "card" ? '<p>Confirming your card payment…</p>' : '<p>The seller has your order. Pay now to lock it in:</p><div class="paybtns">' + payLinks(o.pay_method, o.total_cents, o.code) + '</div><p class="note">Put <b>' + esc(o.code) + '</b> in the payment note. Your cards are held while the seller confirms payment.</p>')
        + '<div class="acts"><button class="btn" data-act="view" data-view="orders">See my orders</button><button class="btn ghost" data-act="done">Back to the shop</button></div></div>';
    }
    return h + '</section>' + (step < 4 ? summaryHTML(st) : '<aside class="panel"><h2>Thanks!</h2><p class="note">You can check this order any time under My orders on this device.</p></aside>') + '</div>';
  }
  async function placeOrder() {
    var st = status(); if (S.busy) return;
    S.busy = true; render();
    var addons = st.al.map(function (l) { return { id: l.a.id, qty: l.n }; });
    var args = { p_bundle: st.count && st.p ? st.p.id : null, p_addons: addons, p_delivery: S.delivery, p_name: S.me.name, p_contact: S.me.contact, p_address: S.me.addr, p_note: S.note, p_method: S.method };
    try {
      if (S.method === "card") {
        var f = await sb.functions.invoke("create-checkout", { body: Object.assign({}, args, { return_url: location.origin + location.pathname }) });
        if (f.error) throw f.error;
        if (f.data && f.data.error) throw new Error(f.data.error);
        location.href = f.data.url; return;
      }
      var r = await sb.rpc("place_order", args);
      if (r.error) throw r.error;
      S.order = { id: r.data.order_id, code: r.data.code, total_cents: r.data.total_cents, pay_method: S.method, status: "awaiting_payment" };
      S.addonSel = {}; ls("bbh-addons", null); S.step = 4; S.busy = false;
      await refresh(); render(); window.scrollTo(0, 0);
    } catch (e) {
      S.busy = false; var m = errText(e); toast(m);
      if (/timed out/.test(m)) { await refresh(); S.expired = true; }
      render();
    }
  }

  /* ---------- orders ---------- */
  var STATUS = { awaiting_payment: ["Awaiting payment", "warn"], paid: ["Paid", "ok"], shipped: ["Shipped", "acc"], cancelled: ["Cancelled", ""], expired: ["Expired (not paid in time)", "bad"] };
  async function loadOrders() {
    var r = await sb.from("orders").select("id,code,status,total_cents,created_at,pay_method,bundle_name,delivery,order_items(name,qty)").order("created_at", { ascending: false }).limit(50);
    S.orders = r.data || [];
  }
  function ordersHTML() {
    if (!S.orders.length) return '<div class="panel"><h2>My orders</h2><p class="note">No orders on this device yet.</p></div>';
    return '<div class="panel"><h2>My orders</h2><p class="note">Orders placed on this device.</p><div class="orders">' + S.orders.map(function (o) {
      var s = STATUS[o.status] || [o.status, ""];
      return '<div class="order"><div class="row2"><b>' + esc(o.code) + '</b><span class="chip ' + s[1] + '">' + esc(s[0]) + '</span></div><div class="row2 note"><span>' + new Date(o.created_at).toLocaleString() + (o.bundle_name ? ' · ' + esc(o.bundle_name) : '') + '</span><span class="price">' + money(o.total_cents) + '</span></div><div class="note">' + (o.order_items || []).map(function (i) { return (i.qty > 1 ? i.qty + '× ' : '') + esc(i.name); }).join(", ") + '</div>'
        + (o.status === "awaiting_payment" && o.pay_method !== "card" ? '<div class="paybtns">' + payLinks(o.pay_method, o.total_cents, o.code) + '</div>' : '') + '</div>';
    }).join("") + '</div></div>';
  }

  /* ---------- events ---------- */
  async function act(t) {
    var a = t.getAttribute("data-act"), id = t.getAttribute("data-id");
    if (a === "pick") { S.pkg = id; ls("bbh-pkg", id); S.picking = false; renderPkgs(); renderGrid(); renderCart(); }
    else if (a === "pick-change") { S.picking = true; renderPkgs(); }
    else if (a === "game") { S.game = t.getAttribute("data-game"); S.limit = 60; renderGrid(); }
    else if (a === "more") { S.limit += 120; renderGrid(); }
    else if (a === "inc") {
      var c = cardById(id), st = status(), why = c ? canAdd(c, st) : "max";
      if (why === "nopkg") { S.picking = true; renderPkgs(); toast("Choose a bundle first."); document.getElementById("pkgs").scrollIntoView({ behavior: "smooth" }); return; }
      if (why !== "ok") return;
      if (!S.signedIn) { toast(ERR.not_signed_in); return; }
      t.disabled = true;
      var r = await sb.rpc("hold_card", { p_card: id });
      if (r.error) toast(errText(r.error));
      else if (r.data && r.data.server_now) S.offset = Date.parse(r.data.server_now) - Date.now();
      await refresh(); renderGrid(); renderCart(); renderPkgs();
    }
    else if (a === "dec" || a === "remove") {
      t.disabled = true;
      var r2 = await sb.rpc("release_card", { p_card: id, p_all: a === "remove" });
      if (r2.error) toast(errText(r2.error));
      await refresh(); renderGrid(); renderCart(); renderPkgs();
    }
    else if (a === "clear") { await sb.rpc("release_cart"); S.addonSel = {}; ls("bbh-addons", null); await refresh(); renderGrid(); renderCart(); renderPkgs(); }
    else if (a === "addon") { var ad = S.addons.find(function (x) { return x.id === id; }); S.addonSel[id] = Math.max(0, Math.min(ad.max_qty, (+S.addonSel[id] || 0) + (+t.getAttribute("data-d")))); ls("bbh-addons", JSON.stringify(S.addonSel)); renderCart(); }
    else if (a === "sheet") { S.sheet = t.getAttribute("data-open") === "1"; var cart = document.getElementById("cart"); if (cart) cart.classList.toggle("open", S.sheet); }
    else if (a === "checkout") { S.view = "checkout"; S.step = 1; S.order = null; S.expired = false; S.sheet = false; render(); window.scrollTo(0, 0); }
    else if (a === "step") {
      var to = +t.getAttribute("data-step");
      if (to === 3 && S.step === 2) {
        var st2 = status(), err = !S.me.name.trim() ? ERR.name_required : (st2.count && S.delivery === "ship" && !S.me.addr.trim()) ? ERR.address_required : "";
        if (err) { var fe = document.getElementById("f-err"); fe.textContent = err; fe.hidden = false; return; }
        ls("bbh-buyer", JSON.stringify(S.me));
      }
      S.step = to; render(); window.scrollTo(0, 0);
    }
    else if (a === "method") { S.method = t.getAttribute("data-m"); render(); }
    else if (a === "place") { placeOrder(); }
    else if (a === "done") { S.view = "shop"; S.step = 1; S.order = null; render(); }
    else if (a === "view") { S.view = t.getAttribute("data-view"); if (S.view === "orders") await loadOrders(); if (S.view === "shop") { await refresh(); } render(); window.scrollTo(0, 0); }
  }
  app.addEventListener("click", function (e) { var t = e.target.closest("[data-act]"); if (t && !t.disabled) act(t); });
  app.addEventListener("input", function (e) {
    var t = e.target;
    if (t.id === "q") { S.search = t.value; S.limit = 60; renderGrid(); }
    else if (t.id === "f-name") S.me.name = t.value.slice(0, 80);
    else if (t.id === "f-contact") S.me.contact = t.value.slice(0, 120);
    else if (t.id === "f-addr") S.me.addr = t.value.slice(0, 400);
    else if (t.id === "f-note") S.note = t.value.slice(0, 300);
  });
  app.addEventListener("change", function (e) {
    var t = e.target;
    if (t.id === "sort") { S.sort = t.value; renderGrid(); }
    if (t.name === "deliv") { S.delivery = t.value === "stack" ? "stack" : "ship"; ls("bbh-deliv", S.delivery); render(); }
  });
  document.addEventListener("load", function (e) { var t = e.target; if (t && t.tagName === "IMG" && t.naturalWidth > t.naturalHeight * 1.1) { t.classList.add("land"); if (t.parentNode && t.parentNode.classList.contains("art")) t.parentNode.classList.add("landbg"); } }, true);

  /* ---------- live updates ---------- */
  function busyTyping() { var a = document.activeElement; return a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName); }
  setInterval(function () {
    var tt = document.getElementById("timer-t");
    if (tt && Object.keys(S.cart).length) {
      tt.textContent = timerText();
      var tb = tt.parentNode; if (tb) tb.classList.toggle("low", S.cartExp - now() < 120000);
      if (S.cartExp && now() >= S.cartExp) {
        S.cart = {}; refresh().then(function () { S.expired = true; toast(ERR.cart_expired); if (S.view === "shop") { renderGrid(); renderCart(); renderPkgs(); } else if (S.view === "checkout" && S.step < 4) render(); });
      }
    }
  }, 1000);
  setInterval(async function () {
    if (document.hidden || S.busy) return;
    if (S.view === "checkout" && S.step === 4 && S.order && S.order.pay_method === "card" && S.order.status === "awaiting_payment") {
      var r = await sb.from("orders").select("*").eq("id", S.order.id).single(); if (r.data){ S.order = r.data; render(); } return;
    }
    var lost = await refresh();
    if (lost && S.view !== "orders") toast(ERR.cart_expired);
    if (S.view === "shop" && !busyTyping()) { renderGrid(); renderCart(); renderPkgs(); }
    else if (S.view === "checkout" && S.step < 4 && status().empty) render();
  }, 8000);

  /* ---------- start ---------- */
  (async function () {
    try {
      await startSession();
      await loadStatic();
      var qs = new URLSearchParams(location.search);
      if (qs.get("cancelled")) { await sb.rpc("cancel_my_order", { p_order: qs.get("cancelled") }); toast("Card payment cancelled. Your cards are back in your cart."); }
      await refresh();
      if (qs.get("paid")) {
        var r = await sb.from("orders").select("*").eq("code", qs.get("paid")).single();
        if (r.data) { S.order = r.data; S.view = "checkout"; S.step = 4; S.addonSel = {}; ls("bbh-addons", null); }
      }
      if (qs.toString()) history.replaceState(null, "", location.pathname);
      render();
    } catch (e) {
      app.innerHTML = '<div class="wrap"><div class="panel" style="margin-top:40px"><h2>The shop couldn’t load</h2><p class="note">Check your connection and reload. (' + esc(e.message || e) + ')</p></div></div>';
    }
  })();
})();

// Test-only stand-in for supabase-js. Every call is forwarded to window.__sb (provided by the test runner),
// which runs it against a real Postgres loaded with schema.sql, as the signed-in user.
(function () {
  function uid() { return localStorage.getItem("mock-uid"); }
  function call(p) { p.uid = uid(); return window.__sb(p); }
  function builder(table) {
    var q = { kind: "from", table: table, action: "select", columns: "*", filters: [], order: null, limit: null, single: false, values: null, returning: false };
    var b = {
      select: function (cols) { if (q.action === "select") q.columns = cols || "*"; else q.returning = true; return b; },
      eq: function (c, v) { q.filters.push({ op: "eq", col: c, val: v }); return b; },
      is: function (c, v) { q.filters.push({ op: "is", col: c, val: v }); return b; },
      gt: function (c, v) { q.filters.push({ op: "gt", col: c, val: v }); return b; },
      in: function (c, v) { q.filters.push({ op: "in", col: c, val: v }); return b; },
      order: function (c, o) { q.order = { col: c, asc: !o || o.ascending !== false }; return b; },
      limit: function (n) { q.limit = n; return b; },
      single: function () { q.single = true; return b; },
      update: function (v) { q.action = "update"; q.values = v; return b; },
      insert: function (v) { q.action = "insert"; q.values = v; return b; },
      delete: function () { q.action = "delete"; return b; },
      then: function (res, rej) { return call(q).then(res, rej); }
    };
    return b;
  }
  var client = {
    auth: {
      getSession: async function () { var u = uid(); return { data: { session: u ? { user: { id: u, is_anonymous: localStorage.getItem("mock-anon") === "1", email: localStorage.getItem("mock-email") } } : null } }; },
      signInAnonymously: async function () { var u = crypto.randomUUID(); localStorage.setItem("mock-uid", u); localStorage.setItem("mock-anon", "1"); return { data: { user: { id: u } }, error: null }; },
      signInWithPassword: async function (c) {
        if (c.email === "seller@example.com" && c.password === "test-password") { localStorage.setItem("mock-uid", "00000000-0000-0000-0000-00000000000a"); localStorage.setItem("mock-anon", "0"); localStorage.setItem("mock-email", c.email); return { data: {}, error: null }; }
        return { data: null, error: { message: "Invalid login credentials" } };
      },
      signOut: async function () { localStorage.removeItem("mock-uid"); return { error: null }; }
    },
    from: builder,
    rpc: function (name, args) { return call({ kind: "rpc", name: name, args: args || {} }); },
    storage: { from: function () { return { upload: async function (path) { return { data: { path: path }, error: null }; } }; } },
    functions: { invoke: function (name, opts) { return call({ kind: "fn", name: name, args: (opts && opts.body) || {} }); } }
  };
  window.supabase = { createClient: function () { return client; } };
})();

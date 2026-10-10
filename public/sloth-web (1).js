// Browser side of the Netlify build. Provides what the app normally gets from Claude's runtime:
// window.__SLOTH_WEB, window.claude.use('user' | 'db' | 'mcp'), window.__slothAuth, window.__slothGoogle.
(function () {
  'use strict';
  window.__SLOTH_WEB = true;

  var KEY = 'sloth_session';
  var POLL_MS = 3000;

  function readSession() { try { var s = JSON.parse(localStorage.getItem(KEY) || 'null'); return s && s.uid && s.token ? s : null; } catch (e) { return null; } }
  function writeSession(s) { try { if (s) localStorage.setItem(KEY, JSON.stringify(s)); else localStorage.removeItem(KEY); } catch (e) {} }
  var session = readSession();

  function mkErr(code, message, extra) { var e = new Error(message || code); e.code = code; if (extra) for (var k in extra) e[k] = extra[k]; return e; }

  async function api(path, opts) {
    opts = opts || {};
    var headers = { 'content-type': 'application/json' };
    if (session) headers.authorization = 'Bearer ' + session.uid + '.' + session.token;
    var res;
    try {
      res = await fetch('/api/' + path, { method: opts.method || (opts.body ? 'POST' : 'GET'), headers: headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
    } catch (e) { throw mkErr('network', 'Network error'); }
    var j = null;
    try { j = await res.json(); } catch (e) {}
    if (!res.ok) {
      var er = (j && j.error) || {};
      if (res.status === 401) { session = null; writeSession(null); }
      throw mkErr(er.code || 'error', er.message || ('HTTP ' + res.status), { status: res.status, retryable: res.status === 429 || res.status >= 500, retryAfterMs: 1500 });
    }
    return j;
  }

  // ---------- sign-in (pick a name) ----------
  var pendingPrompt = null;
  function prompt() {
    if (session) return Promise.resolve(session);
    if (pendingPrompt) return pendingPrompt;
    pendingPrompt = new Promise(function (resolve) {
      var wrap = document.createElement('div');
      wrap.className = 'fixed inset-0 z-50 bg-black/40 flex items-end justify-center';
      wrap.style.cssText = 'position:fixed;inset:0;z-index:60;background:rgba(0,0,0,.4);display:flex;align-items:flex-end;justify-content:center';
      wrap.innerHTML =
        '<div style="background:var(--card);color:var(--foreground);width:100%;max-width:28rem;max-height:calc(100vh - 1rem);max-height:calc(100dvh - 1rem);overflow-y:auto;border-radius:1.5rem 1.5rem 0 0;padding:1.5rem 1.5rem calc(1.5rem + env(safe-area-inset-bottom,0px));font-family:Nunito,system-ui,sans-serif">' +
        '<div style="font-size:2.5rem;text-align:center">🦥</div>' +
        '<h3 style="font-size:1.25rem;font-weight:800;text-align:center;margin-top:.5rem">What should people call you?</h3>' +
        '<p style="font-size:.875rem;color:var(--muted-foreground);text-align:center;margin-top:.25rem">No password needed. This name is what others see on shared calendars. It stays signed in on this device.</p>' +
        '<input id="slothName" maxlength="40" autocomplete="name" placeholder="Your name" style="margin-top:1rem;width:100%;box-sizing:border-box;border-radius:1rem;background:var(--muted);color:var(--foreground);padding:.75rem 1rem;font-weight:600;border:0;outline:none;font-size:1rem" />' +
        '<p id="slothErr" style="font-size:.875rem;font-weight:700;color:var(--primary);margin-top:.5rem;min-height:1.1rem"></p>' +
        '<button id="slothGo" style="margin-top:.5rem;width:100%;border-radius:9999px;background:var(--primary);color:var(--primary-foreground);padding:.75rem;font-weight:800;border:0;font-size:1rem;cursor:pointer">Continue</button>' +
        '<button id="slothSkip" style="margin-top:.5rem;width:100%;border-radius:9999px;background:var(--secondary);color:var(--secondary-foreground);padding:.75rem;font-weight:700;border:0;font-size:1rem;cursor:pointer">Not now</button></div>';
      document.body.appendChild(wrap);
      var input = wrap.querySelector('#slothName'), err = wrap.querySelector('#slothErr'), go = wrap.querySelector('#slothGo');
      setTimeout(function () { input.focus(); }, 50);
      function done(v) { if (wrap.parentNode) wrap.parentNode.removeChild(wrap); pendingPrompt = null; resolve(v); }
      async function submit() {
        var name = input.value.replace(/\s+/g, ' ').trim();
        if (!name) { err.textContent = 'Type a name first.'; return; }
        go.disabled = true; go.style.opacity = '.6'; err.textContent = '';
        try {
          var j = await api('auth/join', { body: { name: name } });
          session = { uid: j.uid, token: j.token }; writeSession(session); done(session);
        } catch (e) { go.disabled = false; go.style.opacity = '1'; err.textContent = e.code === 'network' ? "Can't reach the server. Check your connection." : (e.status === 404 || e.status === 405 || e.status === 0 || e.status === undefined) ? 'No backend found here. This only works on the deployed Netlify site (deployed with Git or the Netlify CLI), not in a preview or a drag-and-drop upload.' : e.status >= 500 ? 'The server hit an error. Check the function logs in Netlify (Logs, Functions).' : 'Something went wrong. Try again.'; }
      }
      go.addEventListener('click', submit);
      input.addEventListener('keydown', function (e) { if (e.key === 'Enter') submit(); });
      wrap.querySelector('#slothSkip').addEventListener('click', function () { done(null); });
    });
    return pendingPrompt;
  }
  window.__slothAuth = { prompt: prompt, signedIn: function () { return !!session; } };

  // ---------- user capability ----------
  function avatarUrl(name, color) {
    var ini = String(name || '?').split(/\s+/).filter(Boolean).map(function (w) { return w[0]; }).join('').slice(0, 2).toUpperCase() || '?';
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="' + (color || '#9B7BA8') + '"/><text x="32" y="41" font-family="Arial,sans-serif" font-size="26" font-weight="700" text-anchor="middle" fill="#fff">' + ini.replace(/[<&]/g, '') + '</text></svg>';
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }
  var profileCache = {};
  var user = {
    id: async function () {
      var autoJoin = /[#?&]join=/.test(location.hash + location.search);
      if (!session && autoJoin) await prompt();
      if (!session) return null;
      try { await api('me'); } catch (e) { if (e.code === 'unauthenticated') return null; }
      return session ? session.uid : null;
    },
    profiles: async function (uids) {
      var need = uids.filter(function (u) { return !profileCache[u]; });
      if (need.length) {
        var got = await api('profiles', { body: { uids: need } });
        need.forEach(function (u) { if (got[u]) profileCache[u] = { name: got[u].name, color: got[u].color, avatarUrl: avatarUrl(got[u].name, got[u].color) }; });
      }
      var out = {}; uids.forEach(function (u) { if (profileCache[u]) out[u] = profileCache[u]; });
      return out;
    },
    search: async function (q) {
      var list = await api('search?q=' + encodeURIComponent(q || ''));
      return list.map(function (p) { return { id: p.id, name: p.name, color: p.color, avatarUrl: avatarUrl(p.name, p.color) }; });
    },
    can: async function () { return true; },
  };

  // ---------- db capability (polling snapshots) ----------
  var subs = new Map(), seq = 0, timer = null, busy = false, again = false;

  function mkDoc(id, data) { return { id: id, data: function () { return data; } }; }

  function schedule(ms) { clearTimeout(timer); timer = setTimeout(tick, ms); }
  function poke() { if (busy) { again = true; return; } schedule(120); }

  async function tick() {
    if (busy) { again = true; return; }
    if (!subs.size || !session) { schedule(POLL_MS); return; }
    if (document.hidden) { schedule(POLL_MS * 3); return; }
    busy = true;
    var list = Array.from(subs.values());
    try {
      var res = await api('db/poll', { body: { subs: list.map(function (s) { return { id: s.id, kind: s.kind, path: s.path, where: s.where, h: s.h || null }; }) } });
      list.forEach(function (s) {
        if (!subs.has(s.id)) return;
        var r = res.results[s.id];
        if (!r || r.same) return;
        if (r.error) { if (s.err) s.err({ code: r.error.code, message: r.error.message }); return; }
        s.h = r.h;
        try { s.deliver(r); } catch (e) { console.error(e); }
      });
    } catch (e) {
      list.forEach(function (s) { if (s.err) s.err({ code: e.code || 'error', message: e.message }); });
    }
    busy = false;
    if (again) { again = false; schedule(120); } else schedule(POLL_MS);
  }
  document.addEventListener('visibilitychange', function () { if (!document.hidden) poke(); });

  function addSub(def, cb, err) {
    var id = 's' + (++seq);
    var s = { id: id, kind: def.kind, path: def.path, where: def.where || [], err: err, h: null, prev: new Map(), first: true };
    if (def.kind === 'doc') {
      s.deliver = function (r) { cb({ exists: !!r.exists, id: def.path.split('/').pop(), data: function () { return r.exists ? r.data : undefined; } }); };
    } else {
      s.deliver = function (r) {
        var docs = r.docs.map(function (d) { return mkDoc(d.id, d.data); });
        var next = new Map(r.docs.map(function (d) { return [d.id, JSON.stringify(d.data)]; }));
        var changes = [];
        docs.forEach(function (d) {
          if (!s.prev.has(d.id)) changes.push({ type: 'added', doc: d });
          else if (s.prev.get(d.id) !== next.get(d.id)) changes.push({ type: 'modified', doc: d });
        });
        s.prev.forEach(function (_, pid) { if (!next.has(pid)) changes.push({ type: 'removed', doc: mkDoc(pid, null) }); });
        s.prev = next; s.first = false;
        cb({ docs: docs, size: docs.length, empty: !docs.length, docChanges: function () { return changes; } });
      };
    }
    subs.set(id, s);
    poke();
    return function () { subs.delete(id); };
  }

  function Query(path, where) { this.path = path; this.w = where; }
  Query.prototype.where = function (f, op, v) { return new Query(this.path, this.w.concat([[f, op, v]])); };
  Query.prototype.doc = function (id) { return new DocRef(this.path + '/' + id); };
  Query.prototype.onSnapshot = function (cb, err) { return addSub({ kind: 'col', path: this.path, where: this.w }, cb, err); };

  function DocRef(path) { this.path = path; }
  DocRef.prototype.get = async function () {
    var r = await api('db/get', { body: { path: this.path } });
    return { exists: !!r.exists, id: this.path.split('/').pop(), data: function () { return r.exists ? r.data : undefined; } };
  };
  async function write(op, path, data) { await api('db/' + op, { body: { path: path, data: data } }); poke(); }
  DocRef.prototype.set = function (d) { return write('set', this.path, d); };
  DocRef.prototype.update = function (d) { return write('update', this.path, d); };
  DocRef.prototype.delete = async function () { await api('db/delete', { body: { path: this.path } }); poke(); };
  DocRef.prototype.onSnapshot = function (cb, err) { return addSub({ kind: 'doc', path: this.path }, cb, err); };

  var db = {
    collection: function (p) { return new Query(p, []); },
    doc: function (p) { return new DocRef(p); },
    writeMany: async function (ops) {
      for (var i = 0; i < ops.length; i += 100) await api('db/batch', { body: { ops: ops.slice(i, i + 100) } });
      poke();
    },
  };

  // ---------- Google Calendar (server proxy) ----------
  window.__slothGoogle = {
    status: function () { return api('google/status'); },
    start: async function () { return (await api('google/start', { method: 'POST', body: {} })).url; },
    disconnect: function () { return api('google/disconnect', { method: 'POST', body: {} }); },
  };
  var mcp = {
    callTool: function (server, tool, input) { return api('google/call', { body: { tool: tool, input: input } }); },
  };

  window.claude = {
    use: async function (name) {
      if (name === 'user') return user;
      if (name === 'db') return db;
      if (name === 'mcp') return mcp;
      return null;
    },
  };
})();

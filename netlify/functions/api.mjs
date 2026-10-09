// Sloth Sync backend: one Netlify Function behind /api/*
// - Accounts: pick a name, get a random uid + secret token (kept in the browser)
// - A small Firestore-style document store on Netlify Blobs, with access rules
// - Google Calendar: OAuth link + read-only proxy (list_calendars / list_events)
import { getStore } from '@netlify/blobs';
import { createHash, randomBytes } from 'node:crypto';

export const config = { path: '/api/*' };

const store = () => getStore({ name: 'sloth', consistency: 'strong' });
const COLORS = ['#7D8FB3', '#9B7BA8', '#6FA3A0', '#C4A15B', '#B08968', '#8A9A5B'];
const sha = (s) => createHash('sha256').update(s).digest('hex');
const rid = (n) => randomBytes(n).toString('hex');
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const fail = (status, code, message) => json({ error: { code, message: message || code } }, status);
class HttpError extends Error { constructor(status, code, message) { super(message || code); this.status = status; this.code = code; } }

// ---------- helpers ----------
async function getJSON(key) { return (await store().get(key, { type: 'json' })) || null; }
async function putJSON(key, val) { await store().setJSON(key, val); }
async function delKey(key) { await store().delete(key); }
const segs = (p) => String(p || '').split('/');
function cleanPath(p) {
  p = String(p || '').replace(/^\/+|\/+$/g, '');
  const s = p.split('/');
  if (!p || s.some((x) => !x || x === '.' || x === '..') || p.length > 300) throw new HttpError(400, 'bad_path');
  if (s[0] === 'sys') throw new HttpError(403, 'forbidden');
  return p;
}
const isDocPath = (p) => segs(p).length % 2 === 0;
const isColPath = (p) => segs(p).length % 2 === 1;

async function listCollection(path) {
  const prefix = path + '/';
  const out = [];
  const { blobs } = await store().list({ prefix, directories: true });
  const keys = blobs.map((b) => b.key).filter((k) => !k.slice(prefix.length).includes('/'));
  const docs = await Promise.all(keys.map(async (k) => ({ id: k.slice(prefix.length), data: await getJSON(k) })));
  docs.forEach((d) => { if (d.data) out.push(d); });
  return out;
}

async function auth(req) {
  const h = req.headers.get('authorization') || '';
  const m = /^Bearer ([a-f0-9]{8,64})\.([a-f0-9]{16,128})$/.exec(h);
  if (!m) throw new HttpError(401, 'unauthenticated');
  const u = await getJSON('sys/users/' + m[1]);
  if (!u || u.tokenHash !== sha(m[2])) throw new HttpError(401, 'unauthenticated');
  return m[1];
}
const profileOf = (uid, u) => ({ name: u.name, color: u.color });

// ---------- access rules ----------
const has = (arr, v) => Array.isArray(arr) && arr.includes(v);
const keysOf = (o) => Object.keys(o || {});
const subset = (a, b) => a.every((x) => b.includes(x));

async function activeInviteFor(calId) {
  const invs = await listCollection('invites');
  const now = Date.now();
  return invs.some(({ data: v }) => v && v.cal === calId && !v.revoked && !(v.expiresMs && now > v.expiresMs) && !(v.maxUses && (v.uses || 0) >= v.maxUses));
}

function canRead(path, uid, doc, listing) {
  const s = segs(path);
  if (s[0] === 'data') return s[1] === 'users' && s[2] === uid;
  if (s[0] === 'invites') return listing ? doc.owner === uid : true;
  if (s[0] === 'cals' && s.length === 2) return listing ? has(doc.members, uid) : true;
  if (s[0] === 'reqs') return doc.owner === uid || has(doc.inv, uid);
  return false;
}

async function calMember(calId, uid) {
  const c = await getJSON('cals/' + calId);
  return { cal: c, ok: !!c && has(c.members, uid) };
}

async function canWrite(op, path, uid, existing, data) {
  const s = segs(path);
  if (s[0] === 'data') return s[1] === 'users' && s[2] === uid;

  if (s[0] === 'invites' && s.length === 2) {
    if (!existing) {
      if (!data || data.owner !== uid || typeof data.cal !== 'string') return false;
      const c = await getJSON('cals/' + data.cal);
      return !!c && c.owner === uid;
    }
    if (existing.owner === uid) return true;
    if (op === 'delete') return false;
    return subset(keysOf(data), ['uses', 'joined']);
  }

  if (s[0] === 'cals' && s.length === 2) {
    if (!existing) return op === 'set' && data && data.owner === uid && has(data.members, uid) && s[1].startsWith(uid + '-');
    if (existing.owner === uid) return true;
    if (op !== 'update' || !subset(keysOf(data), ['members'])) return false;
    const next = data.members;
    if (!Array.isArray(next) || next.length > 200) return false;
    const old = existing.members || [];
    const adds = next.filter((x) => !old.includes(x));
    const removes = old.filter((x) => !next.includes(x));
    if (removes.length && !(removes.length === 1 && removes[0] === uid && !adds.length)) return false;
    if (adds.length) {
      if (!(adds.length === 1 && adds[0] === uid && !removes.length)) return false;
      return activeInviteFor(s[1]);
    }
    return true;
  }

  if (s[0] === 'cals' && s[2] === 'ev' && s.length === 4) {
    const { cal, ok } = await calMember(s[1], uid);
    if (!cal) return op === 'delete';
    return ok;
  }

  if (s[0] === 'reqs' && s.length === 2) {
    if (!existing) return op === 'set' && data && data.owner === uid && Array.isArray(data.inv);
    if (existing.owner === uid) return true;
    if (!has(existing.inv, uid) || op !== 'update') return false;
    if (!subset(keysOf(data), ['startMs', 'endMs', 'counterBy', 'counterName', 'ver', 'rounds', 'meAsk', 'origStartMs', 'origEndMs', 'res'])) return false;
    return subset(keysOf(data.res), [uid]);
  }
  return false;
}

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
function deepMerge(a, b) {
  const out = { ...a };
  for (const k of Object.keys(b)) out[k] = isObj(b[k]) && isObj(a[k]) ? deepMerge(a[k], b[k]) : b[k];
  return out;
}
function checkData(d) {
  if (!isObj(d)) throw new HttpError(400, 'invalid_argument', 'data must be an object');
  if (JSON.stringify(d).length > 60000) throw new HttpError(400, 'invalid_argument', 'document too large');
}

async function cascadeDeleteCal(calId) {
  const evs = await listCollection('cals/' + calId + '/ev');
  await Promise.all(evs.map((e) => delKey('cals/' + calId + '/ev/' + e.id)));
  const invs = await listCollection('invites');
  await Promise.all(invs.filter((i) => i.data.cal === calId).map((i) => delKey('invites/' + i.id)));
}

function matches(doc, where) {
  return (where || []).every(([f, op, val]) => {
    const v = doc[f];
    if (op === '==') return v === val;
    if (op === 'array-contains') return Array.isArray(v) && v.includes(val);
    throw new HttpError(400, 'invalid_argument', 'unsupported operator');
  });
}

async function readSub(sub, uid) {
  const path = cleanPath(sub.path);
  if (sub.kind === 'doc') {
    if (!isDocPath(path)) throw new HttpError(400, 'bad_path');
    const d = await getJSON(path);
    if (d && !canRead(path, uid, d, false)) return { exists: false };
    return d ? { exists: true, data: d } : { exists: false };
  }
  if (!isColPath(path)) throw new HttpError(400, 'bad_path');
  const s = segs(path);
  if (s[0] === 'cals' && s[2] === 'ev') {
    const { ok } = await calMember(s[1], uid);
    if (!ok) return { docs: [] };
    return { docs: await listCollection(path) };
  }
  const all = await listCollection(path);
  return { docs: all.filter((d) => canRead(path + '/' + d.id, uid, d.data, true) && matches(d.data, sub.where)) };
}

// ---------- Google ----------
const GOOGLE = () => ({ id: process.env.GOOGLE_CLIENT_ID, secret: process.env.GOOGLE_CLIENT_SECRET });
const gConfigured = () => !!(GOOGLE().id && GOOGLE().secret);
const redirectUri = (req) => process.env.GOOGLE_REDIRECT_URI || new URL(req.url).origin + '/api/google/callback';
const tokenCache = new Map();

async function gAccessToken(uid) {
  const hit = tokenCache.get(uid);
  if (hit && hit.exp > Date.now() + 30000) return hit.token;
  const rec = await getJSON('sys/google/' + uid);
  if (!rec || !rec.refresh) throw new HttpError(400, 'server_not_connected');
  const g = GOOGLE();
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: g.id, client_secret: g.secret, refresh_token: rec.refresh, grant_type: 'refresh_token' }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) {
    if (j.error === 'invalid_grant') { await delKey('sys/google/' + uid); throw new HttpError(400, 'needs_reauth'); }
    throw new HttpError(502, 'upstream_error');
  }
  tokenCache.set(uid, { token: j.access_token, exp: Date.now() + (j.expires_in || 3000) * 1000 });
  return j.access_token;
}

async function gApi(uid, url) {
  const token = await gAccessToken(uid);
  const r = await fetch(url, { headers: { authorization: 'Bearer ' + token } });
  if (r.status === 401) { tokenCache.delete(uid); throw new HttpError(400, 'needs_reauth'); }
  if (r.status === 429) throw new HttpError(429, 'rate_limited');
  const j = await r.json().catch(() => ({}));
  if (r.status === 403 && j.error && /insufficient|scope/i.test(JSON.stringify(j.error))) throw new HttpError(400, 'needs_reauth');
  if (r.status >= 500) throw new HttpError(502, 'upstream_error');
  if (!r.ok) throw new HttpError(400, 'tool_error', (j.error && j.error.message) || 'Google error');
  return j;
}

async function gCall(uid, tool, input) {
  input = input || {};
  if (tool === 'list_calendars') {
    const q = new URLSearchParams({ maxResults: String(Math.min(250, input.pageSize || 100)), showHidden: 'true' });
    if (input.pageToken) q.set('pageToken', input.pageToken);
    const j = await gApi(uid, 'https://www.googleapis.com/calendar/v3/users/me/calendarList?' + q);
    return { calendars: (j.items || []).map((c) => ({ id: c.id, summary: c.summaryOverride || c.summary || c.id, accessRole: c.accessRole, hidden: !!c.hidden })), nextPageToken: j.nextPageToken };
  }
  if (tool === 'list_events') {
    if (!input.calendarId) throw new HttpError(400, 'tool_error', 'calendarId required');
    const q = new URLSearchParams({ singleEvents: 'true', orderBy: 'startTime', maxResults: String(Math.min(250, input.pageSize || 100)), timeMin: input.startTime, timeMax: input.endTime });
    if (input.pageToken) q.set('pageToken', input.pageToken);
    const j = await gApi(uid, 'https://www.googleapis.com/calendar/v3/calendars/' + encodeURIComponent(input.calendarId) + '/events?' + q);
    const events = (j.items || []).map((e) => ({
      id: e.id, status: e.status, summary: e.summary, start: e.start, end: e.end, transparency: e.transparency,
    }));
    return { summary: j.summary, accessRole: j.accessRole, events, nextPageToken: j.nextPageToken };
  }
  throw new HttpError(400, 'tool_error', 'unknown tool');
}

// ---------- router ----------
export default async (req) => {
  const url = new URL(req.url);
  const route = url.pathname.replace(/^\/api\/?/, '').replace(/\/$/, '');
  try {
    // public routes
    if (route === 'auth/join' && req.method === 'POST') {
      const body = await req.json().catch(() => ({}));
      const name = String(body.name || '').replace(/\s+/g, ' ').trim().slice(0, 40);
      if (!name) throw new HttpError(400, 'invalid_argument', 'Name required');
      const uid = rid(8), token = rid(24);
      const color = COLORS[parseInt(uid.slice(0, 4), 16) % COLORS.length];
      await putJSON('sys/users/' + uid, { name, color, tokenHash: sha(token), createdMs: Date.now() });
      await putJSON('sys/names/' + uid, { name, lower: name.toLowerCase(), color });
      return json({ uid, token, profile: { name, color } });
    }
    if (route === 'google/redirect-uri' && req.method === 'GET') {
      const uri = redirectUri(req);
      return new Response('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:system-ui;padding:24px;max-width:640px;margin:auto"><h2>Google redirect URI</h2><p>Add this exact value under <b>Authorized redirect URIs</b> in your Google Cloud OAuth client:</p><p style="word-break:break-all;background:#eee;padding:12px;border-radius:8px;font-family:monospace">' + uri.replace(/[<&]/g, '') + '</p><p>' + (process.env.GOOGLE_REDIRECT_URI ? 'It comes from the GOOGLE_REDIRECT_URI environment variable.' : 'It was built from the address you are visiting now. Open this page from the same address people use for the app.') + '</p></body>', { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
    }
    if (route === 'google/callback' && req.method === 'GET') {
      const back = (qs) => new Response(null, { status: 302, headers: { location: '/#google=' + qs, 'cache-control': 'no-store' } });
      if (!gConfigured()) return back('error&reason=notconfigured');
      const err = url.searchParams.get('error');
      const state = url.searchParams.get('state') || '';
      const st = /^[a-f0-9]{32}$/.test(state) ? await getJSON('sys/gstate/' + state) : null;
      if (st) await delKey('sys/gstate/' + state);
      if (err) return back('error&reason=denied');
      if (!st || Date.now() > st.exp) return back('error&reason=state');
      const code = url.searchParams.get('code');
      if (!code) return back('error&reason=denied');
      const g = GOOGLE();
      const r = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ code, client_id: g.id, client_secret: g.secret, redirect_uri: redirectUri(req), grant_type: 'authorization_code' }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.access_token) return back('error&reason=denied');
      if (!String(j.scope || '').includes('calendar')) return back('error&reason=scope');
      const prev = await getJSON('sys/google/' + st.uid);
      const refresh = j.refresh_token || (prev && prev.refresh);
      if (!refresh) return back('error&reason=norefresh');
      await putJSON('sys/google/' + st.uid, { refresh, linkedMs: Date.now() });
      tokenCache.set(st.uid, { token: j.access_token, exp: Date.now() + (j.expires_in || 3000) * 1000 });
      return back('linked');
    }

    // everything below needs a signed-in user
    const uid = await auth(req);

    if (route === 'me') return json({ uid });

    if (route === 'profiles' && req.method === 'POST') {
      const { uids } = await req.json();
      const out = {};
      for (const u of (Array.isArray(uids) ? uids : []).slice(0, 100)) {
        if (!/^[a-f0-9]{8,64}$/.test(u)) continue;
        const p = await getJSON('sys/names/' + u);
        if (p) out[u] = { name: p.name, color: p.color };
      }
      return json(out);
    }

    if (route === 'search') {
      const q = (url.searchParams.get('q') || '').trim().toLowerCase();
      const { blobs } = await store().list({ prefix: 'sys/names/' });
      const rows = await Promise.all(blobs.slice(0, 500).map(async (b) => ({ id: b.key.slice('sys/names/'.length), p: await getJSON(b.key) })));
      const list = rows.filter((r) => r.p && (!q || r.p.lower.includes(q))).sort((a, b) => a.p.lower.localeCompare(b.p.lower)).slice(0, 20)
        .map((r) => ({ id: r.id, name: r.p.name, color: r.p.color }));
      return json(list);
    }

    if (route === 'db/poll' && req.method === 'POST') {
      const { subs } = await req.json();
      const results = {};
      await Promise.all((Array.isArray(subs) ? subs : []).slice(0, 40).map(async (sub) => {
        try {
          const r = await readSub(sub, uid);
          const h = sha(JSON.stringify(r)).slice(0, 16);
          results[sub.id] = h === sub.h ? { same: true } : { ...r, h };
        } catch (e) { results[sub.id] = { error: { code: e.code || 'error', message: e.message } }; }
      }));
      return json({ results });
    }

    if (route.startsWith('db/') && req.method === 'POST') {
      const op = route.slice(3);
      const body = await req.json().catch(() => ({}));
      const path = cleanPath(body.path);
      if (!isDocPath(path)) throw new HttpError(400, 'bad_path');
      const existing = await getJSON(path);

      if (op === 'get') {
        if (existing && !canRead(path, uid, existing, false)) return json({ exists: false });
        return json({ exists: !!existing, data: existing || null });
      }
      if (op === 'delete') {
        if (!existing) { if (segs(path)[2] !== 'ev') return json({ ok: true }); }
        if (!(await canWrite('delete', path, uid, existing, null))) throw new HttpError(403, 'invalid_argument', 'Not allowed');
        if (existing) await delKey(path);
        if (segs(path)[0] === 'cals' && segs(path).length === 2) await cascadeDeleteCal(segs(path)[1]);
        return json({ ok: true });
      }
      if (op === 'set' || op === 'update') {
        const data = body.data;
        checkData(data);
        if (op === 'update' && !existing) throw new HttpError(404, 'not_found', 'Document does not exist');
        if (!(await canWrite(op, path, uid, existing, data))) throw new HttpError(403, 'invalid_argument', 'Not allowed');
        let next = op === 'set' ? data : deepMerge(existing, data);
        if (existing && existing.owner && segs(path).length === 2) next.owner = existing.owner;
        await putJSON(path, next);
        return json({ ok: true });
      }
    }

    if (route === 'google/status') return json({ configured: gConfigured(), linked: !!(await getJSON('sys/google/' + uid)) });
    if (route === 'google/start' && req.method === 'POST') {
      if (!gConfigured()) throw new HttpError(400, 'web_not_configured');
      const state = rid(16);
      await putJSON('sys/gstate/' + state, { uid, exp: Date.now() + 10 * 60 * 1000 });
      const q = new URLSearchParams({
        client_id: GOOGLE().id, redirect_uri: redirectUri(req), response_type: 'code',
        scope: 'https://www.googleapis.com/auth/calendar.readonly', access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state,
      });
      return json({ url: 'https://accounts.google.com/o/oauth2/v2/auth?' + q });
    }
    if (route === 'google/call' && req.method === 'POST') {
      if (!gConfigured()) throw new HttpError(400, 'web_not_configured');
      const { tool, input } = await req.json();
      return json({ payload: await gCall(uid, String(tool), input) });
    }
    if (route === 'google/disconnect' && req.method === 'POST') {
      const rec = await getJSON('sys/google/' + uid);
      tokenCache.delete(uid);
      if (rec && rec.refresh) {
        await delKey('sys/google/' + uid);
        await fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(rec.refresh), { method: 'POST' }).catch(() => {});
      }
      return json({ ok: true });
    }

    return fail(404, 'not_found');
  } catch (e) {
    if (e instanceof HttpError) return fail(e.status, e.code, e.message);
    console.error(e);
    return fail(500, 'error', 'Server error');
  }
};

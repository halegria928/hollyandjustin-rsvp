'use strict';
const express = require('express');
const path = require('path');
const fs = require('fs');
const { Pool } = require('pg');
const crypto = require('crypto');
const archiver = require('archiver');

const PORT = process.env.PORT || 8080;
const DEFAULT_PASSWORD = process.env.PORTAL_PASSWORD || 'Hacienda-0313';
const LOOKS = [
  { id: 'blush', file: 'index.html', title: 'Blush' }, { id: 'rose', file: 'rose.html', title: 'Rose' }, { id: 'bouquet', file: 'bouquet.html', title: 'Blush Bouquet' }, { id: 'lace', file: 'lace.html', title: 'Blush Lace' }, { id: 'mauve', file: 'mauve.html', title: 'Mauve Roses' }, { id: 'together', file: 'together.html', title: 'Holly & Justin' },
  { id: 'hacienda-dark', file: 'hacienda-dark.html', title: 'Hacienda Dark' }, { id: 'hacienda-light', file: 'hacienda-light.html', title: 'Hacienda' },
  { id: 'shore-dark', file: 'shore-dark.html', title: 'Shore Dark' }, { id: 'shore-light', file: 'shore-light.html', title: 'Shore' }
];
const OPTIONS = {
  likelihood: ['Unknown', 'Likely', '50-50', 'Leaning no'], lodging: ['Unsure', 'Villa', 'Off-site'],
  offsite: ['Catalonia Riviera Maya', 'Dreams Aventuras Riviera Maya', 'Puerto Aventuras Beach Condos', 'Other'],
  guestType: ['Adult', 'Adult child', 'Child'], tier: ['A', 'B', 'C']
};

function dbConfig() {
  const raw = process.env.DATABASE_URL || 'postgres://localhost/hj_test';
  let url; try { url = new URL(raw); } catch (e) { return { connectionString: raw }; }
  const local = /^(localhost|127\.0\.0\.1)$/.test(url.hostname);
  url.searchParams.delete('sslmode');
  const ssl = local ? false : (process.env.DB_CA_CERT ? { ca: process.env.DB_CA_CERT, rejectUnauthorized: true } : { rejectUnauthorized: false });
  return { connectionString: url.toString(), ssl };
}
const pool = new Pool(dbConfig());
const q = (text, params) => pool.query(text, params);

// One-time bootstrap: when the app is connected as the cluster admin, hand this database to the
// low-privilege 'wedding' user so the app can run as that user afterwards. Skipped/harmless otherwise.
async function bootstrapPrivileges() {
  const who = (await q('SELECT current_user AS u, current_database() AS d')).rows[0];
  if (who.u === 'wedding') return;
  const tryq = async sql => { try { await q(sql); } catch (e) { console.log('bootstrap skip:', sql.slice(0, 40), '-', e.message); } };
  await tryq(`ALTER DATABASE "${who.d}" OWNER TO wedding`);
  await tryq('GRANT ALL ON SCHEMA public TO wedding');
  await tryq('GRANT ALL ON ALL TABLES IN SCHEMA public TO wedding');
  await tryq('GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO wedding');
  for (const t of ['households', 'guests', 'responses', 'matches', 'settings', 'photos', 'users', 'activity']) await tryq(`ALTER TABLE IF EXISTS ${t} OWNER TO wedding`);
}
async function init() {
  await bootstrapPrivileges();
  await q(`CREATE TABLE IF NOT EXISTS households (
    id serial PRIMARY KEY, name text NOT NULL DEFAULT '', tier text NOT NULL DEFAULT 'A', invited boolean NOT NULL DEFAULT true,
    plus_one boolean NOT NULL DEFAULT false, likelihood text NOT NULL DEFAULT 'Unknown', notes text NOT NULL DEFAULT '',
    lodging text NOT NULL DEFAULT 'Unsure', room text NOT NULL DEFAULT '', headcount integer, room_charge numeric, food_charge numeric,
    offsite_place text NOT NULL DEFAULT '', offsite_details text NOT NULL DEFAULT '', created timestamptz NOT NULL DEFAULT now())`);
  await q(`ALTER TABLE households ADD COLUMN IF NOT EXISTS priority integer NOT NULL DEFAULT 1000000`);
  await q(`ALTER TABLE households ADD COLUMN IF NOT EXISTS paid numeric`);
  await q(`ALTER TABLE households ADD COLUMN IF NOT EXISTS billing text NOT NULL DEFAULT 'charged'`);
  await q(`CREATE TABLE IF NOT EXISTS guests (id serial PRIMARY KEY, household_id integer NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    name text NOT NULL, type text NOT NULL DEFAULT 'Adult', phone text NOT NULL DEFAULT '', pos integer NOT NULL DEFAULT 0)`);
  await q(`ALTER TABLE guests ADD COLUMN IF NOT EXISTS room integer`);
  await q(`ALTER TABLE households ADD COLUMN IF NOT EXISTS address text NOT NULL DEFAULT ''`);
  await q(`ALTER TABLE guests ADD COLUMN IF NOT EXISTS plus_one boolean NOT NULL DEFAULT false`);
  await q(`ALTER TABLE households ADD COLUMN IF NOT EXISTS paid_via text NOT NULL DEFAULT ''`);
  await q(`ALTER TABLE households ADD COLUMN IF NOT EXISTS phone text NOT NULL DEFAULT ''`);
  await q(`ALTER TABLE households ADD COLUMN IF NOT EXISTS email text NOT NULL DEFAULT ''`);
  await q(`CREATE TABLE IF NOT EXISTS responses (id serial PRIMARY KEY, created timestamptz NOT NULL DEFAULT now(), first_name text NOT NULL DEFAULT '',
    last_name text NOT NULL DEFAULT '', attending text NOT NULL DEFAULT '', count text NOT NULL DEFAULT '', others jsonb NOT NULL DEFAULT '[]',
    events text NOT NULL DEFAULT '', note text NOT NULL DEFAULT '', look text NOT NULL DEFAULT '')`);
  await q(`ALTER TABLE responses ADD COLUMN IF NOT EXISTS phone text NOT NULL DEFAULT ''`);
  await q(`ALTER TABLE responses ADD COLUMN IF NOT EXISTS emails text NOT NULL DEFAULT ''`);
  await q(`CREATE TABLE IF NOT EXISTS matches (response_id integer PRIMARY KEY REFERENCES responses(id) ON DELETE CASCADE,
    household_id integer NOT NULL REFERENCES households(id) ON DELETE CASCADE, approved boolean NOT NULL DEFAULT false, method text NOT NULL DEFAULT 'auto')`);
  await q(`CREATE TABLE IF NOT EXISTS settings (key text PRIMARY KEY, value text NOT NULL)`);
  await q(`CREATE TABLE IF NOT EXISTS users (name text PRIMARY KEY, pass text NOT NULL)`);
  await q(`CREATE TABLE IF NOT EXISTS activity (id serial PRIMARY KEY, ts timestamptz NOT NULL DEFAULT now(), actor text NOT NULL DEFAULT '', detail text NOT NULL DEFAULT '')`);
  if (!Number((await q('SELECT COUNT(*) AS c FROM users')).rows[0].c)) {
    const legacy = await getSetting('password', DEFAULT_PASSWORD);
    await q('INSERT INTO users(name,pass) VALUES($1,$2),($3,$4) ON CONFLICT DO NOTHING', ['Holly', hashPw(legacy), 'Haley', hashPw('Alegria-0313')]);
  }
  await q(`CREATE TABLE IF NOT EXISTS photos (id serial PRIMARY KEY, created timestamptz NOT NULL DEFAULT now(),
    uploader text NOT NULL DEFAULT '', visibility text NOT NULL DEFAULT 'public', mime text NOT NULL DEFAULT 'image/jpeg',
    size integer NOT NULL DEFAULT 0, token text NOT NULL, data bytea NOT NULL)`);
  await bootstrapPrivileges();
}
async function getSetting(key, dflt) { const r = await q('SELECT value FROM settings WHERE key=$1', [key]); return r.rows.length ? r.rows[0].value : dflt; }
async function setSetting(key, value) { await q('INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value', [key, value]); }

// ---------- matching (name similarity) ----------
const norm = s => String(s || '').toLowerCase().replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();
function nameScore(a, b) {
  a = norm(a); b = norm(b); if (!a || !b) return 0; if (a === b) return 3;
  const ta = a.split(' '), tb = b.split(' '), fa = ta[0], fb = tb[0], la = ta[ta.length - 1], lb = tb[tb.length - 1];
  let s = 0;
  if (la === lb && ta.length > 1 && tb.length > 1) { s = 1.5; if (fa === fb) s = 2.6; else if (fa[0] === fb[0]) s = 1.9; }
  else if (fa === fb) s = 0.8;
  if (a.includes(b) || b.includes(a)) s = Math.max(s, 2);
  return s;
}
function suggest(resp, households) {
  const names = [resp.name, ...resp.others.map(o => o.name)];
  return households.map(h => {
    let total = 0;
    for (const n of names) { let best = 0; for (const g of h.guests) best = Math.max(best, nameScore(n, g.name)); best = Math.max(best, nameScore(n, h.name) * 0.6); total += best; }
    return { hid: String(h.id), score: Math.round(total * 10) / 10 };
  }).filter(x => x.score >= 1.4).sort((a, b) => b.score - a.score).slice(0, 3);
}

// ---------- data ----------
async function loadAll() {
  const hh = (await q('SELECT * FROM households ORDER BY name')).rows.map(r => ({
    id: String(r.id), name: r.name, tier: r.tier, invited: r.invited, priority: r.priority == null ? 1000000 : r.priority, plusOne: r.plus_one, likelihood: r.likelihood, notes: r.notes, lodging: r.lodging,
    room: r.room, headcount: r.headcount == null ? '' : r.headcount, roomCharge: r.room_charge == null ? '' : Number(r.room_charge),
    foodCharge: r.food_charge == null ? '' : Number(r.food_charge), paid: r.paid == null ? '' : Number(r.paid), billing: r.billing || 'charged', offsitePlace: r.offsite_place, offsiteDetails: r.offsite_details, address: r.address || '', paidVia: r.paid_via || '', phone: r.phone || '', email: r.email || '', guests: []
  }));
  const byId = Object.fromEntries(hh.map(h => [h.id, h]));
  for (const g of (await q('SELECT * FROM guests ORDER BY household_id, pos, id')).rows) { const h = byId[String(g.household_id)]; if (h) h.guests.push({ name: g.name, type: g.type, phone: g.phone, room: g.room == null ? '' : g.room, plusOne: !!g.plus_one }); }
  const responses = (await q('SELECT * FROM responses ORDER BY created DESC')).rows.map(r => ({
    key: String(r.id), ts: r.created, name: (r.first_name + ' ' + r.last_name).trim(), first: r.first_name, last: r.last_name, attending: r.attending, count: r.count,
    others: Array.isArray(r.others) ? r.others : [], events: r.events, note: r.note, look: r.look, phone: r.phone || '', emails: r.emails || ''
  }));
  const matches = {};
  for (const m of (await q('SELECT * FROM matches')).rows) matches[String(m.response_id)] = { hid: String(m.household_id), approved: m.approved, method: m.method };
  const suggestions = {};
  for (const resp of responses) {
    const s = suggest(resp, hh); suggestions[resp.key] = s;
    if (!matches[resp.key] && s.length && s[0].score >= 2.2 && (s.length === 1 || s[0].score - s[1].score >= 0.5)) {
      await q('INSERT INTO matches(response_id,household_id,approved,method) VALUES($1,$2,false,$3) ON CONFLICT DO NOTHING', [Number(resp.key), Number(s[0].hid), 'auto']);
      matches[resp.key] = { hid: s[0].hid, approved: false, method: 'auto' };
    }
  }
  const theme = await getSetting('theme', 'blush');
  let villa = {}; try { villa = JSON.parse(await getSetting('villa', '{}')) || {}; } catch (e) { villa = {}; }
  const activity = (await q('SELECT id, ts, actor, detail FROM activity ORDER BY id DESC LIMIT 150')).rows;
  return { ok: true, households: hh, responses, matches, suggestions, options: OPTIONS, theme, villa, activity, looks: LOOKS.map(l => ({ id: l.id, title: l.title })) };
}
const numOrNull = v => (v === '' || v === null || v === undefined || isNaN(Number(v))) ? null : Number(v);
async function saveHousehold(h) {
  const vals = [h.name || '', OPTIONS.tier.includes(h.tier) ? h.tier : 'A', h.invited !== false, !!h.plusOne, h.likelihood || 'Unknown', h.notes || '', h.lodging || 'Unsure', h.room || '',
    numOrNull(h.headcount), numOrNull(h.roomCharge), numOrNull(h.foodCharge), numOrNull(h.paid), h.billing === 'included' ? 'included' : 'charged', h.offsitePlace || '', h.offsiteDetails || '', String(h.address || '').slice(0, 300), String(h.paidVia || '').slice(0, 120), String(h.phone || '').trim().slice(0, 40), String(h.email || '').trim().slice(0, 120)];
  let id = Number(h.id) || 0;
  if (id) {
    const r = await q(`UPDATE households SET name=$1,tier=$2,invited=$3,plus_one=$4,likelihood=$5,notes=$6,lodging=$7,room=$8,headcount=$9,room_charge=$10,food_charge=$11,paid=$12,billing=$13,offsite_place=$14,offsite_details=$15,address=$16,paid_via=$17,phone=$18,email=$19 WHERE id=$20 RETURNING id`, [...vals, id]);
    if (!r.rows.length) id = 0;
  }
  if (!id) id = (await q(`INSERT INTO households(name,tier,invited,plus_one,likelihood,notes,lodging,room,headcount,room_charge,food_charge,paid,billing,offsite_place,offsite_details,address,paid_via,phone,email) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING id`, vals)).rows[0].id;
  if (Array.isArray(h.guests)) {
    await q('DELETE FROM guests WHERE household_id=$1', [id]);
    let pos = 0;
    for (const g of h.guests) { const name = String(g.name || '').trim(); if (!name) continue; const rm = Number(g.room); await q('INSERT INTO guests(household_id,name,type,phone,pos,room,plus_one) VALUES($1,$2,$3,$4,$5,$6,$7)', [id, name, OPTIONS.guestType.includes(g.type) ? g.type : 'Adult', g.phone || '', pos++, rm >= 1 && rm <= 15 ? rm : null, !!g.plusOne]); }
  }
  return { ok: true, id: String(id) };
}

// ---------- app ----------
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '200kb' }));
const PUB = path.join(__dirname, 'public');

app.get('/', async (req, res, next) => {
  try { const theme = dbReady ? await getSetting('theme', 'blush') : 'blush'; const look = LOOKS.find(l => l.id === theme) || LOOKS[0]; res.set('Cache-Control', 'no-cache'); res.sendFile(path.join(PUB, look.file)); }
  catch (e) { next(e); }
});
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'SAMEORIGIN');
  res.set('Referrer-Policy', 'same-origin');
  if (req.method === 'GET' && req.headers['x-forwarded-proto'] === 'http') return res.redirect(301, 'https://' + req.hostname + req.originalUrl);
  next();
});
app.use((req, res, next) => {
  const ch = process.env.CANONICAL_HOST;
  if (ch && req.method === 'GET' && req.path !== '/healthz' && /ondigitalocean\.app$/.test(req.hostname || '')) {
    return res.redirect(301, 'https://' + ch + req.originalUrl);
  }
  next();
});
app.use(express.static(PUB, { extensions: ['html'] }));

app.post('/api/rsvp', async (req, res) => {
  if (!dbReady) return res.status(503).json({ ok: false, error: 'db_unavailable' });
  const ip = req.ip || ''; rlPush('r:' + ip);
  if (rlCount('r:' + ip, 3600000) > 25) return res.status(429).json({ ok: false, error: 'too_many' });
  try {
    const b = req.body || {};
    const first = String(b.first || '').trim().slice(0, 80), last = String(b.last || '').trim().slice(0, 80), attending = String(b.attending || '').slice(0, 40);
    if (!first || !last || !attending) return res.status(400).json({ ok: false, error: 'missing' });
    const others = (Array.isArray(b.others) ? b.others : []).slice(0, 12).map(o => ({ name: String(o.name || '').trim().slice(0, 80), type: OPTIONS.guestType.includes(o.type) ? o.type : 'Adult' })).filter(o => o.name);
    const events = (Array.isArray(b.events) ? b.events : []).map(e => String(e).slice(0, 80)).join('; ');
    const phone = String(b.phone || '').trim().slice(0, 40);
    const emails = (Array.isArray(b.emails) ? b.emails : []).map(e => String(e || '').trim().slice(0, 120)).filter(e => /.+@.+\..+/.test(e)).slice(0, 4).join('; ');
    const r = await q('INSERT INTO responses(first_name,last_name,attending,count,others,events,note,look,phone,emails) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id',
      [first, last, attending, String(b.count || '').slice(0, 40), JSON.stringify(others), events, String(b.note || '').slice(0, 2000), String(b.look || '').slice(0, 40), phone, emails]);
    res.json({ ok: true, id: r.rows[0].id });
  } catch (e) { console.error(e); res.status(500).json({ ok: false, error: 'server' }); }
});


// ---------- photos ----------
const PHOTO_MAX = 8 * 1024 * 1024, PHOTO_TOTAL_MAX = 8 * 1024 * 1024 * 1024;
app.post('/api/photos', express.raw({ type: 'image/*', limit: '9mb' }), async (req, res) => {
  if (!dbReady) return res.status(503).json({ ok: false, error: 'db_unavailable' });
  try {
    const bytes = req.body;
    if (!Buffer.isBuffer(bytes) || !bytes.length) return res.status(400).json({ ok: false, error: 'no_image' });
    if (bytes.length > PHOTO_MAX) return res.status(413).json({ ok: false, error: 'too_large' });
    const mime = String(req.headers['content-type'] || 'image/jpeg').split(';')[0];
    if (!/^image\//.test(mime)) return res.status(400).json({ ok: false, error: 'not_image' });
    const uploader = decodeURIComponent(String(req.headers['x-uploader'] || '')).slice(0, 80);
    const visibility = String(req.headers['x-visibility']) === 'couple' ? 'couple' : 'public';
    const total = Number((await q('SELECT COALESCE(SUM(size),0) AS t FROM photos')).rows[0].t);
    if (total + bytes.length > PHOTO_TOTAL_MAX) return res.status(507).json({ ok: false, error: 'album_full' });
    const token = crypto.randomBytes(12).toString('hex');
    const r = await q('INSERT INTO photos(uploader,visibility,mime,size,token,data) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',
      [uploader, visibility, mime, bytes.length, token, bytes]);
    res.json({ ok: true, id: r.rows[0].id, token });
  } catch (e) { console.error(e); res.status(500).json({ ok: false, error: 'server' }); }
});
app.get('/api/photos', async (req, res) => {
  if (!dbReady) return res.status(503).json({ ok: false, error: 'db_unavailable' });
  try {
    const r = await q(`SELECT id, uploader, created, token FROM photos WHERE visibility='public' ORDER BY created DESC LIMIT 800`);
    res.json({ ok: true, photos: r.rows });
  } catch (e) { console.error(e); res.status(500).json({ ok: false, error: 'server' }); }
});
app.get('/photo/:id/:token', async (req, res) => {
  if (!dbReady) return res.status(503).end();
  try {
    const r = await q('SELECT mime, data FROM photos WHERE id=$1 AND token=$2', [Number(req.params.id) || 0, String(req.params.token)]);
    if (!r.rows.length) return res.status(404).end();
    res.set('Content-Type', r.rows[0].mime).set('Cache-Control', 'public, max-age=86400').send(r.rows[0].data);
  } catch (e) { console.error(e); res.status(500).end(); }
});
function pwMatch(given, actual) {
  const norm = v => String(v == null ? '' : v).trim().replace(/[\u2010\u2011\u2012\u2013\u2014\u2212]/g, '-').toLowerCase();
  return norm(given) === norm(actual) && norm(given).length > 0;
}
const normPw = v => String(v == null ? '' : v).trim().replace(/[\u2010\u2011\u2012\u2013\u2014\u2212]/g, '-').toLowerCase();
function hashPw(pw) { const salt = crypto.randomBytes(12).toString('hex'); return 'scrypt:' + salt + ':' + crypto.scryptSync(normPw(pw), salt, 32).toString('hex'); }
async function matchUser(given) {
  const g = normPw(given); if (!g) return null;
  const rows = (await q('SELECT name, pass FROM users ORDER BY name')).rows;
  for (const u of rows) {
    if (String(u.pass).startsWith('scrypt:')) {
      const p = u.pass.split(':');
      try { if (crypto.timingSafeEqual(crypto.scryptSync(g, p[1], 32), Buffer.from(p[2], 'hex'))) return u.name; } catch (e) {}
    } else if (pwMatch(given, u.pass)) {
      try { await q('UPDATE users SET pass=$1 WHERE name=$2', [hashPw(u.pass), u.name]); } catch (e) {}
      return u.name;
    }
  }
  return null;
}
const RL = {};
function rlPush(k) { (RL[k] = RL[k] || []).push(Date.now()); }
function rlCount(k, windowMs) { const now = Date.now(); const e = RL[k] = RL[k] || []; while (e.length && now - e[0] > windowMs) e.shift(); return e.length; }
async function copyContact(hid, rid) {
  try {
    const rr = (await q('SELECT phone, emails FROM responses WHERE id=$1', [rid])).rows[0]; if (!rr) return;
    const em = String(rr.emails || '').split(';')[0].trim();
    await q(`UPDATE households SET phone = CASE WHEN phone='' THEN $1 ELSE phone END, email = CASE WHEN email='' THEN $2 ELSE email END WHERE id=$3`, [rr.phone || '', em, hid]);
  } catch (e) { console.error(e); }
}
async function unroomDeclined(actor, hid, rid) {
  try {
    const rr = (await q('SELECT first_name, last_name, attending, others FROM responses WHERE id=$1', [rid])).rows[0];
    if (!rr || !/decline/i.test(rr.attending)) return;
    const names = [(rr.first_name + ' ' + rr.last_name).trim()].concat((Array.isArray(rr.others) ? rr.others : []).map(o => o.name || '')).map(n => n.trim().toLowerCase()).filter(Boolean);
    const hh = (await q('SELECT room FROM households WHERE id=$1', [hid])).rows[0]; if (!hh) return;
    const gs = (await q('SELECT id, name, room FROM guests WHERE household_id=$1', [hid])).rows;
    const famRoom = hh.room ? Number(hh.room) : null;
    const pulled = [];
    for (const g of gs) {
      const isDecl = names.includes((g.name || '').trim().toLowerCase());
      if (!isDecl) continue;
      const eff = g.room != null ? g.room : famRoom;
      if (eff == null) continue;
      if (g.room != null) await q('UPDATE guests SET room=NULL WHERE id=$1', [g.id]);
      pulled.push(g.name);
    }
    if (pulled.length && famRoom) {
      for (const g of gs) {
        const isDecl = names.includes((g.name || '').trim().toLowerCase());
        if (!isDecl && g.room == null) await q('UPDATE guests SET room=$1 WHERE id=$2', [famRoom, g.id]);
      }
      await q(`UPDATE households SET room='' WHERE id=$1`, [hid]);
    }
    if (pulled.length) await logAct(actor, 'removed from their room (declined): ' + pulled.join(', '));
  } catch (e) { console.error(e); }
}
async function logAct(actor, detail) {
  try { await q('INSERT INTO activity(actor,detail) VALUES($1,$2)', [actor, String(detail || '').slice(0, 600)]); } catch (e) { console.error(e); }
}
function normV(v) { if (v === null || v === undefined) return ''; if (typeof v === 'boolean') return v ? 'Y' : 'N'; const n = Number(v); if (v !== '' && !isNaN(n)) return String(n); return String(v).trim(); }
function diffHousehold(cur, curG, h) {
  const parts = [];
  const F = [['name','name'],['tier','tier'],['likelihood',"Holly's guess"],['lodging','lodging'],['room','room'],['billing','billing'],['headcount','heads'],['notes','notes']];
  const map = { name: h.name, tier: h.tier, likelihood: h.likelihood, lodging: h.lodging, room: h.room, billing: h.billing, headcount: h.headcount, notes: h.notes };
  for (const [k, label] of F) { const a = normV(cur[k]), b2 = normV(map[k]); if (a !== b2) parts.push(label + (k === 'notes' ? ' updated' : ' ' + (a || '—') + '→' + (b2 || '—'))); }
  const M2 = [['invited', h.invited, 'invited'], ['plus_one', h.plusOne, 'plus-one']];
  for (const [k, nv, label] of M2) { const a = normV(!!cur[k]), b2 = normV(!!nv); if (a !== b2) parts.push(label + ' ' + a + '→' + b2); }
  const N2 = [['room_charge', h.roomCharge, 'room $'], ['food_charge', h.foodCharge, 'food $'], ['paid', h.paid, 'paid $'], ['offsite_place', h.offsitePlace, 'off-site'], ['offsite_details', h.offsiteDetails, 'off-site details'], ['address', h.address, 'address'], ['paid_via', h.paidVia, 'paid via'], ['phone', h.phone, 'phone'], ['email', h.email, 'email']];
  for (const [k, nv, label] of N2) { const a = normV(cur[k]), b2 = normV(nv); if (a !== b2) parts.push(label + ' ' + (a || '—') + '→' + (b2 || '—')); }
  const curMap = {}; curG.forEach(g => curMap[g.name.trim()] = normV(g.room));
  const newMap = {}; (h.guests || []).forEach(g => { if (g && g.name && g.name.trim()) newMap[g.name.trim()] = normV(g.room); });
  for (const n2 of Object.keys(newMap)) { if (!(n2 in curMap)) parts.push('+' + n2); else if (curMap[n2] !== newMap[n2]) parts.push(n2 + ' Rm ' + (curMap[n2] || '—') + '→' + (newMap[n2] || '—')); }
  for (const n2 of Object.keys(curMap)) if (!(n2 in newMap)) parts.push('removed ' + n2);
  return parts.join(', ');
}
app.post('/api/photos.zip', async (req, res) => {
  if (!dbReady) return res.status(503).json({ ok: false, error: 'db_unavailable' });
  try {
    if (!(await matchUser((req.body || {}).pw))) return res.status(401).json({ ok: false, error: 'bad_password' });
    const ids = (await q('SELECT id FROM photos ORDER BY created')).rows.map(r => r.id);
    res.set('Content-Type', 'application/zip').set('Content-Disposition', 'attachment; filename="holly-justin-photos.zip"');
    const zip = archiver('zip', { zlib: { level: 1 } });
    zip.on('error', e => { console.error(e); try { res.end(); } catch (_) {} });
    zip.pipe(res);
    for (const id of ids) {
      const r = await q('SELECT uploader, visibility, mime, created, data FROM photos WHERE id=$1', [id]);
      if (!r.rows.length) continue;
      const p = r.rows[0];
      const ext = ({ 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'image/gif': 'gif' })[p.mime] || 'jpg';
      const who = (p.uploader || 'guest').replace(/[^A-Za-z0-9 _-]/g, '').trim().replace(/\s+/g, '-') || 'guest';
      zip.append(p.data, { name: `${p.visibility === 'couple' ? 'just-for-you' : 'everyone'}/${String(id).padStart(4, '0')}-${who}.${ext}` });
    }
    await zip.finalize();
  } catch (e) { console.error(e); try { res.status(500).end(); } catch (_) {} }
});

app.post('/api/admin', async (req, res) => {
  const b = req.body || {};
  if (!dbReady) return res.status(503).json({ ok: false, error: 'Database unavailable: ' + dbError });
  try {
    const ip = req.ip || '';
    if (rlCount('af:' + ip, 900000) >= 15) return res.status(429).json({ ok: false, error: 'Too many attempts — wait 15 minutes' });
    const actor = await matchUser(b.pw);
    if (!actor) { rlPush('af:' + ip); return res.status(401).json({ ok: false, error: 'bad_password' }); }
    switch (b.action) {
      case 'login': await logAct(actor, 'logged in'); return res.json({ ok: true, user: actor });
      case 'load': return res.json(await loadAll());
      case 'saveHousehold': {
        const h = b.household || {};
        let detail = '';
        if (h.id) {
          const cur = (await q('SELECT * FROM households WHERE id=$1', [Number(h.id)])).rows[0];
          const curG = (await q('SELECT name, room FROM guests WHERE household_id=$1', [Number(h.id)])).rows;
          if (cur) detail = diffHousehold(cur, curG, h);
          if (detail) detail = 'edited ' + (h.name || cur.name) + ' — ' + detail;
        } else detail = 'added household ' + (h.name || '') + ' (' + ((h.guests || []).length) + ' guests)';
        const out = await saveHousehold(h);
        if (out.ok && detail) await logAct(actor, detail);
        return res.json(out);
      }
      case 'deleteHousehold': {
        const cur = (await q('SELECT name FROM households WHERE id=$1', [Number(b.id)])).rows[0];
        await q('DELETE FROM households WHERE id=$1', [Number(b.id)]);
        await logAct(actor, 'deleted household ' + (cur ? cur.name : '#' + b.id));
        return res.json({ ok: true });
      }
      case 'deleteResponse': {
        const cur = (await q('SELECT first_name,last_name FROM responses WHERE id=$1', [Number(b.key)])).rows[0];
        await q('DELETE FROM responses WHERE id=$1', [Number(b.key)]);
        await logAct(actor, 'deleted the RSVP from ' + (cur ? (cur.first_name + ' ' + cur.last_name).trim() : '#' + b.key));
        return res.json({ ok: true });
      }
      case 'setMatch': {
        const rid = Number(b.key), hid = Number(b.hid);
        const rn = (await q('SELECT first_name,last_name FROM responses WHERE id=$1', [rid])).rows[0];
        const who = rn ? (rn.first_name + ' ' + rn.last_name).trim() : '#' + rid;
        if (!hid) { await q('DELETE FROM matches WHERE response_id=$1', [rid]); await logAct(actor, 'unlinked the RSVP from ' + who); return res.json({ ok: true }); }
        await q('INSERT INTO matches(response_id,household_id,approved,method) VALUES($1,$2,$3,$4) ON CONFLICT (response_id) DO UPDATE SET household_id=EXCLUDED.household_id, approved=EXCLUDED.approved, method=EXCLUDED.method', [rid, hid, !!b.approved, b.method || 'manual']);
        const hn = (await q('SELECT name FROM households WHERE id=$1', [hid])).rows[0];
        if (b.approved) { await copyContact(hid, rid); await unroomDeclined(actor, hid, rid); }
        await logAct(actor, (b.approved ? 'approved' : 'matched') + ' the RSVP from ' + who + ' \u2192 ' + (hn ? hn.name : '#' + hid));
        return res.json({ ok: true });
      }
      case 'reorderBackup': {
        const ids = Array.isArray(b.ids) ? b.ids.map(Number).filter(Boolean) : [];
        for (let i = 0; i < ids.length; i++) await q('UPDATE households SET priority=$1 WHERE id=$2', [i + 1, ids[i]]);
        await logAct(actor, 'reordered the backup list');
        return res.json({ ok: true });
      }
      case 'listPhotos': {
        const r = await q('SELECT id, uploader, created, visibility, size, token FROM photos ORDER BY created DESC LIMIT 2000');
        return res.json({ ok: true, photos: r.rows });
      }
      case 'setPhotoVisibility': {
        const vis = b.visibility === 'couple' ? 'couple' : 'public';
        await q('UPDATE photos SET visibility=$1 WHERE id=$2', [vis, Number(b.id)]); await logAct(actor, 'made a photo ' + (vis === 'couple' ? 'private' : 'public')); return res.json({ ok: true });
      }
      case 'deletePhoto': await q('DELETE FROM photos WHERE id=$1', [Number(b.id)]); await logAct(actor, 'deleted a photo'); return res.json({ ok: true });
      case 'manualRsvp': {
        const hid = Number(b.hid);
        const hh = (await q('SELECT name FROM households WHERE id=$1', [hid])).rows[0];
        if (!hh) return res.json({ ok: false, error: 'no household' });
        const first = String(b.first || '').trim().slice(0, 80), last = String(b.last || '').trim().slice(0, 80);
        if (!first) return res.json({ ok: false, error: 'missing name' });
        const attending = b.attending === 'Regretfully decline' ? 'Regretfully decline' : 'Joyfully accept';
        const others = (Array.isArray(b.others) ? b.others : []).slice(0, 12).map(o => ({ name: String(o.name || '').trim().slice(0, 80), type: OPTIONS.guestType.includes(o.type) ? o.type : 'Adult' })).filter(o => o.name);
        const events = (Array.isArray(b.events) ? b.events : []).map(e => String(e).slice(0, 80)).join('; ');
        const emails = (Array.isArray(b.emails) ? b.emails : []).map(e => String(e || '').trim().slice(0, 120)).filter(e => /.+@.+\..+/.test(e)).slice(0, 4).join('; ');
        const r2 = await q('INSERT INTO responses(first_name,last_name,attending,count,others,events,note,look,phone,emails) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id',
          [first, last, attending, String(b.count || '').slice(0, 40), JSON.stringify(others), events, String(b.note || '').slice(0, 2000), 'manual', String(b.phone || '').trim().slice(0, 40), emails]);
        await q('INSERT INTO matches(response_id,household_id,approved,method) VALUES($1,$2,true,$3) ON CONFLICT (response_id) DO UPDATE SET household_id=EXCLUDED.household_id, approved=true, method=EXCLUDED.method', [r2.rows[0].id, hid, 'manual']);
        await copyContact(hid, r2.rows[0].id);
        await unroomDeclined(actor, hid, r2.rows[0].id);
        await logAct(actor, 'entered an RSVP for ' + (first + ' ' + last).trim() + ' (' + (attending === 'Joyfully accept' ? 'coming' : 'declined') + ') \u2192 ' + hh.name);
        return res.json({ ok: true, id: r2.rows[0].id });
      }
      case 'exportBackup': {
        const data = await loadAll();
        await logAct(actor, 'downloaded a backup');
        return res.json({ ok: true, backup: { exported: new Date().toISOString(), households: data.households, responses: data.responses, matches: data.matches, theme: data.theme, villa: data.villa, activity: data.activity } });
      }
      case 'exportCsv': {
        const data = await loadAll();
        const splitAddr = a => {
          a = String(a || '').trim(); if (!a) return ['', '', '', ''];
          const parts = a.split(',').map(x => x.trim()).filter(Boolean);
          const m = parts.length >= 2 ? parts[parts.length - 1].match(/^([A-Za-z]{2})\.?\s+(\d{5}(?:-\d{4})?)$/) : null;
          if (m) {
            const city = parts.length >= 3 ? parts[parts.length - 2] : '';
            const street = parts.slice(0, Math.max(parts.length - (parts.length >= 3 ? 2 : 1), 0)).join(', ');
            return [street, city, m[1].toUpperCase(), m[2]];
          }
          return [a, '', '', ''];
        };
        const esc = v => { let x = String(v == null ? '' : v); if (/^[=+@]/.test(x) || (/^-/.test(x) && !/^-?\d+(\.\d+)?$/.test(x))) x = "'" + x; return '"' + x.replace(/"/g, '""') + '"'; };
        const rows = [['Household','Tier','Invited','Plus-one OK',"Holly's guess",'RSVP status','Heads coming','Guests (invited)','RSVP names','Phone','Emails','Contact phone','Contact email','Events','Lodging','Villa room','Headcount','Room charge','Food & tips','Billing','Paid','Paid via','Owed','Off-site place','Street','City','State','Zip','Notes']];
        for (const h of data.households) {
          const resps = data.responses.filter(r => data.matches[r.key] && data.matches[r.key].hid === h.id);
          const acc = resps.filter(r => /accept/i.test(r.attending));
          const status = acc.length ? 'Coming' : (resps.some(r => /decline/i.test(r.attending)) ? 'Declined' : 'No reply');
          const heads = acc.reduce((s2, r) => s2 + Math.max(parseInt(r.count, 10) || 0, 1 + r.others.length), 0);
          rows.push([h.name, h.tier, h.invited ? 'Yes' : 'No', h.plusOne ? 'Yes' : 'No', h.likelihood, status, heads || '',
            h.guests.map(g => g.name + (g.type !== 'Adult' ? ' (' + g.type + ')' : '')).join('; '),
            resps.map(r => r.name + (r.others.length ? ' + ' + r.others.map(o => o.name).join(', ') : '')).join(' | '),
            resps.map(r => r.phone).filter(Boolean).join(' | '),
            resps.map(r => r.emails).filter(Boolean).join(' | '), h.phone, h.email,
            resps.map(r => r.events).filter(Boolean).join(' | '), h.lodging, h.room, h.headcount, h.roomCharge, h.foodCharge, h.billing, h.paid, h.paidVia, h.billing === 'included' ? '' : (((Number(h.roomCharge)||0)+(Number(h.foodCharge)||0))-(Number(h.paid)||0) || ''), h.offsitePlace, ...splitAddr(h.address), h.notes]);
        }
        return res.json({ ok: true, csv: rows.map(r => r.map(esc).join(',')).join('\r\n') });
      }
      case 'setVilla': {
        const src = b.villa || {}; const out = { rooms: {} };
        const num = v => (v === '' || v == null || isNaN(Number(v))) ? null : Number(v);
        if (num(src.roomDefault) != null) out.roomDefault = num(src.roomDefault);
        if (num(src.foodPerHead) != null) out.foodPerHead = num(src.foodPerHead);
        const rs = src.rooms || {};
        for (let i = 1; i <= 15; i++) { const r = rs[String(i)]; if (!r) continue; const o = {}; if (r.rollaway) o.rollaway = true; if (num(r.price) != null) o.price = num(r.price); if (typeof r.note === 'string' && r.note.trim()) o.note = String(r.note).trim().slice(0, 140); if (Object.keys(o).length) out.rooms[String(i)] = o; }
        let prev = {}; try { prev = JSON.parse(await getSetting('villa', '{}')) || {}; } catch (e) {}
        const vparts = [];
        if (normV(prev.roomDefault) !== normV(out.roomDefault)) vparts.push('room default $' + (out.roomDefault != null ? out.roomDefault : '\u2014'));
        if (normV(prev.foodPerHead) !== normV(out.foodPerHead)) vparts.push('food/person $' + (out.foodPerHead != null ? out.foodPerHead : '\u2014'));
        for (let i = 1; i <= 15; i++) { const a = JSON.stringify((prev.rooms || {})[String(i)] || {}), b2 = JSON.stringify(out.rooms[String(i)] || {}); if (a !== b2) vparts.push('Room ' + i); }
        await setSetting('villa', JSON.stringify(out));
        if (vparts.length) await logAct(actor, 'villa settings \u2014 ' + vparts.join(', '));
        return res.json({ ok: true });
      }
      case 'setTheme': { if (!LOOKS.some(l => l.id === b.theme)) return res.json({ ok: false, error: 'unknown look' }); await setSetting('theme', b.theme); await logAct(actor, 'set the live design to ' + b.theme); return res.json({ ok: true }); }
      case 'changePassword': { const np = String(b.newPw || '').trim(); if (np.length < 6) return res.json({ ok: false, error: 'Password must be at least 6 characters' }); if (await matchUser(np)) return res.json({ ok: false, error: 'That password is taken \u2014 pick a different one' }); await q('UPDATE users SET pass=$1 WHERE name=$2', [hashPw(np), actor]); await logAct(actor, 'changed their password'); return res.json({ ok: true, user: actor }); }
      default: return res.json({ ok: false, error: 'unknown_action' });
    }
  } catch (e) { console.error(e); res.status(500).json({ ok: false, error: 'server' }); }
});

let dbReady = false, dbError = null;
async function initLoop() {
  try { await init(); dbReady = true; dbError = null; console.log('Database ready'); }
  catch (e) { dbReady = false; dbError = String(e && e.message || e); console.error('DB init failed:', dbError); setTimeout(initLoop, 30000); }
}
app.get('/api/theme', async (req, res) => { try { res.json({ ok: true, theme: dbReady ? await getSetting('theme', 'blush') : 'blush' }); } catch (e) { res.json({ ok: true, theme: 'blush' }); } });
const BOOT = String(Date.now());
app.get('/api/version', (req, res) => res.json({ ok: true, v: BOOT }));
app.get('/healthz', (req, res) => res.json({ ok: dbReady, db: dbReady ? 'ready' : 'unavailable', error: dbError, hasUrl: !!process.env.DATABASE_URL }));
app.listen(PORT, () => { console.log('RSVP site listening on ' + PORT); initLoop(); });

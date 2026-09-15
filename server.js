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
  guestType: ['Adult', 'Teen', 'Child'], tier: ['A', 'B', 'C']
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
  for (const t of ['households', 'guests', 'responses', 'matches', 'settings', 'photos']) await tryq(`ALTER TABLE IF EXISTS ${t} OWNER TO wedding`);
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
  await q(`CREATE TABLE IF NOT EXISTS responses (id serial PRIMARY KEY, created timestamptz NOT NULL DEFAULT now(), first_name text NOT NULL DEFAULT '',
    last_name text NOT NULL DEFAULT '', attending text NOT NULL DEFAULT '', count text NOT NULL DEFAULT '', others jsonb NOT NULL DEFAULT '[]',
    events text NOT NULL DEFAULT '', note text NOT NULL DEFAULT '', look text NOT NULL DEFAULT '')`);
  await q(`ALTER TABLE responses ADD COLUMN IF NOT EXISTS phone text NOT NULL DEFAULT ''`);
  await q(`CREATE TABLE IF NOT EXISTS matches (response_id integer PRIMARY KEY REFERENCES responses(id) ON DELETE CASCADE,
    household_id integer NOT NULL REFERENCES households(id) ON DELETE CASCADE, approved boolean NOT NULL DEFAULT false, method text NOT NULL DEFAULT 'auto')`);
  await q(`CREATE TABLE IF NOT EXISTS settings (key text PRIMARY KEY, value text NOT NULL)`);
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
    foodCharge: r.food_charge == null ? '' : Number(r.food_charge), paid: r.paid == null ? '' : Number(r.paid), billing: r.billing || 'charged', offsitePlace: r.offsite_place, offsiteDetails: r.offsite_details, guests: []
  }));
  const byId = Object.fromEntries(hh.map(h => [h.id, h]));
  for (const g of (await q('SELECT * FROM guests ORDER BY household_id, pos, id')).rows) { const h = byId[String(g.household_id)]; if (h) h.guests.push({ name: g.name, type: g.type, phone: g.phone, room: g.room == null ? '' : g.room }); }
  const responses = (await q('SELECT * FROM responses ORDER BY created DESC')).rows.map(r => ({
    key: String(r.id), ts: r.created, name: (r.first_name + ' ' + r.last_name).trim(), first: r.first_name, last: r.last_name, attending: r.attending, count: r.count,
    others: Array.isArray(r.others) ? r.others : [], events: r.events, note: r.note, look: r.look, phone: r.phone || ''
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
  return { ok: true, households: hh, responses, matches, suggestions, options: OPTIONS, theme, looks: LOOKS.map(l => ({ id: l.id, title: l.title })) };
}
const numOrNull = v => (v === '' || v === null || v === undefined || isNaN(Number(v))) ? null : Number(v);
async function saveHousehold(h) {
  const vals = [h.name || '', OPTIONS.tier.includes(h.tier) ? h.tier : 'A', h.invited !== false, !!h.plusOne, h.likelihood || 'Unknown', h.notes || '', h.lodging || 'Unsure', h.room || '',
    numOrNull(h.headcount), numOrNull(h.roomCharge), numOrNull(h.foodCharge), numOrNull(h.paid), h.billing === 'included' ? 'included' : 'charged', h.offsitePlace || '', h.offsiteDetails || ''];
  let id = Number(h.id) || 0;
  if (id) {
    const r = await q(`UPDATE households SET name=$1,tier=$2,invited=$3,plus_one=$4,likelihood=$5,notes=$6,lodging=$7,room=$8,headcount=$9,room_charge=$10,food_charge=$11,paid=$12,billing=$13,offsite_place=$14,offsite_details=$15 WHERE id=$16 RETURNING id`, [...vals, id]);
    if (!r.rows.length) id = 0;
  }
  if (!id) id = (await q(`INSERT INTO households(name,tier,invited,plus_one,likelihood,notes,lodging,room,headcount,room_charge,food_charge,paid,billing,offsite_place,offsite_details) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`, vals)).rows[0].id;
  if (Array.isArray(h.guests)) {
    await q('DELETE FROM guests WHERE household_id=$1', [id]);
    let pos = 0;
    for (const g of h.guests) { const name = String(g.name || '').trim(); if (!name) continue; const rm = Number(g.room); await q('INSERT INTO guests(household_id,name,type,phone,pos,room) VALUES($1,$2,$3,$4,$5,$6)', [id, name, OPTIONS.guestType.includes(g.type) ? g.type : 'Adult', g.phone || '', pos++, rm >= 1 && rm <= 15 ? rm : null]); }
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
  const ch = process.env.CANONICAL_HOST;
  if (ch && req.method === 'GET' && req.path !== '/healthz' && /ondigitalocean\.app$/.test(req.hostname || '')) {
    return res.redirect(301, 'https://' + ch + req.originalUrl);
  }
  next();
});
app.use(express.static(PUB, { extensions: ['html'] }));

app.post('/api/rsvp', async (req, res) => {
  if (!dbReady) return res.status(503).json({ ok: false, error: 'db_unavailable' });
  try {
    const b = req.body || {};
    const first = String(b.first || '').trim().slice(0, 80), last = String(b.last || '').trim().slice(0, 80), attending = String(b.attending || '').slice(0, 40);
    if (!first || !last || !attending) return res.status(400).json({ ok: false, error: 'missing' });
    const others = (Array.isArray(b.others) ? b.others : []).slice(0, 12).map(o => ({ name: String(o.name || '').trim().slice(0, 80), type: OPTIONS.guestType.includes(o.type) ? o.type : 'Adult' })).filter(o => o.name);
    const events = (Array.isArray(b.events) ? b.events : []).map(e => String(e).slice(0, 80)).join('; ');
    const phone = String(b.phone || '').trim().slice(0, 40);
    const r = await q('INSERT INTO responses(first_name,last_name,attending,count,others,events,note,look,phone) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id',
      [first, last, attending, String(b.count || '').slice(0, 40), JSON.stringify(others), events, String(b.note || '').slice(0, 2000), String(b.look || '').slice(0, 40), phone]);
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
app.post('/api/photos.zip', async (req, res) => {
  if (!dbReady) return res.status(503).json({ ok: false, error: 'db_unavailable' });
  try {
    const pw = await getSetting('password', DEFAULT_PASSWORD);
    if (String((req.body || {}).pw || '') !== pw) return res.status(401).json({ ok: false, error: 'bad_password' });
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
    const pw = await getSetting('password', DEFAULT_PASSWORD);
    if (String(b.pw || '') !== pw) return res.status(401).json({ ok: false, error: 'bad_password' });
    switch (b.action) {
      case 'login': return res.json({ ok: true });
      case 'load': return res.json(await loadAll());
      case 'saveHousehold': return res.json(await saveHousehold(b.household || {}));
      case 'deleteHousehold': await q('DELETE FROM households WHERE id=$1', [Number(b.id)]); return res.json({ ok: true });
      case 'deleteResponse': await q('DELETE FROM responses WHERE id=$1', [Number(b.key)]); return res.json({ ok: true });
      case 'setMatch': {
        const rid = Number(b.key), hid = Number(b.hid);
        if (!hid) { await q('DELETE FROM matches WHERE response_id=$1', [rid]); return res.json({ ok: true }); }
        await q('INSERT INTO matches(response_id,household_id,approved,method) VALUES($1,$2,$3,$4) ON CONFLICT (response_id) DO UPDATE SET household_id=EXCLUDED.household_id, approved=EXCLUDED.approved, method=EXCLUDED.method', [rid, hid, !!b.approved, b.method || 'manual']);
        return res.json({ ok: true });
      }
      case 'reorderBackup': {
        const ids = Array.isArray(b.ids) ? b.ids.map(Number).filter(Boolean) : [];
        for (let i = 0; i < ids.length; i++) await q('UPDATE households SET priority=$1 WHERE id=$2', [i + 1, ids[i]]);
        return res.json({ ok: true });
      }
      case 'listPhotos': {
        const r = await q('SELECT id, uploader, created, visibility, size, token FROM photos ORDER BY created DESC LIMIT 2000');
        return res.json({ ok: true, photos: r.rows });
      }
      case 'setPhotoVisibility': {
        const vis = b.visibility === 'couple' ? 'couple' : 'public';
        await q('UPDATE photos SET visibility=$1 WHERE id=$2', [vis, Number(b.id)]); return res.json({ ok: true });
      }
      case 'deletePhoto': await q('DELETE FROM photos WHERE id=$1', [Number(b.id)]); return res.json({ ok: true });
      case 'exportCsv': {
        const data = await loadAll();
        const esc = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
        const rows = [['Household','Tier','Invited','Plus-one OK',"Holly's guess",'RSVP status','Heads coming','Guests (invited)','RSVP names','Phone','Events','Lodging','Villa room','Headcount','Room charge','Food & tips','Billing','Paid','Owed','Off-site place','Notes']];
        for (const h of data.households) {
          const resps = data.responses.filter(r => data.matches[r.key] && data.matches[r.key].hid === h.id);
          const acc = resps.filter(r => /accept/i.test(r.attending));
          const status = acc.length ? 'Coming' : (resps.some(r => /decline/i.test(r.attending)) ? 'Declined' : 'No reply');
          const heads = acc.reduce((s2, r) => s2 + Math.max(parseInt(r.count, 10) || 0, 1 + r.others.length), 0);
          rows.push([h.name, h.tier, h.invited ? 'Yes' : 'No', h.plusOne ? 'Yes' : 'No', h.likelihood, status, heads || '',
            h.guests.map(g => g.name + (g.type !== 'Adult' ? ' (' + g.type + ')' : '')).join('; '),
            resps.map(r => r.name + (r.others.length ? ' + ' + r.others.map(o => o.name).join(', ') : '')).join(' | '),
            resps.map(r => r.phone).filter(Boolean).join(' | '),
            resps.map(r => r.events).filter(Boolean).join(' | '), h.lodging, h.room, h.headcount, h.roomCharge, h.foodCharge, h.billing, h.paid, h.billing === 'included' ? '' : (((Number(h.roomCharge)||0)+(Number(h.foodCharge)||0))-(Number(h.paid)||0) || ''), h.offsitePlace, h.notes]);
        }
        return res.json({ ok: true, csv: rows.map(r => r.map(esc).join(',')).join('\r\n') });
      }
      case 'setTheme': { if (!LOOKS.some(l => l.id === b.theme)) return res.json({ ok: false, error: 'unknown look' }); await setSetting('theme', b.theme); return res.json({ ok: true }); }
      case 'changePassword': { const np = String(b.newPw || '').trim(); if (np.length < 6) return res.json({ ok: false, error: 'Password must be at least 6 characters' }); await setSetting('password', np); return res.json({ ok: true }); }
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
app.get('/healthz', (req, res) => res.json({ ok: dbReady, db: dbReady ? 'ready' : 'unavailable', error: dbError, hasUrl: !!process.env.DATABASE_URL }));
app.listen(PORT, () => { console.log('RSVP site listening on ' + PORT); initLoop(); });

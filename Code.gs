/** Holly & Justin — RSVP portal backend.
 *  Lives inside the "Holly & Justin | Wedding RSVP (Responses)" spreadsheet.
 *  Deploy as Web app: Execute as Me, Who has access: Anyone.
 *  Run setup() once to create the Households / Guests / Matches tabs.
 */
var INITIAL_PASSWORD = 'Hacienda-0313';
var OPTIONS = {
  likelihood: ['Unknown', 'Likely', '50-50', 'Leaning no'],
  lodging: ['Unsure', 'Villa', 'Off-site'],
  offsite: ['Catalonia Riviera Maya', 'Dreams Aventuras Riviera Maya', 'Puerto Aventuras Beach Condos', 'Other'],
  guestType: ['Adult', 'Child']
};
var H_HEAD = ['ID','Household','Plus-one OK','Likelihood','Notes','Lodging','Villa room','Villa headcount','Room charge','Food charge','Off-site place','Off-site details','Created'];
var G_HEAD = ['Household ID','Name','Type','Phone'];
var M_HEAD = ['Response key','Household ID','Approved','Method'];

function setup() {
  var ss = SpreadsheetApp.getActive();
  ensureSheet_(ss, 'Households', H_HEAD);
  ensureSheet_(ss, 'Guests', G_HEAD);
  ensureSheet_(ss, 'Matches', M_HEAD);
  var p = PropertiesService.getScriptProperties();
  if (!p.getProperty('PORTAL_PASSWORD')) p.setProperty('PORTAL_PASSWORD', INITIAL_PASSWORD);
}
function ensureSheet_(ss, name, head) {
  var sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, head.length).setValues([head]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

function doGet() { return json_({ ok: true, service: 'Holly & Justin RSVP portal' }); }

function doPost(e) {
  try {
    var req = JSON.parse((e.postData && e.postData.contents) || '{}');
    var props = PropertiesService.getScriptProperties();
    var pw = props.getProperty('PORTAL_PASSWORD') || INITIAL_PASSWORD;
    if (String(req.pw) !== pw) return json_({ ok: false, error: 'bad_password' });
    var lock = LockService.getScriptLock(); lock.waitLock(20000);
    try {
      var out;
      switch (req.action) {
        case 'login': out = { ok: true }; break;
        case 'load': out = load_(); break;
        case 'saveHousehold': out = saveHousehold_(req.household || {}); break;
        case 'deleteHousehold': out = deleteHousehold_(req.id); break;
        case 'setMatch': out = setMatch_(req.key, req.hid, req.approved, req.method); break;
        case 'changePassword':
          var np = String(req.newPw || '').trim();
          if (np.length < 6) { out = { ok: false, error: 'Password must be at least 6 characters' }; break; }
          props.setProperty('PORTAL_PASSWORD', np); out = { ok: true }; break;
        default: out = { ok: false, error: 'unknown_action' };
      }
      return json_(out);
    } finally { lock.releaseLock(); }
  } catch (err) { return json_({ ok: false, error: String(err) }); }
}
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

function readRows_(name) {
  var sh = SpreadsheetApp.getActive().getSheetByName(name);
  if (!sh || sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, Math.max(sh.getLastColumn(), 4)).getValues();
}
function yes_(v) { return v === true || String(v).toUpperCase() === 'Y' || String(v).toUpperCase() === 'TRUE'; }
function num_(v) { return (v === '' || v === null || v === undefined) ? '' : Number(v); }

function load_() {
  var households = readRows_('Households').filter(function (r) { return r[0]; }).map(function (r) {
    return { id: String(r[0]), name: String(r[1] || ''), plusOne: yes_(r[2]), likelihood: String(r[3] || 'Unknown'),
      notes: String(r[4] || ''), lodging: String(r[5] || 'Unsure'), room: String(r[6] || ''), headcount: num_(r[7]),
      roomCharge: num_(r[8]), foodCharge: num_(r[9]), offsitePlace: String(r[10] || ''), offsiteDetails: String(r[11] || ''), guests: [] };
  });
  var byId = {}; households.forEach(function (h) { byId[h.id] = h; });
  readRows_('Guests').forEach(function (r) {
    var h = byId[String(r[0])];
    if (h && r[1]) h.guests.push({ name: String(r[1]), type: String(r[2] || 'Adult'), phone: String(r[3] || '') });
  });
  var responses = readResponses_();
  var matches = {};
  readRows_('Matches').forEach(function (r) {
    if (r[0]) matches[String(r[0])] = { hid: String(r[1] || ''), approved: yes_(r[2]), method: String(r[3] || 'manual') };
  });
  var suggestions = {};
  responses.forEach(function (resp) {
    var s = suggest_(resp, households);
    suggestions[resp.key] = s;
    // Auto-match confident guesses so status updates immediately; Holly still reviews/approves.
    if (!matches[resp.key] && s.length && s[0].score >= 2.2 && (s.length === 1 || s[0].score - s[1].score >= 0.5)) {
      setMatch_(resp.key, s[0].hid, false, 'auto');
      matches[resp.key] = { hid: s[0].hid, approved: false, method: 'auto' };
    }
  });
  return { ok: true, households: households, responses: responses, matches: matches, suggestions: suggestions, options: OPTIONS };
}

function readResponses_() {
  var sh = SpreadsheetApp.getActive().getSheetByName('Form Responses 1');
  if (!sh || sh.getLastRow() < 2) return [];
  var vals = sh.getRange(1, 1, sh.getLastRow(), sh.getLastColumn()).getValues();
  var head = vals[0].map(function (h) { return String(h).toLowerCase(); });
  var col = function (p) { for (var i = 0; i < head.length; i++) if (head[i].indexOf(p) === 0) return i; return -1; };
  var cName = col('your full name'), cAtt = col('will you be attending'), cCnt = col('total number'),
      cOth = col('names of the other'), cEv = col('which weekend'), cDiet = col('any dietary'), cNote = col('a note');
  var out = [];
  for (var r = 1; r < vals.length; r++) {
    var v = vals[r]; if (!v[0] && !v[cName]) continue;
    var ts = v[0] instanceof Date ? v[0].toISOString() : String(v[0]);
    var others = String(cOth >= 0 ? v[cOth] : '').split(/\n/).map(function (s) { return s.trim(); }).filter(Boolean).map(function (s) {
      var m = s.match(/^(.*?)\s*[—–-]\s*(adult|child)\s*$/i);
      return m ? { name: m[1].trim(), type: m[2].charAt(0).toUpperCase() + m[2].slice(1).toLowerCase() } : { name: s, type: 'Adult' };
    });
    out.push({ key: ts + '|' + String(v[cName]), ts: ts, name: String(v[cName]), attending: String(cAtt >= 0 ? v[cAtt] : ''),
      count: String(cCnt >= 0 ? v[cCnt] : ''), others: others, events: String(cEv >= 0 ? v[cEv] : ''),
      dietary: String(cDiet >= 0 ? v[cDiet] : ''), note: String(cNote >= 0 ? v[cNote] : '') });
  }
  return out;
}

function norm_(s) { return String(s || '').toLowerCase().replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim(); }
function nameScore_(a, b) {
  a = norm_(a); b = norm_(b); if (!a || !b) return 0; if (a === b) return 3;
  var ta = a.split(' '), tb = b.split(' '), fa = ta[0], fb = tb[0], la = ta[ta.length - 1], lb = tb[tb.length - 1];
  var s = 0;
  if (la === lb && ta.length > 1 && tb.length > 1) { s = 1.5; if (fa === fb) s = 2.6; else if (fa[0] === fb[0]) s = 1.9; }
  else if (fa === fb) s = 0.8;
  if (a.indexOf(b) >= 0 || b.indexOf(a) >= 0) s = Math.max(s, 2);
  return s;
}
function suggest_(resp, households) {
  var names = [resp.name].concat(resp.others.map(function (o) { return o.name; }));
  return households.map(function (h) {
    var total = 0;
    names.forEach(function (n) {
      var best = 0;
      h.guests.forEach(function (g) { best = Math.max(best, nameScore_(n, g.name)); });
      best = Math.max(best, nameScore_(n, h.name) * 0.6);
      total += best;
    });
    return { hid: h.id, score: Math.round(total * 10) / 10 };
  }).filter(function (x) { return x.score >= 1.4; }).sort(function (a, b) { return b.score - a.score; }).slice(0, 3);
}

function saveHousehold_(h) {
  var ss = SpreadsheetApp.getActive(), sh = ss.getSheetByName('Households'), gs = ss.getSheetByName('Guests');
  var rows = readRows_('Households'); var id = String(h.id || '').trim(); var rowIdx = -1;
  if (id) for (var i = 0; i < rows.length; i++) if (String(rows[i][0]) === id) { rowIdx = i + 2; break; }
  if (!id || rowIdx < 0) {
    var max = 0; rows.forEach(function (r) { var m = String(r[0]).match(/^H(\d+)$/); if (m) max = Math.max(max, Number(m[1])); });
    id = 'H' + ('000' + (max + 1)).slice(-3); rowIdx = -1;
  }
  var line = [id, h.name || '', h.plusOne ? 'Y' : 'N', h.likelihood || 'Unknown', h.notes || '', h.lodging || 'Unsure', h.room || '',
    num_(h.headcount), num_(h.roomCharge), num_(h.foodCharge), h.offsitePlace || '', h.offsiteDetails || '', rowIdx > 0 ? rows[rowIdx - 2][12] : new Date()];
  if (rowIdx > 0) sh.getRange(rowIdx, 1, 1, line.length).setValues([line]); else sh.appendRow(line);
  if (h.guests) {
    var keep = readRows_('Guests').filter(function (r) { return r[0] && String(r[0]) !== id; }).map(function (r) { return [r[0], r[1], r[2], r[3]]; });
    var mine = h.guests.filter(function (g) { return g.name && String(g.name).trim(); }).map(function (g) { return [id, String(g.name).trim(), g.type || 'Adult', g.phone || '']; });
    var all = keep.concat(mine);
    if (gs.getLastRow() > 1) gs.getRange(2, 1, gs.getLastRow() - 1, Math.max(gs.getLastColumn(), 4)).clearContent();
    if (all.length) gs.getRange(2, 1, all.length, 4).setValues(all);
  }
  return { ok: true, id: id };
}

function deleteHousehold_(id) {
  id = String(id || ''); if (!id) return { ok: false, error: 'no id' };
  var ss = SpreadsheetApp.getActive();
  [['Households', 0], ['Guests', 0], ['Matches', 1]].forEach(function (pair) {
    var sh = ss.getSheetByName(pair[0]); if (!sh || sh.getLastRow() < 2) return;
    var vals = sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).getValues();
    for (var r = vals.length - 1; r >= 0; r--) if (String(vals[r][pair[1]]) === id) sh.deleteRow(r + 2);
  });
  return { ok: true };
}

function setMatch_(key, hid, approved, method) {
  var sh = SpreadsheetApp.getActive().getSheetByName('Matches'); key = String(key || ''); hid = String(hid || '');
  var rows = readRows_('Matches'); var idx = -1;
  for (var i = 0; i < rows.length; i++) if (String(rows[i][0]) === key) { idx = i + 2; break; }
  if (!hid) { if (idx > 0) sh.deleteRow(idx); return { ok: true }; }
  var line = [key, hid, approved ? 'Y' : 'N', method || 'manual'];
  if (idx > 0) sh.getRange(idx, 1, 1, 4).setValues([line]); else sh.appendRow(line);
  return { ok: true };
}

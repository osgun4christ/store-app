/* Store Manager PWA — offline-first POS, stock, credit and dual-currency accounting.
 * Talks to the Apps Script backend (Api.gs). No build step, no libraries.
 */
'use strict';

const APP_VERSION = '1.2.0';
const PIN_ROUNDS_DEFAULT = 100;
const ICON_SRC = (typeof window !== 'undefined' && window.SM_ICON) || 'icons/icon-192.png';
const AUTO_SYNC_MS = 120000;   // push + pull every 2 minutes while the app is open
const PUSH_BATCH = 50;
// Running inside the Apps Script web app (App.html)? Then talk to the server via google.script.run.
const GAS = typeof google !== 'undefined' && google.script && google.script.run;

/* =====================================================================
 * Storage (IndexedDB key/value)
 * ===================================================================== */
const KV = (() => {
  let dbp;
  const db = () => dbp || (dbp = new Promise((res, rej) => {
    const r = indexedDB.open('store-manager', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
  const tx = async (mode, fn) => {
    const d = await db();
    return new Promise((res, rej) => {
      const t = d.transaction('kv', mode);
      const out = fn(t.objectStore('kv'));
      t.oncomplete = () => res(out && out.result);
      t.onerror = () => rej(t.error);
    });
  };
  // Fallback when IndexedDB is unavailable (some embedded / private browsing contexts): localStorage, then memory.
  const mem = {};
  const ls = {
    get: async (k) => { try { const v = localStorage.getItem('sm:' + k); return v === null ? undefined : JSON.parse(v); } catch (e) { return mem[k]; } },
    set: async (k, v) => { try { localStorage.setItem('sm:' + k, JSON.stringify(v)); } catch (e) { mem[k] = v; } },
    del: async (k) => { try { localStorage.removeItem('sm:' + k); } catch (e) { delete mem[k]; } }
  };
  let useLs = typeof indexedDB === 'undefined';
  const wrap = (name, fn) => async (k, v) => {
    if (useLs) return ls[name](k, v);
    try { return await fn(k, v); } catch (e) { useLs = true; return ls[name](k, v); }
  };
  return {
    get: wrap('get', (k) => tx('readonly', (s) => s.get(k))),
    set: wrap('set', (k, v) => tx('readwrite', (s) => s.put(v, k))),
    del: wrap('del', (k) => tx('readwrite', (s) => s.delete(k)))
  };
})();

/* =====================================================================
 * State
 * ===================================================================== */
const S = {
  cfg: null,        // { url, deviceId, deviceKey, deviceName }
  snap: null,       // last pull from the server
  queue: [],        // [{ rec, status: pending|sent|failed, error, createdAt }]
  journal: [],      // records created on this device (last 500), for history, receipts, shift totals
  session: null,    // { user, permissions, role, token, tokenExp }
  shift: null,      // open shift on this device
  counter: 0,       // receipt counter
  view: 'pos',
  cart: { lines: [], discountUSD: 0, customerId: '' },
  ui: { cat: 'All', q: '', showCart: false, adminTab: null, reportPeriod: 'today', reportStore: 'mine' },
  syncing: false,
  lastSync: null,
  lastError: '',
  admin: null       // cached adminData
};

const persist = {
  queue: () => KV.set('queue', S.queue),
  journal: () => KV.set('journal', S.journal.slice(-500)),
  snap: () => KV.set('snap', S.snap),
  session: () => KV.set('session', S.session),
  misc: () => KV.set('misc', { counter: S.counter, shift: S.shift, lastSync: S.lastSync })
};

/* =====================================================================
 * Helpers
 * ===================================================================== */
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (v) => String(v === undefined || v === null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const num = (v) => { const n = Number(v); return isFinite(n) ? n : 0; };
const r2 = (n) => Math.round((num(n) + Number.EPSILON) * 100) / 100;
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now() + '-' + Math.random().toString(16).slice(2));
const nowISO = () => new Date().toISOString();

/* ---------- icons (inline SVG, stroke style) ---------- */
const ICONS = {
  cart: '<circle cx="9" cy="20" r="1.4"/><circle cx="18" cy="20" r="1.4"/><path d="M2.5 3.5h2.6l2.5 11.6a1.8 1.8 0 0 0 1.8 1.4h8.3a1.8 1.8 0 0 0 1.8-1.4L21 7.5H6"/>',
  box: '<path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="m3 8 9 5 9-5M12 13v8"/>',
  truck: '<path d="M2 6h12v10H2zM14 10h4l3 3v3h-7"/><circle cx="6" cy="18" r="2"/><circle cx="17.5" cy="18" r="2"/>',
  wallet: '<rect x="2.5" y="6" width="19" height="14" rx="2.5"/><path d="M2.5 10.5h19M16 15h2.5M5.5 6l9.5-3 1.2 3"/>',
  users: '<circle cx="9" cy="8" r="3.6"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.6a3.6 3.6 0 0 1 0 6.8M21.5 20a6.5 6.5 0 0 0-4-6"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.2 2"/>',
  chart: '<path d="M3 3v18h18"/><path d="M7.5 16v-3M12 16V9M16.5 16V6"/>',
  sliders: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
  sync: '<path d="M20 11a8 8 0 0 0-14.3-4.6L4 8M4 13a8 8 0 0 0 14.3 4.6L20 16"/><path d="M4 3.5V8h4.5M20 20.5V16h-4.5"/>',
  logout: '<path d="M9 21H5.5A2.5 2.5 0 0 1 3 18.5v-13A2.5 2.5 0 0 1 5.5 3H9"/><path d="m16 17 5-5-5-5M21 12H9"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20.5 20.5-4.3-4.3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>', minus: '<path d="M5 12h14"/>', x: '<path d="M18 6 6 18M6 6l12 12"/>',
  check: '<path d="m4.5 12.5 5 5 10-11"/>', arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12.5A1.5 1.5 0 0 0 8.5 21h7a1.5 1.5 0 0 0 1.5-1.5L18 7M9 7V4h6v3"/>',
  printer: '<path d="M6 9V3h12v6"/><rect x="2.5" y="9" width="19" height="8" rx="2"/><path d="M6 14h12v7H6z"/>',
  tag: '<path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z"/><circle cx="7.5" cy="7.5" r="1.5"/>',
  swap: '<path d="M7 4 3 8l4 4M3 8h14M17 20l4-4-4-4M21 16H7"/>',
  store: '<path d="M3 9.5 4.5 4h15L21 9.5M3 9.5a3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 6 0M4.5 12.5V20h15v-7.5"/><path d="M9.5 20v-5h5v5"/>',
  cash: '<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 9.5v5M18 9.5v5"/>',
  phone: '<rect x="6.5" y="2.5" width="11" height="19" rx="2.5"/><path d="M11 18.5h2"/>',
  book: '<path d="M4 19.5V5a2 2 0 0 1 2-2h14v15H6a2 2 0 0 0-2 2zM4 19.5A2 2 0 0 0 6 21.5h14"/>',
  palette: '<path d="M12 3a9 9 0 0 0 0 18c1.1 0 1.8-.8 1.8-1.8 0-.5-.2-.9-.5-1.2-.3-.3-.5-.7-.5-1.2 0-1 .8-1.8 1.8-1.8H17a4 4 0 0 0 4-4C21 6.6 17 3 12 3z"/><circle cx="7.5" cy="11" r="1"/><circle cx="10" cy="7" r="1"/><circle cx="15" cy="7.5" r="1"/>',
  chat: '<path d="M21 11.5a8.4 8.4 0 0 1-12.4 7.4L3 21l2.1-5.4A8.5 8.5 0 1 1 21 11.5z"/>',
  bag: '<path d="M5 8h14l-1 13H6zM9 8V6a3 3 0 0 1 6 0v2"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-9 9"/>',
  link: '<path d="M10 14a4.5 4.5 0 0 0 6.4 0l3.2-3.2a4.5 4.5 0 0 0-6.4-6.4L12 5.6M14 10a4.5 4.5 0 0 0-6.4 0l-3.2 3.2a4.5 4.5 0 0 0 6.4 6.4l1.2-1.2"/>',
  alert: '<path d="M12 3 2 20h20zM12 10v4M12 17.5v.5"/>'
};
const icon = (name, size) => `<svg class="i ${size || ''}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`;

const fmtUSD = (n) => '$' + num(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtLRD = (n) => 'L$' + Math.round(num(n)).toLocaleString('en-US');
const fmtCur = (n, c) => (c === 'USD' ? fmtUSD(n) : fmtLRD(n));
const fmtQty = (q) => (Math.round(num(q) * 100) / 100).toLocaleString('en-US');
const fmtDate = (d) => { const x = new Date(d); return isNaN(x) ? '' : x.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }); };
const rate = () => num(S.snap && S.snap.rate) || 1;
const toUSD = (amt, cur) => (cur === 'USD' ? num(amt) : num(amt) / rate());
const toLRD = (amt, cur) => (cur === 'LRD' ? num(amt) : num(amt) * rate());
const setting = (k) => { const r = (S.snap && S.snap.settings || []).find((x) => x.Key === k); return r ? r.Value : undefined; };
const bool = (v) => v === true || String(v).toUpperCase() === 'TRUE';
const store = () => (S.snap && S.snap.store) || { Name: 'Store', Code: '', Type: 'SHOP' };
const storeName = (id) => { if (id === 'HQ') return 'Head Office'; const s = (S.snap.stores || []).find((x) => x.StoreID === id); return s ? s.Name : id; };
const can = (p) => !!S.session && (S.session.permissions[0] === '*' || S.session.permissions.indexOf(p) >= 0);
const canAny = (...ps) => ps.some(can);
const isOwner = () => S.session && S.session.role && S.session.role.RoleID === 'OWNER';
const productById = (id) => (S.snap.products || []).find((p) => p.ProductID === id);
const userName = (id) => { const u = (S.snap.users || []).find((x) => x.UserID === id); return u ? u.FullName : id; };
const isYard = (p) => /yard|metre|meter|kg|litre|liter/i.test(p.Unit || '');

async function sha256hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function hashPin(pin, salt) {
  let h = String(pin);
  const rounds = num(S.snap && S.snap.pinRounds) || PIN_ROUNDS_DEFAULT;
  for (let i = 0; i < rounds; i++) h = await sha256hex(salt + ':' + h);
  return h;
}

function toast(msg, kind) {
  const el = document.createElement('div');
  el.className = 'toast ' + (kind || '');
  el.textContent = msg;
  $('#toast-root').appendChild(el);
  setTimeout(() => el.remove(), kind === 'bad' ? 6000 : 3000);
}

/* =====================================================================
 * API
 * ===================================================================== */
function gasCall(payload) {
  return new Promise((resolve, reject) => {
    google.script.run
      .withSuccessHandler((txt) => { try { resolve(JSON.parse(txt)); } catch (e) { reject(Object.assign(new Error('Unexpected server reply'), { code: 'BAD_REPLY' })); } })
      .withFailureHandler((err) => reject(Object.assign(new Error(navigator.onLine ? 'Server error: ' + (err && err.message || err) : 'Cannot reach the server — check the internet connection'), { code: navigator.onLine ? 'SERVER' : 'NETWORK' })))
      .apiCall(JSON.stringify(payload));
  });
}

async function api(action, body = {}, opts = {}) {
  if (GAS) {
    const payload = Object.assign({ action }, body);
    if (S.cfg && S.cfg.deviceId) { payload.deviceId = S.cfg.deviceId; payload.deviceKey = S.cfg.deviceKey; }
    if (opts.token) payload.token = S.session && S.session.token;
    const j = await gasCall(payload);
    if (!j.ok) throw Object.assign(new Error(j.message || j.error), { code: j.error });
    return j;
  }
  const url = (opts.url || (S.cfg && S.cfg.url) || '').trim();
  if (!url) throw Object.assign(new Error('No server address set'), { code: 'NO_URL' });
  const payload = Object.assign({ action }, body);
  if (S.cfg && S.cfg.deviceId) { payload.deviceId = S.cfg.deviceId; payload.deviceKey = S.cfg.deviceKey; }
  if (opts.token) payload.token = S.session && S.session.token;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeout || 60000);
  let res;
  try {
    res = await fetch(url, { method: 'POST', body: JSON.stringify(payload), headers: { 'Content-Type': 'text/plain;charset=utf-8' }, redirect: 'follow', signal: ctrl.signal });
  } catch (e) {
    throw Object.assign(new Error('Cannot reach the server — check the internet connection'), { code: 'NETWORK' });
  } finally { clearTimeout(t); }
  let j;
  try { j = await res.json(); } catch (e) { throw Object.assign(new Error('Server sent an unexpected reply (is the URL the /exec web app address?)'), { code: 'BAD_REPLY' }); }
  if (!j.ok) throw Object.assign(new Error(j.message || j.error), { code: j.error });
  return j;
}

/* online admin call with token; re-login hint when expired */
async function adminCall(action, body) {
  if (!S.session.token || Date.now() > S.session.tokenExp) {
    throw Object.assign(new Error('Online session needed — log out and log in again while connected'), { code: 'AUTH' });
  }
  try { return await api(action, body, { token: true }); }
  catch (e) {
    if (e.code === 'AUTH' || e.code === 'AUTH_EXPIRED') { S.session.token = ''; persist.session(); }
    throw e;
  }
}

/* =====================================================================
 * Offline queue & sync
 * ===================================================================== */
function enqueue(type, data) {
  const rec = Object.assign({ id: uuid(), type, userId: S.session.user.UserID, timestamp: nowISO(), rate: rate() }, data);
  S.queue.push({ rec, status: 'pending', createdAt: rec.timestamp });
  S.journal.push(rec);
  persist.queue(); persist.journal();
  scheduleSync(2500);
  return rec;
}

let syncTimer = null;
function scheduleSync(ms) {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => sync(false), ms);
}

async function sync(manual) {
  if (!S.cfg || S.syncing) return;
  S.syncing = true; renderStatus();
  try {
    const pending = S.queue.filter((q) => q.status === 'pending');
    for (let i = 0; i < pending.length; i += PUSH_BATCH) {
      const batch = pending.slice(i, i + PUSH_BATCH);
      const res = await api('push', { records: batch.map((q) => q.rec) });
      const ok = new Set(res.accepted.concat(res.duplicates));
      const rej = {}; res.rejected.forEach((r) => { rej[r.id] = r; });
      batch.forEach((q) => {
        if (ok.has(q.rec.id)) q.status = 'sent';
        else if (rej[q.rec.id]) { q.status = 'failed'; q.error = rej[q.rec.id].message; }
      });
      await persist.queue();
      if (res.rejected.length) toast(res.rejected.length + ' record(s) were rejected by the server — see Sync', 'bad');
    }
    const snap = await api('pull');
    S.snap = snap;
    S.queue = S.queue.filter((q) => q.status === 'pending' || q.status === 'failed');
    S.lastSync = nowISO(); S.lastError = '';
    await Promise.all([persist.snap(), persist.queue(), persist.misc()]);
    // current user removed or blocked?
    if (S.session && !(snap.users || []).some((u) => u.UserID === S.session.user.UserID && u.Status === 'ACTIVE')) {
      toast('Your account is no longer active on this store', 'bad');
      logout();
    }
    if (manual) toast('Synced', 'ok');
  } catch (e) {
    S.lastError = e.message;
    if (e.code === 'DEVICE_BLOCKED' || e.code === 'DEVICE_AUTH' || e.code === 'STORE_CLOSED') toast(e.message, 'bad');
    else if (manual) toast(e.message, 'bad');
  } finally {
    S.syncing = false;
    render();
  }
}

/* Local view = last server snapshot + effect of records not yet included in it */
function liveRecords() { return S.queue.filter((q) => q.status === 'pending' || q.status === 'sent').map((q) => q.rec); }

function stockMap() {
  const m = {};
  (S.snap.stock || []).forEach((s) => { m[s.ProductID] = num(s.Qty); });
  const my = store().StoreID;
  const add = (pid, q) => { m[pid] = (m[pid] || 0) + q; };
  liveRecords().forEach((r) => {
    if (r.type === 'sale') r.items.forEach((i) => add(i.productId, -num(i.qty)));
    if (r.type === 'stockIntake') r.items.forEach((i) => add(i.productId, num(i.qty)));
    if (r.type === 'stockAdjust') r.items.forEach((i) => add(i.productId, num(i.qty)));
    if (r.type === 'transfer' && r.mode === 'SEND' && r.fromStoreId === my) r.items.forEach((i) => add(i.productId, -num(i.qty)));
    if (r.type === 'transferAction' && (r.action === 'DISPATCH' || r.action === 'RECEIVE')) {
      (r._items || []).forEach((i) => add(i.productId, r.action === 'DISPATCH' ? -num(i.qty) : num(i.qty)));
    }
  });
  return m;
}

function customers() {
  const list = (S.snap.customers || []).map((c) => Object.assign({}, c));
  const byId = {}; list.forEach((c) => { byId[c.CustomerID] = c; });
  liveRecords().forEach((r) => {
    if (r.type === 'customer' && !byId[r.id]) {
      const c = { CustomerID: r.id, Name: r.name, Phone: r.phone || '', Notes: r.notes || '', CreditLimitUSD: r.creditLimitUSD || 0, BalanceUSD: 0, _pending: true };
      list.push(c); byId[c.CustomerID] = c;
    }
  });
  liveRecords().forEach((r) => {
    if (r.type === 'sale' && r.customerId && byId[r.customerId]) {
      r.payments.filter((p) => p.method === 'CREDIT').forEach((p) => { byId[r.customerId].BalanceUSD += toUSDAt(p.amount, p.currency, r.rate); });
    }
    if (r.type === 'customerPayment' && byId[r.customerId]) byId[r.customerId].BalanceUSD -= toUSDAt(r.amount, r.currency, r.rate);
  });
  return list.sort((a, b) => a.Name.localeCompare(b.Name));
}
const toUSDAt = (amt, cur, rt) => (cur === 'USD' ? num(amt) : num(amt) / num(rt || rate()));

function transfers() {
  const list = (S.snap.transfers || []).map((t) => Object.assign({}, t, {
    items: (S.snap.transferItems || []).filter((i) => i.TransferID === t.TransferID).map((i) => Object.assign({}, i))
  }));
  const byId = {}; list.forEach((t) => { byId[t.TransferID] = t; });
  liveRecords().forEach((r) => {
    if (r.type === 'transfer' && !byId[r.id]) {
      const t = { TransferID: r.id, CreatedAt: r.timestamp, FromStoreID: r.fromStoreId, ToStoreID: r.toStoreId, Note: r.note,
        Status: r.mode === 'SEND' ? 'DISPATCHED' : (bool(setting('TransferApproval')) ? 'REQUESTED' : 'APPROVED'), _pending: true,
        items: r.items.map((i) => ({ ProductID: i.productId, QtyRequested: i.qty, QtySent: r.mode === 'SEND' ? i.qty : '' })) };
      list.unshift(t); byId[t.TransferID] = t;
    }
    if (r.type === 'transferAction' && byId[r.transferId]) {
      const t = byId[r.transferId];
      t.Status = { APPROVE: 'APPROVED', DISPATCH: 'DISPATCHED', RECEIVE: 'RECEIVED', CANCEL: 'CANCELLED' }[r.action] || t.Status;
      if (r.action === 'DISPATCH') (r._items || []).forEach((i) => { const it = t.items.find((x) => x.ProductID === i.productId); if (it) it.QtySent = i.qty; });
      if (r.action === 'RECEIVE') (r._items || []).forEach((i) => { const it = t.items.find((x) => x.ProductID === i.productId); if (it) it.QtyReceived = i.qty; });
      t._pending = true;
    }
  });
  const open = { REQUESTED: 0, APPROVED: 0, DISPATCHED: 0 };
  return list.sort((a, b) => ((a.Status in open ? 0 : 1) - (b.Status in open ? 0 : 1)) || String(b.CreatedAt).localeCompare(String(a.CreatedAt)));
}

/* =====================================================================
 * Boot
 * ===================================================================== */
async function boot() {
  S.cfg = await KV.get('cfg');
  S.snap = await KV.get('snap');
  S.queue = (await KV.get('queue')) || [];
  S.journal = (await KV.get('journal')) || [];
  const misc = (await KV.get('misc')) || {};
  S.counter = misc.counter || 0; S.shift = misc.shift || null; S.lastSync = misc.lastSync || null;
  const sess = await KV.get('session');
  if (sess && sess.expiresAt > Date.now() && S.snap) S.session = sess;
  if (S.session) S.view = defaultView();
  render();
  if (S.cfg) sync(false);
  setInterval(() => { if (S.cfg && navigator.onLine) sync(false); }, AUTO_SYNC_MS);
  window.addEventListener('online', () => { renderStatus(); sync(false); });
  window.addEventListener('offline', renderStatus);
  if (!GAS && !window.Capacitor && 'serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
}

function defaultView() {
  if (store().Type === 'SHOP' && can('POS_SELL')) return 'pos';
  if (store().Type === 'HQ') return canAny('REPORTS_ALL', 'REPORTS_STORE') ? 'reports' : 'admin';
  return 'stock';
}

/* =====================================================================
 * Rendering
 * ===================================================================== */
function render() {
  applyTheme();
  const app = $('#app');
  const active = document.activeElement;
  const keepId = active && active.id;
  const caret = active && typeof active.selectionStart === 'number' ? active.selectionStart : null;
  if (!S.cfg || !S.snap) app.innerHTML = viewDeviceSetup();
  else if (!S.session) app.innerHTML = viewLogin();
  else app.innerHTML = viewShell();
  if (keepId) {
    const el = document.getElementById(keepId);
    if (el) { el.focus(); try { if (caret !== null) el.setSelectionRange(caret, caret); } catch (e) { /* ignore */ } }
  }
}

function renderStatus() {
  const el = $('#sync-chip');
  if (el) el.outerHTML = syncChip();
}

function syncChip() {
  const pend = S.queue.filter((q) => q.status === 'pending').length;
  const failed = S.queue.filter((q) => q.status === 'failed').length;
  const online = navigator.onLine;
  let cls = 'pill', text;
  if (S.syncing) { cls += ' busy'; text = 'Syncing…'; }
  else if (!online) { cls += ' off'; text = 'Offline' + (pend ? ' · ' + pend : ''); }
  else if (failed) { cls += ' off'; text = failed + ' failed'; }
  else if (pend) { cls += ' pending'; text = pend + ' to sync'; }
  else { cls += ' synced-ok'; text = 'Synced'; }
  return `<button id="sync-chip" class="${cls}" data-act="go" data-view="sync" title="Sync status"><span class="dot"></span><span class="lbl">${text}</span></button>`;
}

/* ---------- theme ---------- */
const SWATCHES = ['#0F766E', '#0F4C5C', '#2563EB', '#4F46E5', '#7C3AED', '#C026D3', '#BE123C', '#DC2626', '#EA580C', '#CA8A04', '#15803D', '#475569', '#111827'];
const CAT_COLORS = [['#e0f2fe', '#0369a1'], ['#fce7f3', '#be185d'], ['#ede9fe', '#6d28d9'], ['#dcfce7', '#15803d'], ['#fef3c7', '#b45309'], ['#ffe4e6', '#be123c'], ['#e0e7ff', '#4338ca'], ['#ccfbf1', '#0f766e']];
function hexToRgb(h) { const m = /^#?([0-9a-f]{6})$/i.exec(String(h || '').trim()); if (!m) return null; const n = parseInt(m[1], 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; }
function rgbToHex(r, g, b) { return '#' + [r, g, b].map((x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0')).join(''); }
function mix(c1, c2, t) { return rgbToHex(c1[0] + (c2[0] - c1[0]) * t, c1[1] + (c2[1] - c1[1]) * t, c1[2] + (c2[2] - c1[2]) * t); }
function themeColor() { return (S.snap && store().Color) || setting('ThemeColor') || '#0F766E'; }
function applyTheme() {
  let mode = 'auto';
  try { mode = localStorage.getItem('sm-mode') || 'auto'; } catch (e) { /* ignore */ }
  const dark = mode === 'dark' || (mode === 'auto' && window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches);
  const root = document.documentElement;
  root.dataset.theme = dark ? 'dark' : 'light';
  const rgb = hexToRgb(themeColor()) || [15, 118, 110];
  const lum = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;
  root.style.setProperty('--brand', rgbToHex(...rgb));
  root.style.setProperty('--brand-ink', mix(rgb, [0, 0, 0], dark ? -0.15 : 0.22));
  root.style.setProperty('--brand-soft', dark ? mix(rgb, [22, 27, 34], 0.72) : mix(rgb, [255, 255, 255], 0.88));
  root.style.setProperty('--brand-tint', dark ? mix(rgb, [22, 27, 34], 0.85) : mix(rgb, [255, 255, 255], 0.95));
  root.style.setProperty('--on-brand', lum > 0.62 ? '#111827' : '#ffffff');
  const meta = document.querySelector('meta[name=theme-color]');
  if (meta) meta.setAttribute('content', rgbToHex(...rgb));
}
function catColor(cat) {
  let h = 0; String(cat || '').split('').forEach((c) => { h = (h * 31 + c.charCodeAt(0)) >>> 0; });
  return CAT_COLORS[h % CAT_COLORS.length];
}
const initials = (name) => String(name || '?').replace(/\(.*?\)/g, '').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();

/* ---------- device setup ---------- */
function viewDeviceSetup() {
  const params = new URLSearchParams(location.search);
  let saved = ''; try { saved = localStorage.getItem('sm-url') || ''; } catch (e) { /* ignore */ }
  const url = (S.cfg && S.cfg.url) || params.get('api') || saved || window.SM_DEFAULT_API || '';
  return `<div class="auth-wrap"><div class="auth">
    <div class="auth-head"><div class="logo">${icon('store', 'lg')}</div><div><div class="k">Store Manager</div><h2>Connect this device</h2></div></div>
    <form data-form="register" class="auth-body">
      ${GAS ? '' : `<div class="field"><label for="f-url">Server address</label>
        <input id="f-url" name="url" type="url" required placeholder="https://script.google.com/macros/s/…/exec" value="${esc(url)}"></div>`}
      <div class="field"><label for="f-code">Setup code</label>
        <input id="f-code" name="code" type="text" required autocomplete="off" placeholder="e.g. K7Q2M9XD" style="text-transform:uppercase;letter-spacing:.2em;font-weight:700;font-size:1.15rem;text-align:center"></div>
      <div class="field"><label for="f-name">Device name</label>
        <input id="f-name" name="name" type="text" required placeholder="e.g. Waterside Till 1"></div>
      <button class="btn primary block big" type="submit">Connect device ${icon('arrow')}</button>
      <p class="muted small" style="margin:1rem 0 0">Ask the owner or a manager for a setup code. In the Google Sheet: <b>Store Manager → Create device setup code</b>, or in this app: <b>Admin → Devices</b>. Each code works once.</p>
    </form>
  </div></div>`;
}

/* ---------- login ---------- */
let pinEntry = '';
let loginUser = null;
function viewLogin() {
  const users = (S.snap.users || []).filter((u) => u.Status === 'ACTIVE');
  const roles = {}; (S.snap.roles || []).forEach((r) => { roles[r.RoleID] = r.RoleName; });
  const sel = users.find((u) => u.UserID === loginUser);
  const dots = Math.max(4, pinEntry.length);
  return `<div class="auth-wrap"><div class="auth">
    <div class="auth-head"><div class="logo">${esc(initials(store().Name))}</div>
      <div class="grow"><div class="k">${esc(setting('BusinessName') || 'Store Manager')}</div><h2>${esc(store().Name)}</h2></div></div>
    <div class="auth-body">
      ${!sel ? `<label>Who is working?</label><div class="users">
        ${users.map((u) => `<button class="user-tile" data-act="pick-user" data-id="${esc(u.UserID)}"><span class="avatar">${esc(initials(u.FullName))}</span>
          <span><b>${esc(u.FullName)}</b><span class="r">${esc(roles[u.RoleID] || u.RoleID)}</span></span></button>`).join('') || '<div class="muted">No users for this store yet.</div>'}
      </div>` : `
      <div class="row between"><div class="row"><span class="avatar" style="width:40px;height:40px">${esc(initials(sel.FullName))}</span>
        <div><b>${esc(sel.FullName)}</b><div class="muted small">${esc(roles[sel.RoleID] || '')}</div></div></div>
        <button class="btn ghost sm" data-act="pick-user" data-id="">Change</button></div>
      <div class="pin-dots">${Array.from({ length: dots }, (_, i) => `<span class="${i < pinEntry.length ? 'on' : ''}"></span>`).join('')}</div>
      <div class="pad">${['1', '2', '3', '4', '5', '6', '7', '8', '9', 'C', '0', '⏎'].map((k) =>
        `<button data-act="pin" data-k="${k}" class="${k === '⏎' ? 'go' : k === 'C' ? 'clr' : ''}">${k === '⏎' ? icon('arrow', 'lg') : k === 'C' ? 'Clear' : k}</button>`).join('')}</div>`}
    </div>
    <div class="auth-foot"><span>${syncChip().replace('data-act="go" data-view="sync"', 'data-act="sync-now"')}</span>
      <span>${esc(S.cfg.deviceName || '')} · v${APP_VERSION}</span>
      <button class="btn ghost sm" data-act="reset-device">Disconnect</button></div>
  </div></div>`;
}

async function doLogin() {
  const u = (S.snap.users || []).find((x) => x.UserID === loginUser);
  if (!u) return;
  const pin = pinEntry;
  pinEntry = '';
  let session = null;
  if (navigator.onLine) {
    try {
      const r = await api('login', { username: u.Username, pin });
      session = { user: r.user, permissions: r.permissions, role: r.role, token: r.token, tokenExp: Date.now() + r.tokenHours * 3600e3 - 60e3 };
    } catch (e) {
      if (e.code !== 'NETWORK' && e.code !== 'BAD_REPLY') { toast(e.message, 'bad'); render(); return; }
    }
  }
  if (!session) {
    const h = await hashPin(pin, u.PinSalt);
    if (h !== u.PinHash) { toast('Wrong PIN', 'bad'); render(); return; }
    const role = (S.snap.roles || []).find((r) => r.RoleID === u.RoleID) || {};
    session = { user: u, permissions: String(u.Permissions || '').split(',').filter(Boolean), role, token: '', tokenExp: 0 };
    toast('Logged in offline — reports and admin need internet', '');
  }
  session.expiresAt = Date.now() + 14 * 3600e3;
  S.session = session;
  loginUser = null;
  S.view = defaultView();
  S.admin = null;
  await persist.session();
  reportCache = null;
  render();
  if (S.view === 'reports' && S.session.token) loadReport();
}

function logout() {
  S.session = null; S.cart = { lines: [], discountUSD: 0, customerId: '' }; S.admin = null;
  KV.del('session');
  render();
}

/* ---------- shell ---------- */
function navItems() {
  const shop = store().Type === 'SHOP';
  const items = [];
  if (shop && can('POS_SELL')) items.push(['pos', 'cart', 'Sell']);
  if (shop && can('ORDERS_MANAGE') && (bool(store().OnlineShop) || (S.snap.orders || []).length)) { const n = newOrderCount(); items.push(['orders', 'bag', 'Orders' + (n ? ' · ' + n : '')]); }
  if (store().Type !== 'HQ') items.push(['stock', 'box', 'Stock']);
  if (canAny('TRANSFER_REQUEST', 'TRANSFER_DISPATCH', 'TRANSFER_RECEIVE', 'TRANSFER_APPROVE')) items.push(['transfers', 'truck', 'Transfers']);
  if (store().Type !== 'HQ' && canAny('EXPENSE_RECORD', 'INCOME_RECORD')) items.push(['money', 'wallet', 'Money']);
  if (canAny('CREDIT_SALE', 'CREDIT_COLLECT', 'CUSTOMER_MANAGE')) items.push(['customers', 'users', 'Customers']);
  if (shop && can('SHIFT_OPEN_CLOSE')) items.push(['shift', 'clock', 'Shift']);
  if (canAny('REPORTS_STORE', 'REPORTS_ALL')) items.push(['reports', 'chart', 'Reports']);
  if (canAny('STORE_MANAGE', 'USER_MANAGE', 'DEVICE_MANAGE', 'PRODUCT_MANAGE', 'SETTINGS_MANAGE', 'RATE_SET_GLOBAL', 'RATE_SET_STORE', 'PRICE_MANAGE', 'SHOP_MANAGE')) items.push(['admin', 'sliders', 'Admin']);
  items.push(['sync', 'sync', 'Sync']);
  return items;
}

function viewShell() {
  const items = navItems();
  if (!items.some((i) => i[0] === S.view)) S.view = items[0][0];
  const st = store();
  const u = S.session.user;
  const views = { pos: viewPOS, stock: viewStock, transfers: viewTransfers, money: viewMoney, customers: viewCustomers,
    shift: viewShift, reports: viewReports, admin: viewAdmin, sync: viewSync, orders: viewOrders };
  const typeLabel = st.Type === 'WAREHOUSE' ? 'Warehouse' : st.Type === 'HQ' ? 'Head office' : 'Shop';
  return `<div class="shell">
    <header class="topbar">
      <div class="store-id"><div class="logo">${esc(initials(st.Name))}</div>
        <div class="t"><div class="n">${esc(st.Name)}</div><div class="b">${esc(setting('BusinessName') || '')} · ${typeLabel}</div></div></div>
      <button class="pill rate-pill" data-act="go" data-view="${can('RATE_SET_GLOBAL') || can('RATE_SET_STORE') ? 'admin' : S.view}" title="Exchange rate">${icon('swap', 'sm')}<span class="hide-sm">1 USD =</span> ${rate()}<span class="hide-sm"> LRD</span></button>
      ${syncChip()}
      <button class="me" data-act="logout" title="Log out"><span class="avatar">${esc(initials(u.FullName))}</span>
        <span class="who">${esc(u.FullName.split(' ')[0])}<span>${esc((S.session.role && S.session.role.RoleName) || '')}</span></span>${icon('logout', 'sm')}</button>
    </header>
    <nav class="nav">
      <div class="brandmark"><div class="logo">${esc(initials(st.Name))}</div><div><div class="n">${esc(st.Name)}</div><div class="b">${esc(setting('BusinessName') || '')}</div></div></div>
      ${items.map((i) => `<button class="${S.view === i[0] ? 'on' : ''}" data-act="go" data-view="${i[0]}">${icon(i[1])}<span>${i[2]}</span></button>`).join('')}
      <div class="navfoot">${esc(S.cfg.deviceName || '')}<br>Store Manager v${APP_VERSION}</div>
    </nav>
    <main class="main"><div class="page">${views[S.view]()}</div></main>
  </div>`;
}

/* =====================================================================
 * POS
 * ===================================================================== */
function sellable() {
  return (S.snap.products || []).filter((p) => p.Sells !== false);
}

function viewPOS() {
  const cats = ['All'].concat(Array.from(new Set(sellable().map((p) => p.Category).filter(Boolean))));
  const t = cartTotals();
  const n = S.cart.lines.length;
  return `<div class="pos">
    <section>
      <div class="searchbox">${icon('search')}<input id="pos-search" type="text" placeholder="Search products, SKU or barcode" value="${esc(S.ui.q)}" data-input="pos-search" autocomplete="off"></div>
      <div class="chips">${cats.map((c) => `<button class="chip-f ${S.ui.cat === c ? 'on' : ''}" data-act="cat" data-cat="${esc(c)}">${esc(c)}</button>`).join('')}</div>
      <div id="pos-grid">${posGrid()}</div>
      ${n ? `<div class="cartbar"><span class="count">${n}</span><button class="btn accent big" data-act="show-cart">Review sale · ${fmtUSD(t.total)}</button></div>` : ''}
    </section>
    <aside class="cart-panel ${S.ui.showCart ? '' : 'mobile-hidden'}" id="cart-panel">${cartPanel()}</aside>
  </div>`;
}

function posGrid() {
  const q = S.ui.q.trim().toLowerCase();
  const stock = stockMap();
  const allowNeg = bool(setting('AllowNegativeStock'));
  const inCart = {}; S.cart.lines.forEach((l) => { inCart[l.productId] = l.qty; });
  const list = sellable().filter((p) => (S.ui.cat === 'All' || p.Category === S.ui.cat) &&
    (!q || (p.Name + ' ' + p.SKU + ' ' + p.Barcode).toLowerCase().indexOf(q) >= 0));
  if (!list.length) return `<div class="card empty">${icon('search')}No products match “${esc(S.ui.q)}”.</div>`;
  return `<div class="products">${list.map((p) => {
    const qty = stock[p.ProductID] || 0;
    const low = qty <= num(p.ReorderLevel);
    const badge = qty <= 0 ? 'bad' : low ? 'warn' : 'ok';
    const cc = catColor(p.Category);
    return `<button class="prod" data-act="add" data-id="${esc(p.ProductID)}" ${qty <= 0 && !allowNeg ? 'disabled' : ''}>
      ${inCart[p.ProductID] ? `<span class="incart">${fmtQty(inCart[p.ProductID])}</span>` : ''}
      <span class="thumb" style="background:${cc[0]};color:${cc[1]}">${esc(initials(p.Name))}</span>
      <span class="n">${esc(p.Name)}</span>
      <span class="foot"><span class="p">${fmtCur(p.SellingPrice, p.PriceCurrency)}</span>
      <span class="badge ${badge}">${fmtQty(qty)} ${esc(p.Unit || '')}</span></span></button>`;
  }).join('')}</div>`;
}

function lineUSD(l) { return toUSD(l.unitPrice * l.qty, l.priceCurrency); }
function cartTotals() {
  const sub = S.cart.lines.reduce((t, l) => t + lineUSD(l), 0);
  const disc = Math.min(num(S.cart.discountUSD), sub);
  const total = Math.max(0, sub - disc);
  return { sub, disc, total, totalLRD: total * rate() };
}

function cartPanel() {
  const t = cartTotals();
  const cust = S.cart.customerId ? customers().find((c) => c.CustomerID === S.cart.customerId) : null;
  return `<div class="card">
    <div class="cart-head"><h3>Current sale</h3>
      <span class="row">${S.cart.lines.length ? `<button class="btn ghost sm" data-act="clear-cart">${icon('trash', 'sm')} Clear</button>` : ''}
      <button class="btn ghost icon sm" data-act="hide-cart" style="display:${S.ui.showCart ? 'inline-flex' : 'none'}">${icon('x')}</button></span></div>
    ${S.cart.orderId ? `<div class="order-banner">${icon('bag', 'sm')} <span>Online order <b>${esc(S.cart.orderNo)}</b>${S.cart.orderFee && S.cart.orderFee.fee ? ` · collect delivery fee <b>${fmtCur(S.cart.orderFee.fee, S.cart.orderFee.currency)}</b> too (recorded automatically)` : ''}</span></div>` : ''}
    <div class="cart-lines">${S.cart.lines.length ? S.cart.lines.map((l, i) => `<div class="cart-line">
        <div><div class="n">${esc(l.name)}</div><div class="muted small">${fmtCur(l.unitPrice, l.priceCurrency)} / ${esc(l.unit || 'unit')}</div></div>
        <div class="right"><b class="num">${fmtCur(l.unitPrice * l.qty, l.priceCurrency)}</b></div>
        <div class="qty"><button data-act="qty" data-i="${i}" data-d="-1" aria-label="less">${icon('minus', 'sm')}</button>
          <input id="qty-${i}" type="number" inputmode="decimal" step="${l.step}" min="0" value="${l.qty}" data-input="qty" data-i="${i}">
          <button data-act="qty" data-i="${i}" data-d="1" aria-label="more">${icon('plus', 'sm')}</button></div>
        <div class="right"><button class="btn ghost icon sm" data-act="remove" data-i="${i}" title="Remove">${icon('trash', 'sm')}</button></div>
      </div>`).join('') : `<div class="empty">${icon('cart')}Tap a product to start a sale</div>`}</div>
    <div class="cart-foot">
      <div class="row" style="margin-bottom:.7rem">
        ${can('POS_DISCOUNT') ? `<button class="btn sm" data-act="discount" ${S.cart.lines.length ? '' : 'disabled'}>${icon('tag', 'sm')} Discount</button>` : ''}
        <button class="btn sm ${cust ? 'soft' : ''}" data-act="pick-customer">${icon('user', 'sm')} ${cust ? esc(cust.Name) : 'Add customer'}</button>
      </div>
      <div class="totals">
        <div class="line"><span>Subtotal</span><span class="num">${fmtUSD(t.sub)}</span></div>
        ${t.disc ? `<div class="line"><span>Discount</span><span class="num">−${fmtUSD(t.disc)}</span></div>` : ''}
        <div class="line grand"><span>Total</span><span class="num">${fmtUSD(t.total)}</span></div>
        <div class="line"><span>In LRD at ${rate()}</span><span class="num">${fmtLRD(t.totalLRD)}</span></div>
      </div>
      <button class="btn accent block big" style="margin-top:.9rem" data-act="checkout" ${S.cart.lines.length ? '' : 'disabled'}>Charge ${fmtUSD(t.total)}</button>
    </div>
  </div>`;
}

function addToCart(pid) {
  const p = productById(pid);
  if (!p) return;
  const step = isYard(p) ? 0.5 : 1;
  const ex = S.cart.lines.find((l) => l.productId === pid);
  const stock = stockMap()[pid] || 0;
  const want = (ex ? ex.qty : 0) + (isYard(p) ? 1 : 1);
  if (want > stock && !bool(setting('AllowNegativeStock'))) { toast('Only ' + fmtQty(stock) + ' ' + (p.Unit || '') + ' in stock', 'bad'); return; }
  if (ex) ex.qty = r2(ex.qty + 1);
  else S.cart.lines.push({ productId: pid, name: p.Name, unit: p.Unit, qty: 1, step, unitPrice: num(p.SellingPrice), priceCurrency: p.PriceCurrency });
  render();
}

/* ---------- checkout ---------- */
let co = null; // checkout state { tenders: [], method, amount, changeCurrency }
const METHODS = [
  ['USD_CASH', 'USD cash', 'USD', 'cash'], ['LRD_CASH', 'LRD cash', 'LRD', 'cash'], ['MOMO_MTN', 'MTN MoMo', 'LRD', 'phone'],
  ['MOMO_ORANGE', 'Orange Money', 'LRD', 'phone'], ['CREDIT', 'On credit', 'USD', 'book']
];

function openCheckout() {
  co = { tenders: [], method: 'LRD_CASH', changeCurrency: 'LRD' };
  showModal(checkoutModal);
}

function coPaid() {
  const t = cartTotals();
  const paidUSD = co.tenders.reduce((s, x) => s + toUSD(x.amount, x.currency), 0);
  return { t, paidUSD, remainUSD: t.total - paidUSD };
}

function checkoutModal() {
  const { t, paidUSD, remainUSD } = coPaid();
  const m = METHODS.find((x) => x[0] === co.method);
  const remainInCur = m[2] === 'USD' ? Math.max(0, remainUSD) : Math.max(0, remainUSD * rate());
  const suggest = m[2] === 'USD' ? r2(remainInCur) : Math.ceil(remainInCur);
  const cust = S.cart.customerId ? customers().find((c) => c.CustomerID === S.cart.customerId) : null;
  const methods = METHODS.filter((x) => x[0] !== 'CREDIT' || can('CREDIT_SALE'));
  const change = -remainUSD;
  const done = remainUSD <= 0.005;
  return `<div class="modal-head"><h2>Take payment</h2><button class="btn ghost icon" data-act="close">${icon('x')}</button></div>
    <div class="due"><div class="usd">${fmtUSD(t.total)}</div><div class="lrd">${fmtLRD(t.totalLRD)} · rate ${rate()}</div></div>
    ${co.tenders.map((x, i) => `<div class="tender"><span>${esc(METHODS.find((mm) => mm[0] === x.method)[1])}${x.reference ? ' · ' + esc(x.reference) : ''}</span>
      <span class="row"><b class="num">${fmtCur(x.amount, x.currency)}</b><button class="btn ghost icon sm" data-act="co-del" data-i="${i}">${icon('x', 'sm')}</button></span></div>`).join('')}
    ${!done ? `<div class="methods">${methods.map((x) => `<button class="btn ${co.method === x[0] ? 'on' : ''}" data-act="co-method" data-m="${x[0]}">${icon(x[3])}${x[1]}</button>`).join('')}</div>
      ${co.method === 'CREDIT' && !cust ? `<div class="card flat row between" style="background:var(--warn-soft);border-color:transparent"><span>Credit sales need a customer.</span><button class="btn sm primary" data-act="pick-customer">${icon('user', 'sm')} Choose customer</button></div>` : `
      <div class="grid2">
        <div class="field"><label for="co-amt">Amount received (${m[2]})</label>
          <input id="co-amt" type="number" inputmode="decimal" step="any" value="${suggest}"></div>
        ${co.method.indexOf('MOMO') === 0 ? `<div class="field"><label for="co-ref">Transaction ID</label><input id="co-ref" type="text"></div>` : '<div></div>'}
      </div>
      <div class="quick">${m[2] === 'LRD' && co.method === 'LRD_CASH' ? [500, 1000, 2000, 5000].map((v) => `<button class="btn sm" data-act="co-quick" data-v="${v}">+${v}</button>`).join('') : ''}
        ${m[2] === 'USD' && co.method === 'USD_CASH' ? [1, 5, 10, 20, 50, 100].map((v) => `<button class="btn sm" data-act="co-quick" data-v="${v}">$${v}</button>`).join('') : ''}</div>
      <button class="btn primary block" style="margin-top:.6rem" data-act="co-add">Add ${esc(m[1])} payment</button>`}` : ''}
    <div class="totals">
      <div class="line"><span>Paid</span><span class="num">${fmtUSD(paidUSD)}</span></div>
      ${!done ? `<div class="line"><b>Still to pay</b><b class="num">${fmtUSD(remainUSD)} · ${fmtLRD(remainUSD * rate())}</b></div>` : `
      <div class="line change"><span>Change</span><span class="num">${co.changeCurrency === 'USD' ? fmtUSD(change) : fmtLRD(change * rate())}</span></div>
      <div class="row"><span class="muted small">Give change in</span>
        <button class="btn sm ${co.changeCurrency === 'LRD' ? 'primary' : ''}" data-act="co-change" data-c="LRD">LRD</button>
        <button class="btn sm ${co.changeCurrency === 'USD' ? 'primary' : ''}" data-act="co-change" data-c="USD">USD</button></div>`}
    </div>
    <button class="btn accent block big" style="margin-top:1rem" data-act="co-finish" ${done ? '' : 'disabled'}>${icon('check')} Complete sale</button>`;
}

function finishSale() {
  const { t, remainUSD } = coPaid();
  if (remainUSD > 0.005) return;
  const st = store();
  S.counter += 1;
  const receiptNo = st.Code + '-' + S.cfg.deviceId.slice(-4) + '-' + String(S.counter).padStart(5, '0');
  const rec = enqueue('sale', {
    receiptNo,
    customerId: S.cart.customerId || undefined,
    items: S.cart.lines.map((l) => ({ productId: l.productId, qty: l.qty, priceCurrency: l.priceCurrency, unitPrice: l.unitPrice })),
    discountUSD: r2(t.disc),
    payments: co.tenders.map((x) => ({ method: x.method, currency: x.currency, amount: x.amount, reference: x.reference || undefined })),
    changeCurrency: co.changeCurrency
  });
  rec._names = S.cart.lines.map((l) => l.name);
  if (S.cart.orderId) enqueue('orderStatus', { orderId: S.cart.orderId, status: 'PAID', saleId: rec.id });
  rec._change = { usd: -remainUSD, currency: co.changeCurrency };
  persist.journal(); persist.misc();
  S.cart = { lines: [], discountUSD: 0, customerId: '' };
  S.ui.showCart = false;
  co = null;
  showModal(() => receiptModal(rec));
  render();
}

function receiptHTML(r) {
  const st = store();
  const rt = num(r.rate);
  let sub = 0;
  const lines = r.items.map((i, k) => {
    const p = productById(i.productId) || {};
    const usd = toUSDAt(i.unitPrice * i.qty, i.priceCurrency, rt);
    sub += usd;
    return `<div>${esc((r._names && r._names[k]) || p.Name || i.productId)}</div>
      <div class="l"><span>${fmtQty(i.qty)} × ${fmtCur(i.unitPrice, i.priceCurrency)}</span><span>${fmtCur(i.unitPrice * i.qty, i.priceCurrency)}</span></div>`;
  }).join('');
  const total = sub - num(r.discountUSD);
  const paid = r.payments.reduce((s, p) => s + toUSDAt(p.amount, p.currency, rt), 0);
  const changeUSD = Math.max(0, paid - total);
  const cust = r.customerId ? customers().find((c) => c.CustomerID === r.customerId) : null;
  return `<div class="receipt">
    <div class="c"><b>${esc(st.ReceiptHeader || st.Name)}</b><br>${esc(st.Address || '')}<br>${esc(st.Phone || '')}</div><hr>
    <div class="l"><span>Receipt</span><span>${esc(r.receiptNo)}</span></div>
    <div class="l"><span>Date</span><span>${fmtDate(r.timestamp)}</span></div>
    <div class="l"><span>Cashier</span><span>${esc(userName(r.userId))}</span></div>
    ${cust ? `<div class="l"><span>Customer</span><span>${esc(cust.Name)}</span></div>` : ''}<hr>
    ${lines}<hr>
    ${num(r.discountUSD) ? `<div class="l"><span>Discount</span><span>−${fmtUSD(r.discountUSD)}</span></div>` : ''}
    <div class="l"><b>TOTAL USD</b><b>${fmtUSD(total)}</b></div>
    <div class="l"><b>TOTAL LRD</b><b>${fmtLRD(total * rt)}</b></div>
    <div class="l small"><span>Rate</span><span>1 USD = ${rt} LRD</span></div><hr>
    ${r.payments.map((p) => `<div class="l"><span>${esc((METHODS.find((m) => m[0] === p.method) || [0, p.method])[1])}</span><span>${fmtCur(p.amount, p.currency)}</span></div>`).join('')}
    ${changeUSD > 0.004 ? `<div class="l"><b>Change</b><b>${r.changeCurrency === 'USD' ? fmtUSD(changeUSD) : fmtLRD(changeUSD * rt)}</b></div>` : ''}
    <hr><div class="c">${esc(st.ReceiptFooter || 'Thank you!')}</div></div>`;
}

function receiptModal(r) {
  return `<div class="modal-head"><div class="steps-done">${icon('check', 'lg')}<h2 style="color:var(--ok)">Sale complete</h2></div><button class="btn ghost icon" data-act="close">${icon('x')}</button></div>
    ${receiptHTML(r)}
    <div class="grid2" style="margin-top:1rem">
      <button class="btn" data-act="print" data-id="${esc(r.id)}">${icon('printer')} Print</button>
      <button class="btn primary" data-act="close">New sale ${icon('arrow')}</button></div>`;
}

/* ---------- customer picker ---------- */
function customerPicker() {
  const q = (S.ui.custQ || '').toLowerCase();
  const list = customers().filter((c) => !q || (c.Name + ' ' + c.Phone).toLowerCase().indexOf(q) >= 0).slice(0, 50);
  return `<div class="modal-head"><h2>Customer</h2><button class="btn ghost icon" data-act="${co ? 'back-checkout' : 'close'}">${icon('x')}</button></div>
    <div class="searchbox">${icon('search')}<input id="cust-q" type="text" placeholder="Search name or phone" value="${esc(S.ui.custQ || '')}" data-input="cust-q"></div>
    <div id="cust-list" style="margin-top:.6rem">${list.map((c) => `<div class="tender" data-act="set-customer" data-id="${esc(c.CustomerID)}" style="cursor:pointer">
      <span><b>${esc(c.Name)}</b> <span class="muted small">${esc(c.Phone)}</span></span>
      <span class="num ${c.BalanceUSD > 0 ? '' : 'muted'}">${c.BalanceUSD > 0.004 ? 'owes ' + fmtUSD(c.BalanceUSD) : '—'}</span></div>`).join('') || '<div class="empty">No customers</div>'}</div>
    <div class="row" style="margin-top:.6rem">
      ${S.cart.customerId ? '<button class="btn" data-act="set-customer" data-id="">No customer</button>' : ''}
      ${canAny('CUSTOMER_MANAGE', 'CREDIT_SALE') ? `<button class="btn primary" data-act="new-customer">${icon('plus', 'sm')} New customer</button>` : ''}</div>`;
}

function customerForm(c) {
  c = c || {};
  return `<div class="modal-head"><h2>${c.CustomerID ? 'Edit' : 'New'} customer</h2><button class="btn ghost icon" data-act="close">${icon('x')}</button></div>
    <form data-form="customer" data-id="${esc(c.CustomerID || '')}">
      <div class="field"><label>Name</label><input name="name" type="text" required value="${esc(c.Name || '')}"></div>
      <div class="grid2"><div class="field"><label>Phone</label><input name="phone" type="tel" value="${esc(c.Phone || '')}"></div>
      <div class="field"><label>Credit limit (USD)</label><input name="limit" type="number" step="any" value="${esc(c.CreditLimitUSD || '')}" ${can('CUSTOMER_MANAGE') ? '' : 'disabled'}></div></div>
      <div class="field"><label>Notes</label><input name="notes" type="text" value="${esc(c.Notes || '')}"></div>
      <button class="btn primary block" type="submit">Save</button></form>`;
}

/* =====================================================================
 * Online orders (from the WhatsApp shop)
 * ===================================================================== */
const ORDER_TABS = [['NEW', 'New'], ['CONFIRMED', 'Confirmed'], ['PAID', 'Paid · to hand over'], ['DONE', 'Done']];
const ORDER_BADGE = { NEW: 'warn', CONFIRMED: 'brand', PAID: 'ok', DELIVERED: '', CANCELLED: 'bad' };

function orders() {
  const list = (S.snap.orders || []).map((o) => Object.assign({}, o));
  const byId = {}; list.forEach((o) => { byId[o.OrderID] = o; });
  liveRecords().forEach((r) => {
    if (r.type === 'orderStatus' && byId[r.orderId]) { byId[r.orderId].Status = r.status; byId[r.orderId]._pending = true; if (r.saleId) byId[r.orderId].SaleID = r.saleId; }
  });
  return list;
}
const newOrderCount = () => orders().filter((o) => o.Status === 'NEW').length;
const waLink = (phone, text) => {
  let d = String(phone || '').replace(/\D/g, '');
  if (d.length === 10 && d[0] === '0') d = '231' + d.slice(1);
  if (d.length === 9 && d[0] !== '0') d = '231' + d;
  return 'https://wa.me/' + d + (text ? '?text=' + encodeURIComponent(text) : '');
};

function viewOrders() {
  const tab = S.ui.orderTab || 'NEW';
  const all = orders();
  const count = (k) => all.filter((o) => (k === 'DONE' ? ['DELIVERED', 'CANCELLED'].indexOf(o.Status) >= 0 : o.Status === k)).length;
  const list = all.filter((o) => (tab === 'DONE' ? ['DELIVERED', 'CANCELLED'].indexOf(o.Status) >= 0 : o.Status === tab));
  return `<div class="page-head"><div><h2>Online orders</h2><div class="sub">Orders customers sent from your WhatsApp shop</div></div>
      <button class="btn" data-act="sync-now">${icon('sync', 'sm')} Check for new orders</button></div>
    <div class="tabs">${ORDER_TABS.map((t) => `<button class="tab ${tab === t[0] ? 'on' : ''}" data-act="order-tab" data-t="${t[0]}">${t[1]}${count(t[0]) ? ` (${count(t[0])})` : ''}</button>`).join('')}</div>
    ${list.length ? `<div class="orders">${list.map(orderCard).join('')}</div>`
      : `<div class="card empty">${icon('bag')}${tab === 'NEW' ? 'No new orders. Share your shop link on WhatsApp status to get orders.' : 'Nothing here.'}</div>`}`;
}

function orderCard(o) {
  const items = o.Items || [];
  const acts = [];
  const hello = `Hello ${o.CustomerName}, thank you for your order ${o.OrderNo} at ${store().Name}. `;
  if (o.Status === 'NEW') {
    acts.push(`<a class="btn sm wa" href="${esc(waLink(o.CustomerPhone, hello + 'We have your items. Total ' + fmtUSD(o.TotalUSD) + ' / ' + fmtLRD(o.TotalLRD) + '. You can pay by MTN MoMo, Orange Money or cash. '))}" target="_blank" rel="noopener">${icon('chat', 'sm')} WhatsApp customer</a>`);
    acts.push(`<button class="btn sm primary" data-act="order-status" data-id="${esc(o.OrderID)}" data-s="CONFIRMED">${icon('check', 'sm')} Confirm</button>`);
  }
  if (o.Status === 'NEW' || o.Status === 'CONFIRMED') {
    if (o.Status === 'CONFIRMED') acts.push(`<a class="btn sm wa" href="${esc(waLink(o.CustomerPhone, hello))}" target="_blank" rel="noopener">${icon('chat', 'sm')} WhatsApp</a>`);
    if (can('POS_SELL')) acts.push(`<button class="btn sm accent" data-act="order-ring" data-id="${esc(o.OrderID)}">${icon('cart', 'sm')} Paid — ring up sale</button>`);
    acts.push(`<button class="btn sm danger" data-act="order-status" data-id="${esc(o.OrderID)}" data-s="CANCELLED">Cancel</button>`);
  }
  if (o.Status === 'PAID') {
    acts.push(`<button class="btn sm primary" data-act="order-status" data-id="${esc(o.OrderID)}" data-s="DELIVERED">${icon('check', 'sm')} ${o.Method === 'DELIVERY' ? 'Delivered' : 'Picked up'}</button>`);
    acts.push(`<a class="btn sm wa" href="${esc(waLink(o.CustomerPhone, hello + (o.Method === 'DELIVERY' ? 'Your order is on the way.' : 'Your order is ready for pickup.')))}" target="_blank" rel="noopener">${icon('chat', 'sm')} Tell customer</a>`);
  }
  return `<div class="card order">
    <div class="row between"><div><b class="ono">${esc(o.OrderNo)}</b> <span class="badge ${ORDER_BADGE[o.Status] || ''}">${esc(o.Status)}${o._pending ? ' · not synced' : ''}</span>
      <div class="muted small">${fmtDate(o.CreatedAt)}</div></div>
      <div class="right"><div class="ototal">${fmtUSD(o.TotalUSD)}</div><div class="muted small">${fmtLRD(o.TotalLRD)}</div></div></div>
    <div class="ocust"><span class="avatar">${esc(initials(o.CustomerName))}</span><div><b>${esc(o.CustomerName)}</b><div class="muted small">${esc(o.CustomerPhone)}</div></div></div>
    <div class="ometa">${o.Method === 'DELIVERY' ? `${icon('truck', 'sm')} <span><b>Delivery${o.Place ? ' – ' + esc(o.Place) : ''}</b> · ${esc(o.Address || '')}</span>` : `${icon('store', 'sm')} <span><b>Pickup</b> · ${esc(o.Place || 'at the shop')}</span>`}</div>
    ${o.Note ? `<div class="onote">“${esc(o.Note)}”</div>` : ''}
    <div class="olines">${items.map((l) => `<div><span>${fmtQty(l.qty)} × ${esc(l.name)}</span><span class="num">${fmtCur(l.total, l.currency)}</span></div>`).join('')}
      ${o.Method === 'DELIVERY' ? `<div class="muted"><span>Delivery fee</span><span class="num">${num(o.Fee) ? fmtCur(o.Fee, o.FeeCurrency) : 'Free'}</span></div>` : ''}</div>
    ${acts.length ? `<div class="row oacts">${acts.join('')}</div>` : ''}
  </div>`;
}

function ringUpOrder(o) {
  if (S.cart.lines.length && !confirm('Replace the current sale with order ' + o.OrderNo + '?')) return;
  const missing = [];
  const lines = [];
  (o.Items || []).forEach((l) => {
    const p = productById(l.id);
    if (!p) { missing.push(l.name); return; }
    lines.push({ productId: p.ProductID, name: p.Name, unit: p.Unit, qty: num(l.qty), step: isYard(p) ? 0.5 : 1, unitPrice: num(l.price), priceCurrency: l.currency });
  });
  S.cart = { lines, discountUSD: 0, customerId: '', orderId: o.OrderID, orderNo: o.OrderNo, orderFee: o.Method === 'DELIVERY' ? { fee: num(o.Fee), currency: o.FeeCurrency } : null };
  if (missing.length) toast('Not found in this store: ' + missing.join(', '), 'bad');
  S.view = 'pos'; S.ui.showCart = true;
  render();
  setTimeout(() => { const c = $('#cart-panel'); if (c) c.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 60);
}

/* =====================================================================
 * Admin → Online shop
 * ===================================================================== */
async function loadShopAdmin() {
  S.ui.shopLoading = true; render();
  try { S.shopAdmin = await adminCall('shopData', { storeId: shopStoreId() }); }
  catch (e) { toast(e.message, 'bad'); }
  S.ui.shopLoading = false; render();
}
function shopStoreId() {
  if (store().StoreID !== 'HQ') return store().StoreID;
  const shops = (S.snap.stores || []).filter((s) => s.Type === 'SHOP' && s.Status === 'ACTIVE');
  if (!S.ui.shopStore && shops[0]) S.ui.shopStore = shops[0].StoreID;
  return S.ui.shopStore;
}
function shopLink(d) {
  const base = String(d.shopUrl || '').trim();
  const code = d.store.Code;
  if (base) return base + (base.indexOf('?') >= 0 ? '&' : '?') + 'shop=' + encodeURIComponent(code);
  return d.webAppUrl ? d.webAppUrl + '?shop=' + encodeURIComponent(code) : '';
}

function adminShop() {
  if (!S.shopAdmin || S.shopAdmin.store.StoreID !== shopStoreId()) {
    return `<div class="card empty">${S.ui.shopLoading ? 'Loading…' : `<button class="btn primary" data-act="shop-load">Load online shop settings</button>`}</div>`;
  }
  const d = S.shopAdmin;
  const st = d.store;
  const on = bool(st.OnlineShop);
  const link = shopLink(d);
  const del = d.options.filter((o) => o.Type === 'DELIVERY');
  const pick = d.options.filter((o) => o.Type === 'PICKUP');
  const shops = (S.snap.stores || []).filter((s) => s.Type === 'SHOP' && s.Status === 'ACTIVE');
  const q = (S.ui.shopQ || '').toLowerCase();
  const prods = d.products.filter((p) => p.Status === 'ACTIVE' && (!q || p.Name.toLowerCase().indexOf(q) >= 0));
  return `
  ${store().StoreID === 'HQ' ? `<div class="field" style="max-width:340px"><label>Shop</label><select data-input="shop-store">${shops.map((s) => `<option value="${esc(s.StoreID)}" ${s.StoreID === st.StoreID ? 'selected' : ''}>${esc(s.Code + ' ' + s.Name)}</option>`).join('')}</select></div>` : ''}
  <div class="rcols" style="margin-top:0">
    <div class="card"><h3>${icon('chat')} WhatsApp shop</h3>
      <form data-form="shop-settings">
        <label class="check"><input type="checkbox" name="onlineShop" ${on ? 'checked' : ''}> <b>Take orders online</b></label>
        <div class="field" style="margin-top:.6rem"><label>WhatsApp number that receives orders (with country code)</label>
          <input name="whatsapp" type="tel" value="${esc(st.WhatsApp || '')}" placeholder="231770123456"></div>
        <div class="field"><label>Welcome message on the shop page</label><input name="shopMessage" type="text" value="${esc(st.ShopMessage || '')}" placeholder="e.g. Order before 2pm for same-day delivery"></div>
        <button class="btn primary" type="submit">Save</button></form></div>
    <div class="card"><h3>${icon('link')} Your shop link</h3>
      ${on && link ? `<div class="linkbox"><input id="shop-link" type="text" readonly value="${esc(link)}"><button class="btn sm" data-act="copy-link">Copy</button></div>
        <div class="row" style="margin:.7rem 0"><a class="btn sm wa" href="https://wa.me/?text=${encodeURIComponent('Shop with us on WhatsApp 👇\n' + link)}" target="_blank" rel="noopener">${icon('chat', 'sm')} Share on WhatsApp</a>
          <a class="btn sm" href="${esc(link)}" target="_blank" rel="noopener">Open shop</a></div>
        <img class="qr" alt="QR code for the shop" src="https://api.qrserver.com/v1/create-qr-code/?size=220x220&margin=8&data=${encodeURIComponent(link)}">
        <p class="muted small">Print the QR code for your shop door and counter. Put the link in your WhatsApp Business profile and status.</p>`
        : `<p class="muted">${on ? 'Deploy the web app first to get a link.' : 'Turn on “Take orders online” and add your WhatsApp number to get your shop link.'}</p>`}</div>
  </div>

  <div class="rcols">
    <div class="card"><div class="row between"><h3 style="margin:0">${icon('truck')} Delivery areas</h3><button class="btn sm" data-act="opt-edit" data-type="DELIVERY">${icon('plus', 'sm')} Add area</button></div>
      <p class="muted small">Customers pay this fee on top of their items.</p>
      ${del.length ? del.map((o) => optRow(o)).join('') : '<div class="empty">No delivery areas — customers can only pick up.</div>'}</div>
    <div class="card"><div class="row between"><h3 style="margin:0">${icon('store')} Pickup places</h3><button class="btn sm" data-act="opt-edit" data-type="PICKUP">${icon('plus', 'sm')} Add place</button></div>
      <p class="muted small">Your shop or agreed meeting points.</p>
      ${pick.length ? pick.map((o) => optRow(o)).join('') : '<div class="empty">No pickup places — customers can only choose delivery.</div>'}</div>
  </div>

  <div class="card" style="margin-top:1rem"><div class="row between"><h3 style="margin:0">${icon('image')} Products in the shop</h3>
      <div class="searchbox" style="max-width:280px">${icon('search')}<input id="shop-q" type="text" placeholder="Find product" value="${esc(S.ui.shopQ || '')}" data-input="shop-q"></div></div>
    <p class="muted small">Tick to show a product online. Add a clear photo — it sells much better.</p>
    <div class="plist">${prods.map((p) => `<div class="list-item">
      ${p.ImageURL ? `<img class="pthumb" src="${esc(p.ImageURL)}" alt="" referrerpolicy="no-referrer">` : `<span class="pthumb ph">${esc(initials(p.Name))}</span>`}
      <span class="grow"><b>${esc(p.Name)}</b><div class="muted small">${esc(p.Description || 'No description')}</div></span>
      <label class="check" style="margin:0"><input type="checkbox" data-act="online-toggle" data-id="${esc(p.ProductID)}" ${p.ShowOnline ? 'checked' : ''}> Online</label>
      <button class="btn sm" data-act="photo-pick" data-id="${esc(p.ProductID)}">${icon('image', 'sm')} Photo</button>
      <button class="btn sm ghost" data-act="desc-edit" data-id="${esc(p.ProductID)}">Edit</button></div>`).join('')}</div>
    <input type="file" id="photo-file" accept="image/*" capture="environment" hidden>
  </div>`;
}

function optRow(o) {
  const active = !(o.Active === false || String(o.Active).toUpperCase() === 'FALSE');
  return `<div class="list-item ${active ? '' : 'muted'}"><span class="grow"><b>${esc(o.Name)}</b>${o.Details ? `<div class="muted small">${esc(o.Details)}</div>` : ''}${active ? '' : ' <span class="badge">hidden</span>'}</span>
    ${o.Type === 'DELIVERY' ? `<b class="num">${num(o.Fee) ? fmtCur(o.Fee, o.Currency) : 'Free'}</b>` : ''}
    <button class="btn sm ghost" data-act="opt-edit" data-id="${esc(o.OptionID)}">Edit</button></div>`;
}

function optForm(o, type) {
  o = o || { Type: type, Currency: 'USD', Fee: '', Active: true };
  const del = o.Type === 'DELIVERY';
  const active = !(o.Active === false || String(o.Active).toUpperCase() === 'FALSE');
  return `<div class="modal-head"><h2>${o.OptionID ? 'Edit' : 'Add'} ${del ? 'delivery area' : 'pickup place'}</h2><button class="btn ghost icon" data-act="close">${icon('x')}</button></div>
    <form data-form="opt" data-id="${esc(o.OptionID || '')}" data-type="${esc(o.Type)}">
      <div class="field"><label>${del ? 'Area name' : 'Place name'}</label><input name="name" type="text" required value="${esc(o.Name || '')}" placeholder="${del ? 'e.g. Sinkor' : 'e.g. ELWA Junction'}"></div>
      ${del ? `<div class="grid2"><div class="field"><label>Fee currency</label><select name="currency"><option ${o.Currency === 'USD' ? 'selected' : ''}>USD</option><option ${o.Currency === 'LRD' ? 'selected' : ''}>LRD</option></select></div>
        <div class="field"><label>Delivery fee (0 = free)</label><input name="fee" type="number" step="any" min="0" value="${esc(o.Fee)}"></div></div>` : ''}
      <div class="field"><label>Details shown to customers (optional)</label><input name="details" type="text" value="${esc(o.Details || '')}" placeholder="${del ? 'e.g. Same day if ordered before 2pm' : 'e.g. Weekdays after 4pm, we agree the time on WhatsApp'}"></div>
      <label class="check"><input type="checkbox" name="active" ${active ? 'checked' : ''}> Show to customers</label>
      <button class="btn primary block" style="margin-top:1rem" type="submit">Save</button></form>`;
}

function descForm(p) {
  return `<div class="modal-head"><h2>${esc(p.Name)}</h2><button class="btn ghost icon" data-act="close">${icon('x')}</button></div>
    <form data-form="desc" data-id="${esc(p.ProductID)}">
      <div class="field"><label>Description shown in the shop</label><textarea name="description" rows="4" placeholder="Material, size, colours, what it is good for">${esc(p.Description || '')}</textarea></div>
      <div class="field"><label>Photo link (or use the Photo button to upload)</label><input name="imageUrl" type="url" value="${esc(p.ImageURL || '')}" placeholder="https://… or a Google Drive share link"></div>
      <button class="btn primary block" type="submit">Save</button></form>`;
}

/** Resize a photo on the device (max 900px, JPEG) before uploading. */
function resizeImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const max = 900;
      const k = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', 0.82));
    };
    img.onerror = () => reject(new Error('Could not read that photo'));
    img.src = url;
  });
}

/* =====================================================================
 * Stock
 * ===================================================================== */
function viewStock() {
  const stock = stockMap();
  const q = (S.ui.stockQ || '').toLowerCase();
  const showLow = S.ui.stockLow;
  const list = (S.snap.products || []).filter((p) => (!q || (p.Name + ' ' + p.SKU + ' ' + p.Category).toLowerCase().indexOf(q) >= 0))
    .filter((p) => !showLow || (stock[p.ProductID] || 0) <= num(p.ReorderLevel));
  const canIntake = can('STOCK_INTAKE') && !(store().Type === 'SHOP' && !bool(setting('ShopsBuyFromSuppliers')));
  const lowCount = (S.snap.products || []).filter((p) => (stock[p.ProductID] || 0) <= num(p.ReorderLevel)).length;
  return `<div class="page-head"><h2>Stock — ${esc(store().Name)}</h2>
      <div class="row">${canIntake ? `<button class="btn primary" data-act="intake">${icon('plus', 'sm')} Receive stock</button>` : ''}
      ${can('STOCK_ADJUST') ? `<button class="btn" data-act="adjust">${icon('sliders', 'sm')} Adjust / count</button>` : ''}</div></div>
    <div class="row" style="margin-bottom:.6rem"><div class="searchbox grow" style="max-width:380px">${icon('search')}<input id="stock-q" type="text" placeholder="Search stock" value="${esc(S.ui.stockQ || '')}" data-input="stock-q"></div>
      <button class="chip-f ${showLow ? 'on' : ''}" data-act="toggle-low">Low stock (${lowCount})</button></div>
    <div class="card table-wrap" id="stock-table"><table><thead><tr><th>Product</th><th>Category</th><th class="right">In stock</th><th class="right">Reorder at</th><th>Price</th></tr></thead><tbody>
      ${list.map((p) => { const qn = stock[p.ProductID] || 0; const cls = qn <= 0 ? 'bad' : qn <= num(p.ReorderLevel) ? 'warn' : 'ok';
        return `<tr><td><b>${esc(p.Name)}</b><div class="muted small">${esc(p.SKU || '')}${p.Sells === false ? ' · not sold here' : ''}</div></td><td>${esc(p.Category)}</td>
        <td class="right"><span class="badge ${cls}">${fmtQty(qn)} ${esc(p.Unit || '')}</span></td><td class="right num">${fmtQty(p.ReorderLevel)}</td>
        <td class="num">${fmtCur(p.SellingPrice, p.PriceCurrency)}</td></tr>`; }).join('') || '<tr><td colspan="5" class="empty">Nothing here</td></tr>'}
    </tbody></table></div>`;
}

function productOptions(sel) {
  return (S.snap.products || []).map((p) => `<option value="${esc(p.ProductID)}" ${p.ProductID === sel ? 'selected' : ''}>${esc(p.Name)}</option>`).join('');
}

let lines = []; // shared editable item lines for intake / adjust / transfer forms
function linesEditor(kind) {
  const withCost = kind === 'intake';
  return `<div id="lines">${lines.map((l, i) => `<div class="row" style="margin-bottom:.4rem">
      <select class="grow" data-input="line" data-i="${i}" data-f="productId" style="min-width:160px">${productOptions(l.productId)}</select>
      <input type="number" step="any" placeholder="${kind === 'adjust' ? '± qty' : 'Qty'}" value="${esc(l.qty)}" data-input="line" data-i="${i}" data-f="qty" style="width:90px">
      ${withCost ? `<input type="number" step="any" placeholder="Unit cost" value="${esc(l.unitCost)}" data-input="line" data-i="${i}" data-f="unitCost" style="width:110px">` : ''}
      <button class="btn ghost icon sm" type="button" data-act="line-del" data-i="${i}">${icon('trash', 'sm')}</button></div>`).join('')}</div>
    <button class="btn sm" type="button" data-act="line-add" data-kind="${kind}">${icon('plus', 'sm')} Add item</button>`;
}

function intakeModal() {
  const sups = S.snap.suppliers || [];
  return `<div class="modal-head"><h2>Receive stock from supplier</h2><button class="btn ghost icon" data-act="close">${icon('x')}</button></div>
    <form data-form="intake">
      <div class="grid2"><div class="field"><label>Supplier</label><select name="supplierId"><option value="">— none —</option>${sups.map((s) => `<option value="${esc(s.SupplierID)}">${esc(s.Name)}</option>`).join('')}</select></div>
      <div class="field"><label>Invoice no.</label><input name="invoiceNo" type="text"></div></div>
      <div class="grid2"><div class="field"><label>Currency of costs</label><select name="currency"><option>USD</option><option>LRD</option></select></div>
      <div class="field"><label>Amount paid now</label><input name="paid" type="number" step="any" value="0"></div></div>
      <label>Items</label>${linesEditor('intake')}
      <button class="btn primary block" style="margin-top:1rem" type="submit">Save intake</button></form>`;
}

function adjustModal() {
  return `<div class="modal-head"><h2>Adjust stock</h2><button class="btn ghost icon" data-act="close">${icon('x')}</button></div>
    <form data-form="adjust">
      <div class="field"><label>Reason</label><select name="reason">${['Damaged', 'Lost / stolen', 'Count correction', 'Opening stock', 'Returned to supplier', 'Other'].map((x) => `<option>${x}</option>`).join('')}</select></div>
      <p class="muted small">Enter a negative number to remove stock (e.g. −2 damaged) and a positive number to add.</p>
      ${linesEditor('adjust')}
      <button class="btn primary block" style="margin-top:1rem" type="submit">Save adjustment</button></form>`;
}

/* =====================================================================
 * Transfers
 * ===================================================================== */
function transferTargets(direction) {
  const me = store();
  const whOn = bool(setting('WarehouseEnabled'));
  const s2s = bool(setting('ShopToShopTransfers'));
  return (S.snap.stores || []).filter((s) => s.Status === 'ACTIVE' && s.StoreID !== me.StoreID)
    .filter((s) => whOn || (s.Type !== 'WAREHOUSE' && me.Type !== 'WAREHOUSE'))
    .filter((s) => s2s || !(s.Type === 'SHOP' && me.Type === 'SHOP'));
}

const ST_BADGE = { REQUESTED: 'warn', APPROVED: 'dark', DISPATCHED: 'warn', RECEIVED: 'ok', CANCELLED: 'bad' };
function viewTransfers() {
  const me = store().StoreID;
  const list = transfers();
  const approval = bool(setting('TransferApproval'));
  const targets = transferTargets();
  return `<div class="page-head"><h2>Transfers</h2><div class="row">
      ${can('TRANSFER_REQUEST') && me !== 'HQ' && targets.length ? '<button class="btn primary" data-act="transfer-new" data-mode="REQUEST">Request stock</button>' : ''}
      ${can('TRANSFER_DISPATCH') && me !== 'HQ' && targets.length ? '<button class="btn" data-act="transfer-new" data-mode="SEND">Send stock</button>' : ''}</div></div>
    ${list.length ? list.map((t) => {
      const acts = [];
      if (t.Status === 'REQUESTED' && can('TRANSFER_APPROVE')) acts.push(['APPROVE', 'Approve', 'primary']);
      if (t.FromStoreID === me && can('TRANSFER_DISPATCH') && (t.Status === 'APPROVED' || (t.Status === 'REQUESTED' && !approval))) acts.push(['DISPATCH', 'Dispatch', 'primary']);
      if (t.ToStoreID === me && can('TRANSFER_RECEIVE') && t.Status === 'DISPATCHED') acts.push(['RECEIVE', 'Confirm received', 'accent']);
      if ((t.Status === 'REQUESTED' || t.Status === 'APPROVED') && canAny('TRANSFER_APPROVE', 'TRANSFER_REQUEST')) acts.push(['CANCEL', 'Cancel', 'danger']);
      return `<div class="card" style="margin-bottom:.6rem">
        <div class="row between"><div><b>${esc(storeName(t.FromStoreID))} → ${esc(storeName(t.ToStoreID))}</b>
          <div class="muted small">${fmtDate(t.CreatedAt)}${t.Note ? ' · ' + esc(t.Note) : ''}</div></div>
          <span class="badge ${ST_BADGE[t.Status] || ''}">${t.Status}${t._pending ? ' · not synced' : ''}</span></div>
        <table style="margin-top:.4rem"><thead><tr><th>Item</th><th class="right">Asked</th><th class="right">Sent</th><th class="right">Received</th></tr></thead><tbody>
          ${t.items.map((i) => `<tr><td>${esc((productById(i.ProductID) || {}).Name || i.ProductID)}</td><td class="right num">${fmtQty(i.QtyRequested)}</td>
            <td class="right num">${i.QtySent === '' || i.QtySent === undefined ? '—' : fmtQty(i.QtySent)}</td>
            <td class="right num">${i.QtyReceived === '' || i.QtyReceived === undefined ? '—' : fmtQty(i.QtyReceived)}</td></tr>`).join('')}</tbody></table>
        ${acts.length ? `<div class="row" style="margin-top:.6rem">${acts.map((a) => `<button class="btn sm ${a[2]}" data-act="transfer-act" data-id="${esc(t.TransferID)}" data-a="${a[0]}">${a[1]}</button>`).join('')}</div>` : ''}
      </div>`;
    }).join('') : '<div class="card empty">No transfers yet.</div>'}`;
}

function transferModal(mode) {
  const targets = transferTargets();
  return `<div class="modal-head"><h2>${mode === 'REQUEST' ? 'Request stock' : 'Send stock'}</h2><button class="btn ghost icon" data-act="close">${icon('x')}</button></div>
    <form data-form="transfer" data-mode="${mode}">
      <div class="field"><label>${mode === 'REQUEST' ? 'Request from' : 'Send to'}</label>
        <select name="other">${targets.map((s) => `<option value="${esc(s.StoreID)}">${esc(s.Code + ' ' + s.Name)}${s.Type === 'WAREHOUSE' ? ' (warehouse)' : ''}</option>`).join('')}</select></div>
      <label>Items</label>${linesEditor('transfer')}
      <div class="field" style="margin-top:.6rem"><label>Note</label><input name="note" type="text"></div>
      <button class="btn primary block" type="submit">${mode === 'REQUEST' ? 'Send request' : 'Send stock now'}</button></form>`;
}

function transferQtyModal(t, action) {
  return `<div class="modal-head"><h2>${action === 'DISPATCH' ? 'Dispatch' : 'Confirm received'}</h2><button class="btn ghost icon" data-act="close">${icon('x')}</button></div>
    <form data-form="transfer-qty" data-id="${esc(t.TransferID)}" data-a="${action}">
      <p class="muted small">${action === 'DISPATCH' ? 'Quantity actually sent' : 'Quantity actually received — any difference is reported to the owner'}.</p>
      ${t.items.map((i) => `<div class="row" style="margin-bottom:.4rem"><span class="grow">${esc((productById(i.ProductID) || {}).Name || i.ProductID)}</span>
        <input type="number" step="any" name="q-${esc(i.ProductID)}" value="${esc(action === 'DISPATCH' ? i.QtyRequested : i.QtySent)}" style="width:110px"></div>`).join('')}
      <button class="btn primary block" type="submit">${action === 'DISPATCH' ? 'Dispatch' : 'Confirm'}</button></form>`;
}

/* =====================================================================
 * Money (expenses & income)
 * ===================================================================== */
function viewMoney() {
  const tab = S.ui.moneyTab || (can('EXPENSE_RECORD') ? 'expense' : 'income');
  const cats = (S.snap.categories || []).filter((c) => c.Type === (tab === 'expense' ? 'EXPENSE' : 'INCOME'));
  const recent = S.journal.filter((r) => r.type === 'expense' || r.type === 'income').slice(-30).reverse();
  return `<div class="page-head"><div><h2>Money</h2><div class="sub">Expenses and other income for ${esc(store().Name)}</div></div></div><div class="tabs">
      ${can('EXPENSE_RECORD') ? `<button class="tab ${tab === 'expense' ? 'on' : ''}" data-act="money-tab" data-t="expense">Expense</button>` : ''}
      ${can('INCOME_RECORD') ? `<button class="tab ${tab === 'income' ? 'on' : ''}" data-act="money-tab" data-t="income">Other income</button>` : ''}</div>
    <div class="card"><form data-form="money" data-t="${tab}">
      <div class="grid2"><div class="field"><label>Category</label><select name="category">${cats.map((c) => `<option>${esc(c.Name)}</option>`).join('')}</select></div>
        <div class="field"><label>${tab === 'expense' ? 'Paid to' : 'Received from'}</label><input name="party" type="text"></div></div>
      <div class="field"><label>Description</label><input name="description" type="text"></div>
      <div class="grid2"><div class="field"><label>Currency</label><select name="currency"><option>LRD</option><option>USD</option></select></div>
        <div class="field"><label>Amount</label><input name="amount" type="number" step="any" required></div></div>
      <button class="btn primary block" type="submit">Save ${tab === 'expense' ? 'expense' : 'income'}</button></form></div>
    <h3 style="margin-top:1.2rem">Recorded on this device</h3>
    <div class="card table-wrap"><table><tbody>${recent.map((r) => `<tr><td>${fmtDate(r.timestamp)}</td><td><span class="badge ${r.type === 'expense' ? 'bad' : 'ok'}">${r.type}</span> ${esc(r.category)}<div class="muted small">${esc(r.description || '')}</div></td>
      <td class="right num">${fmtCur(r.amount, r.currency)}</td></tr>`).join('') || '<tr><td class="empty">Nothing yet</td></tr>'}</tbody></table></div>`;
}

/* =====================================================================
 * Customers
 * ===================================================================== */
function viewCustomers() {
  const q = (S.ui.custListQ || '').toLowerCase();
  const list = customers().filter((c) => !q || (c.Name + ' ' + c.Phone).toLowerCase().indexOf(q) >= 0);
  const total = list.reduce((t, c) => t + Math.max(0, c.BalanceUSD), 0);
  return `<div class="page-head"><h2>Customers & credit</h2>
      ${canAny('CUSTOMER_MANAGE', 'CREDIT_SALE') ? `<button class="btn primary" data-act="new-customer">${icon('plus', 'sm')} New customer</button>` : ''}</div>
    <div class="kpis" style="margin-bottom:.8rem"><div class="kpi"><div class="k">Owed to the business</div><div class="v">${fmtUSD(total)}</div><div class="s">${fmtLRD(total * rate())}</div></div>
      <div class="kpi"><div class="k">Customers</div><div class="v">${list.length}</div></div></div>
    <div class="searchbox" style="max-width:380px;margin-bottom:.8rem">${icon('search')}<input id="custlist-q" type="text" placeholder="Search name or phone" value="${esc(S.ui.custListQ || '')}" data-input="custlist-q"></div>
    <div class="card table-wrap" id="cust-table"><table><thead><tr><th>Customer</th><th class="right">Balance</th><th></th></tr></thead><tbody>
      ${list.map((c) => `<tr><td><b>${esc(c.Name)}</b>${c._pending ? ' <span class="badge warn">not synced</span>' : ''}<div class="muted small">${esc(c.Phone)}${num(c.CreditLimitUSD) ? ' · limit ' + fmtUSD(c.CreditLimitUSD) : ''}</div></td>
        <td class="right num"><b class="${c.BalanceUSD > 0.004 ? '' : 'muted'}">${fmtUSD(c.BalanceUSD)}</b><div class="muted small">${fmtLRD(c.BalanceUSD * rate())}</div></td>
        <td class="right">${can('CREDIT_COLLECT') && c.BalanceUSD > 0.004 ? `<button class="btn sm primary" data-act="collect" data-id="${esc(c.CustomerID)}">Receive payment</button>` : ''}
        ${can('CUSTOMER_MANAGE') ? `<button class="btn sm ghost" data-act="edit-customer" data-id="${esc(c.CustomerID)}">Edit</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="3" class="empty">No customers</td></tr>'}
    </tbody></table></div>`;
}

function collectModal(c) {
  return `<div class="modal-head"><h2>Payment from ${esc(c.Name)}</h2><button class="btn ghost icon" data-act="close">${icon('x')}</button></div>
    <div class="due"><div class="usd">${fmtUSD(c.BalanceUSD)}</div><div class="lrd">owed · ${fmtLRD(c.BalanceUSD * rate())}</div></div>
    <form data-form="collect" data-id="${esc(c.CustomerID)}">
      <div class="grid2"><div class="field"><label>Paid with</label><select name="method">${METHODS.filter((m) => m[0] !== 'CREDIT').map((m) => `<option value="${m[0]}">${m[1]}</option>`).join('')}</select></div>
        <div class="field"><label>Currency</label><select name="currency"><option>LRD</option><option>USD</option></select></div></div>
      <div class="field"><label>Amount</label><input name="amount" type="number" step="any" required></div>
      <button class="btn primary block" type="submit">Save payment</button></form>`;
}

/* =====================================================================
 * Shift (till open / close)
 * ===================================================================== */
function shiftExpected() {
  const sh = S.shift;
  const out = { usd: num(sh.openingUSD), lrd: num(sh.openingLRD), sales: 0, salesUSD: 0 };
  S.journal.filter((r) => r.timestamp >= sh.openedAt && r.userId === sh.userId).forEach((r) => {
    if (r.type === 'sale') {
      out.sales++;
      r.payments.forEach((p) => {
        if (p.method === 'USD_CASH') out.usd += num(p.amount);
        if (p.method === 'LRD_CASH') out.lrd += num(p.amount);
        out.salesUSD += toUSDAt(p.amount, p.currency, r.rate);
      });
      // change handed back
      const total = r.items.reduce((t, i) => t + toUSDAt(i.unitPrice * i.qty, i.priceCurrency, r.rate), 0) - num(r.discountUSD);
      const paid = r.payments.reduce((t, p) => t + toUSDAt(p.amount, p.currency, r.rate), 0);
      const ch = Math.max(0, paid - total);
      if (r.changeCurrency === 'USD') out.usd -= ch; else out.lrd -= Math.round(ch * num(r.rate));
    }
    if (r.type === 'customerPayment') { if (r.method === 'USD_CASH') out.usd += num(r.amount); if (r.method === 'LRD_CASH') out.lrd += num(r.amount); }
    if (r.type === 'expense') { if (r.currency === 'USD') out.usd -= num(r.amount); else out.lrd -= num(r.amount); }
  });
  return out;
}

function viewShift() {
  if (!S.shift) {
    return `<div class="page-head"><div><h2>Till shift</h2><div class="sub">Open with your cash float, close with a cash count</div></div></div><div class="card" style="max-width:520px"><p>Open a shift at the start of the day with the cash in the drawer. At closing you count the cash and the app compares it with what it should be.</p>
      <form data-form="shift-open"><div class="grid2"><div class="field"><label>Opening cash USD</label><input name="usd" type="number" step="any" value="0"></div>
      <div class="field"><label>Opening cash LRD</label><input name="lrd" type="number" step="any" value="0"></div></div>
      <button class="btn primary block" type="submit">Open shift</button></form></div>`;
  }
  const e = shiftExpected();
  return `<div class="page-head"><div><h2>Till shift</h2><div class="sub">Open with your cash float, close with a cash count</div></div></div><div class="card" style="max-width:620px">
    <p>Opened ${fmtDate(S.shift.openedAt)} by <b>${esc(userName(S.shift.userId))}</b> · ${e.sales} sale(s)</p>
    <div class="kpis"><div class="kpi"><div class="k">Expected USD in drawer</div><div class="v">${fmtUSD(e.usd)}</div></div>
      <div class="kpi"><div class="k">Expected LRD in drawer</div><div class="v">${fmtLRD(e.lrd)}</div></div></div>
    <p class="muted small">Expected = opening cash + cash sales + cash debt repayments − change given − expenses paid on this device.</p>
    ${S.shift.userId === S.session.user.UserID || can('SALE_VOID') ? `<form data-form="shift-close"><div class="grid2"><div class="field"><label>Counted USD</label><input name="usd" type="number" step="any" required></div>
      <div class="field"><label>Counted LRD</label><input name="lrd" type="number" step="any" required></div></div>
      <div class="field"><label>Note</label><input name="note" type="text"></div>
      <button class="btn accent block" type="submit">Close shift</button></form>` : '<p class="muted">Only the person who opened the shift or a manager can close it.</p>'}</div>`;
}

/* =====================================================================
 * Reports (online)
 * ===================================================================== */
let reportCache = null;
function periodRange(p) {
  const d = new Date(); d.setHours(0, 0, 0, 0);
  const tomorrow = new Date(d.getTime() + 86400000);
  if (p === 'today') return [d, tomorrow];
  if (p === 'yesterday') return [new Date(d.getTime() - 86400000), d];
  if (p === 'week') return [new Date(d.getTime() - 6 * 86400000), tomorrow];
  if (p === 'month') return [new Date(d.getFullYear(), d.getMonth(), 1), tomorrow];
  return [new Date(0), tomorrow];
}

function viewReports() {
  const periods = [['today', 'Today'], ['yesterday', 'Yesterday'], ['week', 'Last 7 days'], ['month', 'This month'], ['all', 'All time']];
  const stores = (S.snap.stores || []).filter((s) => s.Status === 'ACTIVE');
  const myStores = S.session.user.StoreIDs === 'ALL' || (S.session.role && S.session.role.Scope === 'ALL_STORES') ? stores.map((s) => s.StoreID) : String(S.session.user.StoreIDs || '').split(',');
  const opts = [];
  if (can('REPORTS_ALL')) opts.push(['all', 'All stores']);
  stores.filter((s) => myStores.indexOf(s.StoreID) >= 0).forEach((s) => opts.push([s.StoreID, s.Code + ' ' + s.Name]));
  if (S.ui.reportStore === 'mine') S.ui.reportStore = can('REPORTS_ALL') && store().StoreID === 'HQ' ? 'all' : (myStores.indexOf(store().StoreID) >= 0 ? store().StoreID : (opts[0] || [''])[0]);
  const r = reportCache && reportCache.key === S.ui.reportPeriod + '|' + S.ui.reportStore ? reportCache.report : null;
  return `<div class="page-head"><div><h2>Reports</h2><div class="sub">Every amount in US dollars, with Liberian dollars underneath</div></div>
      <select id="rep-store" data-input="rep-store" style="max-width:280px">${opts.map((o) => `<option value="${esc(o[0])}" ${S.ui.reportStore === o[0] ? 'selected' : ''}>${esc(o[1])}</option>`).join('')}</select></div>
    <div class="tabs">${periods.map((p) => `<button class="tab ${S.ui.reportPeriod === p[0] ? 'on' : ''}" data-act="rep-period" data-p="${p[0]}">${p[1]}</button>`).join('')}
      <button class="tab" data-act="rep-load">${icon('sync', 'sm')} Refresh</button></div>
    <div id="report-body">${r ? reportBody(r) : `<div class="card empty">${S.ui.repLoading ? 'Loading report…' : (S.ui.repError ? esc(S.ui.repError) : 'Tap Refresh to load the report (needs internet).')}</div>`}</div>`;
}

const PERIOD_LABEL = { today: 'today', yesterday: 'yesterday', week: 'in the last 7 days', month: 'this month', all: 'so far' };

function bigCard(label, usd, lrd, note, cls) {
  return `<div class="rcard ${cls || ''}"><div class="k">${label}</div>
    <div class="v">${fmtUSD(usd)}</div><div class="v2">${fmtLRD(lrd)}</div>${note ? `<div class="s">${note}</div>` : ''}</div>`;
}

function reportBody(r) {
  const t = r.totals;
  const hasProfit = t.netProfitUSD !== undefined;
  const when = PERIOD_LABEL[S.ui.reportPeriod] || '';
  const taken = r.taken || { usd: 0, lrd: 0 };
  const methods = Object.keys(r.byPayment).map((k) => Object.assign({ k }, r.byPayment[k])).sort((a, b) => b.amountUSD - a.amountUSD);
  const maxPay = Math.max(1, ...methods.map((m) => m.amountUSD));
  const daily = r.daily || [];
  const maxDay = Math.max(1, ...daily.map((d) => d.salesUSD));
  const stores = Object.keys(r.byStore);
  const mini = [];
  if (hasProfit) mini.push(['Cost of goods sold', fmtUSD(t.cogsUSD), fmtLRD(t.cogsLRD)], ['Gross profit', fmtUSD(t.grossProfitUSD), fmtLRD(t.grossProfitLRD)]);
  mini.push(['Other income', fmtUSD(t.incomeUSD), fmtLRD(t.incomeLRD)], ['Sold on credit', fmtUSD(t.creditSalesUSD), fmtLRD(t.creditSalesUSD * rate()) + ' today']);
  mini.push(['Customers owe you', fmtUSD(t.creditOutstandingUSD), fmtLRD(t.creditOutstandingUSD * rate()) + ' today']);
  if (hasProfit && t.stockValueUSD !== undefined) mini.push(['Stock value (cost)', fmtUSD(t.stockValueUSD), fmtLRD(t.stockValueUSD * rate()) + ' today']);
  if (t.discountUSD) mini.push(['Discounts given', fmtUSD(t.discountUSD), '']);

  return `
  <div class="rgrid">
    ${bigCard('Sales', t.salesUSD, t.salesLRD, `${t.salesCount} sale${t.salesCount === 1 ? '' : 's'} ${when}`, 'brand')}
    ${bigCard('Expenses', t.expensesUSD, t.expensesLRD, 'rent, fuel, salaries and other costs')}
    ${hasProfit ? bigCard('Profit', t.netProfitUSD, t.netProfitLRD, 'sales − cost of goods − expenses + other income', t.netProfitUSD >= 0 ? 'good' : 'bad')
      : `<div class="rcard"><div class="k">Profit</div><div class="s" style="margin-top:.6rem">Only the owner and managers can see profit.</div></div>`}
    <div class="rcard"><div class="k">Money taken in</div>
      <div class="v">${fmtUSD(taken.usd)}</div><div class="v">${fmtLRD(taken.lrd)}</div>
      <div class="s">cash + mobile money, after change. Should match your drawer and phones.</div></div>
  </div>

  <div class="card" style="margin-top:1rem"><div class="ministats">${mini.map((m) => `<div><div class="k">${m[0]}</div><div class="v">${m[1]}</div><div class="s">${m[2]}</div></div>`).join('')}</div></div>

  <div class="rcols">
    <div class="card"><h3>Daily sales · last 14 days</h3>
      ${daily.length ? `<div class="bars">${daily.map((d) => {
        const dt = new Date(d.date + 'T12:00:00Z');
        const isToday = d.date === new Date().toISOString().slice(0, 10);
        return `<div class="bar ${isToday ? 'today' : ''}" title="${dt.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}: ${fmtUSD(d.salesUSD)} · ${fmtLRD(d.salesLRD)} · ${d.count} sales">
          <span class="amt">${d.salesUSD >= 1000 ? '$' + (d.salesUSD / 1000).toFixed(1) + 'k' : '$' + Math.round(d.salesUSD)}</span>
          <span class="col" style="height:${Math.max(2, Math.round(d.salesUSD / maxDay * 100))}%"></span>
          <span class="lbl">${dt.toLocaleDateString('en-GB', { day: 'numeric' })}<br>${dt.toLocaleDateString('en-GB', { weekday: 'narrow' })}</span></div>`;
      }).join('')}</div>` : '<div class="empty">No data</div>'}</div>

    <div class="card"><h3>How customers paid</h3>
      ${methods.length ? methods.map((m) => { const mm = METHODS.find((x) => x[0] === m.k);
        return `<div class="payrow"><div class="row between"><span class="row">${icon(mm ? mm[3] : 'cash', 'sm')} <b>${esc(mm ? mm[1] : m.k)}</b> <span class="muted small">${m.count}×</span></span>
          <span class="num"><b>${fmtUSD(m.amountUSD)}</b></span></div>
          <div class="meter"><span style="width:${Math.round(m.amountUSD / maxPay * 100)}%"></span></div>
          <div class="muted small">${m.k === 'CREDIT' ? 'not paid yet — added to customer balances' : 'received: ' + [m.tenderedUSD ? fmtUSD(m.tenderedUSD) : '', m.tenderedLRD ? fmtLRD(m.tenderedLRD) : ''].filter(Boolean).join(' + ')}</div></div>`; }).join('')
        : `<div class="empty">No sales ${when}</div>`}</div>
  </div>

  ${stores.length > 1 ? `<div class="card" style="margin-top:1rem"><h3>Stores</h3><div class="table-wrap"><table><thead><tr><th>Store</th><th class="right">Sales</th><th class="right">Expenses</th>${hasProfit ? '<th class="right">Profit</th>' : ''}<th class="right">Sales</th></tr></thead><tbody>
    ${stores.map((k) => { const a = r.byStore[k]; const st = (S.snap.stores || []).find((x) => x.StoreID === k) || {};
      return `<tr><td><span class="store-dot" style="background:${esc(st.Color || themeColor())}"></span><b>${esc(storeName(k))}</b></td>
        <td class="right num"><b>${fmtUSD(a.salesUSD)}</b><div class="muted small">${fmtLRD(a.salesLRD)}</div></td>
        <td class="right num">${fmtUSD(a.expensesUSD)}<div class="muted small">${fmtLRD(a.expensesLRD)}</div></td>
        ${hasProfit ? `<td class="right num"><b style="color:${a.netProfitUSD < 0 ? 'var(--bad)' : 'var(--ok)'}">${fmtUSD(a.netProfitUSD)}</b><div class="muted small">${fmtLRD(a.netProfitLRD)}</div></td>` : ''}
        <td class="right num muted">${a.salesCount}</td></tr>`; }).join('')}</tbody></table></div></div>` : ''}

  <div class="rcols">
    <div class="card"><h3>Best sellers</h3>${r.topByRevenue.length ? r.topByRevenue.slice(0, 8).map((p, i) => `<div class="list-item">
      <span class="rank">${i + 1}</span><span class="grow"><b>${esc(p.name)}</b><div class="muted small">${fmtQty(p.qty)} sold${p.profitUSD !== undefined ? ' · profit ' + fmtUSD(p.profitUSD) : ''}</div></span>
      <b class="num">${fmtUSD(p.revenueUSD)}</b></div>`).join('') : `<div class="empty">No sales ${when}</div>`}</div>
    <div class="card"><h3>Needs attention</h3>
      ${r.lowStock.length ? r.lowStock.slice(0, 8).map((x) => `<div class="list-item"><span class="grow"><b>${esc(x.product)}</b><div class="muted small">${esc(x.store)} · reorder at ${fmtQty(x.reorderLevel)}</div></span>
        <span class="badge ${x.qty <= 0 ? 'bad' : 'warn'}">${fmtQty(x.qty)} left</span></div>`).join('') + (r.lowStock.length > 8 ? `<p class="muted small">+ ${r.lowStock.length - 8} more low items — see Stock</p>` : '')
        : `<div class="empty">${icon('check')}Everything is well stocked</div>`}
      ${Object.keys(r.expensesByCategory).length ? `<h3 style="margin-top:1rem">Where expenses went</h3>${Object.keys(r.expensesByCategory).sort((a, b) => r.expensesByCategory[b].usd - r.expensesByCategory[a].usd).map((k) =>
        `<div class="list-item"><span class="grow">${esc(k)}</span><span class="num right"><b>${fmtUSD(r.expensesByCategory[k].usd)}</b><div class="muted small">${fmtLRD(r.expensesByCategory[k].lrd)}</div></span></div>`).join('')}` : ''}
    </div>
  </div>`;
}

async function loadReport() {
  const [from, to] = periodRange(S.ui.reportPeriod);
  const storeIds = S.ui.reportStore === 'all' ? [] : [S.ui.reportStore];
  S.ui.repLoading = true; S.ui.repError = ''; render();
  try {
    const res = await adminCall('report', { from: from.toISOString(), to: to.toISOString(), storeIds });
    reportCache = { key: S.ui.reportPeriod + '|' + S.ui.reportStore, report: res.report };
  } catch (e) { S.ui.repError = e.message; reportCache = null; }
  S.ui.repLoading = false;
  render();
}

/* =====================================================================
 * Admin (online)
 * ===================================================================== */
function adminTabs() {
  const t = [];
  if (canAny('RATE_SET_GLOBAL', 'RATE_SET_STORE')) t.push(['rate', 'Exchange rate']);
  t.push(['stores', 'Stores']);
  if (can('USER_MANAGE')) t.push(['users', 'Users']);
  if (can('DEVICE_MANAGE')) t.push(['devices', 'Devices']);
  if (canAny('PRODUCT_MANAGE', 'PRICE_MANAGE')) t.push(['products', 'Products']);
  if (canAny('SHOP_MANAGE', 'STORE_MANAGE') && (store().Type === 'SHOP' || store().StoreID === 'HQ')) t.push(['shop', 'Online shop']);
  if (can('SETTINGS_MANAGE')) t.push(['settings', 'Owner settings']);
  return t;
}

function viewAdmin() {
  const tabs = adminTabs();
  if (!S.ui.adminTab || !tabs.some((x) => x[0] === S.ui.adminTab)) S.ui.adminTab = tabs[0][0];
  const body = { rate: adminRate, stores: adminStores, users: adminUsers, devices: adminDevices, products: adminProducts, settings: adminSettings, shop: adminShop }[S.ui.adminTab];
  const needData = ['users', 'devices', 'products', 'settings'].indexOf(S.ui.adminTab) >= 0;
  return `<div class="page-head"><div><h2>Admin</h2><div class="sub">Manage stores, people, devices and settings</div></div></div><div class="tabs">${tabs.map((x) => `<button class="tab ${S.ui.adminTab === x[0] ? 'on' : ''}" data-act="admin-tab" data-t="${x[0]}">${x[1]}</button>`).join('')}</div>
    ${!S.session.token ? '<div class="card" style="background:#fbf0d9;margin-bottom:.8rem">You logged in offline. Admin changes need internet — log out and log in again while connected.</div>' : ''}
    ${needData && !S.admin ? `<div class="card empty">${S.ui.adminLoading ? 'Loading…' : `<button class="btn primary" data-act="admin-load">Load (needs internet)</button>`}</div>` : body()}`;
}

function adminRate() {
  const mode = setting('RateMode');
  const perStore = mode === 'PER_STORE';
  const st = store();
  return `<div class="card" style="max-width:560px">
    <p>Rate mode: <b>${perStore ? 'Each store sets its own rate' : 'One rate for all stores (set centrally)'}</b>${isOwner() ? ' — change in Owner settings' : ''}.</p>
    <p>Current rate here: <b>1 USD = ${rate()} LRD</b></p>
    ${perStore && st.StoreID !== 'HQ' && can('RATE_SET_STORE') ? `<form data-form="rate" data-scope="store"><div class="field"><label>New rate for ${esc(st.Name)} (LRD per 1 USD)</label><input name="rate" type="number" step="any" required></div>
      <button class="btn primary" type="submit">Set store rate</button></form>` : ''}
    ${can('RATE_SET_GLOBAL') ? `<form data-form="rate" data-scope="global" style="margin-top:1rem"><div class="field"><label>Business-wide rate (LRD per 1 USD)${perStore ? ' — used by stores without their own rate' : ''}</label>
      <input name="rate" type="number" step="any" required value="${esc(setting('GlobalRate'))}"></div><button class="btn primary" type="submit">Set business-wide rate</button></form>` : ''}
    ${!perStore && !can('RATE_SET_GLOBAL') ? '<p class="muted">The owner sets the rate for all stores.</p>' : ''}
    <p class="muted small">Sales already recorded keep the rate they were made at.</p></div>`;
}

function adminStores() {
  const stores = S.snap.stores || [];
  return `<div class="row between" style="margin-bottom:.6rem"><span class="muted">${stores.length} location(s)</span>
      ${can('STORE_MANAGE') ? `<button class="btn primary" data-act="store-new">${icon('plus', 'sm')} New store</button>` : ''}</div>
    <div class="card table-wrap"><table><thead><tr><th>Code</th><th>Name</th><th>Type</th><th>Rate</th><th>Status</th><th></th></tr></thead><tbody>
    ${stores.map((s) => `<tr><td><span class="store-dot" style="background:${esc(s.Color || setting('ThemeColor') || '#0F766E')}"></span><b>${esc(s.Code)}</b></td><td>${esc(s.Name)}<div class="muted small">${esc(s.Address || '')}</div></td><td>${esc(s.Type)}</td>
      <td class="num">${s.Rate ? esc(s.Rate) : '<span class="muted">global</span>'}</td><td><span class="badge ${s.Status === 'ACTIVE' ? 'ok' : 'bad'}">${esc(s.Status)}</span></td>
      <td class="right">${can('STORE_MANAGE') ? `<button class="btn sm" data-act="store-color" data-id="${esc(s.StoreID)}">${icon('palette', 'sm')} Colour</button>` : ''}
        ${can('STORE_MANAGE') && s.Status === 'ACTIVE' ? `<button class="btn sm danger" data-act="store-close" data-id="${esc(s.StoreID)}">Close</button>` : ''}
        ${can('STORE_MANAGE') && s.Status !== 'ACTIVE' ? `<button class="btn sm" data-act="store-reopen" data-id="${esc(s.StoreID)}">Reopen</button>` : ''}</td></tr>`).join('')}
    </tbody></table></div>`;
}

function storeForm() {
  const wh = bool(setting('WarehouseEnabled'));
  return `<div class="modal-head"><h2>New store</h2><button class="btn ghost icon" data-act="close">${icon('x')}</button></div>
    <form data-form="store">
      <div class="field"><label>Store name</label><input name="name" type="text" required placeholder="e.g. Duala Market Shop"></div>
      <div class="grid2"><div class="field"><label>Type</label><select name="type"><option value="SHOP">Shop (sells)</option>${wh ? '<option value="WAREHOUSE">Warehouse (holds & dispatches)</option>' : ''}</select></div>
        <div class="field"><label>Phone</label><input name="phone" type="tel"></div></div>
      <div class="field"><label>Address / location</label><input name="address" type="text"></div>
      ${setting('RateMode') === 'PER_STORE' ? '<div class="field"><label>Starting exchange rate (optional)</label><input name="rate" type="number" step="any"></div>' : ''}
      <div class="field"><label>Store colour</label>${colorPicker('color', '')}</div>
      <p class="muted small">Next: add staff in Users, then create a device setup code for this store.</p>
      <button class="btn primary block" type="submit">Create store</button></form>`;
}

function colorPicker(name, value) {
  const v = value || '';
  return `<div class="swatches" data-picker="${name}">
    ${SWATCHES.map((c) => `<button type="button" class="swatch ${v.toUpperCase() === c ? 'on' : ''}" style="background:${c}" data-act="pick-color" data-c="${c}" title="${c}"></button>`).join('')}
    <input type="color" value="${esc(v || '#0F766E')}" data-input="color-custom" title="Custom colour">
    <input type="hidden" name="${name}" value="${esc(v)}"></div>`;
}

function storeColorModal(st) {
  return `<div class="modal-head"><h2>Colour for ${esc(st.Name)}</h2><button class="btn ghost icon" data-act="close">${icon('x')}</button></div>
    <p class="muted">Devices in this store use this colour for buttons, the header and the login screen. It helps staff see at a glance which store a device belongs to.</p>
    <form data-form="store-color" data-id="${esc(st.StoreID)}">${colorPicker('color', st.Color || '')}
      <div class="row" style="margin-top:1.2rem"><button class="btn primary grow" type="submit">Save colour</button>
      <button class="btn" type="button" data-act="clear-store-color" data-id="${esc(st.StoreID)}">Use business colour</button></div></form>`;
}

function adminUsers() {
  const users = S.admin.users || [];
  const roles = {}; (S.admin.roles || []).forEach((r) => { roles[r.RoleID] = r.RoleName; });
  return `<div class="row between" style="margin-bottom:.6rem"><span class="muted">${users.length} user(s)</span><button class="btn primary" data-act="user-edit" data-id="">${icon('plus', 'sm')} New user</button></div>
    <div class="card table-wrap"><table><thead><tr><th>Name</th><th>Role</th><th>Stores</th><th>Status</th><th></th></tr></thead><tbody>
    ${users.map((u) => `<tr><td><b>${esc(u.FullName)}</b><div class="muted small">@${esc(u.Username)}${u.ExtraPermissions ? ' · +' + esc(u.ExtraPermissions) : ''}</div></td><td>${esc(roles[u.RoleID] || u.RoleID)}</td>
      <td class="small">${String(u.StoreIDs) === 'ALL' ? 'All stores' : String(u.StoreIDs).split(',').filter(Boolean).map(storeName).map(esc).join(', ')}</td>
      <td><span class="badge ${u.Status === 'ACTIVE' ? 'ok' : 'bad'}">${esc(u.Status)}</span></td>
      <td class="right"><button class="btn sm" data-act="user-edit" data-id="${esc(u.UserID)}">Edit</button></td></tr>`).join('')}
    </tbody></table></div>`;
}

function userForm(u) {
  u = u || {};
  const myRank = num(S.session.role.Rank);
  const roles = (S.admin.roles || []).filter((r) => isOwner() || num(r.Rank) < myRank).filter((r) => r.RoleID !== 'OWNER' || isOwner());
  const allMine = S.session.user.StoreIDs === 'ALL' || S.session.role.Scope === 'ALL_STORES';
  const mine = allMine ? (S.snap.stores || []).map((s) => s.StoreID) : String(S.session.user.StoreIDs).split(',');
  const userStores = String(u.StoreIDs || '').split(',');
  const extra = String(u.ExtraPermissions || '').split(',');
  const grantable = (S.admin.permissions || []).filter((p) => !p.ownerOnly && can(p.code));
  return `<div class="modal-head"><h2>${u.UserID ? 'Edit user' : 'New user'}</h2><button class="btn ghost icon" data-act="close">${icon('x')}</button></div>
    <form data-form="user" data-id="${esc(u.UserID || '')}">
      <div class="grid2"><div class="field"><label>Full name</label><input name="fullName" type="text" required value="${esc(u.FullName || '')}"></div>
        <div class="field"><label>Username</label><input name="username" type="text" required value="${esc(u.Username || '')}" autocapitalize="off"></div></div>
      <div class="grid2"><div class="field"><label>Role</label><select name="roleId">${roles.map((r) => `<option value="${esc(r.RoleID)}" ${r.RoleID === u.RoleID ? 'selected' : ''}>${esc(r.RoleName)}</option>`).join('')}</select></div>
        <div class="field"><label>${u.UserID ? 'New PIN (leave empty to keep)' : 'PIN (4–8 digits)'}</label><input name="pin" type="password" inputmode="numeric" pattern="[0-9]{4,8}" ${u.UserID ? '' : 'required'}></div></div>
      <div class="grid2"><div class="field"><label>Phone</label><input name="phone" type="tel" value="${esc(u.Phone || '')}"></div>
        <div class="field"><label>Status</label><select name="status"><option ${u.Status !== 'INACTIVE' ? 'selected' : ''}>ACTIVE</option><option ${u.Status === 'INACTIVE' ? 'selected' : ''}>INACTIVE</option></select></div></div>
      <label>Stores</label><div class="card" style="padding:.5rem .8rem;margin-bottom:.8rem">
        ${allMine ? `<label class="check"><input type="checkbox" name="allStores" ${String(u.StoreIDs) === 'ALL' ? 'checked' : ''}> All stores (including future ones)</label>` : ''}
        ${(S.snap.stores || []).filter((s) => mine.indexOf(s.StoreID) >= 0).map((s) => `<label class="check"><input type="checkbox" name="store" value="${esc(s.StoreID)}" ${userStores.indexOf(s.StoreID) >= 0 ? 'checked' : ''}> ${esc(s.Code + ' ' + s.Name)}</label>`).join('')}</div>
      <details><summary class="muted" style="cursor:pointer;margin-bottom:.4rem">Extra responsibilities (on top of the role)</summary>
        <div class="card" style="padding:.5rem .8rem;max-height:260px;overflow:auto">${grantable.map((p) => `<label class="check"><input type="checkbox" name="extra" value="${esc(p.code)}" ${extra.indexOf(p.code) >= 0 ? 'checked' : ''}> <span><b>${esc(p.code)}</b> <span class="muted small">${esc(p.description)}</span></span></label>`).join('')}</div></details>
      <button class="btn primary block" style="margin-top:1rem" type="submit">Save user</button></form>`;
}

function adminDevices() {
  const devs = S.admin.devices || [];
  const allMine = S.session.user.StoreIDs === 'ALL' || S.session.role.Scope === 'ALL_STORES';
  const mine = allMine ? (S.snap.stores || []).map((s) => s.StoreID) : String(S.session.user.StoreIDs).split(',');
  return `<div class="card" style="margin-bottom:.8rem"><h3>Connect a new device</h3>
      <form data-form="setup-code" class="row"><select name="storeId" class="grow" style="max-width:320px">
        ${(S.snap.stores || []).filter((s) => s.Status === 'ACTIVE' && mine.indexOf(s.StoreID) >= 0).map((s) => `<option value="${esc(s.StoreID)}" ${s.StoreID === store().StoreID ? 'selected' : ''}>${esc(s.Code + ' ' + s.Name)}</option>`).join('')}
        ${allMine ? '<option value="HQ">Head office (owner / supervisor laptop)</option>' : ''}</select>
      <button class="btn primary" type="submit">Get setup code</button></form>
      ${S.ui.setupCode ? `<div class="setup-code" style="margin-top:.8rem">${esc(S.ui.setupCode.code)}</div><p class="muted small center">For ${esc(storeName(S.ui.setupCode.storeId))} · valid 24 hours · works once. Open the app on the new device and enter this code.</p>` : ''}</div>
    <div class="card table-wrap"><table><thead><tr><th>Device</th><th>Store</th><th>Last sync</th><th>Status</th><th></th></tr></thead><tbody>
    ${devs.filter((d) => d.Status !== 'SAMPLE').map((d) => `<tr><td><b>${esc(d.DeviceName)}</b>${d.DeviceID === S.cfg.deviceId ? ' <span class="badge">this device</span>' : ''}</td><td>${esc(storeName(d.StoreID))}</td>
      <td class="small">${fmtDate(d.LastSyncAt)}</td><td><span class="badge ${d.Status === 'ACTIVE' ? 'ok' : 'bad'}">${esc(d.Status)}</span></td>
      <td class="right">${d.DeviceID !== S.cfg.deviceId ? `<button class="btn sm ${d.Status === 'ACTIVE' ? 'danger' : ''}" data-act="device-status" data-id="${esc(d.DeviceID)}" data-s="${d.Status === 'ACTIVE' ? 'BLOCKED' : 'ACTIVE'}">${d.Status === 'ACTIVE' ? 'Block' : 'Unblock'}</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="5" class="empty">No devices yet</td></tr>'}
    </tbody></table></div>`;
}

function adminProducts() {
  const list = S.admin.products || [];
  const showCost = can('VIEW_COST_PROFIT');
  return `<div class="row between" style="margin-bottom:.6rem"><span class="muted">${list.length} product(s) in the shared catalog</span>
      ${can('PRODUCT_MANAGE') ? `<button class="btn primary" data-act="product-edit" data-id="">${icon('plus', 'sm')} New product</button>` : ''}</div>
    <div class="card table-wrap"><table><thead><tr><th>Product</th><th>Category</th>${showCost ? '<th class="right">Cost</th>' : ''}<th class="right">Price</th><th class="right">Reorder</th><th></th></tr></thead><tbody>
    ${list.map((p) => `<tr><td><b>${esc(p.Name)}</b><div class="muted small">${esc(p.SKU || '')} · ${esc(p.Unit || '')}${p.Status !== 'ACTIVE' ? ' · ' + esc(p.Status) : ''}</div></td><td>${esc(p.Category)}</td>
      ${showCost ? `<td class="right num">${fmtCur(p.CostPrice, p.PriceCurrency)}</td>` : ''}<td class="right num">${fmtCur(p.SellingPrice, p.PriceCurrency)}</td><td class="right num">${fmtQty(p.ReorderLevel)}</td>
      <td class="right">${can('PRODUCT_MANAGE') ? `<button class="btn sm" data-act="product-edit" data-id="${esc(p.ProductID)}">Edit</button>` : ''}
        ${can('PRICE_MANAGE') && store().StoreID !== 'HQ' ? `<button class="btn sm ghost" data-act="store-price" data-id="${esc(p.ProductID)}">Price here</button>` : ''}</td></tr>`).join('')}
    </tbody></table></div>`;
}

function productForm(p) {
  p = p || { PriceCurrency: 'USD', Status: 'ACTIVE' };
  const cats = (S.snap.categories || []).filter((c) => c.Type === 'PRODUCT');
  return `<div class="modal-head"><h2>${p.ProductID ? 'Edit product' : 'New product'}</h2><button class="btn ghost icon" data-act="close">${icon('x')}</button></div>
    <form data-form="product" data-id="${esc(p.ProductID || '')}">
      <div class="field"><label>Name</label><input name="name" type="text" required value="${esc(p.Name || '')}"></div>
      <div class="grid2"><div class="field"><label>Category</label><select name="category">${cats.map((c) => `<option ${c.Name === p.Category ? 'selected' : ''}>${esc(c.Name)}</option>`).join('')}</select></div>
        <div class="field"><label>Unit (piece, yard, set…)</label><input name="unit" type="text" value="${esc(p.Unit || 'piece')}"></div></div>
      <div class="grid3"><div class="field"><label>Currency</label><select name="priceCurrency"><option ${p.PriceCurrency === 'USD' ? 'selected' : ''}>USD</option><option ${p.PriceCurrency === 'LRD' ? 'selected' : ''}>LRD</option></select></div>
        ${can('VIEW_COST_PROFIT') ? `<div class="field"><label>Cost price</label><input name="costPrice" type="number" step="any" value="${esc(p.CostPrice === undefined ? '' : p.CostPrice)}"></div>` : '<div></div>'}
        <div class="field"><label>Selling price</label><input name="sellingPrice" type="number" step="any" required value="${esc(p.SellingPrice || '')}"></div></div>
      <div class="grid3"><div class="field"><label>SKU</label><input name="sku" type="text" value="${esc(p.SKU || '')}"></div>
        <div class="field"><label>Barcode</label><input name="barcode" type="text" value="${esc(p.Barcode || '')}"></div>
        <div class="field"><label>Reorder level</label><input name="reorderLevel" type="number" step="any" value="${esc(p.ReorderLevel || '')}"></div></div>
      <div class="field"><label>Status</label><select name="status"><option ${p.Status === 'ACTIVE' ? 'selected' : ''}>ACTIVE</option><option ${p.Status === 'INACTIVE' ? 'selected' : ''}>INACTIVE</option></select></div>
      <button class="btn primary block" type="submit">Save product</button></form>`;
}

function storePriceForm(p) {
  const cur = productById(p.ProductID) || p;
  return `<div class="modal-head"><h2>Price at ${esc(store().Name)}</h2><button class="btn ghost icon" data-act="close">${icon('x')}</button></div>
    <p><b>${esc(p.Name)}</b> — catalog price ${fmtCur(p.SellingPrice, p.PriceCurrency)}; here now ${fmtCur(cur.SellingPrice, cur.PriceCurrency)}</p>
    <form data-form="store-price" data-id="${esc(p.ProductID)}">
      <div class="grid2"><div class="field"><label>Currency</label><select name="priceCurrency"><option ${cur.PriceCurrency === 'USD' ? 'selected' : ''}>USD</option><option ${cur.PriceCurrency === 'LRD' ? 'selected' : ''}>LRD</option></select></div>
        <div class="field"><label>Price in this store (empty = catalog price)</label><input name="sellingPrice" type="number" step="any"></div></div>
      <label class="check"><input type="checkbox" name="sells" ${cur.Sells === false ? '' : 'checked'}> This store sells this product</label>
      <button class="btn primary block" style="margin-top:.8rem" type="submit">Save</button></form>`;
}

function adminSettings() {
  const list = S.admin.settings || [];
  return `<div class="card"><form data-form="settings">${list.filter((s) => s.Key !== 'GlobalRate').map((s) => {
    const dis = bool(s.OwnerOnly) && !isOwner() ? 'disabled' : '';
    let input;
    if (typeof s.Value === 'boolean') input = `<label class="check"><input type="checkbox" name="${esc(s.Key)}" ${s.Value ? 'checked' : ''} ${dis}> ${s.Value ? 'On' : 'Off'}</label>`;
    else if (s.Key === 'RateMode') input = `<select name="RateMode" ${dis}><option value="OWNER_GLOBAL" ${s.Value === 'OWNER_GLOBAL' ? 'selected' : ''}>One rate for all stores (owner sets)</option><option value="PER_STORE" ${s.Value === 'PER_STORE' ? 'selected' : ''}>Each store sets its own rate</option></select>`;
    else if (s.Key === 'ThemeColor') input = colorPicker('ThemeColor', String(s.Value || ''));
    else if (s.Key === 'ReportingCurrency') input = `<select name="ReportingCurrency" ${dis}><option ${s.Value === 'USD' ? 'selected' : ''}>USD</option><option ${s.Value === 'LRD' ? 'selected' : ''}>LRD</option></select>`;
    else input = `<input name="${esc(s.Key)}" type="${typeof s.Value === 'number' ? 'number' : 'text'}" step="any" value="${esc(s.Value)}" ${dis}>`;
    return `<div class="field" style="border-bottom:1px solid var(--line);padding-bottom:.6rem"><div class="row between"><b>${esc(SETTING_LABELS[s.Key] || s.Key)}</b>${bool(s.OwnerOnly) ? '<span class="badge">owner only</span>' : ''}</div>
      <div class="muted small" style="margin:.2rem 0 .4rem">${esc(s.Description || '')}</div>${input}</div>`;
  }).join('')}<button class="btn primary block" type="submit">Save settings</button></form></div>`;
}

const SETTING_LABELS = {
  BusinessName: 'Business name', ThemeColor: 'Business colour', ReportingCurrency: 'Reporting currency', RateMode: 'Exchange rate mode',
  WarehouseEnabled: 'Use warehouses', ShopToShopTransfers: 'Shop-to-shop transfers', TransferApproval: 'Transfers need approval',
  ShopsBuyFromSuppliers: 'Shops can buy from suppliers', UpdateCostOnIntake: 'Update cost on each delivery',
  DiscountLimitPct: 'Discount limit (%)', AllowNegativeStock: 'Allow selling at zero stock', LowStockDefault: 'Default low-stock level',
  ReceiptFooterDefault: 'Default receipt footer'
};

async function loadAdmin() {
  S.ui.adminLoading = true; render();
  try { S.admin = await adminCall('adminData', {}); }
  catch (e) { toast(e.message, 'bad'); }
  S.ui.adminLoading = false; render();
}

/* =====================================================================
 * Sync screen
 * ===================================================================== */
function viewSync() {
  const pend = S.queue.filter((q) => q.status === 'pending');
  const failed = S.queue.filter((q) => q.status === 'failed');
  return `<div class="page-head"><div><h2>Sync & device</h2><div class="sub">Connection, waiting records and appearance</div></div></div>
    <div class="kpis"><div class="kpi"><div class="k">Connection</div><div class="v small"><span class="status-dot ${navigator.onLine ? '' : 'off'}"></span>${navigator.onLine ? 'Online' : 'Offline'}</div></div>
      <div class="kpi"><div class="k">Waiting to sync</div><div class="v">${pend.length}</div></div>
      <div class="kpi"><div class="k">Last sync</div><div class="v small">${S.lastSync ? fmtDate(S.lastSync) : 'never'}</div></div></div>
    ${S.lastError ? `<div class="card" style="background:#f8e1de;margin-top:.8rem">Last error: ${esc(S.lastError)}</div>` : ''}
    <button class="btn primary big" style="margin:1rem 0" data-act="sync-now" ${S.syncing ? 'disabled' : ''}>${S.syncing ? 'Syncing…' : 'Sync now'}</button>
    ${failed.length ? `<h3>Rejected by the server</h3><div class="card table-wrap"><table><tbody>${failed.map((q) => `<tr><td>${fmtDate(q.createdAt)}</td><td><b>${esc(q.rec.type)}</b> ${esc(q.rec.receiptNo || '')}<div class="small" style="color:var(--bad)">${esc(q.error)}</div></td>
      <td class="right"><button class="btn sm" data-act="retry" data-id="${esc(q.rec.id)}">Retry</button> <button class="btn sm danger" data-act="discard" data-id="${esc(q.rec.id)}">Discard</button></td></tr>`).join('')}</tbody></table></div>` : ''}
    <h3 style="margin-top:1.2rem">Appearance</h3>
    <div class="tabs">${[['auto', 'Automatic'], ['light', 'Light'], ['dark', 'Dark']].map((m) => `<button class="tab ${themeMode() === m[0] ? 'on' : ''}" data-act="theme-mode" data-m="${m[0]}">${m[1]}</button>`).join('')}</div>
    <p class="muted small" style="margin-top:-.4rem">Store colour: <span class="store-dot" style="background:${esc(themeColor())}"></span>${esc(themeColor())}${can('STORE_MANAGE') ? ' — change it in Admin → Stores' : ''}</p>
    <h3 style="margin-top:1rem">This device</h3>
    <div class="card small"><div>Device: <b>${esc(S.cfg.deviceName)}</b> (${esc(S.cfg.deviceId)})</div><div>Store: <b>${esc(store().Name)}</b></div>
      <div>Server: <span class="muted">${esc(S.cfg.url)}</span></div><div>App version ${APP_VERSION}</div>
      <div style="margin-top:.6rem"><button class="btn sm danger" data-act="reset-device">Disconnect this device</button></div></div>`;
}

function themeMode() { try { return localStorage.getItem('sm-mode') || 'auto'; } catch (e) { return 'auto'; } }

/* =====================================================================
 * Modal helper
 * ===================================================================== */
let modalFn = null;
function showModal(fn, wide) {
  modalFn = fn;
  $('#modal-root').innerHTML = `<div class="overlay" data-act="overlay"><div class="modal ${wide ? 'wide' : ''}" id="modal">${fn()}</div></div>`;
}
function refreshModal() { if (modalFn && $('#modal')) $('#modal').innerHTML = modalFn(); }
function closeModal() { modalFn = null; co = null; $('#modal-root').innerHTML = ''; }

/* =====================================================================
 * Events
 * ===================================================================== */
const ACT = {
  go: (el) => { S.view = el.dataset.view; S.ui.showCart = false; render(); if (S.view === 'reports' && !reportCache) loadReport(); },
  logout: () => { if (S.cart.lines.length && !confirm('Discard the current sale and log out?')) return; logout(); },
  'sync-now': () => sync(true),
  'pick-user': (el) => { loginUser = el.dataset.id || null; pinEntry = ''; render(); },
  pin: (el) => {
    const k = el.dataset.k;
    if (k === 'C') pinEntry = '';
    else if (k === '⏎') { if (pinEntry.length >= 4) { doLogin(); return; } }
    else if (pinEntry.length < 8) pinEntry += k;
    render();
  },
  'reset-device': async () => {
    const pend = S.queue.filter((q) => q.status === 'pending').length;
    if (pend && !confirm(pend + ' record(s) have NOT been synced and will be lost. Continue?')) return;
    if (!confirm('Disconnect this device? You will need a new setup code.')) return;
    await Promise.all(['cfg', 'snap', 'queue', 'journal', 'session', 'misc'].map(KV.del));
    location.reload();
  },
  cat: (el) => { S.ui.cat = el.dataset.cat; render(); },
  add: (el) => addToCart(el.dataset.id),
  qty: (el) => {
    const l = S.cart.lines[+el.dataset.i];
    const nq = r2(l.qty + (+el.dataset.d) * l.step);
    if (nq <= 0) S.cart.lines.splice(+el.dataset.i, 1); else l.qty = nq;
    render();
  },
  remove: (el) => { S.cart.lines.splice(+el.dataset.i, 1); render(); },
  'clear-cart': () => { S.cart = { lines: [], discountUSD: 0, customerId: '' }; render(); },
  'show-cart': () => { S.ui.showCart = true; render(); },
  'hide-cart': () => { S.ui.showCart = false; render(); },
  discount: () => {
    const t = cartTotals();
    const lim = num(setting('DiscountLimitPct'));
    const v = prompt('Discount — enter a % (e.g. 5%) or an amount in USD (e.g. 2.50)' + (can('POS_DISCOUNT_UNLIMITED') ? '' : '\nMaximum ' + lim + '%'), '');
    if (v === null) return;
    let usd = /%$/.test(v.trim()) ? t.sub * num(v.replace('%', '')) / 100 : num(v);
    if (!can('POS_DISCOUNT_UNLIMITED') && usd > t.sub * lim / 100 + 0.001) { toast('Discount above ' + lim + '% needs a manager', 'bad'); return; }
    S.cart.discountUSD = r2(Math.max(0, usd));
    render();
  },
  'pick-customer': () => { S.ui.custQ = ''; showModal(customerPicker); },
  'back-checkout': () => { if (co) showModal(checkoutModal); else closeModal(); },
  'set-customer': (el) => { S.cart.customerId = el.dataset.id; if (co) showModal(checkoutModal); else { closeModal(); } render(); },
  'new-customer': () => showModal(() => customerForm()),
  'edit-customer': (el) => showModal(() => customerForm(customers().find((c) => c.CustomerID === el.dataset.id))),
  checkout: () => openCheckout(),
  'co-method': (el) => { co.method = el.dataset.m; refreshModal(); },
  'co-quick': (el) => { const i = $('#co-amt'); const cur = num(i.value); i.value = co._quicked ? cur + num(el.dataset.v) : num(el.dataset.v); co._quicked = true; },
  'co-add': () => {
    const m = METHODS.find((x) => x[0] === co.method);
    const amt = num($('#co-amt').value);
    if (!(amt > 0)) { toast('Enter an amount', 'bad'); return; }
    co.tenders.push({ method: m[0], currency: m[2], amount: amt, reference: $('#co-ref') ? $('#co-ref').value.trim() : '' });
    co._quicked = false;
    refreshModal();
  },
  'co-del': (el) => { co.tenders.splice(+el.dataset.i, 1); refreshModal(); },
  'co-change': (el) => { co.changeCurrency = el.dataset.c; refreshModal(); },
  'co-finish': () => finishSale(),
  close: () => closeModal(),
  overlay: (el, e) => { if (e.target === el && !co) closeModal(); },
  print: (el) => {
    const r = S.journal.find((x) => x.id === el.dataset.id);
    $('#print-root').innerHTML = receiptHTML(r);
    window.print();
  },
  'toggle-low': () => { S.ui.stockLow = !S.ui.stockLow; render(); },
  intake: () => { lines = [{ productId: (S.snap.products[0] || {}).ProductID, qty: '', unitCost: '' }]; showModal(intakeModal, true); },
  adjust: () => { lines = [{ productId: (S.snap.products[0] || {}).ProductID, qty: '' }]; showModal(adjustModal); },
  'line-add': () => { lines.push({ productId: (S.snap.products[0] || {}).ProductID, qty: '', unitCost: '' }); refreshModal(); },
  'line-del': (el) => { lines.splice(+el.dataset.i, 1); refreshModal(); },
  'transfer-new': (el) => { lines = [{ productId: (S.snap.products[0] || {}).ProductID, qty: '' }]; showModal(() => transferModal(el.dataset.mode)); },
  'transfer-act': (el) => {
    const t = transfers().find((x) => x.TransferID === el.dataset.id);
    const a = el.dataset.a;
    if (a === 'DISPATCH' || a === 'RECEIVE') { showModal(() => transferQtyModal(t, a)); return; }
    if (a === 'CANCEL' && !confirm('Cancel this transfer?')) return;
    enqueue('transferAction', { transferId: t.TransferID, action: a });
    toast(a === 'APPROVE' ? 'Approved' : 'Cancelled', 'ok');
    render();
  },
  'money-tab': (el) => { S.ui.moneyTab = el.dataset.t; render(); },
  collect: (el) => showModal(() => collectModal(customers().find((c) => c.CustomerID === el.dataset.id))),
  'rep-period': (el) => { S.ui.reportPeriod = el.dataset.p; reportCache = null; loadReport(); },
  'rep-load': () => loadReport(),
  'admin-tab': (el) => { S.ui.adminTab = el.dataset.t; S.ui.setupCode = null; render(); if (el.dataset.t === 'shop' && S.session.token && (!S.shopAdmin || S.shopAdmin.store.StoreID !== shopStoreId())) { loadShopAdmin(); return; } if (['users', 'devices', 'products', 'settings'].indexOf(el.dataset.t) >= 0 && !S.admin && S.session.token) loadAdmin(); },
  'admin-load': () => loadAdmin(),
  'store-new': () => showModal(storeForm),
  'order-tab': (el) => { S.ui.orderTab = el.dataset.t; render(); },
  'order-status': (el) => {
    const o = orders().find((x) => x.OrderID === el.dataset.id);
    const s = el.dataset.s;
    if (s === 'CANCELLED' && !confirm('Cancel order ' + o.OrderNo + '?')) return;
    enqueue('orderStatus', { orderId: o.OrderID, status: s });
    toast(o.OrderNo + ': ' + s.toLowerCase(), 'ok'); render();
  },
  'order-ring': (el) => ringUpOrder(orders().find((x) => x.OrderID === el.dataset.id)),
  'shop-load': () => loadShopAdmin(),
  'copy-link': () => { const i = $('#shop-link'); i.select(); try { navigator.clipboard.writeText(i.value); } catch (e) { document.execCommand('copy'); } toast('Link copied', 'ok'); },
  'opt-edit': (el) => showModal(() => optForm(el.dataset.id ? S.shopAdmin.options.find((o) => o.OptionID === el.dataset.id) : null, el.dataset.type)),
  'desc-edit': (el) => showModal(() => descForm(S.shopAdmin.products.find((p) => p.ProductID === el.dataset.id))),
  'online-toggle': async (el) => {
    const p = S.shopAdmin.products.find((x) => x.ProductID === el.dataset.id);
    try { await adminCall('upsertProduct', { productId: p.ProductID, showOnline: el.checked }); p.ShowOnline = el.checked; toast(el.checked ? 'Shown in the shop' : 'Hidden from the shop', 'ok'); }
    catch (e) { el.checked = !el.checked; toast(e.message, 'bad'); }
  },
  'photo-pick': (el) => { S.ui.photoFor = el.dataset.id; const f = $('#photo-file'); f.value = ''; f.click(); },
  'store-color': (el) => showModal(() => storeColorModal((S.snap.stores || []).find((x) => x.StoreID === el.dataset.id))),
  'pick-color': (el) => {
    const box = el.closest('[data-picker]');
    box.querySelectorAll('.swatch').forEach((x) => x.classList.toggle('on', x === el));
    box.querySelector('input[type=hidden]').value = el.dataset.c;
    box.querySelector('input[type=color]').value = el.dataset.c.toLowerCase();
  },
  'clear-store-color': async (el) => {
    try { await adminCall('updateStore', { storeId: el.dataset.id, color: '' }); closeModal(); toast('Store now uses the business colour', 'ok'); await sync(false); }
    catch (e) { toast(e.message, 'bad'); }
  },
  'theme-mode': (el) => { try { localStorage.setItem('sm-mode', el.dataset.m); } catch (e) { /* ignore */ } render(); },
  'store-close': async (el) => {
    const reason = prompt('Close ' + storeName(el.dataset.id) + '? Its devices will be blocked; history stays. Reason:');
    if (reason === null) return;
    try {
      let r = await adminCall('closeStore', { storeId: el.dataset.id, reason });
      if (!r.closed && confirm(r.message + '\n\nClose anyway?')) r = await adminCall('closeStore', { storeId: el.dataset.id, reason, force: true });
      if (r.closed) { toast('Store closed', 'ok'); await sync(false); }
    } catch (e) { toast(e.message, 'bad'); }
  },
  'store-reopen': async (el) => { try { await adminCall('reopenStore', { storeId: el.dataset.id }); toast('Store reopened', 'ok'); await sync(false); } catch (e) { toast(e.message, 'bad'); } },
  'user-edit': (el) => showModal(() => userForm((S.admin.users || []).find((u) => u.UserID === el.dataset.id)), true),
  'device-status': async (el) => {
    try { await adminCall('setDeviceStatus', { deviceId: el.dataset.id, status: el.dataset.s }); S.admin = await adminCall('adminData', {}); render(); }
    catch (e) { toast(e.message, 'bad'); }
  },
  'product-edit': (el) => showModal(() => productForm((S.admin.products || []).find((p) => p.ProductID === el.dataset.id)), true),
  'store-price': (el) => showModal(() => storePriceForm((S.admin.products || []).find((p) => p.ProductID === el.dataset.id))),
  retry: (el) => { const q = S.queue.find((x) => x.rec.id === el.dataset.id); q.status = 'pending'; q.error = ''; persist.queue(); sync(true); },
  discard: (el) => { if (!confirm('Discard this record? It will not reach the server.')) return; S.queue = S.queue.filter((x) => x.rec.id !== el.dataset.id); persist.queue(); render(); }
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const fn = ACT[el.dataset.act];
  if (fn) { if (el.tagName === 'BUTTON' && el.type !== 'submit') e.preventDefault(); fn(el, e); }
});

document.addEventListener('input', (e) => {
  const el = e.target;
  const k = el.dataset && el.dataset.input;
  if (!k) return;
  if (k === 'pos-search') { S.ui.q = el.value; $('#pos-grid').innerHTML = posGrid(); }
  if (k === 'stock-q') { S.ui.stockQ = el.value; const pos = el.selectionStart; render(); const n = $('#stock-q'); n.focus(); n.setSelectionRange(pos, pos); }
  if (k === 'cust-q') { S.ui.custQ = el.value; refreshModal(); const n = $('#cust-q'); n.focus(); n.setSelectionRange(n.value.length, n.value.length); }
  if (k === 'custlist-q') { S.ui.custListQ = el.value; render(); }
  if (k === 'shop-q') { S.ui.shopQ = el.value; const pos = el.selectionStart; render(); const n = $('#shop-q'); if (n) { n.focus(); n.setSelectionRange(pos, pos); } }
  if (k === 'line') { lines[+el.dataset.i][el.dataset.f] = el.value; }
});

document.addEventListener('change', (e) => {
  const el = e.target;
  const k = el.dataset && el.dataset.input;
  if (k === 'qty') {
    const l = S.cart.lines[+el.dataset.i];
    const v = r2(el.value);
    if (v <= 0) S.cart.lines.splice(+el.dataset.i, 1); else l.qty = v;
    render();
  }
  if (k === 'color-custom') {
    const box = el.closest('[data-picker]');
    box.querySelectorAll('.swatch').forEach((x) => x.classList.remove('on'));
    box.querySelector('input[type=hidden]').value = el.value.toUpperCase();
  }
  if (el.id === 'photo-file' && el.files && el.files[0]) {
    const pid = S.ui.photoFor;
    toast('Uploading photo…');
    resizeImage(el.files[0]).then((dataUrl) => adminCall('uploadImage', { productId: pid, dataUrl, name: (productById(pid) || {}).Name || 'photo' }))
      .then((r) => { const p = S.shopAdmin.products.find((x) => x.ProductID === pid); if (p) p.ImageURL = r.url; toast('Photo saved', 'ok'); render(); })
      .catch((e) => toast(e.message, 'bad'));
  }
  if (k === 'shop-store') { S.ui.shopStore = el.value; S.shopAdmin = null; loadShopAdmin(); }
  if (k === 'rep-store') { S.ui.reportStore = el.value; reportCache = null; loadReport(); }
  if (k === 'line') { lines[+el.dataset.i][el.dataset.f] = el.value; }
});

document.addEventListener('keydown', (e) => {
  if (!S.session && loginUser && /^[0-9]$/.test(e.key)) { if (pinEntry.length < 8) pinEntry += e.key; render(); }
  else if (!S.session && loginUser && e.key === 'Enter' && pinEntry.length >= 4) doLogin();
  else if (!S.session && loginUser && e.key === 'Backspace') { pinEntry = pinEntry.slice(0, -1); render(); }
});

const FORMS = {
  register: async (f) => {
    const url = GAS ? 'apps-script' : f.url.value.trim();
    try { localStorage.setItem('sm-url', url); } catch (e) { /* storage may be blocked */ }
    try {
      const r = await api('registerDevice', { setupCode: f.code.value.trim().toUpperCase(), deviceName: f.name.value.trim() }, { url });
      S.cfg = { url, deviceId: r.deviceId, deviceKey: r.deviceKey, deviceName: f.name.value.trim() };
      await KV.set('cfg', S.cfg);
      S.snap = await api('pull');
      await persist.snap();
      toast('Device connected to ' + r.store.Name, 'ok');
      render();
    } catch (e) { toast(e.message, 'bad'); }
  },
  customer: (f) => {
    const id = f.dataset.id;
    const data = { name: f.name.value.trim(), phone: f.phone.value.trim(), notes: f.notes.value.trim() };
    if (can('CUSTOMER_MANAGE') && f.limit.value !== '') data.creditLimitUSD = num(f.limit.value);
    if (id) { data.customerId = id; enqueue('customer', data); }
    else { const rec = enqueue('customer', data); if (modalFn === customerPicker || co || S.view === 'pos') S.cart.customerId = rec.id; }
    toast('Customer saved', 'ok');
    if (co) showModal(checkoutModal); else closeModal();
    render();
  },
  intake: (f) => {
    const items = lines.filter((l) => l.productId && num(l.qty) > 0).map((l) => ({ productId: l.productId, qty: num(l.qty), unitCost: num(l.unitCost) }));
    if (!items.length) { toast('Add at least one item with a quantity', 'bad'); return; }
    enqueue('stockIntake', { supplierId: f.supplierId.value || undefined, invoiceNo: f.invoiceNo.value.trim(), currency: f.currency.value, items, paidAmount: num(f.paid.value) });
    closeModal(); toast('Stock received', 'ok'); render();
  },
  adjust: (f) => {
    const items = lines.filter((l) => l.productId && num(l.qty) !== 0).map((l) => ({ productId: l.productId, qty: num(l.qty) }));
    if (!items.length) { toast('Enter a quantity change', 'bad'); return; }
    enqueue('stockAdjust', { reason: f.reason.value, items });
    closeModal(); toast('Adjustment saved', 'ok'); render();
  },
  transfer: (f) => {
    const mode = f.dataset.mode;
    const items = lines.filter((l) => l.productId && num(l.qty) > 0).map((l) => ({ productId: l.productId, qty: num(l.qty) }));
    if (!items.length) { toast('Add at least one item', 'bad'); return; }
    if (mode === 'SEND') {
      const stock = stockMap();
      const short = items.find((i) => num(i.qty) > (stock[i.productId] || 0));
      if (short && !confirm('You are sending more ' + productById(short.productId).Name + ' than the system shows in stock. Continue?')) return;
    }
    const me = store().StoreID;
    enqueue('transfer', { mode, fromStoreId: mode === 'SEND' ? me : f.other.value, toStoreId: mode === 'SEND' ? f.other.value : me, items, note: f.note.value.trim() });
    closeModal(); toast(mode === 'SEND' ? 'Stock sent' : 'Request sent', 'ok'); render();
  },
  'transfer-qty': (f) => {
    const t = transfers().find((x) => x.TransferID === f.dataset.id);
    const items = t.items.map((i) => ({ productId: i.ProductID, qty: num(f['q-' + i.ProductID].value) }));
    const rec = enqueue('transferAction', { transferId: t.TransferID, action: f.dataset.a, items });
    rec._items = items; // used for the local stock view until the next pull
    const q = S.queue.find((x) => x.rec.id === rec.id); if (q) q.rec._items = items;
    persist.queue();
    closeModal(); toast(f.dataset.a === 'DISPATCH' ? 'Dispatched' : 'Received', 'ok'); render();
  },
  money: (f) => {
    const t = f.dataset.t;
    const amt = num(f.amount.value);
    if (!(amt > 0)) { toast('Enter an amount', 'bad'); return; }
    const data = { category: f.category.value, description: f.description.value.trim(), currency: f.currency.value, amount: amt };
    if (t === 'expense') data.paidTo = f.party.value.trim(); else data.receivedFrom = f.party.value.trim();
    enqueue(t, data);
    toast((t === 'expense' ? 'Expense' : 'Income') + ' saved', 'ok');
    f.reset(); render();
  },
  collect: (f) => {
    const amt = num(f.amount.value);
    if (!(amt > 0)) { toast('Enter an amount', 'bad'); return; }
    let currency = f.currency.value;
    if (f.method.value === 'USD_CASH') currency = 'USD';
    if (f.method.value === 'LRD_CASH') currency = 'LRD';
    enqueue('customerPayment', { customerId: f.dataset.id, method: f.method.value, currency, amount: amt });
    closeModal(); toast('Payment recorded', 'ok'); render();
  },
  'shift-open': (f) => {
    const rec = enqueue('shift', { action: 'OPEN', cashUSD: num(f.usd.value), cashLRD: num(f.lrd.value) });
    S.shift = { shiftId: rec.id, openedAt: rec.timestamp, userId: rec.userId, openingUSD: num(f.usd.value), openingLRD: num(f.lrd.value) };
    persist.misc(); render();
  },
  'shift-close': (f) => {
    const e = shiftExpected();
    const cu = num(f.usd.value), cl = num(f.lrd.value);
    enqueue('shift', { action: 'CLOSE', shiftId: S.shift.shiftId, cashUSD: cu, cashLRD: cl,
      note: (f.note.value.trim() ? f.note.value.trim() + ' | ' : '') + 'expected USD ' + r2(e.usd) + ', LRD ' + Math.round(e.lrd) });
    alert('Shift closed.\n\nUSD: counted ' + fmtUSD(cu) + ', expected ' + fmtUSD(e.usd) + ' → difference ' + fmtUSD(cu - e.usd) +
      '\nLRD: counted ' + fmtLRD(cl) + ', expected ' + fmtLRD(e.lrd) + ' → difference ' + fmtLRD(cl - e.lrd));
    S.shift = null; persist.misc(); render();
  },
  rate: async (f) => {
    try {
      const body = { rate: num(f.rate.value) };
      if (f.dataset.scope === 'store') body.storeId = store().StoreID;
      await adminCall('setRate', body);
      toast('Rate updated', 'ok');
      await sync(false);
    } catch (e) { toast(e.message, 'bad'); }
  },
  store: async (f) => {
    try {
      const body = { name: f.name.value.trim(), type: f.type.value, address: f.address.value.trim(), phone: f.phone.value.trim() };
      const col = f.querySelector('input[name=color]'); if (col && col.value) body.color = col.value;
      if (f.rate && f.rate.value) body.rate = num(f.rate.value);
      const r = await adminCall('createStore', body);
      closeModal(); toast('Created ' + r.store.Code + ' ' + r.store.Name, 'ok');
      await sync(false);
    } catch (e) { toast(e.message, 'bad'); }
  },
  user: async (f) => {
    const body = { fullName: f.fullName.value.trim(), username: f.username.value.trim().toLowerCase(), roleId: f.roleId.value, phone: f.phone.value.trim(), status: f.status.value };
    if (f.dataset.id) body.userId = f.dataset.id;
    if (f.pin.value) body.pin = f.pin.value;
    body.storeIds = f.allStores && f.allStores.checked ? 'ALL' : Array.from(f.querySelectorAll('input[name=store]:checked')).map((x) => x.value);
    body.extraPermissions = Array.from(f.querySelectorAll('input[name=extra]:checked')).map((x) => x.value);
    try {
      await adminCall('upsertUser', body);
      S.admin = await adminCall('adminData', {});
      closeModal(); toast('User saved', 'ok'); render(); sync(false);
    } catch (e) { toast(e.message, 'bad'); }
  },
  'setup-code': async (f) => {
    try { const r = await adminCall('createSetupCode', { storeId: f.storeId.value }); S.ui.setupCode = { code: r.setupCode, storeId: r.storeId }; render(); }
    catch (e) { toast(e.message, 'bad'); }
  },
  product: async (f) => {
    const body = { name: f.name.value.trim(), category: f.category.value, unit: f.unit.value.trim(), priceCurrency: f.priceCurrency.value,
      sellingPrice: num(f.sellingPrice.value), sku: f.sku.value.trim(), barcode: f.barcode.value.trim(), reorderLevel: num(f.reorderLevel.value), status: f.status.value };
    if (f.costPrice && f.costPrice.value !== '') body.costPrice = num(f.costPrice.value);
    if (f.dataset.id) body.productId = f.dataset.id;
    try { await adminCall('upsertProduct', body); S.admin = await adminCall('adminData', {}); closeModal(); toast('Product saved', 'ok'); render(); sync(false); }
    catch (e) { toast(e.message, 'bad'); }
  },
  'shop-settings': async (f) => {
    try {
      const r = await adminCall('updateShop', { storeId: S.shopAdmin.store.StoreID, onlineShop: f.onlineShop.checked, whatsapp: f.whatsapp.value.trim(), shopMessage: f.shopMessage.value.trim() });
      S.shopAdmin.store = r.store; toast('Online shop saved', 'ok'); render(); sync(false);
    } catch (e) { toast(e.message, 'bad'); }
  },
  opt: async (f) => {
    const body = { storeId: S.shopAdmin.store.StoreID, type: f.dataset.type, name: f.name.value.trim(), details: f.details.value.trim(), active: f.active.checked };
    if (f.dataset.id) body.optionId = f.dataset.id;
    if (f.fee) { body.fee = num(f.fee.value); body.currency = f.currency.value; }
    try { await adminCall('upsertOnlineOption', body); S.shopAdmin = await adminCall('shopData', { storeId: S.shopAdmin.store.StoreID }); closeModal(); toast('Saved', 'ok'); render(); }
    catch (e) { toast(e.message, 'bad'); }
  },
  desc: async (f) => {
    const p = S.shopAdmin.products.find((x) => x.ProductID === f.dataset.id);
    try {
      const r = await adminCall('upsertProduct', { productId: p.ProductID, description: f.description.value.trim(), imageUrl: f.imageUrl.value.trim() });
      p.Description = r.product.Description; p.ImageURL = r.product.ImageURL; closeModal(); toast('Saved', 'ok'); render();
    } catch (e) { toast(e.message, 'bad'); }
  },
  'store-color': async (f) => {
    const c = f.querySelector('input[name=color]').value;
    if (!c) { toast('Pick a colour', 'bad'); return; }
    try { await adminCall('updateStore', { storeId: f.dataset.id, color: c }); closeModal(); toast('Colour saved', 'ok'); await sync(false); }
    catch (e) { toast(e.message, 'bad'); }
  },
  'store-price': async (f) => {
    const body = { storeId: store().StoreID, productId: f.dataset.id, sells: f.sells.checked, priceCurrency: f.priceCurrency.value };
    if (f.sellingPrice.value !== '') body.sellingPrice = num(f.sellingPrice.value);
    try { await adminCall('setStorePrice', body); closeModal(); toast('Store price saved', 'ok'); sync(false); }
    catch (e) { toast(e.message, 'bad'); }
  },
  settings: async (f) => {
    const changes = {};
    (S.admin.settings || []).forEach((s) => {
      const el = f.querySelector('[name="' + s.Key + '"]');
      if (!el || el.disabled) return;
      const v = el.type === 'checkbox' ? el.checked : (typeof s.Value === 'number' ? num(el.value) : el.value);
      if (v !== s.Value) changes[s.Key] = v;
    });
    if (!Object.keys(changes).length) { toast('Nothing changed'); return; }
    try { const r = await adminCall('updateSettings', { settings: changes }); S.admin.settings = r.settings.map((x) => Object.assign({}, (S.admin.settings || []).find((y) => y.Key === x.Key), x)); toast('Settings saved', 'ok'); await sync(false); }
    catch (e) { toast(e.message, 'bad'); }
  }
};

document.addEventListener('submit', (e) => {
  const f = e.target;
  const k = f.dataset && f.dataset.form;
  if (!k || !FORMS[k]) return;
  e.preventDefault();
  const btn = f.querySelector('[type=submit]');
  if (btn) btn.disabled = true;
  Promise.resolve(FORMS[k](f)).finally(() => { if (btn && document.body.contains(btn)) btn.disabled = false; });
});

boot();

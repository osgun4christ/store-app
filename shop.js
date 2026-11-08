/* WhatsApp storefront — customers browse, build a cart and send the order to the shop on WhatsApp.
 * Talks to the Apps Script backend (actions: shopCatalog, shopOrder). No login, no payment gateway.
 */
'use strict';
(function () {
  const GAS = typeof google !== 'undefined' && google.script && google.script.run;
  const CFG = Object.assign({}, window.SHOP_CONFIG || {});
  try { const qp = new URLSearchParams(location.search); if (!CFG.api && qp.get('api')) CFG.api = qp.get('api'); } catch (e) { /* ignore */ }
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const num = (v) => { const n = Number(v); return isFinite(n) ? n : 0; };
  const usd = (n) => '$' + num(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const lrd = (n) => 'L$' + Math.round(num(n)).toLocaleString('en-US');
  const cur = (n, c) => (c === 'USD' ? usd(n) : lrd(n));
  const qtyFmt = (q) => (Math.round(num(q) * 100) / 100).toLocaleString('en-US');
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'o' + Date.now() + Math.random().toString(16).slice(2));
  const store = { get: (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } } };
  const IC = {
    cart: '<circle cx="9" cy="20" r="1.4"/><circle cx="18" cy="20" r="1.4"/><path d="M2.5 3.5h2.6l2.5 11.6a1.8 1.8 0 0 0 1.8 1.4h8.3a1.8 1.8 0 0 0 1.8-1.4L21 7.5H6"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20.5 20.5-4.3-4.3"/>', x: '<path d="M18 6 6 18M6 6l12 12"/>',
    plus: '<path d="M12 5v14M5 12h14"/>', minus: '<path d="M5 12h14"/>', truck: '<path d="M2 6h12v10H2zM14 10h4l3 3v3h-7"/><circle cx="6" cy="18" r="2"/><circle cx="17.5" cy="18" r="2"/>',
    pin: '<path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>', back: '<path d="M19 12H5M11 18l-6-6 6-6"/>',
    check: '<path d="m4.5 12.5 5 5 10-11"/>', trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12.5A1.5 1.5 0 0 0 8.5 21h7a1.5 1.5 0 0 0 1.5-1.5L18 7M9 7V4h6v3"/>'
  };
  const WA = '<svg viewBox="0 0 24 24" class="wa"><path fill="currentColor" d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2zm0 18.2a8.2 8.2 0 0 1-4.2-1.2l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1 1 12 20.2zm4.5-6.1c-.2-.1-1.5-.7-1.7-.8-.2-.1-.4-.1-.6.1l-.8 1c-.1.2-.3.2-.5.1a6.7 6.7 0 0 1-3.3-2.9c-.2-.4.2-.4.7-1.3.1-.2 0-.3 0-.4l-.8-1.8c-.2-.5-.4-.4-.6-.4h-.5a1 1 0 0 0-.7.3 3 3 0 0 0-.9 2.2 5.2 5.2 0 0 0 1.1 2.8 11.9 11.9 0 0 0 4.6 4c1.7.7 2.4.8 3.2.7.5-.1 1.5-.6 1.8-1.2.2-.6.2-1.1.1-1.2l-.4-.2z"/></svg>';
  const icon = (n, c) => `<svg class="i ${c || ''}" viewBox="0 0 24 24">${IC[n]}</svg>`;

  const S = { cat: null, ref: '', q: '', cart: [], cartOpen: false, step: 'cart', product: null, sending: false, done: null, error: '' };

  /* ---------- API ---------- */
  function call(action, body) {
    const payload = Object.assign({ action }, body);
    if (GAS) {
      return new Promise((res, rej) => google.script.run
        .withSuccessHandler((t) => { const j = JSON.parse(t); j.ok ? res(j) : rej(new Error(j.message || j.error)); })
        .withFailureHandler((e) => rej(new Error(navigator.onLine ? 'The shop is busy, please try again' : 'No internet connection')))
        .apiCall(JSON.stringify(payload)));
    }
    return fetch(CFG.api, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(payload) })
      .catch(() => { throw new Error('No internet connection — please try again'); })
      .then((r) => r.json()).then((j) => { if (!j.ok) throw new Error(j.message || j.error); return j; });
  }

  function storeRef() {
    if (GAS) return new Promise((res) => google.script.url.getLocation((l) => res((l.parameter && l.parameter.shop) || CFG.store || '')));
    const p = new URLSearchParams(location.search);
    return Promise.resolve(p.get('shop') || p.get('s') || CFG.store || '');
  }

  /* ---------- theme ---------- */
  function theme(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || ''); const n = m ? parseInt(m[1], 16) : 0x0f766e;
    const r = n >> 16 & 255, g = n >> 8 & 255, b = n & 255;
    const mix = (t, w) => '#' + [r, g, b].map((x) => Math.round(x + (w - x) * t).toString(16).padStart(2, '0')).join('');
    const root = document.documentElement.style;
    root.setProperty('--brand', '#' + n.toString(16).padStart(6, '0'));
    root.setProperty('--brand-ink', mix(0.25, 0));
    root.setProperty('--brand-soft', mix(0.88, 255));
    root.setProperty('--on-brand', (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.62 ? '#111827' : '#fff');
    const meta = document.querySelector('meta[name=theme-color]'); if (meta) meta.content = '#' + n.toString(16).padStart(6, '0');
  }

  /* ---------- cart ---------- */
  const key = () => 'shop-cart:' + (S.data ? S.data.store.code : '');
  const product = (id) => S.data.products.find((p) => p.id === id);
  const toUSD = (a, c) => (c === 'USD' ? a : a / S.data.rate);
  const toLRD = (a, c) => (c === 'LRD' ? a : a * S.data.rate);
  function cartLines() { return S.cart.map((l) => ({ l, p: product(l.id) })).filter((x) => x.p && x.p.availability !== 'OUT'); }
  function totals() {
    let u = 0, d = 0;
    cartLines().forEach(({ l, p }) => { u += toUSD(p.price * l.qty, p.currency); d += toLRD(p.price * l.qty, p.currency); });
    return { usd: u, lrd: d, count: cartLines().length };
  }
  function setQty(id, q) {
    const p = product(id); if (!p) return;
    q = Math.round(q * 100) / 100;
    const ex = S.cart.find((l) => l.id === id);
    if (q <= 0) S.cart = S.cart.filter((l) => l.id !== id);
    else if (ex) ex.qty = q; else S.cart.push({ id, qty: q });
    store.set(key(), S.cart);
  }
  const inCart = (id) => (S.cart.find((l) => l.id === id) || {}).qty || 0;

  /* ---------- views ---------- */
  function priceBlock(p, big) {
    const other = p.currency === 'USD' ? lrd(p.price * S.data.rate) : usd(p.price / S.data.rate);
    return `<span class="price ${big ? 'big' : ''}">${cur(p.price, p.currency)}<small>${/yard/i.test(p.unit) ? ' / yard' : ''}</small></span><span class="alt">≈ ${other}</span>`;
  }
  const initials = (n) => String(n).replace(/\(.*?\)/g, '').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  const tints = [['#e0f2fe', '#0369a1'], ['#fce7f3', '#be185d'], ['#ede9fe', '#6d28d9'], ['#dcfce7', '#15803d'], ['#fef3c7', '#b45309'], ['#ffe4e6', '#be123c'], ['#e0e7ff', '#4338ca'], ['#ccfbf1', '#0f766e']];
  const tint = (c) => { let h = 0; String(c).split('').forEach((x) => { h = (h * 31 + x.charCodeAt(0)) >>> 0; }); return tints[h % tints.length]; };
  function photo(p, cls) {
    if (p.image) return `<img class="${cls}" src="${esc(p.image)}" alt="${esc(p.name)}" loading="lazy" referrerpolicy="no-referrer" onerror="this.outerHTML='<div class=&quot;${cls} ph&quot;>${esc(initials(p.name))}</div>'">`;
    const t = tint(p.category);
    return `<div class="${cls} ph" style="background:${t[0]};color:${t[1]}">${esc(initials(p.name))}</div>`;
  }
  const badge = (a) => (a === 'OUT' ? '<span class="tag out">Sold out</span>' : a === 'LOW' ? '<span class="tag low">Few left</span>' : '');

  function grid() {
    const q = S.q.trim().toLowerCase();
    const list = S.data.products.filter((p) => (!S.cat || p.category === S.cat) && (!q || (p.name + ' ' + p.category + ' ' + p.description).toLowerCase().includes(q)));
    if (!list.length) return `<div class="empty">No products match “${esc(S.q)}”.</div>`;
    return `<div class="grid">${list.map((p) => {
      const n = inCart(p.id);
      return `<article class="card ${p.availability === 'OUT' ? 'soldout' : ''}" data-open="${esc(p.id)}">
        <div class="media">${photo(p, 'img')}${badge(p.availability)}</div>
        <div class="body"><h3>${esc(p.name)}</h3>${priceBlock(p)}</div>
        ${p.availability === 'OUT' ? '' : n ? `<div class="stepper" data-stop>
            <button data-dec="${esc(p.id)}" aria-label="less">${icon('minus')}</button><b>${qtyFmt(n)}</b><button data-inc="${esc(p.id)}" aria-label="more">${icon('plus')}</button></div>`
          : `<button class="add" data-inc="${esc(p.id)}" aria-label="Add ${esc(p.name)}">${icon('plus')} Add</button>`}
      </article>`;
    }).join('')}</div>`;
  }

  function page() {
    const d = S.data;
    const t = totals();
    return `
    <header class="top">
      <div class="brand"><div class="logo">${esc(initials(d.store.name))}</div>
        <div><div class="biz">${esc(d.business || '')}</div><h1>${esc(d.store.name)}</h1></div></div>
      ${d.store.whatsapp ? `<a class="ask" href="https://wa.me/${esc(d.store.whatsapp)}" target="_blank" rel="noopener">${WA}<span>Chat</span></a>` : ''}
    </header>
    <section class="hero">
      ${d.store.message ? `<p>${esc(d.store.message)}</p>` : ''}
      <div class="facts">
        ${d.options.delivery.length ? `<span>${icon('truck')} Delivery from ${esc(cheapest(d.options.delivery))}</span>` : ''}
        ${d.options.pickup.length ? `<span>${icon('pin')} Pickup available</span>` : ''}
        <span>💵 USD or LRD · MoMo</span></div>
    </section>
    <div class="sticky">
      <label class="search">${icon('search')}<input id="q" type="search" placeholder="Search fabrics, hats, knitwear…" value="${esc(S.q)}" autocomplete="off"></label>
      <nav class="cats"><button class="${!S.cat ? 'on' : ''}" data-cat="">All</button>${d.categories.map((c) => `<button class="${S.cat === c ? 'on' : ''}" data-cat="${esc(c)}">${esc(c)}</button>`).join('')}</nav>
    </div>
    <main id="grid">${grid()}</main>
    <footer class="foot">Prices in USD and LRD at today's rate (1 USD = ${d.rate} LRD). Orders are confirmed by the shop on WhatsApp. ${d.store.address ? '<br>' + esc(d.store.address) : ''}</footer>
    ${t.count ? `<button class="cartbar" data-cart><span class="n">${t.count}</span><span>View cart</span><b>${usd(t.usd)}</b></button>` : ''}`;
  }
  function cheapest(list) {
    const f = list.map((o) => ({ o, u: toUSD(o.fee, o.currency) })).sort((a, b) => a.u - b.u)[0];
    return f ? cur(f.o.fee, f.o.currency) : '';
  }

  /* ---------- sheets (product, cart, checkout, done) ---------- */
  function productSheet(p) {
    const n = inCart(p.id) || 0;
    const start = n || (p.step < 1 ? 1 : 1);
    return `<div class="sheet-head"><span></span><button class="x" data-close>${icon('x')}</button></div>
      <div class="pd">${photo(p, 'pimg')}${badge(p.availability)}</div>
      <h2>${esc(p.name)}</h2><div class="prow">${priceBlock(p, true)}</div>
      ${p.description ? `<p class="desc">${esc(p.description)}</p>` : ''}
      ${p.availability === 'OUT' ? '<p class="desc"><b>Sold out at the moment.</b> Ask us on WhatsApp when it will be back.</p>' : `
      <div class="qtyrow"><span>Quantity${p.step < 1 ? ' (yards)' : ''}</span>
        <div class="stepper big"><button data-pq="-1">${icon('minus')}</button><input id="pq" type="number" inputmode="decimal" min="${p.step}" step="${p.step}" value="${start}"><button data-pq="1">${icon('plus')}</button></div></div>
      <button class="primary" data-addp="${esc(p.id)}">${n ? 'Update cart' : 'Add to cart'}</button>`}`;
  }

  function cartSheet() {
    const lines = cartLines();
    const t = totals();
    if (!lines.length) return `<div class="sheet-head"><h2>Your cart</h2><button class="x" data-close>${icon('x')}</button></div><div class="empty">Your cart is empty.</div>`;
    return `<div class="sheet-head"><h2>Your cart</h2><button class="x" data-close>${icon('x')}</button></div>
      <div class="lines">${lines.map(({ l, p }) => `<div class="line">${photo(p, 'thumb')}
        <div class="li"><b>${esc(p.name)}</b><span>${cur(p.price, p.currency)}${/yard/i.test(p.unit) ? ' / yard' : ''}</span>
          <div class="stepper"><button data-dec="${esc(p.id)}">${icon(l.qty <= p.step ? 'trash' : 'minus')}</button><b>${qtyFmt(l.qty)}</b><button data-inc="${esc(p.id)}">${icon('plus')}</button></div></div>
        <b class="lt">${cur(p.price * l.qty, p.currency)}</b></div>`).join('')}</div>
      <div class="sum"><div><span>Items total</span><b>${usd(t.usd)}</b></div><div class="muted"><span>In Liberian dollars</span><span>${lrd(t.lrd)}</span></div>
        <p class="muted small">Delivery fee (if any) is added at the next step.</p></div>
      <button class="primary" data-step="checkout">Continue</button>`;
  }

  function checkoutSheet() {
    const d = S.data;
    const c = S.customer;
    const t = totals();
    const delivery = c.method === 'DELIVERY';
    const opts = delivery ? d.options.delivery : d.options.pickup;
    const opt = opts.find((o) => o.id === c.optionId) || null;
    const feeUSD = delivery && opt ? toUSD(opt.fee, opt.currency) : 0;
    const feeLRD = delivery && opt ? toLRD(opt.fee, opt.currency) : 0;
    const both = d.options.delivery.length && d.options.pickup.length;
    return `<div class="sheet-head"><button class="x" data-step="cart">${icon('back')}</button><h2>Your details</h2><button class="x" data-close>${icon('x')}</button></div>
      <form id="co">
        <label>Your name<input name="name" required value="${esc(c.name)}" autocomplete="name" placeholder="e.g. Korto Johnson"></label>
        <label>Phone / WhatsApp number<input name="phone" required type="tel" value="${esc(c.phone)}" autocomplete="tel" placeholder="e.g. 0777 123 456"></label>
        ${both || !d.options.delivery.length && !d.options.pickup.length ? `<div class="seg">
          <button type="button" class="${delivery ? 'on' : ''}" data-method="DELIVERY">${icon('truck')} Delivery</button>
          <button type="button" class="${!delivery ? 'on' : ''}" data-method="PICKUP">${icon('pin')} Pickup</button></div>` : ''}
        ${opts.length ? `<div class="opts">${opts.map((o) => `<label class="opt ${o.id === c.optionId ? 'on' : ''}"><input type="radio" name="opt" value="${esc(o.id)}" ${o.id === c.optionId ? 'checked' : ''}>
          <span><b>${esc(o.name)}</b>${o.details ? `<small>${esc(o.details)}</small>` : ''}</span><em>${delivery ? (o.fee ? cur(o.fee, o.currency) : 'Free') : ''}</em></label>`).join('')}</div>` : ''}
        ${delivery ? `<label>Delivery address or landmark<input name="address" required value="${esc(c.address)}" placeholder="Street, house, nearby landmark"></label>` : ''}
        <label>Note for the shop (optional)<input name="note" value="${esc(c.note)}" placeholder="Colour, time, size…"></label>
        <div class="sum">
          <div><span>Items</span><span>${usd(t.usd)}</span></div>
          ${delivery ? `<div><span>Delivery${opt ? ' – ' + esc(opt.name) : ''}</span><span>${opt ? (opt.fee ? cur(opt.fee, opt.currency) : 'Free') : 'choose area'}</span></div>` : ''}
          <div class="total"><span>Total</span><b>${usd(t.usd + feeUSD)}</b></div>
          <div class="muted"><span>or in Liberian dollars</span><span>${lrd(t.lrd + feeLRD)}</span></div>
          <p class="muted small">No payment now. The shop confirms on WhatsApp and tells you how to pay (MoMo, cash on ${delivery ? 'delivery' : 'pickup'}).</p>
        </div>
        ${S.error ? `<div class="err">${esc(S.error)}</div>` : ''}
        <button class="wa-btn" type="submit" ${S.sending ? 'disabled' : ''}>${WA} ${S.sending ? 'Preparing your order…' : 'Send order on WhatsApp'}</button>
      </form>`;
  }

  function doneSheet() {
    const r = S.done;
    return `<div class="done">${icon('check', 'ok')}<h2>Order ${esc(r.orderNo)} is ready</h2>
      <p>Tap the button to open WhatsApp and send it to ${esc(S.data.store.name)}. The shop will reply to confirm and tell you how to pay.</p>
      <a class="wa-btn" href="${esc(r.whatsappUrl)}" target="_blank" rel="noopener" data-sent>${WA} Open WhatsApp & send</a>
      <details><summary>Show the message</summary><pre>${esc(r.message)}</pre></details>
      <button class="ghost" data-close>Back to the shop</button></div>`;
  }

  function sheet() {
    if (!S.cartOpen) return '';
    let inner;
    if (S.done) inner = doneSheet();
    else if (S.product) inner = productSheet(S.product);
    else if (S.step === 'checkout') inner = checkoutSheet();
    else inner = cartSheet();
    return `<div class="overlay" data-overlay><div class="sheet" role="dialog">${inner}</div></div>`;
  }

  function render() {
    if (!S.data) return;
    const active = document.activeElement && document.activeElement.id;
    $('#app').innerHTML = page();
    $('#sheet').innerHTML = sheet();
    document.body.style.overflow = S.cartOpen ? 'hidden' : '';
    if (active === 'q') { const i = $('#q'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }
  }
  function renderGrid() { $('#grid').innerHTML = grid(); const t = totals(); const bar = $('.cartbar'); if (!t.count || !bar) render(); else bar.querySelector('b').textContent = usd(t.usd), bar.querySelector('.n').textContent = t.count; }
  function renderSheet() { $('#sheet').innerHTML = sheet(); }

  /* ---------- events ---------- */
  document.addEventListener('input', (e) => {
    if (e.target.id === 'q') { S.q = e.target.value; renderGrid(); }
    if (e.target.form && e.target.form.id === 'co' && e.target.name && e.target.name !== 'opt') { S.customer[e.target.name] = e.target.value; store.set('shop-customer', S.customer); }
  });
  document.addEventListener('change', (e) => {
    if (e.target.name === 'opt') { S.customer.optionId = e.target.value; store.set('shop-customer', S.customer); renderSheet(); }
  });
  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-cat],[data-inc],[data-dec],[data-open],[data-cart],[data-close],[data-overlay],[data-step],[data-method],[data-pq],[data-addp],[data-sent]');
    if (!t) return;
    if (t.hasAttribute('data-overlay')) { if (e.target === t) { S.cartOpen = false; S.product = null; if (S.done) { S.done = null; } render(); } return; }
    if (t.hasAttribute('data-cat')) { S.cat = t.dataset.cat || null; render(); return; }
    if (t.hasAttribute('data-inc')) { e.stopPropagation(); const p = product(t.dataset.inc); setQty(p.id, inCart(p.id) + (inCart(p.id) ? p.step : 1)); S.cartOpen ? renderSheet() : null; renderGrid(); return; }
    if (t.hasAttribute('data-dec')) { e.stopPropagation(); const p = product(t.dataset.dec); setQty(p.id, inCart(p.id) - p.step); S.cartOpen ? renderSheet() : null; renderGrid(); return; }
    if (t.hasAttribute('data-open')) { if (e.target.closest('[data-stop]')) return; S.product = product(t.dataset.open); S.cartOpen = true; renderSheet(); document.body.style.overflow = 'hidden'; return; }
    if (t.hasAttribute('data-cart')) { S.cartOpen = true; S.product = null; S.step = 'cart'; render(); return; }
    if (t.hasAttribute('data-close')) { S.cartOpen = false; S.product = null; S.done = null; render(); return; }
    if (t.hasAttribute('data-step')) { S.step = t.dataset.step; S.error = ''; if (S.step === 'checkout') defaultOption(); renderSheet(); return; }
    if (t.hasAttribute('data-method')) { S.customer.method = t.dataset.method; S.customer.optionId = ''; defaultOption(); renderSheet(); return; }
    if (t.hasAttribute('data-pq')) { const i = $('#pq'); const p = S.product; i.value = Math.max(p.step, Math.round((num(i.value) + num(t.dataset.pq) * p.step) * 100) / 100); return; }
    if (t.hasAttribute('data-addp')) { const p = product(t.dataset.addp); setQty(p.id, Math.max(p.step, num($('#pq').value))); S.product = null; S.cartOpen = false; render(); toast('Added to cart'); return; }
    if (t.hasAttribute('data-sent')) { S.cart = []; store.set(key(), []); setTimeout(() => { S.cartOpen = false; S.done = null; render(); }, 800); }
  });
  document.addEventListener('submit', async (e) => {
    if (e.target.id !== 'co') return;
    e.preventDefault();
    const f = e.target;
    const c = S.customer;
    c.name = f.name.value.trim(); c.phone = f.phone.value.trim(); c.note = f.note.value.trim();
    if (f.address) c.address = f.address.value.trim();
    store.set('shop-customer', c);
    const delivery = c.method === 'DELIVERY';
    const opts = delivery ? S.data.options.delivery : S.data.options.pickup;
    if (opts.length && !opts.some((o) => o.id === c.optionId)) { S.error = delivery ? 'Please choose your delivery area.' : 'Please choose where you will pick up.'; renderSheet(); return; }
    S.sending = true; S.error = ''; renderSheet();
    try {
      S.orderRef = S.orderRef || uuid();
      const r = await call('shopOrder', { store: S.data.store.code, clientRef: S.orderRef, name: c.name, phone: c.phone, method: c.method,
        optionId: c.optionId, address: delivery ? c.address : '', note: c.note, items: cartLines().map(({ l }) => ({ id: l.id, qty: l.qty })) });
      S.done = r; S.orderRef = null;
      // try to open WhatsApp straight away; the button stays as a fallback
      try { window.open(r.whatsappUrl, '_blank', 'noopener'); } catch (x) { /* blocked: the button is there */ }
    } catch (err) {
      S.error = err.message;
    }
    S.sending = false; renderSheet();
  });
  function defaultOption() {
    const c = S.customer, d = S.data;
    if (!c.method || (c.method === 'DELIVERY' && !d.options.delivery.length) || (c.method === 'PICKUP' && !d.options.pickup.length)) {
      c.method = d.options.delivery.length ? 'DELIVERY' : 'PICKUP';
    }
    const opts = c.method === 'DELIVERY' ? d.options.delivery : d.options.pickup;
    if (!opts.some((o) => o.id === c.optionId)) c.optionId = opts.length === 1 ? opts[0].id : '';
  }
  function toast(m) { const t = document.createElement('div'); t.className = 'toast'; t.textContent = m; document.body.appendChild(t); setTimeout(() => t.remove(), 1800); }

  /* ---------- boot ---------- */
  async function boot() {
    try {
      S.ref = await storeRef();
      if (!S.ref) throw new Error('This link is missing the shop code. Ask the shop for its link.');
      S.data = await call('shopCatalog', { store: S.ref });
      theme(S.data.store.color);
      document.title = S.data.store.name + ' — order on WhatsApp';
      S.cart = store.get(key(), []).filter((l) => product(l.id));
      S.customer = Object.assign({ name: '', phone: '', method: '', optionId: '', address: '', note: '' }, store.get('shop-customer', {}));
      render();
    } catch (e) {
      $('#app').innerHTML = `<div class="fatal"><h1>Shop unavailable</h1><p>${esc(e.message)}</p><button onclick="location.reload()">Try again</button></div>`;
    }
  }
  boot();
})();

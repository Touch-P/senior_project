'use strict';
/* "สินค้าและราคา" with real data (brief section 8): search by name / SKU / class_name / barcode, scan barcodes
 * with the camera, edit product + price (SCD2 history), bind a barcode or add a product when not found.
 * Built only from the prototype's components (.card, .input, .table, .modal, btn(), badge(), lockedBtn(), toast()).
 * Mock mode keeps the prototype's viewProducts() unchanged.
 */
(() => {
  const PROTO_IMG = new Set(Object.keys(PRODUCTS)); // the 11 product photos shipped with the prototype
  const P = state.lp = {
    list: null, loading: false, q: '', search: null, selId: null, detail: null, adding: null,
    notFound: null, bindQ: '', bindResults: [], scan: null, via: 'table', saving: false,
  };
  let debounce = null;

  const thumb = (cls, size = 40) => PROTO_IMG.has(cls)
    ? `<img class="mini-thumb" style="width:${size}px;height:${size}px" src="assets/products/${esc(cls)}.jpg" alt="">`
    : `<span class="tile b-neutral" style="width:${size}px;height:${size}px;border-radius:8px;display:grid;place-items:center;flex:none">${ic('product', 18)}</span>`;
  const dateTh = (ms) => (ms ? new Date(ms).toLocaleString('th-TH', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
  const localInput = (ms) => { const d = new Date(ms - new Date().getTimezoneOffset() * 60_000); return d.toISOString().slice(0, 16); };

  async function loadList() {
    if (P.loading) return;
    P.loading = true;
    try { P.list = (await API.get('/api/products')).products; }
    catch (err) { toast('danger', err.message); P.list = []; }
    P.loading = false;
    render();
  }

  async function runSearch(q, { barcode = false, via } = {}) {
    P.q = q;
    if (!q.trim()) { P.search = null; P.notFound = null; return render(); }
    try {
      const url = barcode ? `/api/admin/products/search?barcode=${encodeURIComponent(q)}` : `/api/admin/products/search?q=${encodeURIComponent(q)}`;
      const r = await API.get(url);
      if (P.q !== q) return; // a newer query is running
      P.search = r;
      P.via = via ?? (r.mode === 'barcode' ? 'search_barcode' : 'search_name');
      P.notFound = r.mode === 'barcode' && r.barcode_not_found ? r.query : null;
      if (r.warning) toast('warning', r.warning);
      if (r.mode === 'barcode' && r.results.length) await select(r.results[0].product_id);
    } catch (err) { toast('danger', err.message); }
    render();
  }

  async function select(id) {
    P.selId = id; P.adding = null;
    try { P.detail = isStaff() ? (P.list ?? []).find((p) => p.product_id === id) : await API.get(`/api/admin/products/${id}`); }
    catch (err) { toast('danger', err.message); }
    render();
  }

  // ------------------------------------------------------------ view
  function rows(list) {
    const staff = isStaff();
    if (!list.length) return `<tr><td colspan="7" class="muted" style="padding:24px;text-align:center">ไม่พบสินค้าที่ตรงกับ “${esc(P.q)}”</td></tr>`;
    return list.map((x) => `<tr class="${x.product_id === P.selId ? 'sel' : ''}">
      <td class="wrap"><div class="row gap-12">${thumb(x.class_name)}<div class="col"><span class="t-strong">${esc(x.name_th)}</span><span class="t-cap muted">${esc(x.class_name)}${x.in_model ? '' : ' · โมเดลยังไม่รู้จัก'}</span></div></div></td>
      <td>${esc(x.sku ?? '—')}</td><td class="r num">${x.price != null ? baht(x.price) : '—'}</td><td class="r num">${x.promo_price ? baht(x.promo_price) : '—'}</td>
      <td>${dateTh(x.valid_from_ms)}</td><td>${x.is_active ? badge('success', 'ขายอยู่') : badge('neutral', 'ปิดขาย')}</td>
      <td class="r">${staff ? lockedBtn('ghost', 'm', 'แก้ไข', 'เฉพาะ admin เท่านั้น', 'edit') : btn('ghost', 'm', 'แก้ไข', `data-act="lp-select" data-id="${x.product_id}"`, 'edit')}</td></tr>`).join('');
  }

  function searchBar() {
    const staff = isStaff();
    const input = `<div class="input grow ${staff ? 'is-disabled' : ''}">${ic('search', 18)}<input id="psearch" type="search" placeholder="ค้นหาชื่อไทย/อังกฤษ, class_name, SKU หรือบาร์โค้ด" value="${esc(P.q)}" ${staff ? 'disabled' : 'data-lp-search'} aria-label="ค้นหาสินค้า" autocomplete="off"></div>`;
    if (staff) {
      return `<div class="row gap-12" style="margin-bottom:16px"><span class="tip grow" data-tip="ค้นหาและแก้ไขสินค้าได้เฉพาะ admin" tabindex="0" style="display:flex">${input}</span>
        ${lockedBtn('secondary', 'm', 'สแกนบาร์โค้ด', 'ค้นหาและแก้ไขสินค้าได้เฉพาะ admin', 'qr')}</div>`;
    }
    return `<div class="row gap-12" style="margin-bottom:16px">${input}${btn('secondary', 'm', 'สแกนบาร์โค้ด', 'data-act="lp-scan"', 'qr')}</div>`;
  }

  function notFoundCard() {
    if (!P.notFound) return '';
    const results = P.bindResults.map((p) => `<div class="row" style="padding:8px 0;border-top:1px solid var(--border)">${thumb(p.class_name, 32)}
      <div class="col grow"><span class="t-strong">${esc(p.name_th)}</span><span class="t-cap muted">${esc(p.class_name)}${p.barcode ? ` · มีบาร์โค้ด ${esc(p.barcode)} แล้ว` : ''}</span></div>
      ${btn('secondary', 'm', 'ผูก', `data-act="lp-bind" data-id="${p.product_id}"`)}</div>`).join('');
    return `<div class="card card-pad col gap-16" style="margin-bottom:16px" role="status">
      <div class="row gap-12"><span class="tile b-warning" style="width:40px;height:40px;border-radius:10px;display:grid;place-items:center">${ic('qr', 20)}</span>
        <div class="col grow"><span class="t-h3">ไม่พบบาร์โค้ดนี้</span><span class="t-cap muted num">${esc(P.notFound)} · ยังไม่ได้ผูกกับสินค้าใด</span></div>
        ${btn('ghost', 'm', 'ปิด', 'data-act="lp-nf-close"')}</div>
      <div class="col gap-8"><span class="t-strong">ผูกกับสินค้าที่มีอยู่</span>
        <div class="input">${ic('search', 18)}<input id="pbind" type="search" placeholder="ค้นหาด้วยชื่อสินค้า" value="${esc(P.bindQ)}" data-lp-bind aria-label="ค้นหาสินค้าที่จะผูกบาร์โค้ด" autocomplete="off"></div>${results}</div>
      <div class="row gap-12"><span class="t-cap muted grow">หรือเป็นสินค้าใหม่ที่โมเดลยังไม่รู้จัก (in_model = 0)</span>${btn('primary', 'm', 'เพิ่มสินค้าใหม่', 'data-act="lp-add" data-from-barcode="1"', 'plus')}</div></div>`;
  }

  const field = (id, label, value, { type = 'text', ro = false, icon = 'edit', step, placeholder = '', helper = '' } = {}) =>
    `<div class="field"><label for="${id}">${label}</label><div class="input ${ro ? 'is-disabled' : ''}">${ic(icon)}<input id="${id}" type="${type}" ${step ? `step="${step}" min="0"` : ''} value="${esc(value ?? '')}" placeholder="${esc(placeholder)}" ${ro ? 'disabled' : ''}></div>${helper ? `<span class="helper">${helper}</span>` : ''}</div>`;

  function editPanel() {
    const staff = isStaff();
    if (P.adding) return addPanel();
    const d = P.detail;
    if (!d) return `<div class="card card-pad col gap-12" style="position:sticky;top:96px"><span class="t-h3">${staff ? 'ราคา · ดูอย่างเดียว' : 'แก้ไขสินค้า'}</span>
      <span class="muted">เลือกสินค้าจากตาราง${staff ? '' : ' ค้นหา หรือสแกนบาร์โค้ด'}</span></div>`;
    if (staff) {
      return `<div class="card card-pad col gap-16" style="position:sticky;top:96px">
        <div class="row gap-12">${thumb(d.class_name, 56)}<div class="col"><span class="t-h3">ราคา · ดูอย่างเดียว</span><span class="t-cap muted">${esc(d.name_th)} · ${esc(d.class_name)}</span></div></div>
        ${field('price', 'ราคาปกติ (บาท)', d.price?.toFixed(2), { ro: true, icon: 'product' })}${field('promo', 'ราคาโปรโมชั่น', d.promo_price ? d.promo_price.toFixed(2) : '', { ro: true, icon: 'product', placeholder: 'ไม่มี' })}
        <span style="display:flex" class="tip" data-tip="แก้ราคาได้เฉพาะผู้ดูแลระบบ (admin)" tabindex="0"><button class="btn btn-primary btn-m" style="flex:1" disabled aria-disabled="true">${ic('lock', 16)}บันทึก</button></span></div>`;
    }
    const hist = (d.prices ?? []).map((p) => `<div class="row" style="padding:8px 12px;border-radius:8px;background:var(--bg)"><span class="t-strong num">${baht(p.price)}${p.promo_price ? ` <span class="t-cap muted">โปร ${baht(p.promo_price)}</span>` : ''}</span>
      <span class="t-cap muted grow">${dateTh(p.valid_from_ms)} – ${p.valid_to_ms ? dateTh(p.valid_to_ms) : p.is_current ? 'ปัจจุบัน' : 'รอมีผล'}${p.created_by_name ? ` · ${esc(p.created_by_name)}` : ''}</span>${p.is_current ? badge('success', 'ปัจจุบัน') : !p.valid_to_ms ? badge('warning', 'รอมีผล') : ''}</div>`).join('');
    return `<div class="card card-pad col gap-16" style="position:sticky;top:96px">
      <div class="row gap-12">${thumb(d.class_name, 56)}<div class="col grow"><span class="t-h3">แก้ไขสินค้า</span><span class="t-cap muted">${esc(d.class_name)}${d.in_model ? ' · โมเดลตรวจจับได้' : ' · โมเดลยังไม่รู้จัก'}</span></div>
        <button class="toggle ${d.is_active ? 'on' : ''}" data-act="lp-active" aria-pressed="${d.is_active}"><span class="sw"><i></i></span>${d.is_active ? 'เปิดขาย' : 'ปิดขาย'}</button></div>
      ${field('f-name_th', 'ชื่อไทย', d.name_th)}
      ${field('f-barcode', 'บาร์โค้ด', d.barcode, { icon: 'qr', placeholder: 'ยังไม่มี' })}
      ${field('f-brand', 'แบรนด์', d.brand)}${field('f-product_line', 'product_line', d.product_line)}
        ${field('f-flavor', 'รสชาติ / กลิ่น', d.flavor)}${field('f-variant', 'variant (ขนาด/แพ็ก)', d.variant)}
      ${field('f-sub_category', 'หมวด (sub_category)', d.sub_category, { helper: 'ใช้ตัดสิน “เปลี่ยนแบรนด์” — สินค้าหมวดเดียวกันต่างแบรนด์' })}
      ${field('price', 'ราคาปกติ (บาท)', d.price?.toFixed(2), { type: 'number', step: '0.5', icon: 'product' })}
        ${field('promo', 'ราคาโปรโมชั่น', d.promo_price ? d.promo_price.toFixed(2) : '', { type: 'number', step: '0.5', icon: 'product', placeholder: 'ไม่มี' })}
      ${field('from', 'มีผลตั้งแต่ (valid_from)', localInput(Date.now()), { type: 'datetime-local', icon: 'calendar', helper: 'ราคาใหม่มีผลกับสินค้าที่หยิบเข้ารถเข็นหลังเวลานี้ · ของที่อยู่ในรถเข็นแล้วใช้ราคาเดิม' })}
      <div class="col gap-8"><span class="t-strong">ประวัติราคา (product_prices)</span>${hist || '<span class="t-cap muted">ยังไม่มีราคา</span>'}</div>
      <div class="row gap-12">${btn('secondary', 'm', 'ยกเลิก', 'data-act="lp-reset" style="flex:1"')}${btn('primary', 'm', P.saving ? 'กำลังบันทึก…' : 'บันทึก', `data-act="lp-save" style="flex:1" ${P.saving ? 'disabled' : ''}`, 'check')}</div>
    </div>`;
  }

  function addPanel() {
    const a = P.adding;
    return `<div class="card card-pad col gap-16" style="position:sticky;top:96px">
      <div class="col"><span class="t-h3">เพิ่มสินค้าใหม่</span><span class="t-cap muted">โมเดลยังไม่รู้จักสินค้านี้จนกว่าจะ train ใหม่ (in_model = 0)</span></div>
      ${field('n-class_name', 'class_name (a-z, 0-9, _)', a.class_name, { placeholder: 'เช่น taokaenoi_big_ori' })}
      ${field('n-name_th', 'ชื่อไทย', a.name_th)}
      ${field('n-barcode', 'บาร์โค้ด', a.barcode, { icon: 'qr' })}
      ${field('n-brand', 'แบรนด์', a.brand)}${field('n-product_line', 'product_line', a.product_line)}
        ${field('n-flavor', 'รสชาติ / กลิ่น', a.flavor)}${field('n-variant', 'variant', a.variant)}
      ${field('n-sub_category', 'หมวด (sub_category)', a.sub_category, { placeholder: 'เช่น chips' })}
      ${field('n-price', 'ราคาปกติ (บาท)', a.price, { type: 'number', step: '0.5', icon: 'product' })}${field('n-promo', 'ราคาโปรโมชั่น', a.promo, { type: 'number', step: '0.5', icon: 'product', placeholder: 'ไม่มี' })}
      <div class="row gap-12">${btn('secondary', 'm', 'ยกเลิก', 'data-act="lp-add-cancel" style="flex:1"')}${btn('primary', 'm', 'เพิ่มสินค้า', 'data-act="lp-add-save" style="flex:1"', 'plus')}</div></div>`;
  }

  function scanModal() {
    if (!P.scan) return '';
    return `<div class="backdrop" data-act="lp-scan-bg"><div class="modal sm" role="dialog" aria-modal="true" aria-labelledby="scan-title">
      <div class="row"><h2 class="t-h3 grow" id="scan-title" style="margin:0">สแกนบาร์โค้ด</h2><button class="icon-btn" data-act="lp-scan-close" aria-label="ปิด">${ic('close')}</button></div>
      <div class="cam" style="aspect-ratio:4/3;border-radius:var(--r-card)"><video id="scan-video" playsinline muted autoplay style="width:100%;height:100%;object-fit:cover;display:block"></video>
        <svg class="roi" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true" style="position:absolute;inset:0;width:100%;height:100%"><rect x="12" y="34" width="76" height="32" rx="2" fill="none" stroke="#F59E0B" stroke-width="2" stroke-dasharray="8 6" vector-effect="non-scaling-stroke"/></svg></div>
      <span class="t-cap ${P.scan.error ? '' : 'muted'}" ${P.scan.error ? 'style="color:var(--danger)"' : ''} role="status">${esc(P.scan.error ?? (P.scan.engine ? `วางบาร์โค้ดในกรอบ · อ่านด้วย ${P.scan.engine} (ต้องอ่านได้ค่าเดียวกัน 2 ครั้ง)` : 'กำลังเปิดกล้องหลัง…'))}</span>
      <div class="row">${btn('secondary', 'm', 'ปิด', 'data-act="lp-scan-close" style="flex:1"')}</div></div></div>`;
  }

  function viewProductsLive() {
    if (!P.list) { loadList(); }
    const staff = isStaff();
    const list = P.search ? P.search.results : (P.list ?? []);
    const total = P.list?.length ?? 0, inModel = P.list?.filter((p) => p.in_model).length ?? 0;
    return aShell('products', `
      ${pageTitle('สินค้าและราคา', staff ? 'มุมมอง staff · ดูราคาได้ แต่ค้นหาและแก้ไขได้เฉพาะ admin' : `products + product_prices (เก็บประวัติราคา SCD2) · ${total} สินค้า · โมเดลตรวจจับได้ ${inModel}`,
        staff ? lockedBtn('primary', 'm', 'เพิ่มสินค้า', 'เพิ่มสินค้าได้เฉพาะ admin', 'plus') : btn('primary', 'm', 'เพิ่มสินค้า', 'data-act="lp-add"', 'plus'))}
      <div class="grid-side-320">
        <div class="col">${notFoundCard()}
          <div class="card card-pad">${cardHead(P.search ? `ผลการค้นหา (${list.length})` : `สินค้าทั้งหมด (${total})`, P.search ? `“${esc(P.search.query)}” · ${{ barcode: 'บาร์โค้ด', fts: 'ชื่อ (trigram)', 'fts+like': 'ชื่อ', like: 'ชื่อ', all: '' }[P.search.mode] ?? ''}` : 'class_name ต้องตรงกับ label ของโมเดล')}
            ${searchBar()}
            <div class="table-wrap"><table class="table"><thead><tr><th>สินค้า</th><th>SKU</th><th class="r">ราคา</th><th class="r">โปรโมชั่น</th><th>มีผลตั้งแต่</th><th>สถานะ</th><th></th></tr></thead>
              <tbody>${P.list ? rows(list) : '<tr><td colspan="7" class="muted" style="padding:24px;text-align:center">กำลังโหลด…</td></tr>'}</tbody></table></div></div></div>
        ${editPanel()}
      </div>${scanModal()}`);
  }

  // ------------------------------------------------------------ actions
  const val = (id) => document.getElementById(id)?.value.trim() ?? '';
  const nullable = (v) => (v === '' ? null : v);

  Object.assign(ACT, {
    'lp-select': (el) => { P.via = P.search ? P.via : 'table'; select(+el.dataset.id); },
    'lp-reset': () => select(P.selId),
    'lp-active': () => { if (P.detail) { P.detail.is_active = !P.detail.is_active; render(); } },
    'lp-nf-close': () => { P.notFound = null; P.bindResults = []; P.bindQ = ''; render(); },
    'lp-scan': () => {
      P.scan = { engine: null, error: null };
      render();
      Scanner.start(document.getElementById('scan-video'), (code) => {
        P.scan = null; render();
        toast('success', `อ่านบาร์โค้ด ${code} แล้ว`);
        runSearch(code, { barcode: true, via: 'scan_camera' });
      }, (msg) => { if (P.scan) { P.scan.error = msg; render(); } }).then((engine) => { if (P.scan && engine) { P.scan.engine = engine; render(); } });
    },
    'lp-scan-close': () => { Scanner.stop(); P.scan = null; render(); },
    'lp-scan-bg': (el, e) => { if (e.target === el) { Scanner.stop(); P.scan = null; render(); } },
    'lp-bind': async (el) => {
      try {
        const r = await API.post(`/api/admin/products/${el.dataset.id}/barcode`, { barcode: P.notFound, via: P.via === 'scan_camera' ? 'scan_camera' : 'search_barcode' });
        toast('success', `ผูกบาร์โค้ด ${P.notFound} กับ ${r.name_th} แล้ว`);
        P.notFound = null; P.bindResults = []; P.bindQ = ''; P.list = null; P.search = null; P.q = '';
        await select(r.product_id);
      } catch (err) { toast('danger', err.message); }
    },
    'lp-add': (el) => {
      P.adding = { barcode: el.dataset.fromBarcode ? P.notFound : '', class_name: '', name_th: '', brand: '', product_line: '', flavor: '', variant: '', sub_category: '', price: '', promo: '' };
      P.selId = null; P.detail = null; render();
    },
    'lp-add-cancel': () => { P.adding = null; render(); },
    'lp-add-save': async () => {
      const body = {
        class_name: val('n-class_name'), name_th: val('n-name_th'), barcode: nullable(val('n-barcode')), brand: nullable(val('n-brand')),
        product_line: nullable(val('n-product_line')), flavor: nullable(val('n-flavor')), variant: nullable(val('n-variant')),
        sub_category: nullable(val('n-sub_category')), price: parseFloat(val('n-price')), promo_price: val('n-promo') ? parseFloat(val('n-promo')) : null,
        via: P.notFound ? (P.via === 'scan_camera' ? 'scan_camera' : 'search_barcode') : 'table',
      };
      if (!(body.price > 0)) return toast('danger', 'ราคาต้องมากกว่า 0');
      try {
        const r = await API.post('/api/admin/products', body);
        toast('success', `เพิ่ม ${r.name_th} แล้ว`);
        P.adding = null; P.notFound = null; P.list = null; P.search = null; P.q = '';
        await select(r.product_id);
      } catch (err) { toast('danger', err.body?.issues?.[0]?.message ?? err.message); }
    },
    'lp-save': async () => {
      const d = P.detail; if (!d || P.saving) return;
      const price = parseFloat(val('price')), promoRaw = val('promo'), promo = promoRaw ? parseFloat(promoRaw) : null;
      if (!(price > 0)) return toast('danger', 'ราคาต้องมากกว่า 0');
      if (promo != null && !(promo > 0 && promo < price)) return toast('danger', 'ราคาโปรโมชั่นต้องน้อยกว่าราคาปกติ');
      const patch = {};
      for (const k of ['name_th', 'brand', 'product_line', 'flavor', 'variant', 'sub_category']) {
        const v = nullable(val(`f-${k}`));
        if (v !== (d[k] ?? null)) patch[k] = v;
      }
      if (patch.name_th === null) return toast('danger', 'ต้องมีชื่อไทย');
      const original = P.list?.find((p) => p.product_id === d.product_id);
      if (original && original.is_active !== d.is_active) patch.is_active = d.is_active;
      const barcode = val('f-barcode');
      if (barcode && !/^\d{8,14}$/.test(barcode)) return toast('danger', 'บาร์โค้ดต้องเป็นตัวเลข 8–14 หลัก');
      P.saving = true; render();
      try {
        if (Object.keys(patch).length) await API.patch(`/api/admin/products/${d.product_id}`, { ...patch, via: P.via });
        if (barcode && barcode !== (d.barcode ?? '')) await API.post(`/api/admin/products/${d.product_id}/barcode`, { barcode, via: P.via });
        if (price !== d.price || promo !== (d.promo_price ?? null)) {
          const from = new Date(val('from')).getTime();
          await API.post(`/api/admin/products/${d.product_id}/prices`, { price, promo_price: promo, ...(from > Date.now() + 60_000 ? { valid_from_ms: from } : {}), via: P.via });
        }
        toast('success', `บันทึก ${patch.name_th ?? d.name_th} แล้ว`);
        P.list = null;
      } catch (err) { toast('danger', err.body?.issues?.[0]?.message ?? err.message); }
      P.saving = false;
      await select(d.product_id);
    },
  });

  // typing in the search boxes: debounce 250 ms, keep focus while the page re-renders
  document.addEventListener('input', (e) => {
    if (e.target.matches('[data-lp-search]')) {
      clearTimeout(debounce);
      const q = e.target.value;
      debounce = setTimeout(() => runSearch(q), 250);
    }
    if (e.target.matches('[data-lp-bind]')) {
      clearTimeout(debounce);
      P.bindQ = e.target.value;
      debounce = setTimeout(async () => {
        try { P.bindResults = P.bindQ.trim() ? (await API.get(`/api/admin/products/search?q=${encodeURIComponent(P.bindQ)}`)).results.slice(0, 5) : []; }
        catch { P.bindResults = []; }
        render();
      }, 250);
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && P.scan) { Scanner.stop(); P.scan = null; render(); }
  });
  // another admin changed a product: refresh the table
  API.on('products_changed', () => { if (currentPath() === '/a/products') { P.list = null; render(); } });

  VIEWS['/a/products'] = () => (API.mock ? viewProducts() : viewProductsLive());
})();

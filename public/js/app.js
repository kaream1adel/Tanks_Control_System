import { api } from './api.js';
import { el, esc, chip, statusClass, fmtDate, dueLabel, fmtSize, bar, statBars, ringHTML, toast, modal } from './ui.js';

const DONE = new Set(['Done', 'Delivered']);

const state = {
  tankTypes: [], tanks: [], parts: [], options: { parts: {}, instances: {}, people: {} },
  route: 'overview', currentTypeId: null, currentTankId: null,
  tankFilter: 'all', statusFilter: 'all', phaseFilter: 'all', group: true, q: '',
  sort: { key: 'no', dir: 1 },
  followTankId: null, followTab: 'daily', followDate: new Date().toISOString().slice(0, 10), followPhase: '',
  tankTab: 'parts', access: 'full', shareMode: 'editor',
};

const $ = (s) => document.querySelector(s);
const view = () => $('#view');
const tankById = (id) => state.tanks.find((t) => t.id === id);

// Position a fixed-position popover (e.g. .dropdown-pop) under its trigger button,
// clamped to the viewport so it's never cropped — by either screen edge, or by a
// scrolling ancestor like .view (overflow:auto clips absolutely-positioned children,
// which is what used to crop the Export menu's left side on narrow screens).
function positionDropdown(btn, pop) {
  const margin = 8;
  const r = btn.getBoundingClientRect();
  pop.style.left = '0px'; pop.style.top = '0px'; // measure at a known position first
  const pw = pop.offsetWidth, ph = pop.offsetHeight;
  let left = r.right - pw; // right-align under the button by default
  left = Math.max(margin, Math.min(left, window.innerWidth - pw - margin));
  let top = r.bottom + 6;
  if (top + ph > window.innerHeight - margin) top = Math.max(margin, r.top - ph - 6); // flip above if no room below
  pop.style.left = left + 'px'; pop.style.top = top + 'px';
}

// ── Boot ──────────────────────────────────────────────────────
async function boot() {
  wireChrome();
  try { setData(await api.bootstrap()); } catch (e) { toast('Load failed: ' + e.message, 'err'); }
  render();
  setInterval(syncTick, 3000); // efficient live sync across machines
}
async function refresh() { setData(await api.bootstrap()); }
// Efficient multi-place sync: poll a tiny version number; only refetch when
// something actually changed somewhere, and never while the user is editing.
let _lastVersion = null;
async function syncTick() {
  let v; try { v = (await api.version()).version; } catch { return; }
  if (_lastVersion === null) { _lastVersion = v; return; }
  if (v === _lastVersion) return;
  _lastVersion = v;
  if (document.getElementById('modal')?.children.length) return;
  const ae = document.activeElement;
  if (ae && ['INPUT', 'SELECT', 'TEXTAREA'].includes(ae.tagName)) return;
  if (['settings', 'new', 'followup'].includes(state.route)) return;
  try { setData(await api.bootstrap()); render(); } catch { /* keep last good data */ }
}
function setData(d) {
  if (!d) return;
  Object.assign(state, { tankTypes: d.tankTypes || [], tanks: d.tanks || [], parts: d.parts || [], options: d.options || { parts: {}, instances: {}, people: {} } });
  if (!state.followTankId || !state.tanks.some((t) => t.id === state.followTankId)) state.followTankId = state.tanks[0]?.id || null;
  if (d.appVersion) {
    const vb = document.getElementById('verBadge'); if (vb) vb.textContent = 'v' + d.appVersion;
    const vf = document.getElementById('verBadgeFoot'); if (vf) vf.textContent = ' · v' + d.appVersion;
  }
  if (d.access) {
    state.access = d.access; api.setAccess(d.access);
    document.getElementById('app')?.classList.toggle('view-only', d.access === 'view');
    const ab = document.getElementById('accessBadge'); if (ab) ab.textContent = d.access === 'view' ? '👁 View only' : '';
  }
}
const canEdit = () => state.access !== 'view';
// view-only: show a clean notice and revert the just-touched control (re-render)
function denyEdit() { toast('🔒 View-only access — editing is disabled', 'err'); render(); }

// ── Chrome ────────────────────────────────────────────────────
function wireChrome() {
  const appEl = document.getElementById('app');
  const closeNav = () => appEl.classList.remove('nav-open');
  $('#navToggle')?.addEventListener('click', () => appEl.classList.toggle('nav-open'));
  $('#navBackdrop')?.addEventListener('click', closeNav);
  $('#nav').addEventListener('click', (e) => { const b = e.target.closest('.nav-item'); if (b) { closeNav(); go(b.dataset.route); } });
  $('#syncBtn').addEventListener('click', async () => {
    const btn = $('#syncBtn'); btn.classList.add('spinning');
    try { await refresh(); render(); toast('Refreshed', 'ok'); } finally { btn.classList.remove('spinning'); }
  });
  $('#globalSearch').addEventListener('input', (e) => {
    state.q = e.target.value;
    if (state.route !== 'parts') { state.route = 'parts'; setActive(); }
    render(); $('#globalSearch').focus();
  });
  // View-only guard: block any interaction with an inline edit control and show a
  // clear "Access denied" notice (capture phase, so it fires before focus/open).
  let _denyAt = 0;
  const editTarget = (el) => el instanceof Element && el.closest('#view')
    && el.matches('input:not([type="search"]), select, textarea');
  const deny = (e) => {
    if (state.access !== 'view' || !editTarget(e.target)) return;
    e.preventDefault(); e.stopPropagation();
    const now = Date.now(); if (now - _denyAt > 1500) { _denyAt = now; toast('🔒 Access denied — view-only access', 'err'); }
  };
  document.addEventListener('mousedown', deny, true);
  document.addEventListener('keydown', (e) => {
    if (state.access !== 'view' || !editTarget(e.target)) return;
    if (e.key.length === 1 || ['Backspace', 'Delete', 'Enter', ' '].includes(e.key)) deny(e);
  }, true);
}
function go(route, opts = {}) {
  state.route = route;
  if (opts.tankFilter) state.tankFilter = opts.tankFilter;
  if (opts.typeId) state.currentTypeId = opts.typeId;
  if (opts.tankId) { state.currentTankId = opts.tankId; state.tankTab = 'parts'; }
  setActive(); render();
}
function setActive() { document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.route === state.route)); }

function render() {
  const crumbs = { overview: 'Overview', tanks: 'Tanks', parts: 'All Parts', types: 'Tank Types', rework: 'Rework Analytics', followup: 'Follow-up', reports: 'Reports', settings: 'Settings', share: 'Share access', guide: 'Guide & Data Safety', new: 'New Tank', typeDetail: 'Tank Type', tankDetail: 'Tank' };
  $('#crumb').textContent = crumbs[state.route] || '';
  ({ overview: renderOverview, tanks: renderTanks, parts: renderParts, types: renderTypes, typeDetail: renderTypeDetail, tankDetail: renderTankDetail, rework: renderRework, followup: renderFollowup, reports: renderReports, settings: renderSettings, share: renderShare, guide: renderGuide, new: renderNew }[state.route] || renderOverview)();
}

// ── Overview ──────────────────────────────────────────────────
function renderOverview() {
  const parts = state.parts;
  const total = parts.length;
  const done = parts.filter((p) => DONE.has(p.status)).length;
  const rework = parts.filter((p) => (p.reworkCount ?? 0) > 0 || p.status === 'Rework').length;
  const pct = total ? Math.round((done / total) * 100) : 0;
  const activeTanks = state.tanks.filter((t) => !DONE.has(t.status)).length;

  if (!state.tanks.length) {
    const e = el('div.empty', { html: `<div class="big">▦</div><h2>No tanks yet</h2>
      <p class="muted">${state.tankTypes.some((t) => t.partCount) ? 'Create your first tank order — it clones the whole parts checklist.' : 'First add a tank type (import a parts list), then create a tank from it.'}</p><br/>
      <button class="btn" id="ovGo">${state.tankTypes.some((t) => t.partCount) ? '＋ New Tank' : '📐 Add a tank type'}</button>` });
    view().replaceChildren(e);
    e.querySelector('#ovGo').onclick = () => go(state.tankTypes.some((t) => t.partCount) ? 'new' : 'types');
    return;
  }

  const statusEntries = countBy(parts, 'status', (state.options.parts.status || []).map((o) => o.name)).map((e) => ({ ...e, chip: true }));
  const phaseEntries = countBy(parts.filter((p) => !DONE.has(p.status)), 'phase', (state.options.parts.phase || []).map((o) => o.name)).filter((e) => e.n > 0);
  const reworkByReason = countBy(parts.filter((p) => (p.reworkCount ?? 0) > 0), 'reworkReason', (state.options.parts.reworkReason || []).map((o) => o.name)).filter((e) => e.n > 0);
  const tankRows = state.tanks.map((t) => `
    <div class="statrow"><div class="name" style="width:170px;cursor:pointer" data-tank="${t.id}">${esc(t.name || 'Untitled')}</div>
      ${bar(t.completion, t.completion === 100)}<div class="n">${t.completion}%</div></div>`).join('');

  view().innerHTML = `
    <div class="grid kpis">
      <div class="panel kpi amber"><div class="label">Overall completion</div><div class="value">${pct}<small>%</small></div><div class="spark">◧</div><div style="margin-top:12px">${bar(pct, pct === 100)}</div></div>
      <div class="panel kpi"><div class="label">Parts done</div><div class="value">${done}<small>/ ${total}</small></div><div class="spark">▤</div></div>
      <div class="panel kpi"><div class="label">Active tanks</div><div class="value">${activeTanks}<small>/ ${state.tanks.length}</small></div><div class="spark">▥</div></div>
      <div class="panel kpi"><div class="label">In rework</div><div class="value" style="color:var(--red)">${rework}</div><div class="spark">↻</div></div>
    </div>
    <div class="grid" style="grid-template-columns:1fr 1fr">
      <div class="panel"><h3>Status breakdown</h3>${statBars(statusEntries) || '<div class="muted">No parts.</div>'}</div>
      <div class="panel"><h3>Pipeline (open parts by phase)</h3>${statBars(phaseEntries) || '<div class="muted">Nothing in progress.</div>'}</div>
    </div>
    <div class="grid" style="grid-template-columns:1.4fr 1fr;margin-top:16px">
      <div class="panel"><h3>Progress per tank</h3>${tankRows}</div>
      <div class="panel"><h3>Rework hotspots (by reason)</h3>${statBars(reworkByReason) || '<div class="muted">No rework logged. 🎉</div>'}</div>
    </div>
    <div class="section-title" style="margin-top:18px">Phase distribution per tank</div>
    <div class="grid phase-pie-grid">${state.tanks.map(tankPhaseCard).join('')}</div>`;
  view().querySelectorAll('[data-tank]').forEach((n) => n.addEventListener('click', () => go('tankDetail', { tankId: n.dataset.tank })));
}

// donut of a tank's parts by phase (hand-built, dependency-free)
const PIE_PALETTE = ['var(--amber)', 'var(--blue)', 'var(--green)', '#9a76e0', 'var(--orange)', '#d6a432', '#4db6ac', '#e573c7', '#8fa3ad', '#c0843a'];
const phaseColor = (name, order) => { const i = order.indexOf(name); return PIE_PALETTE[(i >= 0 ? i : order.length) % PIE_PALETTE.length]; };
function donutBg(segs) {
  const total = segs.reduce((s, x) => s + x.n, 0) || 1;
  let acc = 0;
  const stops = segs.map((s) => { const from = (acc / total) * 100; acc += s.n; return `${s.color} ${from}% ${(acc / total) * 100}%`; });
  return `radial-gradient(closest-side, var(--panel) 58%, transparent 59%), conic-gradient(${stops.join(',')})`;
}
function tankPhaseCard(t) {
  const tp = state.parts.filter((p) => p.tankId === t.id);
  const order = (state.options.parts.phase || []).map((o) => o.name);
  const segs = countBy(tp, 'phase', order).filter((e) => e.n > 0).map((c) => ({ name: c.name, n: c.n, color: phaseColor(c.name, order) }));
  const blank = tp.filter((p) => !p.phase).length;
  if (blank) segs.push({ name: 'Unset', n: blank, color: 'var(--muted-2)' });
  const headline = `<div class="row-between" style="margin-bottom:10px"><div class="tname" style="cursor:pointer" data-tank="${t.id}">${esc(t.name || 'Untitled')}</div><span class="muted">${tp.length} parts</span></div>`;
  if (!segs.length) return `<div class="panel">${headline}<div class="muted">No parts.</div></div>`;
  const legend = segs.map((s) => `<span class="legend-item"><span class="legend-dot" style="background:${s.color}"></span>${esc(s.name)} <b>${s.n}</b></span>`).join('');
  return `<div class="panel">${headline}<div style="display:flex;gap:16px;align-items:center"><div class="donut" style="background:${donutBg(segs)}"></div><div class="legend" style="margin:0">${legend}</div></div></div>`;
}

// ── Tanks ─────────────────────────────────────────────────────
function renderTanks() {
  if (!state.tanks.length) {
    const e = el('div.empty', { html: `<div class="big">▥</div><h2>No tanks yet</h2><p class="muted">Create a tank order from one of your types.</p><br/><button class="btn" id="t0">＋ New Tank</button>` });
    view().replaceChildren(e); e.querySelector('#t0').onclick = () => go('new'); return;
  }
  view().innerHTML = `<div class="grid tank-grid"></div>`;
  const grid = view().querySelector('.tank-grid');
  state.tanks.slice().sort((a, b) => b.completion - a.completion).forEach((t) => grid.append(tankCard(t)));
}
function tankCard(t) {
  const due = dueLabel(t.deliveryDate);
  const card = el('div.panel.tank-card');
  card.innerHTML = `
    <div class="head"><div><div class="tname">${esc(t.name || 'Untitled')}</div>
      <div class="tmeta">${esc(t.client || 'No client')}${t.tankType ? ' · ' + esc(t.tankType) : ''}</div></div>
      <button class="icon-btn" data-del title="Delete tank">🗑</button></div>
    <div class="ring-wrap">${ringHTML(t.completion, t.completion === 100)}
      <div style="flex:1">
        <div class="counts" style="margin-bottom:8px"><b>${t.partsDone}</b>/${t.partsTotal} parts${t.reworkParts ? ` · <span style="color:var(--red)">${t.reworkParts} rework</span>` : ''}</div>
        ${bar(t.completion, t.completion === 100)}
        <div class="counts" style="margin-top:10px">${due ? `<span style="color:var(--${due.cls})">${due.text}</span> · ` : ''}${fmtDate(t.deliveryDate)}</div>
      </div></div>
    <div style="display:flex;gap:8px;margin-top:14px" data-stop>
      ${selectHTML('instances', 'status', t.status, t.id, 'tank')} ${selectHTML('instances', 'priority', t.priority, t.id, 'tank')}</div>
    <div style="margin-top:12px"><button class="btn ghost" style="width:100%" data-open>Open tank →</button></div>`;
  card.querySelector('[data-open]').onclick = () => go('tankDetail', { tankId: t.id });
  card.querySelector('[data-del]').onclick = async (e) => {
    e.stopPropagation();
    if (!confirm(`Delete tank "${t.name}" and all its tracking rows? This cannot be undone.`)) return;
    await api.deleteTank(t.id); await refresh(); render(); toast('Tank deleted', 'ok');
  };
  card.querySelector('[data-stop]').addEventListener('click', (e) => e.stopPropagation());
  card.querySelectorAll('select.cell-edit').forEach((s) => s.addEventListener('change', onTankEdit));
  return card;
}

// ── Tank detail (dedicated per-tank page: status + proofs + export) ──────────
function renderTankDetail() {
  const t = state.tanks.find((x) => x.id === state.currentTankId);
  if (!t) { go('tanks'); return; }
  $('#crumb').textContent = t.name || 'Tank';
  const parts = state.parts.filter((p) => p.tankId === t.id).slice().sort((a, b) => (a.no ?? 0) - (b.no ?? 0));
  const delivered = parts.filter((p) => (p.qtyTotal || 0) > 0 && (p.deliveredQty || 0) >= p.qtyTotal).length;

  view().innerHTML = `
    <div class="row-between">
      <div><button class="btn ghost sm" id="back">← Tanks</button>
        <span style="font-size:18px;font-weight:600;margin-left:12px">${esc(t.name)}</span>
        <span class="muted" style="margin-left:8px">${esc(t.client || '')}${t.tankType ? ' · ' + esc(t.tankType) : ''}</span></div>
      <div class="dropdown" id="exportDD">
        <button class="btn ghost sm" id="exportBtn">⬇ Export ▾</button>
        <div class="dropdown-pop" id="exportPop" hidden>
          <button data-fmt="xlsx">📊 Excel (.xlsx)</button>
          <button data-fmt="doc">📝 Word (.doc)</button>
          <button data-fmt="pdf">📄 PDF (print)</button>
        </div>
      </div>
    </div>
    <div class="grid kpis" style="margin-bottom:14px">
      <div class="panel kpi amber"><div class="label">Completion</div><div class="value">${t.completion}<small>%</small></div><div style="margin-top:10px">${bar(t.completion, t.completion === 100)}</div></div>
      <div class="panel kpi"><div class="label">Parts done</div><div class="value">${t.partsDone}<small>/ ${t.partsTotal}</small></div></div>
      <div class="panel kpi"><div class="label">Delivered</div><div class="value" style="color:var(--green)">${delivered}<small>/ ${parts.length}</small></div></div>
      <div class="panel kpi"><div class="label">In rework</div><div class="value" style="color:var(--red)">${t.reworkParts || 0}</div></div>
    </div>
    <div class="panel" style="margin-bottom:14px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">
      <span class="muted">Status</span> ${selectHTML('instances', 'status', t.status, t.id, 'tank')}
      <span class="muted">Priority</span> ${selectHTML('instances', 'priority', t.priority, t.id, 'tank')}
      ${t.deliveryDate ? `<span class="muted">· Due ${esc(fmtDate(t.deliveryDate))}</span>` : ''}
    </div>
    <div class="tabs" id="tankTabs">
      <button class="tab ${state.tankTab === 'parts' ? 'on' : ''}" data-tab="parts">▤ Parts</button>
      <button class="tab ${state.tankTab === 'followup' ? 'on' : ''}" data-tab="followup">📅 Follow-up</button>
      <button class="tab ${state.tankTab === 'proofs' ? 'on' : ''}" data-tab="proofs">📷 Delivery proofs</button>
    </div>
    <div id="tankTabBody"></div>`;

  $('#back').onclick = () => go('tanks');
  // tank status/priority selects (in the meta panel only) → onTankEdit
  view().querySelectorAll('.panel > select.cell-edit').forEach((s) => s.addEventListener('change', onTankEdit));
  wireExportMenu({
    xlsx: `/api/tanks/${t.id}/report.xlsx`, doc: `/api/tanks/${t.id}/report.doc`,
    pdf: `/api/tanks/${t.id}/report-print`, filename: `${sanitizeName(t.name)}_status`,
  });
  const tabs = view().querySelectorAll('#tankTabs .tab');
  tabs.forEach((b) => b.onclick = () => {
    state.tankTab = b.dataset.tab;
    tabs.forEach((x) => x.classList.toggle('on', x.dataset.tab === state.tankTab));
    renderTankTab(t, parts);
  });
  renderTankTab(t, parts);
}

// fill the active tank-page tab (Parts / Follow-up / Delivery proofs)
function renderTankTab(t, parts) {
  const box = $('#tankTabBody'); if (!box) return;
  if (state.tankTab === 'followup') { renderTankFollowup(t); return; }
  if (state.tankTab === 'proofs') {
    box.innerHTML = `
      <div class="panel">
        <div class="dropzone" id="proofDz"><div class="big">📷</div>Click or drop photos / PDFs of delivery proofs here<div class="hint">Images embed directly; PDFs are saved with a preview image — both appear in the exported report</div></div>
        <input type="file" id="proofIn" accept="image/*,application/pdf" multiple style="display:none"/>
        <div class="viewer-grid" id="proofGrid" style="margin-top:14px"></div>
      </div>`;
    loadProofs(t.id);
    const dz = $('#proofDz'), input = $('#proofIn');
    dz.onclick = () => input.click();
    input.onchange = () => { if (input.files.length) addProofs(t.id, [...input.files]); input.value = ''; };
    wireDrag(dz, (files) => files.length && addProofs(t.id, files));
    return;
  }
  // parts (default)
  const cols = COLS;
  box.innerHTML = `<div class="table-wrap"><table id="tdParts" class="cards">
      <thead><tr>${cols.map((c) => `<th>${c.label}</th>`).join('')}</tr></thead>
      <tbody>${parts.map((p) => partRow(p, cols)).join('') || `<tr><td colspan="${cols.length}"><div class="empty"><div class="big">▤</div>No parts in this tank.</div></td></tr>`}</tbody>
    </table></div>${assigneeDatalist()}`;
  const tb = box.querySelector('#tdParts tbody');
  tb.addEventListener('change', onPartEdit);
  tb.querySelectorAll('[data-files]').forEach((b) => b.addEventListener('click', () => openPartFiles(b.dataset.files)));
}

// per-tank Daily/Weekly worksheet, embedded in the Tank page (reuses renderDailyTab/renderWeeklyTab)
function renderTankFollowup(t) {
  const box = $('#tankTabBody'); if (!box) return;
  state.followTankId = t.id;
  box.innerHTML = `
    <div class="toolbar">
      ${state.followTab === 'daily' ? `<input id="fuDate" type="date" value="${state.followDate}"/>` : ''}
      <div class="spacer"></div>
      <div class="tabs"><button class="tab ${state.followTab === 'daily' ? 'on' : ''}" data-tab="daily">Daily follow-up</button><button class="tab ${state.followTab === 'weekly' ? 'on' : ''}" data-tab="weekly">Weekly rollup</button></div>
    </div>
    <div id="fuBody"><div class="loading">Loading…</div></div>`;
  const dt = $('#fuDate'); if (dt) dt.onchange = (e) => { state.followDate = e.target.value; renderDailyTab(); };
  box.querySelectorAll('.toolbar .tab[data-tab]').forEach((b) => b.onclick = () => { state.followTab = b.dataset.tab; renderTankFollowup(t); });
  if (state.followTab === 'daily') renderDailyTab(); else renderWeeklyTab();
}

// generic Export ▾ dropdown wiring (Excel/Word download, PDF → print tab)
function wireExportMenu({ xlsx, doc, pdf, filename }) {
  const pop = $('#exportPop'); const btn = $('#exportBtn'); if (!pop || !btn) return;
  const closePop = () => {
    pop.hidden = true;
    document.removeEventListener('click', closePop);
    window.removeEventListener('resize', closePop);
    view().removeEventListener('scroll', closePop);
  };
  btn.onclick = (e) => {
    e.stopPropagation();
    if (pop.hidden) {
      pop.hidden = false; positionDropdown(btn, pop);
      setTimeout(() => document.addEventListener('click', closePop), 0);
      window.addEventListener('resize', closePop);
      view().addEventListener('scroll', closePop, { passive: true });
    } else closePop();
  };
  const MIME = { xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', doc: 'application/msword' };
  pop.querySelectorAll('button').forEach((b) => b.onclick = async () => {
    closePop();
    const fmt = b.dataset.fmt;
    if (fmt === 'pdf') { window.open(pdf, '_blank'); return; } // browser → Save as PDF
    try { downloadFile(`${filename}.${fmt}`, await api.exportBlob(fmt === 'xlsx' ? xlsx : doc), MIME[fmt]); toast(`${fmt === 'doc' ? 'Word' : 'Excel'} exported`, 'ok'); }
    catch (e) { toast('Export failed: ' + e.message, 'err'); }
  });
}

// render a local image/PDF File to a downscaled PNG blob (so PDFs become embeddable images)
async function fileToPreviewPng(file) {
  const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
  let canvas;
  if (isPdf) {
    const lib = await getPdfjs();
    const doc = await lib.getDocument({ data: await file.arrayBuffer() }).promise;
    const page = await doc.getPage(1);
    const scale = Math.min(2, 1500 / page.getViewport({ scale: 1 }).width);
    const vp = page.getViewport({ scale });
    canvas = document.createElement('canvas'); canvas.width = Math.round(vp.width); canvas.height = Math.round(vp.height);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
  } else {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('cannot read image')); img.src = url; });
      const sc = Math.min(1, 1500 / Math.max(img.naturalWidth, img.naturalHeight));
      canvas = document.createElement('canvas'); canvas.width = Math.round(img.naturalWidth * sc); canvas.height = Math.round(img.naturalHeight * sc);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    } finally { URL.revokeObjectURL(url); }
  }
  return await new Promise((res) => canvas.toBlob(res, 'image/png'));
}

async function addProofs(tankId, files) {
  const grid = $('#proofGrid'); if (grid) grid.insertAdjacentHTML('afterbegin', `<div class="muted" id="proofUp" style="padding:10px">⏳ Uploading ${files.length} file(s)…</div>`);
  let ok = 0;
  for (const file of files) {
    try {
      let preview = null;
      try { preview = await fileToPreviewPng(file); } catch { /* unsupported preview → store original only */ }
      const fd = new FormData();
      fd.append('file', file, file.name);
      if (preview) fd.append('preview', preview, 'preview.png');
      await api.uploadProof(tankId, fd); ok++;
    } catch (e) { toast(`Proof "${file.name}" failed: ${e.message}`, 'err'); }
  }
  if (ok) toast(`${ok} delivery proof${ok > 1 ? 's' : ''} added`, 'ok');
  loadProofs(tankId);
}

async function loadProofs(tankId) {
  const grid = $('#proofGrid'); if (!grid) return;
  try {
    const { proofs } = await api.tankProofs(tankId);
    if (!proofs.length) { grid.innerHTML = '<div class="muted" style="padding:10px">No delivery proofs yet — drop photos or PDFs above.</div>'; return; }
    grid.innerHTML = proofs.map((f) => `
      <div class="file-card">
        <div class="thumb" data-open="${f.url}"><img src="${f.previewUrl}" alt="" loading="lazy"/></div>
        <div class="fmeta"><span class="fn">${f.kind === 'pdf' ? '📄 ' : ''}${esc(f.filename)}</span>
          <span style="display:flex;gap:8px;align-items:center"><a href="${f.url}" target="_blank">open</a>
          <button class="icon-btn" data-delproof="${f.id}" title="Delete">🗑</button></span></div>
      </div>`).join('');
    grid.querySelectorAll('[data-open]').forEach((n) => n.style.cursor = 'pointer');
    grid.querySelectorAll('.thumb[data-open]').forEach((n) => n.onclick = () => window.open(n.dataset.open, '_blank'));
    grid.querySelectorAll('[data-delproof]').forEach((b) => b.onclick = async () => {
      if (!confirm('Delete this delivery proof?')) return;
      try { await api.deleteProof(b.dataset.delproof); toast('Proof deleted', 'ok'); loadProofs(tankId); } catch (e) { toast('Delete failed: ' + e.message, 'err'); }
    });
  } catch (e) { grid.innerHTML = `<div class="muted" style="padding:10px">Failed to load proofs: ${esc(e.message)}</div>`; }
}

// ── Parts table ───────────────────────────────────────────────
function renderParts() {
  const tankOpts = ['<option value="all">All tanks</option>'].concat(state.tanks.map((t) => `<option value="${t.id}">${esc(t.name || 'Untitled')}</option>`)).join('');
  view().innerHTML = `
    <div class="toolbar">
      <select id="fTank">${tankOpts}</select>
      <select id="fStatus"><option value="all">All statuses</option>${optionList('parts', 'status')}</select>
      <select id="fPhase"><option value="all">All phases</option>${optionList('parts', 'phase')}</select>
      <input id="fSearch" type="search" placeholder="Search…" value="${esc(state.q)}" />
      <div class="spacer"></div>
      <div class="toggle"><button id="gTank" class="${state.group && state.tankFilter === 'all' ? 'on' : ''}">Group by tank</button><button id="gFlat" class="${!state.group || state.tankFilter !== 'all' ? 'on' : ''}">Flat</button></div>
    </div>
    <div class="table-wrap"><table id="ptable" class="cards"></table></div>
    ${assigneeDatalist()}`;
  $('#fTank').value = state.tankFilter;
  $('#fTank').onchange = (e) => { state.tankFilter = e.target.value; renderParts(); };
  $('#fStatus').value = state.statusFilter; $('#fStatus').onchange = (e) => { state.statusFilter = e.target.value; renderTable(); };
  $('#fPhase').value = state.phaseFilter; $('#fPhase').onchange = (e) => { state.phaseFilter = e.target.value; renderTable(); };
  $('#fSearch').oninput = (e) => { state.q = e.target.value; $('#globalSearch').value = e.target.value; renderTable(); };
  $('#gTank').onclick = () => { state.group = true; renderParts(); };
  $('#gFlat').onclick = () => { state.group = false; renderParts(); };
  renderTable();
}
function filteredParts() {
  const q = state.q.trim().toLowerCase();
  return state.parts.filter((p) => {
    if (state.tankFilter !== 'all' && p.tankId !== state.tankFilter) return false;
    if (state.statusFilter !== 'all' && p.status !== state.statusFilter) return false;
    if (state.phaseFilter !== 'all' && p.phase !== state.phaseFilter) return false;
    if (q && !(`${p.itemCode} ${p.partName} ${p.description} ${p.assignedTo}`.toLowerCase().includes(q))) return false;
    return true;
  });
}
const COLS = [
  { key: 'no', label: 'No' }, { key: 'partName', label: 'Part' }, { key: 'phase', label: 'Phase' },
  { key: 'status', label: 'Status' }, { key: 'qtyDone', label: 'Qty' }, { key: 'reworkCount', label: 'Rework' },
  { key: 'reworkReason', label: 'Reason' }, { key: 'assignedTo', label: 'Assignee' }, { key: 'files', label: 'Files' },
];
function renderTable() {
  const table = $('#ptable'); if (!table) return;
  const showTank = state.tankFilter === 'all' && !state.group;
  const cols = showTank ? [...COLS.slice(0, 2), { key: 'tank', label: 'Tank' }, ...COLS.slice(2)] : COLS;
  const head = `<thead><tr>${cols.map((c) => `<th data-sort="${c.key}">${c.label}${state.sort.key === c.key ? (state.sort.dir > 0 ? ' ▲' : ' ▼') : ''}</th>`).join('')}</tr></thead>`;
  let rows = filteredParts();
  const { key, dir } = state.sort;
  rows.sort((a, b) => {
    const va = a[key], vb = b[key];
    if (typeof va === 'number' || typeof vb === 'number') return ((va ?? 0) - (vb ?? 0)) * dir;
    return String(va ?? '').localeCompare(String(vb ?? '')) * dir;
  });
  let bodyHTML = '';
  if (state.group && state.tankFilter === 'all') {
    for (const t of state.tanks) {
      const g = rows.filter((p) => p.tankId === t.id); if (!g.length) continue;
      const doneN = g.filter((p) => DONE.has(p.status)).length;
      bodyHTML += `<tr class="group-row"><td colspan="${cols.length}">${esc(t.name || 'Untitled')} — ${doneN}/${g.length} done</td></tr>` + g.map((p) => partRow(p, cols)).join('');
    }
  } else bodyHTML = rows.map((p) => partRow(p, cols)).join('');
  if (!rows.length) bodyHTML = `<tr><td colspan="${cols.length}"><div class="empty"><div class="big">▤</div>No parts match.</div></td></tr>`;
  table.innerHTML = head + `<tbody>${bodyHTML}</tbody>`;
  table.querySelectorAll('th[data-sort]').forEach((th) => th.addEventListener('click', () => { const k = th.dataset.sort; state.sort = { key: k, dir: state.sort.key === k ? -state.sort.dir : 1 }; renderTable(); }));
  table.querySelector('tbody').addEventListener('change', onPartEdit);
  table.querySelectorAll('[data-files]').forEach((b) => b.addEventListener('click', () => openPartFiles(b.dataset.files)));
}
function partRow(p, cols) {
  const tank = tankById(p.tankId);
  const fc = p.fileCount || 0;
  const cell = {
    no: `<td class="num" data-label="No"><input class="cell-edit cell-num" type="number" min="0" value="${p.no ?? ''}" data-id="${p.id}" data-field="no"/></td>`,
    partName: `<td class="pn" data-label="Part"><input class="cell-edit partname" dir="auto" type="text" value="${esc(p.description || '')}" placeholder="Part name" data-id="${p.id}" data-field="description"/><input class="cell-edit partcode" dir="auto" type="text" value="${esc(p.itemCode || '')}" placeholder="Item code" data-id="${p.id}" data-field="itemCode"/></td>`,
    tank: `<td class="muted" data-label="Tank">${esc(tank?.name || '—')}</td>`,
    phase: `<td data-label="Phase">${selectHTML('parts', 'phase', p.phase, p.id, 'part', true)}</td>`,
    status: `<td data-label="Status">${selectHTML('parts', 'status', p.status, p.id, 'part')}</td>`,
    qtyDone: `<td data-label="Qty"><div class="qbar"><input class="cell-edit cell-num" type="number" min="0" value="${p.qtyDone ?? 0}" data-id="${p.id}" data-field="qtyDone"/><span class="muted">/</span><input class="cell-edit cell-num" style="width:50px" type="number" min="0" value="${p.qtyTotal ?? 0}" data-id="${p.id}" data-field="qtyTotal"/>${bar(p.progress, p.progress === 100)}</div></td>`,
    reworkCount: `<td data-label="Rework"><input class="cell-edit cell-num" type="number" min="0" value="${p.reworkCount ?? 0}" data-id="${p.id}" data-field="reworkCount"/></td>`,
    reworkReason: `<td data-label="Reason">${selectHTML('parts', 'reworkReason', p.reworkReason, p.id, 'part', true)}</td>`,
    assignedTo: `<td data-label="Assignee"><input class="cell-edit" type="text" list="assigneeList" autocomplete="off" value="${esc(p.assignedTo || '')}" placeholder="—" data-id="${p.id}" data-field="assignedTo"/></td>`,
    files: `<td class="act" data-label="Files"><button class="file-pill ${fc ? '' : 'none'}" data-files="${p.id}">📎 ${fc || '0'}</button></td>`,
  };
  return `<tr data-row="${p.id}">${cols.map((c) => cell[c.key]).join('')}</tr>`;
}
async function onPartEdit(e) {
  const t = e.target; if (!t.dataset.id || !t.dataset.field) return;
  if (!canEdit()) return denyEdit();
  const id = t.dataset.id, field = t.dataset.field;
  const value = t.type === 'number' ? (t.value === '' ? null : Number(t.value)) : t.value;
  const td = t.closest('td'); td.classList.remove('saved', 'error'); td.classList.add('saving');
  try {
    const fresh = await api.updatePart(id, { [field]: value });
    const i = state.parts.findIndex((p) => p.id === id); if (i >= 0) state.parts[i] = fresh;
    td.classList.remove('saving'); td.classList.add('saved');
    if (field === 'assignedTo') await rememberAssignee(value);
    // itemCode changes fileCount; no/description affect sort/group/search
    if (['qtyDone', 'qtyTotal', 'status', 'itemCode', 'no', 'description'].includes(field)) renderTable();
  } catch (err) { td.classList.remove('saving'); td.classList.add('error'); toast('Save failed: ' + err.message, 'err'); }
}

// persist a newly-typed assignee so it's offered next time (best-effort)
async function rememberAssignee(value) {
  const name = (value || '').trim(); if (!name) return;
  const list = state.options.people?.assignee || (state.options.people = { assignee: [] }).assignee;
  if (list.some((o) => o.name.toLowerCase() === name.toLowerCase())) return;
  try {
    await api.addOption('assignee', name);
    list.push({ name }); list.sort((a, b) => a.name.localeCompare(b.name));
    const dl = document.getElementById('assigneeList');
    if (dl) dl.innerHTML = list.map((o) => `<option value="${esc(o.name)}"></option>`).join('');
  } catch { /* part already saved; remembering is best-effort */ }
}
function assigneeDatalist() {
  return `<datalist id="assigneeList">${(state.options.people?.assignee || []).map((o) => `<option value="${esc(o.name)}"></option>`).join('')}</datalist>`;
}
async function onTankEdit(e) {
  if (!canEdit()) return denyEdit();
  const t = e.target; const id = t.dataset.id, field = t.dataset.field;
  try { const fresh = await api.updateTank(id, { [field]: t.value }); const i = state.tanks.findIndex((x) => x.id === id); if (i >= 0) state.tanks[i] = fresh; toast('Tank updated', 'ok'); }
  catch (err) { toast('Save failed: ' + err.message, 'err'); }
}
async function openPartFiles(partId) {
  const p = state.parts.find((x) => x.id === partId);
  try {
    const files = await api.partFiles(partId);
    openFileViewer(files, p?.partName || 'Part files', p?.itemCode || '', { partId, typeId: tankById(p?.tankId)?.tankTypeId, itemCode: p?.itemCode, reload: () => api.partFiles(partId) });
  } catch (e) { toast('Could not load files: ' + e.message, 'err'); }
}

// ── File viewer (PDFs / images by item code) ──────────────────
// Files are fetched as in-memory blobs and rendered from object URLs so that
// browser download managers (IDM etc.) can't hijack the request — they display
// inline instead of triggering a download.
function openFileViewer(files, title, subtitle, ctx) {
  const canCrop = !!ctx && canEdit();
  const canAdd = !!(ctx && ctx.typeId) && canEdit();
  const objectUrls = [];
  async function reopenWith() {
    try { await refresh(); } catch { /* ignore */ }
    if (state.route === 'parts') renderTable();
    else if (state.route === 'typeDetail') renderTypeDetail();
    else if (state.route === 'tankDetail') renderTankDetail();
    let fresh = files; try { fresh = await ctx.reload(); } catch { /* keep */ }
    objectUrls.forEach(URL.revokeObjectURL);
    openFileViewer(fresh, title, subtitle, ctx);
  }
  const addZone = canAdd
    ? `<div class="dropzone" id="addFilesDz" style="margin-bottom:14px;padding:18px"><div class="big">⬆</div>Drop files here or click to add to <b dir="auto">${esc(ctx.itemCode || 'this part')}</b><div class="hint">PDFs or images — attached directly to this part</div></div><input type="file" id="addFilesIn" multiple style="display:none"/>`
    : '';
  function wireAddZone(body) {
    if (!canAdd) return;
    const dz = body.querySelector('#addFilesDz'), inp = body.querySelector('#addFilesIn');
    if (!dz) return;
    const doAdd = async (fl) => {
      const list = [...fl].filter((f) => f && f.size >= 0);
      if (!list.length) return;
      if (!ctx.itemCode) { toast('Set an item code for this part first, then add files.', 'err'); return; }
      dz.innerHTML = `<div class="loading">Uploading ${list.length} file(s)…</div>`;
      const fd = new FormData(); list.forEach((f) => fd.append('files', f, f.name));
      try { const r = await api.addFilesToCode(ctx.typeId, ctx.itemCode, fd); toast(`Added ${r.added} file(s)`, 'ok'); }
      catch (e) { toast('Add failed: ' + e.message, 'err'); }
      reopenWith();
    };
    dz.onclick = () => inp.click();
    inp.onchange = () => doAdd(inp.files);
    wireDrag(dz, doAdd);
  }

  const body = el('div');
  if (!files.length) {
    body.innerHTML = addZone + `<div class="empty"><div class="big">📄</div>No files for item code <b>${esc(subtitle || '—')}</b> yet.${canAdd ? '' : '<br/><span class="muted">Add PDFs/images in Tank Types → this type → Upload files (named by item code).</span>'}</div>`;
    modal({ title, subtitle: subtitle ? `Item code: ${subtitle}` : '', body });
    wireAddZone(body);
    return;
  }
  body.innerHTML = addZone + `
    <div class="tabs">${files.map((f, i) => `<button class="tab ${i === 0 ? 'on' : ''}" data-i="${i}">${f.kind === 'pdf' ? '📕' : f.kind === 'image' ? '🖼' : '📎'} ${esc(f.filename)}</button>`).join('')}</div>
    ${canCrop ? '<div class="viewer-actions"><button class="btn sm" id="cropBtn">✂ Crop &amp; save as photo</button><button class="btn ghost sm" id="delFileBtn">🗑 Delete this file</button><span class="hint">Crop the 3D view (or any region) and save it as this part\'s photo — in place.</span></div>' : ''}
    <div id="bigview"></div>`;
  const big = body.querySelector('#bigview');
  const cache = new Map();
  let cur = 0;
  async function blobUrl(f) {
    if (cache.has(f.id)) return cache.get(f.id);
    const res = await fetch(f.url); if (!res.ok) throw new Error('HTTP ' + res.status);
    const url = URL.createObjectURL(await res.blob()); cache.set(f.id, url); objectUrls.push(url); return url;
  }
  async function show(f) {
    big.innerHTML = `<div class="loading">Loading ${esc(f.filename)}…</div>`;
    try {
      const url = await blobUrl(f);
      big.innerHTML = f.kind === 'image'
        ? `<img class="viewer-big" style="object-fit:contain" src="${url}" alt="${esc(f.filename)}"/>`
        : f.kind === 'pdf' ? `<iframe class="viewer-big" src="${url}"></iframe>`
          : `<div class="empty"><a class="btn" href="${url}" download="${esc(f.filename)}">Download ${esc(f.filename)}</a></div>`;
    } catch (e) { big.innerHTML = `<div class="empty">Couldn't load this file.<br/><span class="muted">${esc(e.message)}</span></div>`; }
  }
  body.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => {
    body.querySelectorAll('.tab').forEach((x) => x.classList.remove('on')); b.classList.add('on'); cur = Number(b.dataset.i); show(files[cur]);
  }));
  show(files[0]);
  modal({ title, subtitle: subtitle ? `Item code: ${subtitle}` : '', body, onClose: () => objectUrls.forEach(URL.revokeObjectURL) });
  wireAddZone(body);
  if (canCrop) {
    body.querySelector('#cropBtn').onclick = async () => {
      const saved = await openCropper(files[cur], ctx);
      if (saved) { toast('Photo saved', 'ok'); reopenWith(); }
    };
    body.querySelector('#delFileBtn').onclick = async () => {
      const f = files[cur];
      if (!confirm(`Delete "${f.filename}"? It is removed from this tank type (affects every tank made from it).`)) return;
      try { await api.deleteFile(f.id); toast('File deleted', 'ok'); reopenWith(); }
      catch (e) { toast('Delete failed: ' + e.message, 'err'); }
    };
  }
}

// ── In-place cropper: render a file to a canvas, drag a box, save the crop ──
let _pdfjs = null;
async function getPdfjs() {
  if (!_pdfjs) { _pdfjs = await import('/vendor/pdf.min.mjs'); _pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.min.mjs'; }
  return _pdfjs;
}
async function renderToCanvas(file) {
  const canvas = document.createElement('canvas');
  if (file.kind === 'image') {
    const url = URL.createObjectURL(await (await fetch(file.url)).blob());
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('image load failed')); img.src = url; });
    canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
    canvas.getContext('2d').drawImage(img, 0, 0); URL.revokeObjectURL(url); return canvas;
  }
  if (file.kind === 'pdf') {
    const lib = await getPdfjs();
    const data = await (await fetch(file.url)).arrayBuffer();
    const doc = await lib.getDocument({ data }).promise;
    const page = await doc.getPage(1);
    const scale = Math.min(2.5, 2000 / page.getViewport({ scale: 1 }).width);
    const vp = page.getViewport({ scale });
    canvas.width = Math.round(vp.width); canvas.height = Math.round(vp.height);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
    return canvas;
  }
  throw new Error('Only images and PDFs can be cropped');
}
function openCropper(file, ctx) {
  return new Promise((resolve) => {
    let done = false; const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const body = el('div');
    body.innerHTML = `<div class="crop-toolbar"><span class="muted">Drag a box over the area to keep, then Save.</span><div class="spacer"></div>
        <button class="btn ghost sm" id="cCancel">Cancel</button><button class="btn sm" id="cSave" disabled>Save photo</button></div>
      <div class="crop-stage" id="cStage"><div class="loading">Rendering…</div></div>`;
    const m = modal({ title: 'Crop & save photo', subtitle: file.filename, body, onClose: () => finish(false) });
    const stage = body.querySelector('#cStage'), saveBtn = body.querySelector('#cSave');
    body.querySelector('#cCancel').onclick = () => m.close();
    (async () => {
      let canvas;
      try { canvas = await renderToCanvas(file); } catch (e) { stage.innerHTML = `<div class="empty">Couldn't render this file.<br/><span class="muted">${esc(e.message)}</span></div>`; return; }
      canvas.className = 'crop-canvas';
      const wrap = el('div.crop-wrap'); wrap.append(canvas);
      const selBox = el('div.crop-sel'); selBox.style.display = 'none'; wrap.append(selBox);
      stage.innerHTML = ''; stage.append(wrap);
      let sel = null, sx0 = 0, sy0 = 0, dragging = false;
      const rectOf = () => wrap.getBoundingClientRect();
      const updateBox = () => { selBox.style.left = sel.x + 'px'; selBox.style.top = sel.y + 'px'; selBox.style.width = sel.w + 'px'; selBox.style.height = sel.h + 'px'; };
      const onMove = (e) => { if (!dragging) return; const r = rectOf(); const x = Math.max(0, Math.min(e.clientX - r.left, r.width)), y = Math.max(0, Math.min(e.clientY - r.top, r.height)); sel = { x: Math.min(sx0, x), y: Math.min(sy0, y), w: Math.abs(x - sx0), h: Math.abs(y - sy0) }; updateBox(); };
      const onUp = () => { dragging = false; document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); saveBtn.disabled = !(sel && sel.w > 4 && sel.h > 4); };
      wrap.addEventListener('mousedown', (e) => { const r = rectOf(); dragging = true; sx0 = e.clientX - r.left; sy0 = e.clientY - r.top; sel = { x: sx0, y: sy0, w: 0, h: 0 }; selBox.style.display = 'block'; updateBox(); document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp); e.preventDefault(); });
      saveBtn.onclick = () => {
        if (!sel || sel.w < 4) return;
        const rx = canvas.width / canvas.clientWidth, ry = canvas.height / canvas.clientHeight;
        const out = document.createElement('canvas'); out.width = Math.max(1, Math.round(sel.w * rx)); out.height = Math.max(1, Math.round(sel.h * ry));
        out.getContext('2d').drawImage(canvas, sel.x * rx, sel.y * ry, sel.w * rx, sel.h * ry, 0, 0, out.width, out.height);
        saveBtn.disabled = true; saveBtn.textContent = 'Saving…';
        out.toBlob(async (blob) => {
          try { if (ctx.partId) await api.savePartPhoto(ctx.partId, blob); else await api.saveTypePhoto(ctx.typeId, ctx.itemCode, blob); finish(true); m.close(); }
          catch (e) { toast('Save failed: ' + e.message, 'err'); saveBtn.disabled = false; saveBtn.textContent = 'Save photo'; }
        }, 'image/png');
      };
    })();
  });
}

// ── Tank Types (list) ─────────────────────────────────────────
function renderTypes() {
  const head = `<div class="row-between"><div class="section-title" style="margin:0">Tank types — reusable parts checklists</div>
    <div style="display:flex;gap:8px"><button class="btn ghost sm" id="tNewEmpty">＋ Blank type</button><button class="btn sm" id="tNewFile">📄 New from file</button></div></div>`;
  if (!state.tankTypes.length) {
    view().innerHTML = head + `<div class="empty"><div class="big">📐</div><h2>No tank types yet</h2><p class="muted">Import a parts list (Excel, Word, PDF or CSV) to create your first type.</p></div>`;
  } else {
    view().innerHTML = head + `<div class="grid type-grid"></div>`;
    const grid = view().querySelector('.type-grid');
    state.tankTypes.forEach((tt) => {
      const cov = tt.partCount ? Math.round((tt.partsWithFiles / tt.partCount) * 100) : 0;
      const card = el('div.panel.type-card');
      card.innerHTML = `<div class="row-between" style="margin:0"><div class="tname">${esc(tt.name)}</div><button class="icon-btn" data-del title="Delete type">🗑</button></div>
        <div class="meta">${tt.partCount} part${tt.partCount === 1 ? '' : 's'} · ${tt.fileCount} file${tt.fileCount === 1 ? '' : 's'}</div>
        ${bar(cov)}
        <div class="cover"><span>Files attached</span><b>${tt.partsWithFiles}/${tt.partCount} parts</b></div>
        <div style="margin-top:14px"><button class="btn ghost" style="width:100%" data-open>Open & manage →</button></div>`;
      card.querySelector('[data-open]').onclick = () => go('typeDetail', { typeId: tt.id });
      card.querySelector('.tname').onclick = () => go('typeDetail', { typeId: tt.id });
      card.querySelector('[data-del]').onclick = async (e) => {
        e.stopPropagation();
        if (!confirm(`Delete type "${tt.name}", its parts and files? (Existing tanks are NOT affected.)`)) return;
        await api.deleteType(tt.id); await refresh(); render(); toast('Type deleted', 'ok');
      };
      grid.append(card);
    });
  }
  $('#tNewEmpty').onclick = newEmptyType;
  $('#tNewFile').onclick = newTypeFromFile;
}
function newEmptyType() {
  const body = el('div.form', { html: `<div class="row"><label>Type name</label><input id="ntName" placeholder="e.g. 67 MVA"/></div>
    <div class="row"><label>Description (optional)</label><input id="ntDesc" placeholder="Notes about this tank type"/></div>
    <button class="btn" id="ntGo">Create type</button>` });
  const m = modal({ title: 'New blank tank type', body });
  body.querySelector('#ntGo').onclick = async () => {
    const name = body.querySelector('#ntName').value.trim(); if (!name) return toast('Name required', 'err');
    const tt = await api.createType({ name, description: body.querySelector('#ntDesc').value.trim() });
    m.close(); await refresh(); go('typeDetail', { typeId: tt.id }); toast('Type created — now add parts', 'ok');
  };
}
function newTypeFromFile() {
  const body = el('div.form');
  body.innerHTML = `<div class="row"><label>Type name</label><input id="ntName" placeholder="e.g. 67 MVA"/></div>
    <div class="row"><label>Parts list (Excel, Word, PDF or CSV)</label><div class="dropzone" id="dz"><div class="big">📄</div>Click to choose a file<div class="hint">Reads the parts table from .xlsx · .csv · .docx · .pdf — columns (item code, qty, description, phase) detected automatically</div></div>
    <input type="file" id="fileIn" accept=".xlsx,.xls,.xlsm,.csv,.docx,.pdf" style="display:none"/><div id="fname" class="hint"></div></div>
    <button class="btn" id="ntGo" disabled>Import & create type</button>`;
  const m = modal({ title: 'New tank type from file', body });
  const fileIn = body.querySelector('#fileIn'); let chosen = null;
  const dz = body.querySelector('#dz');
  dz.onclick = () => fileIn.click();
  wireDrag(dz, (files) => { if (files[0]) { chosen = files[0]; body.querySelector('#fname').textContent = '✓ ' + chosen.name; body.querySelector('#ntGo').disabled = false; } });
  fileIn.onchange = () => { chosen = fileIn.files[0]; if (chosen) { body.querySelector('#fname').textContent = '✓ ' + chosen.name; body.querySelector('#ntGo').disabled = false; } };
  body.querySelector('#ntGo').onclick = async () => {
    const name = body.querySelector('#ntName').value.trim(); if (!name) return toast('Name required', 'err'); if (!chosen) return toast('Choose a file', 'err');
    const fd = new FormData(); fd.append('name', name); fd.append('file', chosen);
    try { const r = await api.newTypeFromFile(fd); m.close(); await refresh(); go('typeDetail', { typeId: r.type.id }); toast(`Imported ${r.imported} parts`, 'ok'); }
    catch (e) { toast('Import failed: ' + e.message, 'err'); }
  };
}

// ── Tank Type detail ──────────────────────────────────────────
async function renderTypeDetail() {
  view().innerHTML = `<div class="loading">Loading type…</div>`;
  let tt; try { tt = await api.tankType(state.currentTypeId); } catch (e) { view().innerHTML = `<div class="banner">Could not load type: ${esc(e.message)}</div>`; return; }
  const cov = tt.partCount ? Math.round((tt.partsWithFiles / tt.partCount) * 100) : 0;
  view().innerHTML = `
    <div class="row-between">
      <div><button class="btn ghost sm" id="back">← Types</button>
        <span style="font-size:18px;font-weight:600;margin-left:12px">${esc(tt.name)}</span>
        <span class="muted" style="margin-left:8px">${tt.partCount} parts · ${tt.partsWithFiles}/${tt.partCount} with files</span></div>
      <div style="display:flex;gap:8px">
        <button class="btn ghost sm" id="addPart">＋ Add part</button>
        <button class="btn ghost sm" id="impBtn">📄 Import file</button>
        <div class="dropdown" id="exportDD">
          <button class="btn ghost sm" id="exportBtn">⬇ Export ▾</button>
          <div class="dropdown-pop" id="exportPop" hidden>
            <button data-fmt="xlsx">📊 Excel (.xlsx)</button>
            <button data-fmt="doc">📝 Word (.doc)</button>
            <button data-fmt="pdf">📄 PDF (print)</button>
          </div>
        </div>
        <button class="btn sm" id="filesBtn">📎 Upload files</button>
      </div>
    </div>
    <div class="panel" style="margin-bottom:16px"><div class="cover" style="margin:0 0 8px"><span>Image / PDF coverage (matched by item code)</span><b>${cov}%</b></div>${bar(cov)}</div>
    <div class="table-wrap"><table id="ttable" class="cards">
      <thead><tr><th style="width:60px">No</th><th>Item code</th><th>Description</th><th style="width:80px">Qty</th><th style="width:150px">Default phase</th><th style="width:80px">Files</th><th style="width:50px"></th></tr></thead>
      <tbody>${tt.parts.map(templateRow).join('') || `<tr><td colspan="7"><div class="empty"><div class="big">🔩</div>No parts yet. Import a spreadsheet or add parts.</div></td></tr>`}</tbody>
    </table></div>`;
  $('#back').onclick = () => go('types');
  $('#addPart').onclick = () => addTemplatePart(tt);
  $('#impBtn').onclick = () => importToType(tt);
  $('#filesBtn').onclick = () => uploadFilesTo(tt);
  wireExportMenu({
    xlsx: `/api/tank-types/${tt.id}/export.xlsx`, doc: `/api/tank-types/${tt.id}/export.doc`,
    pdf: `/api/tank-types/${tt.id}/print`, filename: `${sanitizeName(tt.name)}_parts`,
  });
  const tbody = view().querySelector('#ttable tbody');
  tbody.addEventListener('change', onTemplateEdit);
  tbody.querySelectorAll('[data-files]').forEach((b) => b.addEventListener('click', () => {
    const p = tt.parts.find((x) => x.id === b.dataset.files);
    openFileViewer(p.files, p.description || p.itemCode, p.itemCode, { typeId: tt.id, itemCode: p.itemCode, reload: async () => (await api.tankType(tt.id)).parts.find((x) => x.itemCode === p.itemCode)?.files || [] });
  }));
  tbody.querySelectorAll('[data-delpart]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Delete this part from the type?')) return;
    await api.deleteTemplatePart(b.dataset.delpart); renderTypeDetail();
  }));
}
function templateRow(p) {
  const fc = p.files?.length || 0;
  return `<tr>
    <td class="num muted" data-label="No">${p.no ?? ''}</td>
    <td class="pn" data-label="Item code"><input class="cell-edit partcode" dir="auto" type="text" value="${esc(p.itemCode || '')}" data-id="${p.id}" data-field="itemCode"/></td>
    <td class="pn" data-label="Description"><input class="cell-edit" dir="auto" type="text" value="${esc(p.description || '')}" data-id="${p.id}" data-field="description"/></td>
    <td data-label="Qty"><input class="cell-edit cell-num" type="number" min="0" value="${p.qty ?? 1}" data-id="${p.id}" data-field="qty"/></td>
    <td data-label="Default phase">${selectHTML('parts', 'phase', p.defaultPhase, p.id, 'tpl', true)}</td>
    <td data-label="Files"><button class="file-pill ${fc ? '' : 'none'}" data-files="${p.id}">📎 ${fc || '0'}</button></td>
    <td class="act" data-label=""><button class="icon-btn" data-delpart="${p.id}">🗑</button></td></tr>`;
}
async function onTemplateEdit(e) {
  const t = e.target; if (!t.dataset.id || !t.dataset.field) return;
  if (!canEdit()) return denyEdit();
  const id = t.dataset.id, field = t.dataset.field;
  const value = t.type === 'number' ? (t.value === '' ? null : Number(t.value)) : t.value;
  const td = t.closest('td'); td.classList.remove('saved', 'error'); td.classList.add('saving');
  try { await api.updateTemplatePart(id, { [field]: value }); td.classList.remove('saving'); td.classList.add('saved'); }
  catch (err) { td.classList.remove('saving'); td.classList.add('error'); toast('Save failed: ' + err.message, 'err'); }
}
function addTemplatePart(tt) {
  const body = el('div.form');
  body.innerHTML = `<div class="two"><div class="row"><label>Item code</label><input id="ac"/></div><div class="row"><label>Qty</label><input id="aq" type="number" value="1" min="0"/></div></div>
    <div class="row"><label>Description</label><input id="ad"/></div>
    <div class="row"><label>Default phase</label><select id="ap"><option value="">—</option>${optionList('parts', 'phase')}</select></div>
    <button class="btn" id="ago">Add part</button>`;
  const m = modal({ title: `Add part to ${tt.name}`, body });
  body.querySelector('#ago').onclick = async () => {
    await api.addTemplatePart(tt.id, { itemCode: body.querySelector('#ac').value.trim(), qty: Number(body.querySelector('#aq').value) || 1, description: body.querySelector('#ad').value.trim(), defaultPhase: body.querySelector('#ap').value });
    m.close(); renderTypeDetail(); toast('Part added', 'ok');
  };
}
function importToType(tt) {
  const body = el('div.form');
  body.innerHTML = `<div class="row"><label>Mode</label><select id="mode"><option value="append">Append to existing parts</option><option value="replace">Replace all parts</option></select></div>
    <div class="dropzone" id="dz"><div class="big">📄</div>Click to choose a file<div class="hint">Excel · CSV · Word (.docx) · PDF</div></div><input type="file" id="fi" accept=".xlsx,.xls,.xlsm,.csv,.docx,.pdf" style="display:none"/><div id="fn" class="hint"></div>
    <div id="res"></div>`;
  const m = modal({ title: `Import parts into ${tt.name}`, body });
  const fi = body.querySelector('#fi'); const dz = body.querySelector('#dz');
  const doImport = async (file) => {
    body.querySelector('#fn').textContent = '⏳ ' + file.name;
    const fd = new FormData(); fd.append('file', file);
    try {
      const r = await api.importToType(tt.id, fd, body.querySelector('#mode').value);
      const cols = Object.entries(r.headerMap).map(([k, v]) => `<span class="tag">${k} ← ${esc(v)}</span>`).join('') || '<span class="muted">no columns auto-mapped</span>';
      body.querySelector('#res').innerHTML = `<div class="import-result"><div class="ok">✓ Imported ${r.imported} parts.</div><div style="margin-top:8px">Detected: ${cols}</div></div>`;
      await refresh(); toast(`Imported ${r.imported} parts`, 'ok');
      setTimeout(() => { m.close(); renderTypeDetail(); }, 1400);
    } catch (e) { toast('Import failed: ' + e.message, 'err'); body.querySelector('#fn').textContent = ''; }
  };
  dz.onclick = () => fi.click();
  fi.onchange = () => fi.files[0] && doImport(fi.files[0]);
  wireDrag(dz, (files) => files[0] && doImport(files[0]));
}
function uploadFilesTo(tt) {
  const body = el('div.form');
  body.innerHTML = `<div class="banner">Drop a <b>folder</b> (or files) of PDFs/images named by item code — e.g. <code>${esc(tt.parts?.[0]?.itemCode || 'PT-040-132-001-014')}.pdf</code>. Each file is auto-matched to its part.</div>
    <div style="display:flex;gap:8px;margin-bottom:10px"><button class="btn ghost sm" id="pickFolder">📁 Choose folder</button><button class="btn ghost sm" id="pickFiles">📄 Choose files</button></div>
    <div class="dropzone" id="dz"><div class="big">📎</div>…or drop files/folder here</div>
    <input type="file" id="fFolder" webkitdirectory multiple style="display:none"/><input type="file" id="fFiles" multiple style="display:none"/>
    <div id="res"></div>`;
  const m = modal({ title: `Upload part files — ${tt.name}`, body });
  const doUpload = async (files) => {
    files = files.filter((f) => f && f.size >= 0);
    if (!files.length) return;
    body.querySelector('#res').innerHTML = `<div class="import-result">⏳ Uploading ${files.length} file(s)…</div>`;
    const fd = new FormData(); files.forEach((f) => fd.append('files', f, f.name));
    try {
      const r = await api.uploadFiles(tt.id, fd);
      const un = r.unmatched.length ? `<div class="warn" style="margin-top:8px">⚠ ${r.unmatched.length} unmatched (no part with that item code): ${r.unmatched.slice(0, 8).map((x) => `<span class="tag">${esc(x)}</span>`).join('')}${r.unmatched.length > 8 ? '…' : ''}</div>` : '';
      body.querySelector('#res').innerHTML = `<div class="import-result"><div class="ok">✓ Matched & attached ${r.matched} file(s).</div>${un}</div>`;
      await refresh(); toast(`Attached ${r.matched} files`, 'ok');
      setTimeout(renderTypeDetail, 100);
    } catch (e) { toast('Upload failed: ' + e.message, 'err'); body.querySelector('#res').innerHTML = ''; }
  };
  body.querySelector('#pickFolder').onclick = () => body.querySelector('#fFolder').click();
  body.querySelector('#pickFiles').onclick = () => body.querySelector('#fFiles').click();
  body.querySelector('#fFolder').onchange = (e) => doUpload([...e.target.files]);
  body.querySelector('#fFiles').onchange = (e) => doUpload([...e.target.files]);
  body.querySelector('#dz').onclick = () => body.querySelector('#fFiles').click();
  wireDrag(body.querySelector('#dz'), doUpload, true);
}

// ── Rework ────────────────────────────────────────────────────
function renderRework() {
  const reworked = state.parts.filter((p) => (p.reworkCount ?? 0) > 0 || p.status === 'Rework');
  const byReason = countBy(reworked, 'reworkReason', (state.options.parts.reworkReason || []).map((o) => o.name)).filter((e) => e.n > 0);
  const byPhase = countBy(reworked, 'phase', (state.options.parts.phase || []).map((o) => o.name)).filter((e) => e.n > 0);
  const totalRe = reworked.reduce((s, p) => s + (p.reworkCount || 0), 0);
  const list = reworked.sort((a, b) => (b.reworkCount || 0) - (a.reworkCount || 0)).map((p) => {
    const tank = tankById(p.tankId);
    return `<tr><td class="num muted">${p.no ?? ''}</td><td><div class="partname">${esc(p.partName || p.itemCode)}</div><div class="partcode">${esc(tank?.name || '')}</div></td><td>${chip(p.status)}</td><td class="num" style="color:var(--red)">${p.reworkCount || 0}×</td><td>${esc(p.reworkReason || '—')}</td><td class="muted">${esc(p.assignedTo || '—')}</td></tr>`;
  }).join('') || `<tr><td colspan="6"><div class="empty"><div class="big">↻</div>No rework logged.</div></td></tr>`;
  view().innerHTML = `
    <div class="grid kpis" style="grid-template-columns:repeat(3,1fr)">
      <div class="panel kpi"><div class="label">Parts reworked</div><div class="value" style="color:var(--red)">${reworked.length}</div></div>
      <div class="panel kpi"><div class="label">Total rework events</div><div class="value">${totalRe}</div></div>
      <div class="panel kpi"><div class="label">Rework rate</div><div class="value">${state.parts.length ? Math.round((reworked.length / state.parts.length) * 100) : 0}<small>%</small></div></div>
    </div>
    <div class="grid" style="grid-template-columns:1fr 1fr"><div class="panel"><h3>By reason</h3>${statBars(byReason) || '<div class="muted">None.</div>'}</div><div class="panel"><h3>By phase</h3>${statBars(byPhase) || '<div class="muted">None.</div>'}</div></div>
    <div style="margin-top:16px" class="table-wrap"><table><thead><tr><th>No</th><th>Part / Tank</th><th>Status</th><th>Count</th><th>Reason</th><th>Assignee</th></tr></thead><tbody>${list}</tbody></table></div>`;
}

// ── New tank ──────────────────────────────────────────────────
function renderNew() {
  const types = state.tankTypes.filter((t) => t.partCount > 0);
  const typeOpts = types.map((t) => `<option value="${t.id}">${esc(t.name)} (${t.partCount} parts)</option>`).join('');
  const prios = (state.options.instances.priority || [{ name: 'Normal' }]).map((o) => `<option ${o.name === 'Normal' ? 'selected' : ''}>${esc(o.name)}</option>`).join('');
  view().innerHTML = `<div class="panel form"><h3>Create a new tank order</h3>
    ${!types.length ? '<div class="banner warn">No tank types with parts yet. Go to <b>Tank Types</b> and import a parts list first.</div>' : ''}
    <div class="row"><label>Tank name *</label><input id="nName" placeholder="e.g. 32 MVA Ruwais #3"/></div>
    <div class="two"><div class="row"><label>Client</label><input id="nClient" placeholder="El-Sweedy Electric"/></div>
      <div class="row"><label>Tank type (template) *</label><select id="nType">${typeOpts}</select></div></div>
    <div class="two"><div class="row"><label>Priority</label><select id="nPrio">${prios}</select></div><div class="row"><label>Delivery date</label><input id="nDelivery" type="date"/></div></div>
    <div class="row"><label>Start date</label><input id="nStart" type="date"/></div>
    <div class="row"><label>Notes</label><textarea id="nNotes" rows="2"></textarea></div>
    <div id="nCount" class="hint"></div>
    <div style="margin-top:8px"><button class="btn" id="nCreate" ${!types.length ? 'disabled' : ''}>Create tank & clone parts</button></div></div>`;
  const updateCount = () => { const t = types.find((x) => x.id === $('#nType').value); $('#nCount').textContent = t ? `Clones ${t.partCount} parts from "${t.name}".` : ''; };
  $('#nType')?.addEventListener('change', updateCount); updateCount();
  $('#nCreate')?.addEventListener('click', async () => {
    const name = $('#nName').value.trim(); if (!name) return toast('Tank name required', 'err');
    const payload = { name, client: $('#nClient').value.trim(), tankTypeId: $('#nType').value, priority: $('#nPrio').value, startDate: $('#nStart').value || undefined, deliveryDate: $('#nDelivery').value || undefined, notes: $('#nNotes').value.trim() };
    $('#nCreate').disabled = true;
    try { const t = await api.createTank(payload); await refresh(); go('tankDetail', { tankId: t.id }); toast(`Created "${t.name}" — ${t.clonedParts} parts cloned`, 'ok'); }
    catch (e) { toast('Create failed: ' + e.message, 'err'); $('#nCreate').disabled = false; }
  });
}

// ── Follow-up (per tank: daily worksheet + weekly rollup) ─────
function renderFollowup() {
  if (!state.tanks.length) {
    view().innerHTML = `<div class="empty"><div class="big">📅</div><h2>No tanks yet</h2><p class="muted">Create a tank to start daily follow-up.</p></div>`;
    return;
  }
  if (!state.followTankId || !state.tanks.some((t) => t.id === state.followTankId)) state.followTankId = state.tanks[0].id;
  const tankOpts = state.tanks.map((t) => `<option value="${t.id}" ${t.id === state.followTankId ? 'selected' : ''}>${esc(t.name || 'Untitled')}</option>`).join('');
  view().innerHTML = `
    <div class="toolbar">
      <select id="fuTank">${tankOpts}</select>
      ${state.followTab === 'daily' ? `<input id="fuDate" type="date" value="${state.followDate}"/>` : ''}
      <div class="spacer"></div>
      <div class="tabs"><button class="tab ${state.followTab === 'daily' ? 'on' : ''}" data-tab="daily">Daily follow-up</button><button class="tab ${state.followTab === 'weekly' ? 'on' : ''}" data-tab="weekly">Weekly rollup</button></div>
    </div>
    <div id="fuBody"><div class="loading">Loading…</div></div>`;
  $('#fuTank').onchange = (e) => { state.followTankId = e.target.value; renderFollowup(); };
  const dt = $('#fuDate'); if (dt) dt.onchange = (e) => { state.followDate = e.target.value; renderDailyTab(); };
  view().querySelectorAll('.tab[data-tab]').forEach((b) => b.onclick = () => { state.followTab = b.dataset.tab; renderFollowup(); });
  if (state.followTab === 'daily') renderDailyTab(); else renderWeeklyTab();
}
async function renderDailyTab() {
  const box = $('#fuBody'); if (!box) return; box.innerHTML = '<div class="loading">Loading…</div>';
  let d; try { d = await api.daily(state.followTankId, state.followDate, state.followPhase); } catch (e) { box.innerHTML = `<div class="banner warn">${esc(e.message)}</div>`; return; }
  const phaseOpts = ['<option value="">All phases</option>'].concat((d.phases || []).map((ph) => `<option value="${esc(ph)}" ${state.followPhase === ph ? 'selected' : ''}>${esc(ph)}</option>`)).join('');
  const head = `<div class="row-between">
      <div style="display:flex;gap:10px;align-items:center"><div class="section-title" style="margin:0">In-process — ${esc(tankById(state.followTankId)?.name || '')} · ${state.followDate}</div>
        <select id="fuPhase" class="cell-edit" style="width:auto">${phaseOpts}</select></div>
      <button class="btn sm" id="fuSave">Save day</button></div>`;
  const wirePhase = () => { const s = $('#fuPhase'); if (s) s.onchange = (e) => { state.followPhase = e.target.value; renderDailyTab(); }; };
  if (!d.parts.length) {
    box.innerHTML = head + `<div class="empty"><div class="big">✅</div>${state.followPhase ? 'No in-process parts in this phase.' : 'Nothing in progress — every part is fully delivered.'}</div>`;
    wirePhase(); return;
  }
  const rows = d.parts.map((p) => {
    const remaining = (p.qtyTotal || 0) - (p.deliveredQty || 0);
    return `<tr>
    <td class="num muted" data-label="No">${p.no ?? ''}</td>
    <td class="pn" data-label="Part"><div class="partname">${esc(p.partName || p.itemCode)}</div><div class="partcode">${esc(p.itemCode || '')}</div></td>
    <td data-label="Phase">${selectHTML('parts', 'phase', p.phase, p.partId, 'part', true)}</td>
    <td data-label="Status">${selectHTML('parts', 'status', p.status, p.partId, 'part')}</td>
    <td data-label="Progress"><div class="qbar"><span class="muted" style="min-width:42px">${p.qtyDone}/${p.qtyTotal}</span>${bar(p.progress, p.progress === 100)}</div></td>
    <td class="num muted" data-label="Delivered" title="delivered / total">${p.deliveredQty || 0}/${p.qtyTotal || 0}</td>
    <td data-label="Deliver qty"><input class="cell-edit cell-num fu-deliv" type="number" min="0" value="${p.deliveredToday ?? ''}" placeholder="0" data-part="${p.partId}" title="Delivered this day · ${remaining} remaining"/></td>
    <td data-label="Note"><input class="cell-edit fu-note" type="text" value="${esc(p.log?.note || '')}" placeholder="note…" data-part="${p.partId}"/></td>
  </tr>`; }).join('');
  box.innerHTML = head + `
    <div class="table-wrap"><table class="cards">
      <thead><tr><th>No</th><th>Part</th><th>Phase</th><th>Status</th><th>Progress</th><th title="delivered / total">Delivered</th><th>Deliver qty</th><th>Note</th></tr></thead>
      <tbody>${rows}</tbody></table></div>
    ${assigneeDatalist()}`;
  wirePhase();
  box.querySelector('tbody').addEventListener('change', (e) => { if (e.target.dataset.field) onPartEdit(e); });
  $('#fuSave').onclick = async () => {
    const entries = d.parts.map((p) => ({
      partId: p.partId,
      deliveredToday: box.querySelector(`.fu-deliv[data-part="${p.partId}"]`)?.value ?? '',
      note: box.querySelector(`.fu-note[data-part="${p.partId}"]`)?.value || '',
    }));
    try { const r = await api.saveDaily(state.followTankId, { date: state.followDate, entries }); toast(`Saved ${r.saved} update(s)`, 'ok'); renderDailyTab(); }
    catch (e) { toast('Save failed: ' + e.message, 'err'); }
  };
}
async function renderWeeklyTab() {
  const box = $('#fuBody'); if (!box) return; box.innerHTML = '<div class="loading">Loading…</div>';
  let w; try { w = await api.weekly(state.followTankId); } catch (e) { box.innerHTML = `<div class="banner warn">${esc(e.message)}</div>`; return; }
  if (!w.weeks.length) { box.innerHTML = `<div class="empty"><div class="big">📦</div>No deliveries recorded yet for this tank.<br/><span class="muted">In Daily follow-up, enter a "Deliver qty" for a part and Save — it appears here under its week.</span></div>`; return; }
  const totalQty = w.weeks.reduce((s, x) => s + x.totalQty, 0);
  const best = Math.max(...w.weeks.map((x) => x.totalQty));
  box.innerHTML = `
    <div class="grid kpis" style="grid-template-columns:repeat(3,1fr)">
      <div class="panel kpi"><div class="label">Total qty delivered</div><div class="value">${totalQty}</div></div>
      <div class="panel kpi"><div class="label">Weeks active</div><div class="value">${w.weeks.length}</div></div>
      <div class="panel kpi"><div class="label">Best week (qty)</div><div class="value">${best}</div></div>
    </div>
    ${w.weeks.map((wk, i) => `<div class="panel" style="margin-bottom:14px">
      <div class="row-between" style="margin-bottom:10px"><div><b>${esc(wk.isoWeek)}</b> <span class="muted">${fmtDate(wk.weekStart)} – ${fmtDate(wk.weekEnd)}</span></div>
        <div style="display:flex;gap:8px;align-items:center"><span class="file-pill">${wk.totalQty} delivered</span><button class="btn ghost sm" data-csv="${i}">⤓ CSV</button></div></div>
      <div class="table-wrap"><table><thead><tr><th>No</th><th>Part</th><th>Item code</th><th>Delivered qty</th></tr></thead>
      <tbody>${wk.parts.map((p) => `<tr><td class="num muted">${p.no ?? ''}</td><td>${esc(p.partName || p.itemCode)}</td><td class="partcode">${esc(p.itemCode || '')}</td><td class="num">${p.qty}</td></tr>`).join('')}</tbody></table></div></div>`).join('')}`;
  box.querySelectorAll('[data-csv]').forEach((b) => b.onclick = () => exportWeekCsv(w.weeks[Number(b.dataset.csv)], tankById(state.followTankId)?.name || 'tank'));
}
function exportWeekCsv(wk, tankName) {
  const rows = [['No', 'Item code', 'Delivered qty']].concat(wk.parts.map((p) => [p.no ?? '', p.itemCode || '', p.qty]));
  const csv = '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
  downloadFile(`${sanitizeName(tankName)}_${wk.isoWeek}_delivered.csv`, csv, 'text/csv;charset=utf-8');
}

// ── Reports (aggregated analytics + hand-built SVG charts) ─────
const emptyMsg = (msg = 'No data') => `<div class="muted" style="padding:8px 0">${esc(msg)}</div>`;
async function renderReports() {
  view().innerHTML = `<div class="loading">Loading reports…</div>`;
  let r; try { r = await api.reports(); } catch (e) { view().innerHTML = `<div class="banner warn">Could not load reports: ${esc(e.message)}</div>`; return; }
  const o = r.overall;
  const active = r.perTank.filter((t) => t.completion < 100).length;
  view().innerHTML = `
    <div class="grid kpis">
      <div class="panel kpi amber"><div class="label">Overall completion</div><div class="value">${o.completion}<small>%</small></div><div style="margin-top:12px">${bar(o.completion, o.completion === 100)}</div></div>
      <div class="panel kpi"><div class="label">Parts delivered</div><div class="value">${o.partsDone}<small>/ ${o.partsTotal}</small></div></div>
      <div class="panel kpi"><div class="label">Active tanks</div><div class="value">${active}<small>/ ${r.perTank.length}</small></div></div>
      <div class="panel kpi"><div class="label">Overdue tanks</div><div class="value" style="color:var(--red)">${r.tanksOnTime.overdue}</div></div>
    </div>
    <div class="grid" style="grid-template-columns:1.3fr 1fr">
      <div class="panel"><h3>Units delivered per week</h3>${throughputSVG(r.throughput)}</div>
      <div class="panel"><h3>Tanks — on-time vs overdue</h3>${onTimeChart(r.tanksOnTime)}</div>
    </div>
    <div class="grid" style="grid-template-columns:1fr 1fr;margin-top:16px">
      <div class="panel"><h3>Status breakdown</h3>${statBars(r.status.map((e) => ({ ...e, chip: true }))) || emptyMsg()}</div>
      <div class="panel"><h3>Pipeline — open parts by phase</h3>${statBars(r.phasePipeline) || emptyMsg('Nothing in progress')}</div>
    </div>
    <div class="grid" style="grid-template-columns:1fr 1fr;margin-top:16px">
      <div class="panel"><h3>Workload per assignee</h3>${workloadBars(r.workload)}</div>
      <div class="panel"><h3>Progress per tank</h3>${r.perTank.map(perTankRow).join('') || emptyMsg()}</div>
    </div>
    <div class="grid" style="grid-template-columns:1fr 1fr;margin-top:16px">
      <div class="panel"><h3>Rework by reason</h3>${statBars(r.reworkByReason) || emptyMsg('No rework logged 🎉')}</div>
      <div class="panel"><h3>Rework by phase</h3>${statBars(r.reworkByPhase) || emptyMsg('No rework logged 🎉')}</div>
    </div>
    <div class="panel" style="margin-top:16px">
      <div class="row-between"><h3 style="margin:0">Recent activity (audit log)</h3><input id="actSearch" class="search" type="search" placeholder="Filter log…" style="width:200px"/></div>
      <div id="activityLog" style="margin-top:12px"><div class="loading">Loading…</div></div></div>`;
  view().querySelectorAll('[data-tank]').forEach((n) => n.addEventListener('click', () => go('tankDetail', { tankId: n.dataset.tank })));
  loadActivity();
  let t; $('#actSearch').oninput = (e) => { clearTimeout(t); const q = e.target.value; t = setTimeout(() => loadActivity(q), 250); };
}
const CAT_ICON = { part: '✏️', delivery: '📦', tank: '🏭', files: '📎', options: '⚙️', type: '📐' };
async function loadActivity(q) {
  const box = document.getElementById('activityLog'); if (!box) return;
  let a; try { a = await api.activity(q, 150); } catch { box.innerHTML = emptyMsg('Could not load'); return; }
  if (!a.items.length) { box.innerHTML = emptyMsg(q ? 'No matching activity' : 'No activity recorded yet'); return; }
  box.innerHTML = `<div class="table-wrap"><table><thead><tr><th>When</th><th></th><th>Tank</th><th>Item code</th><th>What changed</th></tr></thead><tbody>${a.items.map((it) => {
    const when = esc(String(it.at || '').replace('T', ' ').slice(0, 16));
    return `<tr><td class="muted" style="white-space:nowrap">${when}</td><td title="${esc(it.category || '')}">${CAT_ICON[it.category] || '•'}</td><td>${esc(it.tank || '')}</td><td class="partcode">${esc(it.itemCode || '')}</td><td>${esc(it.summary || '')}</td></tr>`;
  }).join('')}</tbody></table></div>`;
}
function perTankRow(t) {
  return `<div class="statrow"><div class="name" style="width:150px;cursor:pointer" data-tank="${t.id}">${esc(t.name || 'Untitled')}${t.overdue ? ' <span style="color:var(--red)">⚠</span>' : ''}</div>${bar(t.completion, t.completion === 100)}<div class="n">${t.completion}%</div></div>`;
}
function workloadBars(wl) {
  if (!wl.length) return emptyMsg('No assignees set yet');
  const max = Math.max(1, ...wl.map((w) => w.total));
  return wl.map((w) => `<div class="statrow"><div class="name" style="width:130px">${esc(w.name)}</div>
    <div class="bar" style="position:relative"><span style="width:${(w.total / max) * 100}%"></span><span style="position:absolute;left:0;top:0;height:100%;width:${(w.done / max) * 100}%;background:linear-gradient(90deg,#2ea043,var(--green));border-radius:6px"></span></div>
    <div class="n">${w.done}/${w.total}</div></div>`).join('');
}
function throughputSVG(data) {
  if (!data.length) return emptyMsg();
  const W = 600, H = 200, padL = 30, padB = 32, padT = 12;
  const max = Math.max(1, ...data.map((d) => d.delivered));
  const n = data.length, gap = 6, slot = (W - padL - 10) / n, bw = Math.max(4, slot - gap);
  const yTop = padT, plotH = H - padT - padB;
  const grid = [0, 0.5, 1].map((f) => { const gy = yTop + plotH * (1 - f); return `<line class="gridline" x1="${padL}" y1="${gy}" x2="${W - 10}" y2="${gy}"/><text class="axis" x="4" y="${gy + 3}">${Math.round(max * f)}</text>`; }).join('');
  const bars = data.map((d, i) => {
    const bx = padL + i * slot + gap / 2, bh = plotH * (d.delivered / max), by = yTop + plotH - bh;
    const fill = d.estimated ? 'var(--line-2)' : 'var(--amber)';
    return `<g><rect class="col" x="${bx}" y="${by}" width="${bw}" height="${bh}" rx="3" fill="${fill}"><title>${esc(d.week)} (${d.from}–${d.to}): ${d.delivered} delivered${d.estimated ? ' · estimated' : ''}</title></rect>
      <text class="axis" x="${bx + bw / 2}" y="${H - padB + 14}" text-anchor="middle">${esc(d.week.slice(-3))}</text>
      ${d.delivered ? `<text class="axis" x="${bx + bw / 2}" y="${by - 3}" text-anchor="middle">${d.delivered}</text>` : ''}</g>`;
  }).join('');
  const note = data.some((d) => d.estimated) ? '<div class="hint">Dimmed columns are estimated (history from before live tracking).</div>' : '';
  return `<svg class="chart-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">${grid}${bars}</svg>${note}`;
}
function onTimeChart(d) {
  const total = d.onTime + d.overdue + d.noDate + d.delivered;
  if (!total) return emptyMsg('No tanks');
  const segs = [['Delivered', d.delivered, 'var(--green)'], ['On time', d.onTime, 'var(--blue)'], ['Overdue', d.overdue, 'var(--red)'], ['No date', d.noDate, 'var(--muted-2)']].filter((s) => s[1] > 0);
  const W = 600; let x = 0;
  const rects = segs.map(([name, n, c]) => { const w = (n / total) * W; const r = `<rect x="${x}" y="0" width="${w}" height="46" fill="${c}"><title>${esc(name)}: ${n}</title></rect>`; x += w; return r; }).join('');
  const legend = segs.map(([name, n, c]) => `<span class="legend-item"><span class="legend-dot" style="background:${c}"></span>${esc(name)} <b>${n}</b></span>`).join('');
  return `<svg class="chart-svg" viewBox="0 0 ${W} 46" preserveAspectRatio="none" style="height:46px;border-radius:8px">${rects}</svg><div class="legend">${legend}</div>`;
}

// ── Settings (editable dropdown options) ──────────────────────
function renderSettings() {
  view().innerHTML = `
    <div class="section-title">Backup &amp; data</div>
    <div class="panel">
      <div class="row-between" style="margin:0">
        <div><div style="font-weight:600">Backups</div><div class="muted" id="bkInfo" style="font-size:13px;margin-top:4px">Loading…</div></div>
        <button class="btn sm" id="bkNow">⤓ Backup now</button>
      </div>
    </div>
    <div class="section-title" style="margin-top:18px">Manage dropdown options</div>
    <div class="panel">
      <div class="toolbar" style="margin-bottom:0">
        <label class="muted" style="align-self:center">Field</label>
        <select id="optField">
          <option value="phase">Phase</option>
          <option value="status">Part status</option>
          <option value="reworkReason">Rework reason</option>
          <option value="tankStatus">Tank status</option>
          <option value="priority">Priority</option>
          <option value="assignee">Assignee</option>
        </select>
        <div class="spacer"></div>
        <input id="optNew" placeholder="Add a value…" style="width:200px"/>
        <button class="btn sm" id="optAdd">＋ Add</button>
      </div>
    </div>
    <div id="optList" class="panel" style="margin-top:14px"><div class="loading">Loading…</div></div>`;
  const sel = $('#optField'); sel.value = state.settingsField || 'phase';
  sel.onchange = () => { state.settingsField = sel.value; loadOptList(); };
  $('#optAdd').onclick = async () => {
    const v = $('#optNew').value.trim(); if (!v) return;
    try { await api.addOption(sel.value, v); $('#optNew').value = ''; await refresh(); loadOptList(); toast('Added', 'ok'); } catch (e) { toast(e.message, 'err'); }
  };
  $('#optNew').onkeydown = (e) => { if (e.key === 'Enter') $('#optAdd').click(); };
  loadOptList();
  loadBackupInfo();
  $('#bkNow').onclick = async () => {
    $('#bkNow').disabled = true; $('#bkInfo').textContent = 'Backing up…';
    try { const r = await api.backup(); toast('Backup done', 'ok'); showBackup({ last: r }); }
    catch (e) { toast('Backup failed: ' + e.message, 'err'); }
    finally { $('#bkNow').disabled = false; }
  };
}
async function loadBackupInfo() { try { showBackup(await api.backupStatus()); } catch { /* ignore */ } }
function showBackup(s) {
  const el2 = document.getElementById('bkInfo'); if (!el2) return;
  const last = s.last;
  if (!last) { el2.innerHTML = `No backup yet this session · target: <code>${esc(s.configured || './backups')}</code>`; return; }
  const where = (last.targets || []).map((t) => `${t.ok ? '✓' : '✗'} ${esc(t.dir)}${t.newFiles ? ` (+${t.newFiles} files)` : ''}`).join(' · ');
  el2.innerHTML = `Last backup <b>${esc(last.stamp)}</b> (${esc(last.reason || '')})<br/>${where}`;
}
async function loadOptList() {
  const field = $('#optField').value, box = $('#optList'); if (!box) return;
  box.innerHTML = '<div class="loading">Loading…</div>';
  let data; try { data = await api.getOptions(field); } catch (e) { box.innerHTML = `<div class="banner warn">${esc(e.message)}</div>`; return; }
  if (!data.values.length) { box.innerHTML = '<div class="muted">No values yet — add one above.</div>'; return; }
  const vals = data.values.map((v) => v.value);
  box.innerHTML = data.values.map((v, i) => `
    <div class="opt-row">
      <div class="opt-name">${esc(v.value)} ${v.reserved ? '<span class="tag">reserved</span>' : ''}</div>
      <div class="opt-use muted">${v.inUse} in use</div>
      <div class="opt-actions">
        <button class="icon-btn" data-up="${i}" ${i === 0 ? 'disabled' : ''}>▲</button>
        <button class="icon-btn" data-down="${i}" ${i === data.values.length - 1 ? 'disabled' : ''}>▼</button>
        <button class="btn ghost sm" data-rename="${esc(v.value)}" ${v.reserved ? 'disabled' : ''}>Rename</button>
        <button class="btn ghost sm" data-del="${esc(v.value)}" ${v.reserved ? 'disabled' : ''}>Delete</button>
      </div>
    </div>`).join('');
  box.querySelectorAll('[data-rename]').forEach((b) => b.onclick = async () => {
    const from = b.dataset.rename, to = (prompt(`Rename "${from}" to:`, from) || '').trim();
    if (!to || to === from) return;
    try { const r = await api.renameOption(field, from, to); await refresh(); loadOptList(); toast(`Renamed — ${r.renamed} row(s) updated`, 'ok'); } catch (e) { toast(e.message, 'err'); }
  });
  box.querySelectorAll('[data-del]').forEach((b) => b.onclick = () => deleteOptionFlow(field, b.dataset.del, data.values));
  box.querySelectorAll('[data-up]').forEach((b) => b.onclick = () => reorderOpt(field, vals, Number(b.dataset.up), -1));
  box.querySelectorAll('[data-down]').forEach((b) => b.onclick = () => reorderOpt(field, vals, Number(b.dataset.down), 1));
}
async function reorderOpt(field, vals, i, dir) {
  const j = i + dir; if (j < 0 || j >= vals.length) return;
  const a = [...vals]; [a[i], a[j]] = [a[j], a[i]];
  try { await api.reorderOption(field, a); await refresh(); loadOptList(); } catch (e) { toast(e.message, 'err'); }
}
function deleteOptionFlow(field, value, values) {
  const inUse = values.find((v) => v.value === value)?.inUse || 0;
  if (!inUse) { if (confirm(`Delete "${value}"?`)) doDeleteOpt(field, value); return; }
  const others = values.filter((v) => v.value !== value);
  if (!others.length) { toast('Cannot delete the only value while it is in use', 'err'); return; }
  const body = el('div.form');
  body.innerHTML = `<div class="banner warn">"${esc(value)}" is used by ${inUse} row(s). Reassign them before deleting.</div>
    <div class="row"><label>Reassign to</label><select id="reTo">${others.map((o) => `<option value="${esc(o.value)}">${esc(o.value)}</option>`).join('')}</select></div>
    <button class="btn" id="reGo">Reassign & delete</button>`;
  const m = modal({ title: `Delete "${value}"`, body });
  body.querySelector('#reGo').onclick = async () => {
    try { await api.deleteOption(field, value, body.querySelector('#reTo').value); m.close(); await refresh(); loadOptList(); toast('Deleted', 'ok'); } catch (e) { toast(e.message, 'err'); }
  };
}
async function doDeleteOpt(field, value) {
  try { await api.deleteOption(field, value); await refresh(); loadOptList(); toast('Deleted', 'ok'); } catch (e) { toast(e.message, 'err'); }
}

// ── Share access (Cloudflare tunnel link + QR) ────────────────
async function renderShare() {
  let s; try { s = await api.share(); } catch (e) { view().innerHTML = `<div class="banner warn">${esc(e.message)}</div>`; return; }
  if (state.route !== 'share') return; // user navigated away during fetch
  const t = s.tunnel || { status: 'off' };
  const on = t.status === 'on' && t.url;
  const L = s.links || {};
  const P = s.passwords || {};
  const mode = state.shareMode === 'viewer' ? 'viewer' : 'editor';
  const isEd = mode === 'editor';
  const link = isEd ? L.editor : L.viewer;
  const curPw = isEd ? (P.editor || '') : (P.viewer || '');

  let tunnelPanel;
  if (on) {
    tunnelPanel = `<div class="panel" style="margin-top:16px"><div class="row-between">
        <div><b>🌐 Public link is ON</b> <span class="muted">— reachable from any network</span></div>
        <button class="btn ghost sm" id="tunToggle">⏻ Turn off</button></div>
      <div class="hint" style="margin-top:6px">The public link changes if you restart the app — reopen this page for the current QR.</div></div>`;
  } else if (t.status === 'downloading' || t.status === 'starting') {
    tunnelPanel = `<div class="panel" style="margin-top:16px"><div class="loading">${t.status === 'downloading' ? 'Setting up the tunnel (downloading helper, one-time ~50MB)…' : 'Connecting your public link…'}</div>
      <div style="margin-top:10px"><button class="btn ghost sm" id="tunToggle">Cancel</button></div></div>`;
  } else if (t.status === 'error') {
    tunnelPanel = `<div class="panel" style="margin-top:16px"><div class="banner warn">Tunnel error: ${esc(t.error || 'unknown')}. Check this machine's internet.</div>
      <button class="btn" id="tunToggle">🌐 Try again</button></div>`;
  } else {
    tunnelPanel = `<div class="panel" style="margin-top:16px"><div class="row-between">
        <div><b>🌐 Public link is OFF</b> <span class="muted">— the link works only on this Wi-Fi</span></div>
        <button class="btn" id="tunToggle">🌐 Enable public access</button></div>
      <div class="hint" style="margin-top:6px">Turn it on to share from anywhere. First time downloads a small helper (~50&nbsp;MB), once.</div></div>`;
  }

  view().innerHTML = `
    <div class="tabs" id="shareModeTabs" style="margin-bottom:14px">
      <button class="tab ${isEd ? 'on' : ''}" data-m="editor">✏ Editor — can edit</button>
      <button class="tab ${!isEd ? 'on' : ''}" data-m="viewer">👁 Viewer — read-only</button>
    </div>
    <div class="grid" style="grid-template-columns:1.1fr .9fr">
      <div class="panel access-card">
        <h3>${isEd ? '✏ Editor link & QR' : '👁 Viewer link & QR'}</h3>
        <p class="guide-p" style="margin-top:-4px">${isEd
          ? 'Whoever opens this and enters the <b>editor password</b> can view <b>and edit</b> everything.'
          : 'Whoever opens this and enters the <b>viewer password</b> can <b>only view</b> — no edits, ever.'}</p>
        <div class="share-link"><input readonly value="${esc(link?.url || '')}"/><button class="btn sm" data-copy="${esc(link?.url || '')}">Copy link</button></div>
        <div class="share-qr">${link?.qr || '<div class="muted" style="padding:20px">QR unavailable</div>'}</div>
        <div class="hint" style="margin-top:8px">${on ? 'Public link — works from any network.' : 'Works on the same Wi-Fi. Enable the public link below to share anywhere.'}</div>
      </div>
      <div class="panel">
        <h3>${isEd ? 'Editor password' : 'Viewer password'}</h3>
        <p class="guide-p" style="margin-top:-4px">People opening the <b>${mode}</b> link must enter this password first.</p>
        <div class="share-link"><input id="pwField" type="text" value="${esc(curPw)}" placeholder="set a password"/><button class="btn sm" id="savePw">Save</button></div>
        <div class="hint">At least 3 characters. Changing it doesn't sign out anyone already in.</div>
      </div>
    </div>
    ${tunnelPanel}
    <div class="panel" style="margin-top:16px"><h3>How sharing works</h3>
      <ol class="guide-ol">
        <li>Keep this host PC running the app (it holds the data).</li>
        <li>Pick <b>Editor</b> or <b>Viewer</b> above, set its password, then send that link/QR to the right people.</li>
        <li>They open the link → enter the password → they're in at that level. Edits sync to everyone within ~3 seconds.</li>
      </ol>
      <div class="hint">View-only is enforced on the server — a viewer genuinely cannot change anything, through any screen. Everyone shares one database on this PC.</div>
    </div>`;

  view().querySelectorAll('#shareModeTabs .tab').forEach((b) => b.onclick = () => { state.shareMode = b.dataset.m; renderShare(); });
  view().querySelectorAll('[data-copy]').forEach((b) => b.onclick = () => { navigator.clipboard?.writeText(b.dataset.copy); toast('Link copied', 'ok'); });
  const sp = $('#savePw');
  if (sp) sp.onclick = async () => {
    const v = $('#pwField').value.trim();
    if (v.length < 3) return toast('Password must be at least 3 characters', 'err');
    sp.disabled = true;
    try { await api.changeAccessPassword(mode, v); toast(`${isEd ? 'Editor' : 'Viewer'} password saved`, 'ok'); }
    catch (e) { toast('Save failed: ' + e.message, 'err'); }
    sp.disabled = false;
  };
  const tg = $('#tunToggle');
  if (tg) tg.onclick = async () => {
    const turningOn = t.status === 'off' || t.status === 'error';
    tg.disabled = true; tg.textContent = turningOn ? 'Starting…' : 'Stopping…';
    try {
      if (turningOn) { await api.tunnelStart(); toast('Enabling public link…', 'ok'); }
      else { await api.tunnelStop(); toast('Public link turned off', 'ok'); }
    } catch (e) { toast(e.message, 'err'); }
    if (state.route === 'share') renderShare();
  };
  // while the link is coming up, keep refreshing so the URL appears automatically
  if (['downloading', 'starting'].includes(t.status)) setTimeout(() => { if (state.route === 'share') renderShare(); }, 2500);
}

// ── Guide & Data Safety (playbook) ────────────────────────────
function renderGuide() {
  view().innerHTML = `
    <div class="grid" style="grid-template-columns:1fr 1fr">
      <div class="panel"><h3>How the app is built</h3>
        <p class="guide-p"><b>Tank Types</b> = reusable templates (the parts checklist + each part's PDF/photo). Build once per product.</p>
        <p class="guide-p"><b>Tanks</b> = real orders. Creating one <b>clones</b> the type's checklist into its own tracking rows.</p>
        <p class="guide-p"><b>Parts</b> = the live tracking — phase, status, quantities, rework, assignee — per tank, isolated from the template.</p>
        <p class="guide-p"><b>Follow-up</b> = daily work + weekly delivered quantities. <b>Reports</b> = the numbers. <b>Settings</b> = edit dropdowns + backups.</p>
      </div>
      <div class="panel" style="border-color:rgba(229,83,75,.4)"><h3 style="color:var(--red)">🛡 Golden rules — never lose data</h3>
        <ol class="guide-ol">
          <li><b>One host, many viewers.</b> ONE PC runs the app; everyone else opens its address. <b>Never copy the folder to a 2nd PC and run both</b> — that creates two separate databases that drift apart.</li>
          <li><b>Backups are automatic</b> (on start, every 6h, and Settings → Backup now). Keep one target on a <b>USB/2nd drive</b> and one on a <b>cloud folder</b> (Google Drive/OneDrive). Check "last backup" in Settings.</li>
          <li><b>Never hand-edit</b> the <code>data</code> folder while the app is running.</li>
          <li><b>Restore</b> = copy the newest <code>db-…sqlite</code> backup to <code>data/app.sqlite</code> and the backup's <code>files</code> folder back. (See DEPLOY.md.)</li>
        </ol>
      </div>
    </div>

    <div class="panel" style="margin-top:16px"><h3>Daily way of working (rule of thumb)</h3>
      <ol class="guide-ol">
        <li><b>Morning:</b> Follow-up → pick the tank → today's date. Use the <b>phase filter</b> to work one stage at a time (e.g. everything in Welding).</li>
        <li>For each part: set its <b>Phase</b> and <b>Status</b>, type a short <b>Note</b>, and when units actually ship enter <b>Deliver qty</b>. Hit <b>Save day</b>.</li>
        <li><b>Status flow:</b> Not Started → In Progress → (Rework if a defect) → Done. Mark <b>Delivered</b> only when it leaves to the customer.</li>
        <li><b>Weekly:</b> Follow-up → Weekly rollup shows quantity delivered per week; <b>⤓ CSV</b> exports it.</li>
      </ol>
    </div>

    <div class="panel" style="margin-top:16px"><h3>Scenario playbook</h3>
      <table class="guide-table"><tbody>
        <tr><td><b>New product</b></td><td>Tank Types → <i>New from file</i> (Excel/Word/PDF/CSV — or Blank + Add parts) → <i>Upload files</i> (PDFs/images named by item code) → open a part's 📎 → <b>Crop &amp; save</b> the 3D view as its photo.</td></tr>
        <tr><td><b>New order</b></td><td>New Tank → pick the type → the whole checklist is cloned automatically.</td></tr>
        <tr><td><b>A part fails QC</b></td><td>Set Status = <b>Rework</b>, bump <b>Rework count</b>, choose a reason. It shows in Reports → Rework.</td></tr>
        <tr><td><b>Partial delivery</b></td><td>Ship some now: enter <b>Deliver qty</b>; the remaining units keep moving through phases. Weekly rollup sums what was delivered.</td></tr>
        <tr><td><b>Fix a phase/status name</b></td><td>Settings → Rename — it updates every part using it. <b>Don't rename Done/Delivered</b> (reserved by the math).</td></tr>
        <tr><td><b>Edit one tank only</b></td><td>Change a part's code/name/qty in the Parts table — it affects <b>only that tank</b>, never the template.</td></tr>
        <tr><td><b>Customer parts list</b></td><td>Tank Types → open the type → <b>📊 Export Excel</b> (with the cropped photos embedded).</td></tr>
        <tr><td><b>"Who changed what?"</b></td><td>Reports → <b>Recent activity</b> — every change, delivery, file and rename is logged. Use the filter box.</td></tr>
      </tbody></table>
    </div>

    <div class="grid" style="grid-template-columns:1fr 1fr;margin-top:16px">
      <div class="panel"><h3>Working from more than one place</h3>
        <p class="guide-p">The host PC stays on; the other place connects to it (e.g. via <b>Tailscale</b> — see DEPLOY.md). Both edit the <b>same</b> database, so there's one truth and no loss.</p>
        <p class="guide-p">Edits made anywhere appear on the other screens within <b>~3 seconds</b> automatically — no refresh needed. If you ever want an instant pull, hit <b>Refresh</b> (sidebar).</p>
      </div>
      <div class="panel"><h3>If something looks off</h3>
        <ol class="guide-ol">
          <li>Click <b>Refresh</b> (sidebar) to pull the latest.</li>
          <li>Check <b>Reports → Recent activity</b> to see what changed.</li>
          <li>Worst case, <b>restore the latest backup</b> (Golden rule 4). Your backups are timestamped, so you can go back to any point.</li>
        </ol>
      </div>
    </div>`;
}

// ── helpers ───────────────────────────────────────────────────
function countBy(arr, key, order) {
  const m = new Map();
  for (const x of arr) { const k = x[key] || ''; if (!k) continue; m.set(k, (m.get(k) || 0) + 1); }
  const keys = order?.length ? order.filter((k) => m.has(k)) : [...m.keys()];
  for (const k of m.keys()) if (!keys.includes(k)) keys.push(k);
  return keys.map((name) => ({ name, n: m.get(name) || 0 }));
}
function optionList(group, field) {
  return (state.options[group]?.[field] || []).map((o) => `<option value="${esc(o.name)}">${esc(o.name)}</option>`).join('');
}
function selectHTML(group, field, value, id, scope, blank = false) {
  const opts = state.options[group]?.[field] || [];
  const cls = field === 'status' ? `cell-edit ${statusClass(value)}` : 'cell-edit';
  const blankOpt = blank ? `<option value="" ${!value ? 'selected' : ''}>—</option>` : '';
  const body = opts.map((o) => `<option value="${esc(o.name)}" ${value === o.name ? 'selected' : ''}>${esc(o.name)}</option>`).join('');
  const missing = value && !opts.some((o) => o.name === value) ? `<option selected>${esc(value)}</option>` : '';
  return `<select class="${cls}" data-id="${id}" data-field="${field}">${blankOpt}${body}${missing}</select>`;
}

// CSV / download helpers
const csvCell = (v) => { const s = String(v ?? ''); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const sanitizeName = (s) => String(s || '').replace(/[^\w\-]+/g, '_').slice(0, 40) || 'export';
function downloadFile(name, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type: type || 'text/plain' }));
  const a = document.createElement('a'); a.href = url; a.download = name; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// drag & drop wiring (files, and folders when recurse=true)
function wireDrag(zone, onFiles, recurse = false) {
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('drag'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag'));
  zone.addEventListener('drop', async (e) => {
    e.preventDefault(); zone.classList.remove('drag');
    if (recurse && e.dataTransfer.items) {
      const files = [];
      const walk = (entry) => new Promise((res) => {
        if (entry.isFile) entry.file((f) => { files.push(f); res(); });
        else if (entry.isDirectory) { const rd = entry.createReader(); rd.readEntries(async (ents) => { for (const en of ents) await walk(en); res(); }); }
        else res();
      });
      const items = [...e.dataTransfer.items].map((i) => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean);
      for (const it of items) await walk(it);
      onFiles(files.length ? files : [...e.dataTransfer.files]);
    } else onFiles([...e.dataTransfer.files]);
  });
}

boot();

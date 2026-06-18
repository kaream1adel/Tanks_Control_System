// ── Small DOM + formatting helpers ────────────────────────────
export function el(spec, props = {}, children = []) {
  const [tag, ...classes] = spec.split('.');
  const node = document.createElement(tag || 'div');
  if (classes.length) node.className = classes.join(' ');
  for (const [k, v] of Object.entries(props)) {
    if (v == null) continue;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

export const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export const statusClass = (s) => 's-' + String(s || 'notstarted').toLowerCase().replace(/[^a-z]/g, '');
export const chip = (status) => `<span class="chip ${statusClass(status)}">${esc(status || '—')}</span>`;

export function fmtDate(iso) {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: '2-digit' }); }
  catch { return iso; }
}
export function dueLabel(iso) {
  if (!iso) return null;
  const days = Math.ceil((new Date(iso).getTime() - Date.now()) / 86400000);
  if (days < 0) return { text: `${-days}d overdue`, cls: 'red' };
  if (days === 0) return { text: 'due today', cls: 'orange' };
  if (days <= 7) return { text: `${days}d left`, cls: 'orange' };
  return { text: `${days}d left`, cls: 'muted' };
}
export const fmtSize = (b) => (b < 1024 ? b + ' B' : b < 1048576 ? (b / 1024).toFixed(0) + ' KB' : (b / 1048576).toFixed(1) + ' MB');

export function bar(pct, green = false) {
  return `<div class="bar ${green ? 'green' : ''}"><span style="width:${Math.min(100, pct || 0)}%"></span></div>`;
}
export function statBars(entries) {
  const max = Math.max(1, ...entries.map((e) => e.n));
  return entries.map((e) => `
    <div class="statrow">
      <div class="name">${e.chip ? chip(e.name) : esc(e.name)}</div>
      <div class="bar"><span style="width:${(e.n / max) * 100}%"></span></div>
      <div class="n">${e.n}</div>
    </div>`).join('');
}
export const ringHTML = (pct, done = false) => `<div class="ring ${done ? 'done' : ''}" style="--p:${pct}">${pct}%</div>`;

let toastTimer;
export function toast(msg, kind = 'ok') {
  const wrap = document.getElementById('toast');
  const t = el('div.toast', { class: `toast ${kind}` }, [msg]);
  wrap.append(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transform = 'translateX(20px)'; setTimeout(() => t.remove(), 260); }, 2800);
}

// ── Modal ─────────────────────────────────────────────────────
export function modal({ title, subtitle, body, onClose }) {
  const root = document.getElementById('modal');
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const close = () => { root.innerHTML = ''; document.removeEventListener('keydown', onKey); if (onClose) onClose(); };
  const back = el('div.modal-back', { onclick: (e) => { if (e.target === back) close(); } });
  const m = el('div.modal');
  m.innerHTML = `
    <div class="modal-head">
      <div><div class="mt">${esc(title)}</div>${subtitle ? `<div class="ms">${esc(subtitle)}</div>` : ''}</div>
      <button class="modal-close">✕</button>
    </div>
    <div class="modal-body"></div>`;
  m.querySelector('.modal-close').onclick = close;
  const bodyEl = m.querySelector('.modal-body');
  if (typeof body === 'string') bodyEl.innerHTML = body; else if (body) bodyEl.append(body);
  back.append(m);
  root.innerHTML = '';
  root.append(back);
  document.addEventListener('keydown', onKey);
  return { close, bodyEl };
}

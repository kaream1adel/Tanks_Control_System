// Thin fetch wrapper around the local server API.
// Access level: a VIEW session is read-only. We refuse writes client-side too (the
// server enforces it regardless), so any edit attempt shows a clean "view-only"
// notice instead of a raw error — and never reaches the network.
import { toast } from './ui.js';
let _access = 'full';
const VIEW_MSG = '🔒 View-only access — editing is disabled';
function guard(method) {
  if (_access === 'view' && method !== 'GET') {
    toast(VIEW_MSG, 'err');
    const e = new Error(VIEW_MSG); e.viewDenied = true; throw e;
  }
}

async function req(method, url, body) {
  guard(method);
  const opt = { method, headers: {} };
  if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  const res = await fetch(url, opt);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}
async function upload(url, formData) {
  guard('POST');
  const res = await fetch(url, { method: 'POST', body: formData });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}

export const api = {
  setAccess: (a) => { _access = a === 'view' ? 'view' : 'full'; },
  bootstrap: () => req('GET', '/api/bootstrap'),

  // parts (live tracking)
  updatePart: (id, patch) => req('PATCH', `/api/parts/${id}`, patch),
  partFiles: (id) => req('GET', `/api/parts/${id}/files`),

  // tanks (orders)
  updateTank: (id, patch) => req('PATCH', `/api/tanks/${id}`, patch),
  createTank: (payload) => req('POST', '/api/tanks', payload),
  deleteTank: (id) => req('DELETE', `/api/tanks/${id}`),

  // tank types (templates)
  tankTypes: () => req('GET', '/api/tank-types'),
  tankType: (id) => req('GET', `/api/tank-types/${id}`),
  createType: (payload) => req('POST', '/api/tank-types', payload),
  updateType: (id, patch) => req('PATCH', `/api/tank-types/${id}`, patch),
  deleteType: (id) => req('DELETE', `/api/tank-types/${id}`),
  newTypeFromFile: (form) => upload('/api/tank-types/new-from-file', form),
  importToType: (id, form, mode = 'append') => upload(`/api/tank-types/${id}/import?mode=${mode}`, form),
  uploadFiles: (id, form) => upload(`/api/tank-types/${id}/files`, form),
  addFilesToCode: (typeId, code, form) => upload(`/api/tank-types/${typeId}/add-files?code=${encodeURIComponent(code)}`, form),

  // template parts
  addTemplatePart: (typeId, payload) => req('POST', `/api/tank-types/${typeId}/parts`, payload),
  updateTemplatePart: (id, patch) => req('PATCH', `/api/template-parts/${id}`, patch),
  deleteTemplatePart: (id) => req('DELETE', `/api/template-parts/${id}`),
  deleteFile: (id) => req('DELETE', `/api/file/${id}`),

  addOption: (field, value) => req('POST', `/api/options/${field}`, { value }),
  getOptions: (field) => req('GET', `/api/options/${field}`),
  renameOption: (field, from, to) => req('PATCH', `/api/options/${field}/rename`, { from, to }),
  deleteOption: (field, value, reassignTo) => req('DELETE', `/api/options/${field}`, { value, reassignTo }),
  reorderOption: (field, order) => req('PATCH', `/api/options/${field}/reorder`, { order }),

  // save a cropped photo (blob) to a part or a tank-type item code
  savePartPhoto: (partId, blob) => { const fd = new FormData(); fd.append('file', blob, 'crop.png'); return upload(`/api/parts/${partId}/photo`, fd); },
  saveTypePhoto: (typeId, itemCode, blob) => { const fd = new FormData(); fd.append('file', blob, 'crop.png'); fd.append('itemCode', itemCode); return upload(`/api/tank-types/${typeId}/photo`, fd); },

  // backups
  backup: () => req('POST', '/api/backup'),
  backupStatus: () => req('GET', '/api/backup'),

  // live-sync + export
  version: () => req('GET', '/api/version'),
  share: () => req('GET', '/api/share'),
  tunnelStart: () => req('POST', '/api/tunnel/start'),
  tunnelStop: () => req('POST', '/api/tunnel/stop'),
  exportType: async (id) => { const res = await fetch(`/api/tank-types/${id}/export.xlsx`); if (!res.ok) throw new Error('Export failed (' + res.status + ')'); return res.blob(); },
  exportBlob: async (url) => { const res = await fetch(url); if (!res.ok) throw new Error('Export failed (' + res.status + ')'); return res.blob(); },

  // delivery proofs (per tank)
  tankProofs: (id) => req('GET', `/api/tanks/${id}/proofs`),
  uploadProof: (id, form) => upload(`/api/tanks/${id}/proofs`, form),
  deleteProof: (id) => req('DELETE', `/api/tank-proof/${id}`),

  // reports + follow-up
  reports: (weeks) => req('GET', `/api/reports${weeks ? `?weeks=${weeks}` : ''}`),
  activity: (q, limit) => req('GET', `/api/activity?limit=${limit || 150}${q ? `&q=${encodeURIComponent(q)}` : ''}`),
  daily: (id, date, phase) => req('GET', `/api/tanks/${id}/daily?date=${date}${phase ? `&phase=${encodeURIComponent(phase)}` : ''}`),
  saveDaily: (id, payload) => req('POST', `/api/tanks/${id}/daily`, payload),
  weekly: (id) => req('GET', `/api/tanks/${id}/weekly`),
};

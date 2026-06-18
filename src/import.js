// Parse an uploaded spreadsheet (.xlsx / .xls / .csv) into normalized template
// parts. Header detection is fuzzy and bilingual, and it auto-locates the header
// row even when the sheet starts with title/blank rows — so the user can drop
// almost any reasonable sheet with "least work".
import * as XLSX from 'xlsx';

// normalize a header cell: lowercase, strip spaces/punctuation (keep a-z, 0-9, arabic)
const norm = (s) => String(s ?? '').toLowerCase().replace(/[\s_\-#.()]+/g, '').trim();

const SYNONYMS = {
  itemCode: ['itemcode', 'code', 'partcode', 'item', 'partno', 'partnumber', 'كود', 'رقمالصنف', 'الكود'],
  no: ['no', 'number', 'seq', 'sn', 'serial', 'م', 'مسلسل', 'رقم'],
  qty: ['qty', 'quantity', 'count', 'pcs', 'العدد', 'الكمية', 'كمية'],
  description: ['description', 'desc', 'name', 'part', 'partname', 'detail', 'details', 'الوصف', 'البيان', 'الاسم', 'اسم'],
  defaultPhase: ['phase', 'defaultphase', 'stage', 'step', 'process', 'المرحلة', 'مرحلة'],
};

// which field (if any) a single header cell maps to. Exact matches win across all
// fields before any fuzzy contains-match, so short tokens like "No" can't be
// swallowed by "partNo" under itemCode.
function fieldFor(cell) {
  const n = norm(cell);
  if (!n) return null;
  for (const [field, syns] of Object.entries(SYNONYMS)) if (syns.some((s) => n === s)) return field;
  for (const [field, syns] of Object.entries(SYNONYMS)) {
    for (const s of syns) {
      if (Math.min(n.length, s.length) >= 4 && (n.includes(s) || s.includes(n))) return field;
    }
  }
  return null;
}

const EMPTY = { parts: [], headerMap: {}, headers: [], rowCount: 0, headerRow: -1 };

// scan the first rows for the one that looks most like a header (must contain an
// item-code or description column; more recognized columns = higher score).
function findHeaderRow(aoa) {
  let best = { idx: -1, score: 0, fields: null };
  const limit = Math.min(aoa.length, 30);
  for (let i = 0; i < limit; i++) {
    const fields = new Map();
    (aoa[i] || []).forEach((cell, ci) => { const f = fieldFor(cell); if (f && !fields.has(f)) fields.set(f, ci); });
    if (!fields.has('itemCode') && !fields.has('description')) continue;
    const score = fields.size + (fields.has('itemCode') ? 2 : 0);
    if (score > best.score) best = { idx: i, score, fields };
  }
  return best;
}

export function parseSpreadsheet(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) return EMPTY;
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false, blankrows: false });
  if (!aoa.length) return EMPTY;

  const { idx: hIdx, fields } = findHeaderRow(aoa);
  if (hIdx < 0) return EMPTY;

  const headerCells = (aoa[hIdx] || []).map((c) => String(c ?? '').trim());
  const col = (field) => (fields.has(field) ? fields.get(field) : -1);
  const cell = (row, field) => { const c = col(field); return c >= 0 ? String(row[c] ?? '').trim() : ''; };

  const headerMap = {};
  for (const [field, ci] of fields) headerMap[field] = headerCells[ci] || `col${ci + 1}`;

  const parts = [];
  let i = 0;
  for (let r = hIdx + 1; r < aoa.length; r++) {
    const row = aoa[r] || [];
    const itemCode = cell(row, 'itemCode');
    const description = cell(row, 'description');
    if (!itemCode && !description) continue; // blank / separator row
    const qtyRaw = cell(row, 'qty').replace(/[^\d.]/g, '');
    const noRaw = cell(row, 'no').replace(/[^\d]/g, '');
    parts.push({
      itemCode,
      description,
      no: noRaw ? Number(noRaw) : ++i,
      qty: qtyRaw ? Math.max(0, Math.round(Number(qtyRaw))) : 1,
      defaultPhase: cell(row, 'defaultPhase'),
    });
    if (noRaw) i = Math.max(i, Number(noRaw));
  }
  return { parts, headerMap, headers: headerCells.filter(Boolean), rowCount: parts.length, headerRow: hIdx + 1 };
}

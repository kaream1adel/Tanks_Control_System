// Parse an uploaded parts list into normalized template parts. Supports
//   • spreadsheets  (.xlsx / .xls / .xlsm / .csv)  via the xlsx lib
//   • Word          (.docx)                        via mammoth -> HTML tables
//   • PDF           (.pdf)                          via pdf.js text + geometry
// All three are reduced to an "array of arrays" (rows × columns), then funneled
// through the SAME fuzzy/bilingual header detection so behaviour is identical
// across formats. If no recognizable parts table is found, parts come back empty
// and the caller shows "No parts table found".
import * as XLSX from 'xlsx';

// Arabic-aware normalization for matching. NFKC folds the Unicode "presentation
// forms" some PDFs emit (and full-width chars) back to standard letters; then we
// drop tashkeel/tatweel and unify letter variants (أإآ→ا, ى→ي, ة→ه, ؤ→و, ئ→ي) so
// a header matches regardless of spelling/diacritics.
const AR_STRIP = /[ً-ْٰـ]/g; // harakat, dagger-alef, tatweel
const arFold = (s) => s
  .replace(AR_STRIP, '')
  .replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ؤ/g, 'و').replace(/ئ/g, 'ي').replace(/ة/g, 'ه');
// normalize a header cell: NFKC, lowercase, Arabic-fold, strip spaces/punctuation
const norm = (s) => arFold(String(s ?? '').normalize('NFKC').toLowerCase())
  .replace(/[\s_\-#.()،؛:|/\\]+/g, '').trim();

// Eastern Arabic-Indic (٠-٩) and Persian (۰-۹) digits → ASCII, for qty / No cells.
const toAsciiDigits = (s) => String(s ?? '')
  .replace(/[٠-٩]/g, (d) => d.charCodeAt(0) - 0x0660)
  .replace(/[۰-۹]/g, (d) => d.charCodeAt(0) - 0x06F0);

const isArabic = (s) => /[؀-ۿﭐ-﷿ﹰ-﻿]/.test(String(s ?? ''));

// Field synonyms (English + Arabic). Arabic terms are written naturally and run
// through norm() below, so the dictionary and the input fold identically.
const SYNONYMS = {
  itemCode: ['itemcode', 'code', 'partcode', 'item', 'partno', 'partnumber',
    'كود', 'الكود', 'كود الصنف', 'رقم الصنف', 'رقم القطعة', 'رقم الجزء', 'الموديل', 'موديل', 'رقم الموديل'],
  no: ['no', 'number', 'seq', 'sn', 'serial',
    'م', 'مسلسل', 'رقم', 'ت', 'رقم متسلسل', 'تسلسل'],
  qty: ['qty', 'quantity', 'count', 'pcs',
    'العدد', 'عدد', 'الكمية', 'كمية'],
  description: ['description', 'desc', 'name', 'part', 'partname', 'detail', 'details',
    'الوصف', 'وصف', 'البيان', 'بيان', 'الاسم', 'اسم', 'الصنف', 'صنف', 'المنتج', 'منتج',
    'التوصيف', 'توصيف', 'النوع', 'نوع', 'المواصفات', 'مواصفات'],
  defaultPhase: ['phase', 'defaultphase', 'stage', 'step', 'process',
    'المرحلة', 'مرحلة', 'العملية', 'عملية', 'الخطوة', 'خطوة'],
};
// pre-fold every synonym once so matching uses identical normalization
const NORM_SYNS = Object.fromEntries(Object.entries(SYNONYMS).map(([f, a]) => [f, [...new Set(a.map(norm))]]));

// which field (if any) a single header cell maps to. Exact matches win across all
// fields before any fuzzy contains-match, so short tokens like "No" can't be
// swallowed by "partNo" under itemCode.
function fieldFor(cell) {
  const n = norm(cell);
  if (!n) return null;
  for (const [field, syns] of Object.entries(NORM_SYNS)) if (syns.includes(n)) return field;
  for (const [field, syns] of Object.entries(NORM_SYNS)) {
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

// Shared core: turn a rows×cols grid into normalized parts. Used by every format.
function aoaToParts(aoa) {
  if (!aoa || !aoa.length) return EMPTY;

  const { idx: hIdx, fields } = findHeaderRow(aoa);
  if (hIdx < 0) return EMPTY;

  const headerCells = (aoa[hIdx] || []).map((c) => String(c ?? '').trim());
  const col = (field) => (fields.has(field) ? fields.get(field) : -1);
  // NFKC on extracted values fixes Arabic presentation-form glyphs from PDFs
  // (without folding letters — descriptions keep their real spelling).
  const cell = (row, field) => { const c = col(field); return c >= 0 ? String(row[c] ?? '').normalize('NFKC').trim() : ''; };

  const headerMap = {};
  for (const [field, ci] of fields) headerMap[field] = headerCells[ci] || `col${ci + 1}`;

  // detect a row that is just a repeat of the header (common in multi-page PDFs)
  const hasCode = col('itemCode') >= 0, hasDesc = col('description') >= 0;
  const isRepeatHeader = (row) => hasCode && hasDesc
    && norm(cell(row, 'itemCode')) === norm(headerMap.itemCode)
    && norm(cell(row, 'description')) === norm(headerMap.description);

  const parts = [];
  let i = 0;
  let strong = 0; // rows that look like a real BOM line (description + another field)
  for (let r = hIdx + 1; r < aoa.length; r++) {
    const row = aoa[r] || [];
    const itemCode = cell(row, 'itemCode');
    const description = cell(row, 'description');
    if (!itemCode && !description) continue;     // blank / separator row
    if (isRepeatHeader(row)) continue;           // repeated header band
    const qtyRaw = toAsciiDigits(cell(row, 'qty')).replace(/[^\d.]/g, '');
    const noRaw = toAsciiDigits(cell(row, 'no')).replace(/[^\d]/g, '');
    if (description && (itemCode || qtyRaw || noRaw)) strong++;
    parts.push({
      itemCode,
      description,
      no: noRaw ? Number(noRaw) : ++i,
      qty: qtyRaw ? Math.max(0, Math.round(Number(qtyRaw))) : 1,
      defaultPhase: cell(row, 'defaultPhase'),
    });
    if (noRaw) i = Math.max(i, Number(noRaw));
  }
  // Reject "tables" that are really a drawing's title block (e.g. PART NUMBER /
  // DESCRIPTION / QTY labels with no actual rows): a genuine parts list always
  // has at least one row with a description plus a code/qty/number.
  if (!strong) return EMPTY;
  return { parts, headerMap, headers: headerCells.filter(Boolean), rowCount: parts.length, headerRow: hIdx + 1 };
}

// ── Spreadsheets ───────────────────────────────────────────────────────────
export function parseSpreadsheet(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) return EMPTY;
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false, blankrows: false });
  return aoaToParts(aoa);
}

// ── Word (.docx) ─────────────────────────────────────────────────────────────
const decodeEntities = (s) => s
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#3?9;/g, "'")
  .replace(/\s+/g, ' ').trim();

// pull every <table> out of mammoth's HTML into a list of rows×cols grids
function htmlTablesToAoas(html) {
  const tables = [];
  const tableRe = /<table[\s\S]*?<\/table>/gi;
  let tm;
  while ((tm = tableRe.exec(html))) {
    const rows = [];
    const trRe = /<tr[\s\S]*?<\/tr>/gi;
    let rm;
    while ((rm = trRe.exec(tm[0]))) {
      const cells = [];
      const tdRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
      let cm;
      while ((cm = tdRe.exec(rm[0]))) cells.push(decodeEntities(cm[1]));
      if (cells.length) rows.push(cells);
    }
    if (rows.length) tables.push(rows);
  }
  return tables;
}

async function parseDocx(buffer) {
  const mammoth = (await import('mammoth')).default;
  const { value: html } = await mammoth.convertToHtml({ buffer });
  // try each table; keep the one that yields the most parts
  let best = EMPTY;
  for (const aoa of htmlTablesToAoas(html)) {
    const r = aoaToParts(aoa);
    if (r.parts.length > best.parts.length) best = r;
  }
  return best;
}

// ── PDF ──────────────────────────────────────────────────────────────────────
let _pdfjs;
async function loadPdfjs() {
  if (!_pdfjs) _pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  return _pdfjs;
}

const median = (arr) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

// Reconstruct a table grid from positioned PDF text. Rows are formed by grouping
// text by vertical position; columns by clustering the x-start of each cell so
// every row lines up under the same headers.
async function parsePdf(buffer) {
  const pdfjs = await loadPdfjs();
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buffer), useSystemFonts: true, isEvalSupported: false, verbosity: 0,
  }).promise;

  const charW = [];
  const pageRows = []; // [{ cells:[{start,text}] }, ...] in reading order
  const maxPages = Math.min(doc.numPages, 60);

  for (let p = 1; p <= maxPages; p++) {
    const page = await doc.getPage(p);
    const items = (await page.getTextContent()).items
      .map((it) => ({ x: it.transform[4], y: it.transform[5], w: it.width || 0, h: it.height || 0, str: it.str || '' }))
      .filter((it) => it.str.trim() !== '');
    page.cleanup?.();
    if (!items.length) continue;
    items.forEach((it) => { if (it.w && it.str.length) charW.push(it.w / it.str.length); });

    // group into rows by baseline y (top of page first)
    items.sort((a, b) => b.y - a.y || a.x - b.x);
    const rowTol = Math.max(2, (median(items.map((i) => i.h)) || 8) * 0.5);
    const rows = [];
    let cur = null;
    for (const it of items) {
      if (!cur || Math.abs(it.y - cur.y) > rowTol) { cur = { y: it.y, items: [it] }; rows.push(cur); }
      else cur.items.push(it);
    }
    // within each row, merge items into cells when the horizontal gap is large
    const gap = Math.max(6, (median(charW) || 4) * 2);
    for (const row of rows) {
      row.items.sort((a, b) => a.x - b.x);
      const cells = [];
      let c = null;
      for (const it of row.items) {
        if (!c || it.x - c.end > gap) { c = { start: it.x, end: it.x + it.w, toks: [it] }; cells.push(c); }
        else { c.toks.push(it); c.end = it.x + it.w; }
      }
      // join each cell's tokens; Arabic reads right-to-left, so reverse the x order
      for (const cl of cells) {
        const ar = cl.toks.some((t) => isArabic(t.str));
        const ordered = ar ? [...cl.toks].sort((a, b) => b.x - a.x) : cl.toks;
        cl.text = ordered.map((t) => t.str).join(' ').replace(/\s+/g, ' ').trim();
      }
      pageRows.push({ cells });
    }
  }
  if (!pageRows.length) return EMPTY;

  // cluster all cell starts into column bins so rows align under shared headers
  const colGap = Math.max(10, (median(charW) || 4) * 3.5);
  const starts = pageRows.flatMap((r) => r.cells.map((c) => c.start)).sort((a, b) => a - b);
  const centers = [];
  let bin = null;
  for (const s of starts) {
    if (!bin || s - bin.last > colGap) { bin = { sum: s, n: 1, last: s }; centers.push(bin); }
    else { bin.sum += s; bin.n++; bin.last = s; }
  }
  const colCenters = centers.map((b) => b.sum / b.n);
  const colOf = (x) => {
    let best = 0, dist = Infinity;
    colCenters.forEach((c, i) => { const d = Math.abs(c - x); if (d < dist) { dist = d; best = i; } });
    return best;
  };

  const aoa = pageRows.map((r) => {
    const out = new Array(colCenters.length).fill('');
    for (const cell of r.cells) {
      const ci = colOf(cell.start);
      out[ci] = out[ci] ? out[ci] + ' ' + cell.text : cell.text;
    }
    return out;
  });
  return aoaToParts(aoa);
}

// Detect the format from the file's bytes — a fallback when the name has no
// usable extension (Arabic filenames are often mangled by the upload layer).
function sniffExt(buffer) {
  if (!buffer || buffer.length < 4) return null;
  if (buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46) return 'pdf'; // %PDF
  if (buffer[0] === 0xD0 && buffer[1] === 0xCF) return 'xls';                                            // OLE (old .xls)
  if (buffer[0] === 0x50 && buffer[1] === 0x4B)                                                          // PK = zip
    return buffer.includes(Buffer.from('word/document.xml')) ? 'docx' : 'xlsx';
  return null;
}

// ── Dispatcher ───────────────────────────────────────────────────────────────
// Pick a parser by file extension, falling back to content sniffing. xlsx/csv
// stay synchronous under the hood; docx/pdf are async — callers `await`.
export async function parseAny(buffer, filename = '') {
  let ext = String(filename).split('.').pop().toLowerCase();
  const known = ['pdf', 'docx', 'doc', 'xlsx', 'xls', 'xlsm', 'csv'];
  if (!known.includes(ext)) ext = sniffExt(buffer) || ext; // Arabic / mangled names → detect by bytes
  if (ext === 'pdf') return parsePdf(buffer);
  if (ext === 'docx') return parseDocx(buffer);
  if (ext === 'doc') throw new Error('Old .doc format is not supported — save it as .docx, .pdf, or .xlsx and try again.');
  return parseSpreadsheet(buffer); // xlsx / xls / xlsm / csv (default)
}

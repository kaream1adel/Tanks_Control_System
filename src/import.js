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

// ── Field detection ──────────────────────────────────────────────────────────
// Header wording varies enormously (especially in Arabic), so we never compare
// whole strings. Each header cell is scored against KEYWORD STEMS — word
// fragments that survive the article ال, plurals and suffixes — after splitting
// into tokens, so multi-word / bilingual headers ("Item No رقم الصنف") still
// match. A row-level resolver then gives each field its single best column.
// Finally, any field whose header gave no signal is inferred from the column's
// DATA (codes look like codes, qty are small ints, No. is sequential,
// description is the long free text) — so detection works even when the column
// titles are unfamiliar, paraphrased, or carry no recognizable words at all.

const SPLIT = /[\s_\-#.()،؛:|/\\]+/;
// stem → weight. Strong, unambiguous stems outrank weak/shared ones on conflict.
const STEMS = {
  itemCode: [['كود', 6], ['code', 6], ['موديل', 6], ['model', 5], ['كتالوج', 6], ['catalog', 5],
    ['باركود', 6], ['barcode', 5], ['sku', 6], ['رمز', 5], ['itemcode', 7], ['itemno', 6],
    ['partno', 6], ['partnumber', 7], ['partcode', 7]],
  qty: [['كمي', 6], ['عدد', 5], ['qty', 7], ['quantity', 7], ['quan', 5], ['count', 5], ['pcs', 5]],
  description: [['وصف', 6], ['توصيف', 6], ['وصيف', 5], ['بيان', 6], ['مواصف', 6], ['مسمي', 5],
    ['اسم', 5], ['صنف', 3], ['منتج', 5], ['نوع', 2], ['بند', 3], ['desc', 6], ['name', 5],
    ['detail', 5], ['تفصيل', 4], ['product', 5]],
  no: [['مسلسل', 7], ['تسلسل', 7], ['serial', 7], ['seq', 6], ['ترتيب', 5], ['رتبه', 5],
    ['index', 5], ['idx', 5], ['order', 3]],
  defaultPhase: [['مرحل', 6], ['phase', 7], ['stage', 6], ['عملي', 5], ['خطوه', 5],
    ['process', 6], ['step', 5], ['تشغيل', 4], ['تصنيع', 3]],
};
// "thing" words name the part itself → lean description; with a number word → code
const THING = ['صنف', 'قطعه', 'جزء', 'موديل', 'منتج', 'مكون', 'وحده', 'part', 'item', 'component'];
// whole-cell serial words ("No", "م", "رقم" on their own)
const NUM_EXACT = new Set(['م', 'ت', 'no', 'num', 'number', 'sn', 'رقم', 'الرقم', 'نمره', 'نمبر', 'رتبه']);

// score a single header cell → { field: weight }
function scoreCell(raw) {
  const full = norm(raw);
  const sc = {};
  if (!full) return sc;
  const add = (f, w) => { sc[f] = Math.max(sc[f] || 0, w); };
  const toks = String(raw ?? '').split(SPLIT).map(norm).filter(Boolean);
  const hit = (stem) => full.includes(stem) || toks.some((t) => t.includes(stem));
  for (const [field, stems] of Object.entries(STEMS))
    for (const [stem, w] of stems) if (hit(stem)) add(field, w);

  const hasThing = THING.some(hit);
  const hasNum = toks.some((t) => NUM_EXACT.has(t)) || full.includes('رقم') || full.includes('نمر') || full.includes('نمب');
  const serialBare = toks.some((t) => NUM_EXACT.has(t)) && toks.length <= 2 && !hasThing;
  if (hasNum && hasThing) add('itemCode', 6);   // "رقم الصنف" / "Item No" → a code, not a serial
  else if (serialBare) add('no', 7);            // bare "م" / "No" / "رقم" → serial
  else if (hasNum) add('no', 5);
  if (hasThing) add('description', 2);          // "الصنف" / "القطعة" alone → a part name
  return sc;
}

// adjust a header cell's scores using the SHAPE of the column's data — this is
// what lets us tell a serial column ("Item No" holding 1,2,3) from a real code
// column ("Reference No." holding TNK-A100) when the header words are ambiguous.
function dataAdjust(sc, f) {
  if (!f || !f.n) return;
  const add = (k, w) => { sc[k] = (sc[k] || 0) + w; };
  const seq = f.intCnt >= 2 && f.intCnt / f.n >= 0.6 && isSeq(f.vals);
  const allInt = f.intCnt / f.n >= 0.8;
  const numeric = f.numCnt / f.n >= 0.7;
  const codey = f.codeCnt / f.n >= 0.5;
  const texty = f.textCnt / f.n >= 0.5;
  if (seq) add('no', 5); else if (!allInt) add('no', -6);          // sequential ⇒ serial; non-numeric ⇒ not
  if (numeric && !seq && medOf(f.vals) <= 500) add('qty', 4); else if (texty) add('qty', -4);
  if (codey) add('itemCode', 5); else if (seq) add('itemCode', -5); else if (texty) add('itemCode', -3);
  if (texty) add('description', Math.min(5, 2 + f.avgLen / 12)); else add('description', -3);
}

// assign each field to its single best-scoring column (unique, strongest first),
// combining header-word score with the column's data shape.
function mapHeaderRow(aoa, hIdx) {
  const cells = (aoa[hIdx] || []).map((c) => String(c ?? ''));
  let ncols = cells.length;
  for (let r = hIdx; r < Math.min(aoa.length, hIdx + 60); r++) ncols = Math.max(ncols, (aoa[r] || []).length);
  const cands = [];
  for (let ci = 0; ci < ncols; ci++) {
    const sc = scoreCell(cells[ci] || '');
    dataAdjust(sc, colStats(aoa, hIdx, ci));
    for (const [f, w] of Object.entries(sc)) if (w > 0) cands.push({ ci, f, w });
  }
  cands.sort((a, b) => b.w - a.w);
  const fieldCol = new Map(); const usedCol = new Set();
  for (const { ci, f } of cands) { if (fieldCol.has(f) || usedCol.has(ci)) continue; fieldCol.set(f, ci); usedCol.add(ci); }
  return fieldCol;
}

const EMPTY = { parts: [], headerMap: {}, headers: [], rowCount: 0, headerRow: -1 };

// pick the row that looks most like a header once header words AND data shape are
// considered (must yield a code or description column). Headers can be fuzzy,
// dotted, bilingual, or even generic ("col1") — the data shape recovers them.
// Drawings are kept out later, by the structural accept gate. Returns {idx,fields}.
function findHeaderRow(aoa) {
  let best = { idx: -1, fields: null, score: -1 };
  const limit = Math.min(aoa.length, 30);
  for (let i = 0; i < limit; i++) {
    if (!(aoa[i] || []).some((c) => String(c ?? '').trim())) continue;
    const fields = mapHeaderRow(aoa, i);
    if (!fields.has('itemCode') && !fields.has('description')) continue;
    const score = fields.size * 10 + (fields.has('itemCode') ? 5 : 0) + (fields.has('description') ? 5 : 0) - i;
    if (score > best.score) best = { idx: i, fields, score };
  }
  return best;
}

const medOf = (arr) => { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
// a serial enumerator counts up consecutively (1,2,3…) from a small start — used
// to tell a real "No." column from a quantity column that merely happens to rise.
const isSeq = (vals) => vals.length >= 2 && vals[0] <= 2 && vals.every((v, k) => k === 0 || v === vals[k - 1] + 1);

// profile one column over the data rows so its role can be inferred from content
function colStats(aoa, hIdx, ci) {
  let n = 0, intCnt = 0, numCnt = 0, codeCnt = 0, textCnt = 0, lenSum = 0; const vals = [];
  const limit = Math.min(aoa.length, hIdx + 60);
  for (let r = hIdx + 1; r < limit; r++) {
    const raw = String((aoa[r] || [])[ci] ?? '').trim();
    if (!raw) continue;
    n++; lenSum += raw.length;
    const asc = toAsciiDigits(raw).replace(/\s+/g, '');
    if (/^\d+$/.test(asc)) { intCnt++; numCnt++; vals.push(Number(asc)); }
    else if (/^\d+(\.\d+)?$/.test(asc)) { numCnt++; vals.push(Number(asc)); }
    else if (/\d/.test(asc) && raw.length <= 24 && !/\s.*\s/.test(raw)) codeCnt++; // a digit, short, ≤1 space → code-like
    else if (raw.length >= 2) textCnt++;
  }
  return { ci, n, intCnt, numCnt, codeCnt, textCnt, avgLen: n ? lenSum / n : 0, vals };
}

// fill any field whose header gave no signal, using each free column's data shape
function inferMissingFields(aoa, hIdx, fields) {
  let ncols = 0;
  for (let r = hIdx; r < Math.min(aoa.length, hIdx + 60); r++) ncols = Math.max(ncols, (aoa[r] || []).length);
  const used = new Set(fields.values());
  let free = [];
  for (let ci = 0; ci < ncols; ci++) if (!used.has(ci)) free.push(colStats(aoa, hIdx, ci));
  free = free.filter((f) => f.n);
  const take = (field, c) => { if (!c) return; fields.set(field, c.ci); free = free.filter((f) => f.ci !== c.ci); };

  if (!fields.has('no'))
    take('no', free.filter((f) => f.intCnt / f.n >= 0.8 && isSeq(f.vals)).sort((a, b) => b.intCnt - a.intCnt)[0]);
  if (!fields.has('qty'))
    take('qty', free.filter((f) => f.numCnt / f.n >= 0.7 && medOf(f.vals) <= 500).sort((a, b) => b.numCnt - a.numCnt)[0]);
  if (!fields.has('itemCode'))
    take('itemCode', free.filter((f) => (f.codeCnt + f.intCnt) / f.n >= 0.6 && f.avgLen <= 24).sort((a, b) => b.codeCnt - a.codeCnt)[0]);
  if (!fields.has('description'))
    take('description', free.filter((f) => f.textCnt / f.n >= 0.5).sort((a, b) => b.avgLen - a.avgLen)[0]);
}

// Structural signature of a real parts list, judged from the mapped columns'
// DATA: a consecutive serial enumerator (1,2,3…), real codes, real quantities.
// Crucially each is measured against the row COUNT, not just the non-empty cells,
// so a column that is mostly empty but holds a few stray codes (typical of a
// scrambled drawing title block) does NOT count as a real code column.
function dataSignature(aoa, hIdx, fields) {
  let nRows = 0;
  const lim = Math.min(aoa.length, hIdx + 60);
  for (let r = hIdx + 1; r < lim; r++) if ((aoa[r] || []).some((c) => String(c ?? '').trim())) nRows++;
  const need = Math.max(2, Math.ceil(nRows * 0.5));   // filled in ≥half the rows
  const noNeed = Math.max(2, Math.ceil(nRows * 0.6));
  const st = (f) => (fields.has(f) ? colStats(aoa, hIdx, fields.get(f)) : null);
  const noS = st('no'), qtyS = st('qty'), codeS = st('itemCode');
  return {
    serial: Boolean(noS && noS.intCnt >= noNeed && noS.intCnt / Math.max(1, noS.n) >= 0.6 && isSeq(noS.vals)),
    realQty: Boolean(qtyS && qtyS.numCnt >= need && qtyS.numCnt / Math.max(1, qtyS.n) >= 0.6),
    realCode: Boolean(codeS && codeS.codeCnt >= need && codeS.codeCnt / Math.max(1, codeS.n) >= 0.5),
  };
}

// Locate the parts table by its (fuzzy, bilingual) header row. No header words →
// not a parts list (this is what keeps engineering drawings out).
function findTable(aoa) {
  const wb = findHeaderRow(aoa);
  if (wb.idx < 0) return null;
  inferMissingFields(aoa, wb.idx, wb.fields);
  return { hIdx: wb.idx, fields: wb.fields };
}

// Shared core: turn a rows×cols grid into normalized parts. Used by every format.
function aoaToParts(aoa) {
  if (!aoa || !aoa.length) return EMPTY;

  const tbl = findTable(aoa);
  if (!tbl) return EMPTY;
  const { hIdx, fields } = tbl;

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

  const sig = dataSignature(aoa, hIdx, fields);
  const noCol = col('no');
  // When the sheet has a reliable serial column, a genuine item line always
  // carries a plain integer there. So a leading metadata block (Job order / Date
  // / Rev.), a re-issue banner, or a trailing "الشكل / عدد N" shapes section —
  // common in real loading/accessories check-lists — is skipped instead of being
  // imported as junk. (Without a serial column we keep every described row.)
  const serialMode = sig.serial && noCol >= 0;
  const isItemNo = (v) => /^\d{1,5}[.)]?$/.test(toAsciiDigits(String(v ?? '')).replace(/\s/g, ''));

  const parts = [];
  let i = 0;
  let strong = 0; // rows that look like a real BOM line (description + another field)
  for (let r = hIdx + 1; r < aoa.length; r++) {
    const row = aoa[r] || [];
    if (serialMode && !isItemNo(row[noCol])) continue; // not a numbered item line
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
  // Reject blocks that aren't really parts lists (drawing title blocks, revision
  // histories, spec sheets, dimension noise). A genuine BOM needs a description,
  // ≥2 real lines, AND a structural signature its imitators lack: a consecutive
  // serial column backed by real codes or real quantities — or, for serial-less
  // sheets, a real code+quantity pair with consistently filled rows. CAD BOM
  // title-block templates have a serial-looking column but EMPTY codes/qty, so
  // requiring real code/qty data turns them away.
  const strongRatio = parts.length ? strong / parts.length : 0;
  const ok = hasDesc && strong >= 2 && (
    (sig.serial && (sig.realCode || sig.realQty))
    || (sig.realCode && sig.realQty && strong >= 3 && strongRatio >= 0.8)
  );
  if (!ok) return EMPTY;
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
  const tables = htmlTablesToAoas(html);
  // try each table on its own; keep the one that yields the most parts
  let best = EMPTY;
  for (const aoa of tables) {
    const r = aoaToParts(aoa);
    if (r.parts.length > best.parts.length) best = r;
  }
  // also try ALL tables concatenated — a parts list often spans several tables
  // (with a metadata block as its own leading table, or the list split in two)
  if (tables.length > 1) {
    const r = aoaToParts(tables.flat());
    if (r.parts.length > best.parts.length) best = r;
  }
  return best;
}

// ── Word (.doc, legacy binary) ───────────────────────────────────────────────
// word-extractor pulls the body text with table cells tab-separated and rows
// newline-separated, which we rebuild into a grid and parse like everything else.
async function parseDoc(buffer) {
  const WordExtractor = (await import('word-extractor')).default;
  const doc = await new WordExtractor().extract(buffer);
  const aoa = doc.getBody().split(/\r?\n/).map((line) => line.split('\t').map((c) => c.trim()));
  return aoaToParts(aoa);
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
  const pageRows = []; // [{ items:[{x,w,str}] }, ...] in reading order (all pages)
  const maxPages = Math.min(doc.numPages, 60);

  for (let p = 1; p <= maxPages; p++) {
    const page = await doc.getPage(p);
    const items = (await page.getTextContent()).items
      .map((it) => ({ x: it.transform[4], y: it.transform[5], w: it.width || 0, h: it.height || 0, str: it.str || '' }))
      .filter((it) => it.str.trim() !== '');
    page.cleanup?.();
    if (!items.length) continue;
    items.forEach((it) => { if (it.w && it.str.length) charW.push(it.w / it.str.length); });

    // group into rows by baseline y (top of page first). A generous tolerance
    // keeps a value that sits a couple of px off its row (common for the serial
    // column) on the same line as the rest of the row.
    items.sort((a, b) => b.y - a.y || a.x - b.x);
    const rowTol = Math.max(4, (median(items.map((i) => i.h)) || 8) * 0.85);
    let cur = null;
    for (const it of items) {
      // compare to the row's last item's y so a slightly-drifting baseline (the
      // serial digit often sits a few px low) chains into the same line
      if (!cur || Math.abs(it.y - cur.lastY) > rowTol) { cur = { y: it.y, lastY: it.y, items: [it] }; pageRows.push(cur); }
      else { cur.items.push(it); cur.lastY = it.y; }
    }
  }
  if (!pageRows.length) return EMPTY;

  // Column detection by whitespace GUTTERS: a column is an x-band covered by text
  // in many rows; the empty bands between them are the gutters. This is far more
  // reliable than per-row gap splitting for wide RTL description columns, whose
  // words sit at many different x positions (which used to fragment the column).
  const cw = median(charW) || 5;
  const minX = Math.min(...pageRows.flatMap((r) => r.items.map((i) => i.x)));
  const maxX = Math.max(...pageRows.flatMap((r) => r.items.map((i) => i.x + i.w)));
  const BIN = 2;
  const nbins = Math.max(1, Math.ceil((maxX - minX) / BIN) + 1);
  const clampBin = (k) => Math.min(nbins - 1, Math.max(0, k));
  // coverage = how many ROWS put text over each x-bin (per-row, so one wide title
  // can't bridge a gutter that every data row leaves empty)
  const cover = new Array(nbins).fill(0);
  for (const row of pageRows) {
    const marked = new Set();
    for (const it of row.items) {
      const a = clampBin(Math.floor((it.x - minX) / BIN));
      const b = clampBin(Math.floor((it.x + it.w - minX) / BIN));
      for (let k = a; k <= b; k++) marked.add(k);
    }
    for (const k of marked) cover[k]++;
  }
  // occupancy is RELATIVE to the busiest column: a true gutter only a few long
  // (RTL) descriptions spill into still reads as empty, so qty/No stay separate.
  const maxCover = Math.max(1, ...cover);
  const thresh = Math.max(2, maxCover * 0.22);
  const occ = cover.map((c) => c >= thresh);
  const minGutter = Math.max(2, Math.round(cw / BIN)); // ~1 char of empty space = a real gutter
  const bands = [];
  let band = null, gap = 0;
  for (let k = 0; k < nbins; k++) {
    if (occ[k]) { if (!band) band = { lo: k, hi: k }; else band.hi = k; gap = 0; }
    else if (band && ++gap >= minGutter) { bands.push(band); band = null; }
  }
  if (band) bands.push(band);
  if (!bands.length) return EMPTY;
  const bandX = bands.map((b) => ({ lo: minX + b.lo * BIN, hi: minX + (b.hi + 1) * BIN }));
  const colOf = (it) => {
    const c = it.x + it.w / 2;
    for (let i = 0; i < bandX.length; i++) if (c >= bandX[i].lo && c <= bandX[i].hi) return i;
    let best = 0, dist = Infinity;
    bandX.forEach((b, i) => { const d = Math.min(Math.abs(c - b.lo), Math.abs(c - b.hi)); if (d < dist) { dist = d; best = i; } });
    return best;
  };

  const aoa = pageRows.map((row) => {
    const buckets = bandX.map(() => []);
    for (const it of row.items) buckets[colOf(it)].push(it);
    return buckets.map((toks) => {
      if (!toks.length) return '';
      const ar = toks.some((t) => isArabic(t.str));
      toks.sort((a, b) => (ar ? b.x - a.x : a.x - b.x)); // Arabic reads right-to-left
      return toks.map((t) => t.str).join(' ').replace(/\s+/g, ' ').trim();
    });
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
  if (ext === 'doc') return parseDoc(buffer);
  return parseSpreadsheet(buffer); // xlsx / xls / xlsm / csv (default)
}

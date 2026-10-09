/* Daily Bread: import your own commentaries.
   Everything here runs on the phone. Imported files are stored in this browser
   (IndexedDB) and are never uploaded anywhere. */
'use strict';

/* ---------- storage ---------- */
const CM = (() => {
  let dbp = null;
  const open = () => dbp || (dbp = new Promise((res, rej) => {
    const r = indexedDB.open('daily-bread', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('commentaries', {keyPath: 'id'});
    r.onsuccess = () => res(r.result);
    r.onerror = () => { dbp = null; rej(r.error); };
  }));
  const tx = async (mode, fn) => {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction('commentaries', mode), st = t.objectStore('commentaries');
      const out = fn(st);
      t.oncomplete = () => res(out && out.result !== undefined ? out.result : undefined);
      t.onerror = () => rej(t.error); t.onabort = () => rej(t.error || new Error('aborted'));
    });
  };
  const mem = {};
  return {
    list: () => { try { return JSON.parse(localStorage.getItem('db1.comms') || '[]'); } catch(e) { return []; } },
    setList(l){ try { localStorage.setItem('db1.comms', JSON.stringify(l)); } catch(e) {} },
    async put(c){ await tx('readwrite', st => st.put(c)); mem[c.id] = c; },
    async get(id){ if (mem[id]) return mem[id]; const c = await tx('readonly', st => st.get(id)); if (c) mem[id] = c; return c; },
    async del(id){ await tx('readwrite', st => st.delete(id)); delete mem[id]; }
  };
})();

/* ---------- book names ---------- */
const BOOK_ALIASES = (() => {
  const m = {};
  const add = (k, i) => { m[k.toLowerCase().replace(/\s+/g, ' ').trim()] = i; };
  NAMES.forEach((n, i) => {
    add(n, i);
    const r = n.replace(/^1 /, 'I ').replace(/^2 /, 'II ').replace(/^3 /, 'III ');
    add(r, i);
    add(n.replace(/^1 /, 'First ').replace(/^2 /, 'Second ').replace(/^3 /, 'Third '), i);
  });
  add('Psalm', 18); add('Song of Songs', 21); add('The Song of Songs', 21); add('Canticles', 21);
  add('The Revelation', 65); add('Revelation of John', 65); add('The Acts', 43); add('Acts of the Apostles', 43);
  return m;
})();
// "1 and 2 Samuel", "1 & 2 Kings", "Ezra and Nehemiah"
function bookHeading(line){
  const t = line.replace(/[.:]$/, '').replace(/\s+/g, ' ').trim();
  if (t.length > 40 || /\d{2}|:/.test(t)) return null;
  const low = t.toLowerCase().replace(/^the (book|gospel|letter|epistle)s? (of|according to) /, '').replace(/^the /, '');
  if (low in BOOK_ALIASES) return {b: BOOK_ALIASES[low], pair: null};
  let m = low.match(/^(1|i)\s*(?:and|&)\s*(2|ii)\s+(.+)$/);
  if (m && ('1 ' + m[3]) in BOOK_ALIASES) return {b: BOOK_ALIASES['1 ' + m[3]], pair: BOOK_ALIASES['2 ' + m[3]]};
  m = low.match(/^(.+?)\s+(?:and|&)\s+(.+)$/);
  if (m && m[1] in BOOK_ALIASES && m[2] in BOOK_ALIASES && BOOK_ALIASES[m[2]] === BOOK_ALIASES[m[1]] + 1) return {b: BOOK_ALIASES[m[1]], pair: BOOK_ALIASES[m[2]]};
  return null;
}

/* ---------- reading text out of a PDF ---------- */
async function loadPdfJs(){
  if (window.pdfjsLib) return window.pdfjsLib;
  await new Promise((res, rej) => {
    const s = document.createElement('script'); s.src = 'vendor/pdf.min.js'; s.onload = res; s.onerror = () => rej(new Error('pdf reader failed to load'));
    document.head.appendChild(s);
  });
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
  return window.pdfjsLib;
}
// Turns one page into lines of text, in reading order. Handles two-column pages.
function pageLines(items, pageWidth){
  const rows = [];
  items.filter(it => it.str && it.str.trim()).forEach(it => {
    const x = it.transform[4], y = it.transform[5], h = Math.abs(it.transform[3]) || it.height || 10;
    let row = rows.find(r => Math.abs(r.y - y) < h * 0.5);
    if (!row) { row = {y, h, items: []}; rows.push(row); }
    row.items.push({x, w: it.width || 0, s: it.str});
  });
  rows.sort((a, b) => b.y - a.y);
  const segsOf = row => {
    row.items.sort((a, b) => a.x - b.x);
    const segs = []; let cur = null;
    row.items.forEach(it => {
      if (cur && it.x - (cur.end) > pageWidth * 0.06) { segs.push(cur); cur = null; }
      if (!cur) cur = {x: it.x, end: it.x + it.w, s: it.s};
      else { const gap = it.x - cur.end; cur.s += (gap > 1 && !/\s$/.test(cur.s) && !/^\s/.test(it.s) ? ' ' : '') + it.s; cur.end = Math.max(cur.end, it.x + it.w); }
    });
    if (cur) segs.push(cur);
    return segs;
  };
  const mid = pageWidth * 0.45;
  const split = rows.map(r => ({y: r.y, h: r.h, segs: segsOf(r)}));
  const twoCol = split.filter(r => r.segs.some(s => s.x >= mid) && r.segs.some(s => s.x < mid)).length >= Math.max(4, split.length * 0.3);
  const out = [];
  const push = (r, s) => out.push({t: s.s.replace(/\s+/g, ' ').trim(), y: r.y, h: r.h});
  if (twoCol) {
    split.forEach(r => r.segs.filter(s => s.x < mid).forEach(s => push(r, s)));
    split.forEach(r => r.segs.filter(s => s.x >= mid).forEach(s => push(r, s)));
  } else {
    split.forEach(r => push(r, {s: r.segs.map(s => s.s).join(' ')}));
  }
  return out.filter(l => l.t);
}
async function pdfToPages(file, onProgress, isCancelled){
  const pdfjs = await loadPdfJs();
  const data = new Uint8Array(await file.arrayBuffer());
  const doc = await pdfjs.getDocument({data, isEvalSupported: false}).promise;
  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    if (isCancelled()) throw new Error('cancelled');
    const page = await doc.getPage(p);
    const vp = page.getViewport({scale: 1});
    const tc = await page.getTextContent();
    pages.push(pageLines(tc.items, vp.width));
    page.cleanup();
    if (p % 5 === 0 || p === doc.numPages) { onProgress(p, doc.numPages); await new Promise(r => setTimeout(r, 0)); }
  }
  await doc.destroy();
  return pages;
}
function textToPages(text){
  // Plain text: blank lines mark paragraph breaks.
  const lines = []; let gap = false;
  text.replace(/\r/g, '').split('\n').forEach(l => {
    const t = l.replace(/\s+/g, ' ').trim();
    if (!t) { gap = true; return; }
    lines.push({t, gapBefore: gap}); gap = false;
  });
  return [lines];
}

/* ---------- finding books and passages ---------- */
const REF_RE = /^(?:((?:[123]|I{1,3})\s?[A-Z][a-z]{1,13})\.?\s+)?(\d{1,3}):(\d{1,3})[a-d]?(?:\s*[–—-]\s*(?:(\d{1,3}):)?(\d{1,3})[a-d]?)?(?=[\s.,;:)]|$)\s*[.:]?\s*(.*)$/;
const CHAP_RE = /^(?:chapter|ch\.)\s+(\d{1,3})\b\s*[.:–—-]?\s*(.*)$/i;

function cleanPages(pages){
  // Drop page numbers, running heads and other lines repeated on most pages.
  const freq = {};
  pages.forEach(ls => ls.forEach(l => { if (l.t.length < 60) freq[l.t] = (freq[l.t] || 0) + 1; }));
  const tooCommon = t => (freq[t] || 0) > Math.max(25, pages.length * 0.15);
  const isRunHead = t => /^\d{1,4}$/.test(t) || (!bookHeading(t) && t.length < 45 && /\d/.test(t) && /^[A-Z0-9 &]+(\s+\d+(:\d+)?([–—-]\d+(:\d+)?)?)?\s*\d*$/.test(t) && /[A-Z]{3}/.test(t));
  const all = [];
  pages.forEach(ls => {
    const keep = ls.slice();
    for (let k = 0; k < 2 && keep.length && isRunHead(keep[0].t); k++) keep.shift();
    while (keep.length && /^\d{1,4}$/.test(keep[keep.length - 1].t)) keep.pop();
    keep.forEach((l, i) => {
      if (tooCommon(l.t)) return;
      const prev = keep[i - 1];
      all.push({t: l.t, gapBefore: l.gapBefore || i === 0 || (prev && prev.h && (prev.y - l.y) > prev.h * 1.75), pageStart: i === 0});
    });
  });
  return all;
}
function toParas(lines){
  if (!lines.length) return [];
  const lens = lines.map(l => l.t.length).sort((a, b) => a - b);
  const typical = lens[Math.floor(lens.length * 0.75)] || 60;
  const paras = []; let cur = '';
  lines.forEach((l, i) => {
    const prev = lines[i - 1];
    const brk = i > 0 && (l.gapBefore && !l.pageStart || (prev.t.length < typical * 0.7 && /[.?!:”’")]$/.test(prev.t)));
    if (brk && cur) { paras.push(cur); cur = ''; }
    if (!cur) cur = l.t;
    else if (/[A-Za-z]-$/.test(cur) && /^[a-z]/.test(l.t)) cur = cur.slice(0, -1) + l.t;
    else cur += ' ' + l.t;
  });
  if (cur) paras.push(cur);
  return paras;
}
function parseCommentary(pages){
  const lines = cleanPages(pages);
  // 1. Book headings. Skip contents lists (names on consecutive lines), prefer
  //    headings in capitals, then keep the longest run of books in Bible order.
  let cands = [];
  lines.forEach((l, i) => { const h = bookHeading(l.t); if (h) cands.push({i, ...h, caps: l.t === l.t.toUpperCase()}); });
  { // drop runs of 3+ book names close together (a contents list)
    const drop = new Set(); let run = [0];
    for (let k = 1; k <= cands.length; k++) {
      if (k < cands.length && cands[k].i - cands[k - 1].i <= 3) { run.push(k); continue; }
      if (run.length >= 3) run.forEach(x => drop.add(x));
      run = [k];
    }
    cands = cands.filter((c, k) => !drop.has(k));
  }
  if (cands.filter(c => c.caps).length >= cands.length / 2) cands = cands.filter(c => c.caps);
  const top = c => c.pair !== null ? c.pair : c.b;
  const best = cands.map(() => 1), from = cands.map(() => -1);
  cands.forEach((c, k) => { for (let j = 0; j < k; j++) if (top(cands[j]) < c.b && best[j] + 1 > best[k]) { best[k] = best[j] + 1; from[k] = j; } });
  const starts = [];
  if (cands.length) {
    let k = best.indexOf(Math.max(...best));
    // among equally long chains prefer the one ending latest (real headings come after front matter)
    best.forEach((v, j) => { if (v === best[k] && j > k) k = j; });
    while (k >= 0) { starts.unshift(cands[k]); k = from[k]; }
    // Each book starts at its FIRST heading after the previous book; later ones are page headers.
    let after = -1;
    starts.forEach((st, n) => {
      const first = cands.find(c => c.b === st.b && c.i > after);
      if (first) starts[n] = first;
      after = starts[n].i;
    });
  }
  const books = {};
  let nSections = 0;
  starts.forEach((s, si) => {
    const stop = si + 1 < starts.length ? starts[si + 1].i : lines.length;
    const body = lines.slice(s.i + 1, stop);
    let book = s.b; const pair = s.pair;
    const secs = []; let intro = []; let cur = null; let last = [0, 0]; let outlineFrom = 0;
    const maxCh = b => NAMES[b] ? (b === 18 ? 150 : INDEX_CHAPTERS[b]) : 0;
    body.forEach((l, i) => {
      if (l.pageStart) { const h = bookHeading(l.t); if (h && (h.b === s.b || h.b === s.pair)) return; } // running header
      const prev = body[i - 1];
      const prevEnds = !prev || l.gapBefore || /[.?!:”’")\]]$/.test(prev.t) || prev.t.length < 45;
      let m = l.t.length <= 90 && prevEnds ? l.t.match(REF_RE) : null;
      let mark = null;
      if (m) {
        const title = (m[6] || '').trim();
        if (!title || /^[A-Z“"‘'(]/.test(title)) {
          let b = book;
          if (m[1] && pair !== null) { const pre = m[1].trim().replace(/^I{1,3}/, r => String(r.length)); if (/^2/.test(pre)) b = pair; else if (/^1/.test(pre)) b = s.b; }
          const c1 = +m[2], v1 = +m[3], c2 = m[4] ? +m[4] : (m[5] ? c1 : null), v2 = m[5] ? +m[5] : null;
          let back = b === book && (c1 < last[0] || (c1 === last[0] && v1 < last[1]));
          // Many commentaries open each book with an outline that lists every section.
          // If the headings jump back to the start and the sections so far hold almost
          // no text, they were that outline: keep it with the introduction and start again.
          const sinceReset = secs.slice(outlineFrom);
          if (back && sinceReset.length >= 3 && sinceReset.reduce((n, x) => n + x.lines.length, 0) <= sinceReset.length * 2) {
            intro.push({t: 'Outline', gapBefore: true});
            sinceReset.forEach(x => intro.push({t: x.label + (x.title ? ' ' + x.title : '') + (x.lines.length ? ' ' + x.lines.map(y => y.t).join(' ') : ''), gapBefore: true}));
            secs.length = outlineFrom; cur = null; last = [0, 0]; book = s.b;
            if (!(m[1] && pair !== null && /^(2|II)/.test(m[1].trim()))) b = s.b;
            back = false;
          }
          if (back && pair !== null && b === book && c1 === 1) { b = pair; back = false; } // second book restarts at chapter 1
          const sameBookBack = back;
          if (c1 >= 1 && c1 <= maxCh(b) && (!c2 || (c2 >= c1 && c2 <= maxCh(b))) && !sameBookBack) mark = {b, c1, v1, c2, v2, title, label: l.t.slice(0, l.t.length - title.length).trim()};
        }
      } else if ((m = l.t.length <= 60 && prevEnds ? l.t.match(CHAP_RE) : null)) {
        const c1 = +m[1];
        if (c1 >= 1 && c1 <= maxCh(book) && c1 >= last[0]) mark = {b: book, c1, v1: 1, c2: c1, v2: 999, title: (m[2] || '').trim(), chapterOnly: true};
      }
      if (mark) {
        if (mark.b !== book) outlineFrom = secs.length;
        book = mark.b; last = [mark.c1, mark.v1];
        cur = {...mark, lines: []}; secs.push(cur);
        return;
      }
      (cur ? cur.lines : intro).push(l);
    });
    // Finish sections: fill in open-ended ranges, turn lines into paragraphs.
    secs.forEach((x, k) => {
      if (x.c2 == null) {
        const nx = secs.slice(k + 1).find(y => y.b === x.b && (y.c1 > x.c1 || y.v1 > x.v1));
        if (nx && nx.c1 === x.c1) { x.c2 = x.c1; x.v2 = Math.max(x.v1, nx.v1 - 1); }
        else { x.c2 = x.c1; x.v2 = 999; }
      }
      // A heading's title is often on the line after the reference.
      const f = x.lines[0];
      if (!x.title && f && f.t.length < 70 && !/[.,;]$/.test(f.t) && /^[A-Z“"‘']/.test(f.t) && !REF_RE.test(f.t)) { x.title = f.t; x.lines.shift(); if (x.lines[0]) x.lines[0].gapBefore = true; }
      x.paras = toParas(x.lines); delete x.lines;
    });
    // Tidy up: drop empty headings left over from outlines. Keep an empty heading only
    // when it introduces a group (the next section starts at the same verse).
    const key = x => x.b + '.' + x.c1 + '.' + x.v1 + '.' + x.c2 + '.' + x.v2;
    const full = new Set(secs.filter(x => x.paras.length).map(key));
    const kept = secs.filter((x, k) => {
      if (x.paras.length) return true;
      if (full.has(key(x))) return false;
      const nx = secs[k + 1];
      return nx && nx.b === x.b && nx.c1 === x.c1 && nx.v1 === x.v1 && nx.paras.length && !(nx.c2 === x.c2 && nx.v2 === x.v2);
    });
    // and keep only the first copy of any heading that appears twice
    const seen = new Set();
    secs.length = 0;
    kept.forEach(x => { const k = key(x) + '|' + x.paras.length; if (!seen.has(k)) { seen.add(k); secs.push(x); } });
    const groups = {};
    secs.forEach(x => { (groups[x.b] = groups[x.b] || []).push([x.c1, x.v1, x.c2, x.v2 || 999, x.title, x.paras]); });
    if (!groups[s.b]) groups[s.b] = [];
    Object.keys(groups).forEach((b, gi) => {
      books[b] = {intro: gi === 0 ? toParas(intro) : [], secs: groups[b]};
      nSections += groups[b].length;
    });
  });
  return {books, nBooks: Object.keys(books).length, nSections};
}
const INDEX_CHAPTERS = (() => {
  // highest chapter number per book, from the reading plan's full coverage
  const max = new Array(66).fill(0);
  const known = [50,40,27,36,34,24,21,4,31,24,22,25,29,36,10,13,10,42,150,31,12,8,66,52,5,48,12,14,3,9,1,4,7,3,3,3,2,14,4,28,16,24,21,28,16,16,13,6,6,4,4,5,3,6,4,3,1,13,5,5,3,5,1,1,1,22];
  return known.map((k, i) => Math.max(k, max[i]));
})();

/* ---------- showing an imported commentary ---------- */
const cmpRef = (c, v) => c * 1000 + Math.min(v, 999);
async function renderImported(id, r, book){
  const c = await CM.get(id);
  if (!c) return '<p class="note">This commentary is no longer on this phone. Choose another one above.</p>';
  const bk = c.books[r.b];
  const segs = r.text, first = segs[0], lastSeg = segs[segs.length - 1];
  const rs = cmpRef(first.c, first.v), re = cmpRef(lastSeg.c, lastSeg.v + lastSeg.t.length - 1);
  const label = x => (r.b === 18 ? 'Psalm ' : '') + (x[0] === x[2] ? x[0] + ':' + x[1] + (x[3] < 999 && x[3] !== x[1] ? '–' + x[3] : '') : x[0] + ':' + x[1] + '–' + x[2] + (x[3] < 999 ? ':' + x[3] : ''));
  if (!bk || (!bk.secs.length && !bk.intro.length)) return '<p class="note">' + esc(c.name) + ' has no notes on ' + esc(NAMES[r.b]) + ' that I could find.</p>';
  let html = '';
  if (first.c === 1 && first.v === 1 && bk.intro.length) {
    html += '<details class="intro"><summary>Introduction to ' + esc(NAMES[r.b]) + '</summary>' + bk.intro.map(p => '<p>' + esc(p) + '</p>').join('') + '</details>';
  }
  const shown = bk.secs.filter(x => {
    const s = cmpRef(x[0], x[1]), e = cmpRef(x[2], x[3]);
    if (e < rs || s > re) return false;
    return (x[2] - x[0] <= 3) || (s >= rs && s <= re);
  });
  if (!shown.length) return html + '<p class="note">' + esc(c.name) + ' has no section that starts in ' + esc(r.ref) + '. Its notes on this passage may sit under a wider section in an earlier chapter.</p>';
  shown.forEach(x => {
    html += '<b>' + esc(label(x)) + (x[4] ? ' ' + esc(x[4]) : '') + '</b>' + x[5].map(p => '<p>' + esc(p) + '</p>').join('');
  });
  return html;
}

/* ---------- More tab: import and manage ---------- */
let importing = null;
function renderCommentaryList(){
  const box = document.getElementById('cmList'); if (!box) return;
  const list = CM.list();
  box.innerHTML = list.length ? '' : '<p class="small">None yet.</p>';
  list.forEach(c => {
    const row = document.createElement('div'); row.className = 'cmrow';
    row.innerHTML = '<div><b></b><span class="small"></span></div><button class="secondary">Remove</button>';
    row.querySelector('b').textContent = c.name;
    row.querySelector('span').textContent = c.nBooks + ' books · ' + c.nSections + ' sections · added ' + fmt(new Date(c.at), {day: 'numeric', month: 'short', year: 'numeric'});
    const btn = row.querySelector('button');
    btn.onclick = async () => {
      if (btn.dataset.sure !== '1') { btn.dataset.sure = '1'; btn.textContent = 'Tap again to remove'; return; }
      await CM.del(c.id).catch(() => {});
      CM.setList(CM.list().filter(x => x.id !== c.id));
      if (LS.get('comm', 'mhcc') === c.id) LS.set('comm', 'mhcc');
      renderCommentaryList();
    };
    box.appendChild(row);
  });
}
async function runImport(file){
  const msg = document.getElementById('cmMsg'), bar = document.getElementById('cmBar'), barI = bar.querySelector('i');
  const cancelBtn = document.getElementById('cmCancel'), pickBtn = document.getElementById('cmPick');
  const name = (document.getElementById('cmName').value.trim() || file.name.replace(/\.[^.]+$/, '')).slice(0, 80);
  importing = {cancelled: false};
  const job = importing;
  let wake = null;
  try { wake = await navigator.wakeLock.request('screen'); } catch(e) {}
  bar.hidden = false; cancelBtn.hidden = false; pickBtn.setAttribute('aria-disabled', 'true'); pickBtn.style.pointerEvents = 'none'; msg.className = 'small';
  const t0 = Date.now();
  try {
    let pages;
    if (/\.pdf$/i.test(file.name) || file.type === 'application/pdf') {
      msg.textContent = 'Opening ' + file.name + '…';
      pages = await pdfToPages(file, (p, n) => {
        barI.style.width = (p / n * 90).toFixed(1) + '%';
        const left = Math.round((Date.now() - t0) / p * (n - p) / 1000);
        msg.textContent = 'Reading page ' + p + ' of ' + n + (p > 20 ? ' · about ' + (left > 90 ? Math.round(left / 60) + ' min' : left + ' sec') + ' left' : '') + '. Keep this screen open.';
      }, () => job.cancelled);
    } else {
      msg.textContent = 'Reading ' + file.name + '…';
      pages = textToPages(await file.text());
    }
    msg.textContent = 'Finding books and passages…'; barI.style.width = '95%';
    await new Promise(r => setTimeout(r, 30));
    const parsed = parseCommentary(pages);
    if (!parsed.nBooks) throw new Error('nobooks');
    const id = 'c' + Date.now().toString(36);
    await CM.put({id, name, books: parsed.books});
    CM.setList(CM.list().concat([{id, name, nBooks: parsed.nBooks, nSections: parsed.nSections, at: Date.now()}]));
    barI.style.width = '100%';
    const found = Object.keys(parsed.books).map(Number).sort((a, b) => a - b);
    const sample = found.slice(0, 3).map(b => NAMES[b] + ' (' + parsed.books[b].secs.length + ')').join(', ');
    msg.textContent = 'Added "' + name + '": ' + parsed.nBooks + ' books, ' + parsed.nSections + ' sections, for example ' + sample + '. Open any reading and choose it in the Commentary tab.';
    LS.set('comm', id);
    document.getElementById('cmName').value = '';
    renderCommentaryList();
  } catch(e) {
    msg.className = 'small bad';
    msg.textContent = e.message === 'cancelled' ? 'Import cancelled.'
      : e.message === 'nobooks' ? 'I could not find any Bible book headings (like GENESIS or 1 SAMUEL) in this file, so nothing was added.'
      : (e.name === 'QuotaExceededError' ? 'This phone does not have enough free space to store the commentary.' : 'The import did not work: ' + (e.message || 'unknown error') + '. If the PDF is a scan (pictures of pages), it has no text to read.');
  } finally {
    importing = null; cancelBtn.hidden = true; pickBtn.removeAttribute('aria-disabled'); pickBtn.style.pointerEvents = '';
    setTimeout(() => { bar.hidden = true; barI.style.width = '0'; }, 1500);
    if (wake) wake.release().catch(() => {});
  }
}
document.getElementById('cmFile').onchange = e => { const f = e.target.files && e.target.files[0]; e.target.value = ''; if (f) runImport(f); };
document.getElementById('cmCancel').onclick = () => { if (importing) importing.cancelled = true; };
renderCommentaryList();

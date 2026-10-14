// Local "chat with your files": parse -> chunk -> embed -> retrieve.
import { db, uid } from './db.js';

const PDFJS_WORKER = new URL('./pdf.worker.min.mjs', document.baseURI).href;

export const ACCEPT = '.pdf,.txt,.md,.markdown,.csv,.tsv,.json,.html,.htm,.docx,.log,.xml,.js,.ts,.py,.rs,.java,.c,.cpp,.css,.sql,.yaml,.yml';

// ---------- parsing ----------
// returns [{ page: number|null, text }]
export async function parseFile(file, onProgress) {
  const name = file.name.toLowerCase();
  if (name.endsWith('.pdf')) return parsePdf(file, onProgress);
  if (name.endsWith('.docx')) return parseDocx(file);
  let text = await file.text();
  if (/\.html?$/.test(name)) {
    const doc = new DOMParser().parseFromString(text, 'text/html');
    doc.querySelectorAll('script,style,noscript').forEach((n) => n.remove());
    text = doc.body?.innerText || doc.body?.textContent || '';
  }
  return [{ page: null, text }];
}

async function parsePdf(file, onProgress) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
  const task = pdfjs.getDocument({ data: await file.arrayBuffer() });
  const pdf = await task.promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const tc = await page.getTextContent();
    let line = '', out = '', lastY = null;
    for (const it of tc.items) {
      if (!('str' in it)) continue;
      const y = it.transform?.[5];
      if (lastY !== null && Math.abs(y - lastY) > 2) { out += line.trimEnd() + '\n'; line = ''; }
      line += it.str + (it.hasEOL ? '\n' : '');
      lastY = y;
    }
    out += line;
    pages.push({ page: i, text: out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n') });
    onProgress?.(i / pdf.numPages);
  }
  await (task.destroy?.() ?? pdf.destroy?.());
  return pages;
}

async function parseDocx(file) {
  const { unzipSync, strFromU8 } = await import('fflate');
  const files = unzipSync(new Uint8Array(await file.arrayBuffer()), { filter: (f) => f.name === 'word/document.xml' });
  const xml = strFromU8(files['word/document.xml'] || new Uint8Array());
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const paras = [...doc.getElementsByTagNameNS(W, 'p')].map((p) =>
    [...p.getElementsByTagNameNS(W, 't')].map((t) => t.textContent).join(''));
  return [{ page: null, text: paras.join('\n') }];
}

// ---------- chunking ----------
const CHUNK = 900, OVERLAP = 150;

export function chunkPages(pages) {
  const chunks = [];
  for (const { page, text } of pages) {
    const clean = text.replace(/\r/g, '').trim();
    if (!clean) continue;
    // split on paragraph boundaries, then pack into ~CHUNK chars with overlap
    const paras = clean.split(/\n\s*\n/).flatMap((p) => p.length > CHUNK ? splitLong(p) : [p]);
    let cur = '';
    for (const p of paras) {
      if (cur && cur.length + p.length + 2 > CHUNK) {
        chunks.push({ page, text: cur.trim() });
        cur = cur.slice(-OVERLAP).replace(/^\S*\s/, '') + '\n\n' + p;
      } else cur = cur ? cur + '\n\n' + p : p;
    }
    if (cur.trim()) chunks.push({ page, text: cur.trim() });
  }
  return chunks;
}

function splitLong(p) {
  const sents = p.match(/[^.!?؟。\n]+[.!?؟。]*\s*/g) || [p];
  const out = [];
  let cur = '';
  for (const s of sents) {
    if (cur.length + s.length > CHUNK && cur) { out.push(cur); cur = ''; }
    if (s.length > CHUNK) { for (let i = 0; i < s.length; i += CHUNK - OVERLAP) out.push(s.slice(i, i + CHUNK)); continue; }
    cur += s;
  }
  if (cur) out.push(cur);
  return out;
}

// ---------- ingest ----------
export async function ingestFile(file, embedder, onStage) {
  onStage?.('read', 0);
  const pages = await parseFile(file, (p) => onStage?.('read', p));
  const chunks = chunkPages(pages);
  if (!chunks.length) throw new Error('NO_TEXT');
  const docId = uid();
  const fullText = pages.map((p) => p.text).join('\n\n');
  const records = [];
  for (let i = 0; i < chunks.length; i++) {
    const [vec] = await embedder.embed([chunks[i].text], 'passage');
    records.push({ id: `${docId}:${i}`, docId, i, page: chunks[i].page, text: chunks[i].text, vec });
    onStage?.('embed', (i + 1) / chunks.length);
  }
  await db.putMany('chunks', records);
  const doc = {
    id: docId, name: file.name, size: file.size, type: file.type, added: Date.now(),
    pages: pages.length, chunks: chunks.length, chars: fullText.length,
    embedModel: embedder.model.key,
    // keep full text for short documents so "summarize this" can use the whole thing
    fullText: fullText.length <= 14000 ? fullText : null,
  };
  await db.put('docs', doc);
  return doc;
}

// Re-embed an existing document with the current embedding model.
export async function reindexDoc(doc, embedder, onProgress) {
  const chunks = await db.byIndex('chunks', 'docId', doc.id);
  for (let i = 0; i < chunks.length; i++) {
    [chunks[i].vec] = await embedder.embed([chunks[i].text], 'passage');
    onProgress?.((i + 1) / chunks.length);
  }
  await db.putMany('chunks', chunks);
  doc.embedModel = embedder.model.key;
  await db.put('docs', doc);
}

export async function deleteDoc(id) {
  await db.delByIndex('chunks', 'docId', id);
  await db.del('docs', id);
}

// ---------- retrieval ----------
const tokenize = (s) => s.toLowerCase().normalize('NFKC').match(/[\p{L}\p{N}]{2,}/gu) || [];

// Hybrid: cosine similarity + light keyword overlap, with per-doc diversity.
export async function retrieve(query, docs, embedder, { k = 5, budgetChars = 6000 } = {}) {
  if (!docs.length) return [];
  // Short docs: include whole text (best for "summarize this file")
  const total = docs.reduce((n, d) => n + (d.fullText ? d.fullText.length : Infinity), 0);
  if (total <= budgetChars) {
    return docs.map((d) => ({ docId: d.id, docName: d.name, page: null, text: d.fullText, score: 1, whole: true }));
  }
  const [q] = await embedder.embed([query], 'query');
  const qt = new Set(tokenize(query));
  const scored = [];
  for (const d of docs) {
    const chunks = await db.byIndex('chunks', 'docId', d.id);
    for (const c of chunks) {
      let dot = 0;
      const v = c.vec;
      for (let i = 0; i < v.length; i++) dot += v[i] * q[i];
      let kw = 0;
      if (qt.size) {
        const ct = new Set(tokenize(c.text));
        for (const t of qt) if (ct.has(t)) kw++;
        kw /= qt.size;
      }
      scored.push({ docId: d.id, docName: d.name, page: c.page, i: c.i, text: c.text, score: dot + 0.15 * kw });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  const picked = [];
  let used = 0;
  for (const s of scored) {
    if (picked.length >= k) break;
    // skip near-duplicate neighbours from the overlap
    if (picked.some((p) => p.docId === s.docId && Math.abs(p.i - s.i) < 1)) continue;
    if (used + s.text.length > budgetChars && picked.length) continue;
    picked.push(s);
    used += s.text.length;
  }
  return picked;
}

export function buildContext(sources, lang) {
  if (!sources.length) return '';
  const blocks = sources.map((s, i) => {
    const where = s.page ? `${s.docName}, p.${s.page}` : s.docName;
    return `[${i + 1}] (${where})\n${s.text}`;
  }).join('\n\n');
  return `Use the following excerpts from the user's files to answer. Cite the excerpts you use with their number in square brackets, like [1] or [2]. If the answer is not in the excerpts, say so plainly instead of guessing.${lang ? ` Answer in the same language as the user's question.` : ''}\n\n<sources>\n${blocks}\n</sources>`;
}

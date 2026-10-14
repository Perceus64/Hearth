import { marked } from 'marked';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/common';
import { db, uid } from './db.js';
import { detectHardware, fitFor } from './hw.js';
import { GPU_MODELS, CPU_MODELS, EMBED_MODELS, resolveGpuModel, fmtBytes } from './models.js';
import { GpuEngine, CpuEngine, Embedder, cache, webllm } from './engines.js';
import { ACCEPT, ingestFile, retrieve, buildContext, deleteDoc, reindexDoc } from './rag.js';
import { t, setLang, applyI18n, PRESETS, presetPrompt } from './i18n.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------------- settings ----------------
const DEFAULTS = {
  lang: (navigator.language || 'en').slice(0, 2).replace(/^(?!ar|fr).*/, 'en'),
  theme: 'system', preset: 'general', temperature: 0.7, top_p: 0.9, max_tokens: 768, ctx: 4096,
  thinking: false, embedKey: 'e5-small', topK: 5, cpuOnly: false, autoLoad: true,
  lastModel: null, engineTab: null,
};
const S = { ...DEFAULTS, ...safeJSON(localStorage.getItem('hearth.settings')) };
const saveSettings = () => localStorage.setItem('hearth.settings', JSON.stringify(S));
function safeJSON(s) { try { return JSON.parse(s) || {}; } catch { return {}; } }

// ---------------- state ----------------
const state = {
  hw: null,
  gpuList: [],          // resolved GPU models
  engine: null,         // active engine instance
  model: null,          // active model descriptor
  loading: false,
  convs: [],
  conv: null,
  docs: [],
  generating: null,     // AbortController
  ingesting: new Map(), // docTempId -> {name, stage, p}
};
const gpu = new GpuEngine();
const cpu = new CpuEngine();
const embedder = new Embedder();

// ---------------- markdown ----------------
marked.setOptions({ gfm: true, breaks: false });
const renderer = new marked.Renderer();
renderer.code = ({ text, lang }) => {
  const l = (lang || '').split(/\s/)[0];
  let html;
  try { html = l && hljs.getLanguage(l) ? hljs.highlight(text, { language: l }).value : hljs.highlightAuto(text).value; }
  catch { html = esc(text); }
  return `<pre class="${l ? 'has-lang' : ''}">${l ? `<span class="lang">${esc(l)}</span>` : ''}<button class="copy-code" type="button">${t('chat.copy')}</button><code class="hljs">${html}</code></pre>`;
};
function md(text) {
  const html = DOMPurify.sanitize(marked.parse(text, { renderer }), { ADD_ATTR: ['target'] });
  const div = document.createElement('div');
  div.innerHTML = html;
  div.querySelectorAll('a').forEach((a) => { a.target = '_blank'; a.rel = 'noopener noreferrer'; });
  return div;
}
// Turn [1], [2] into citation buttons (outside code)
function linkCitations(root, count) {
  if (!count) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => n.parentElement.closest('code,pre,a') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  const nodes = [];
  while (walker.nextNode()) if (/\[\d{1,2}(?:\s*,\s*\d{1,2})*\]/.test(walker.currentNode.nodeValue)) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const frag = document.createDocumentFragment();
    const parts = node.nodeValue.split(/(\[\d{1,2}(?:\s*,\s*\d{1,2})*\])/);
    for (const p of parts) {
      const m = p.match(/^\[([\d,\s]+)\]$/);
      if (m) {
        for (const n of m[1].split(',').map((x) => parseInt(x, 10))) {
          if (n >= 1 && n <= count) {
            const b = document.createElement('button');
            b.className = 'cite'; b.type = 'button'; b.dataset.n = n; b.textContent = n;
            frag.append(b);
          } else frag.append(`[${n}]`);
        }
      } else if (p) frag.append(p);
    }
    node.replaceWith(frag);
  }
}

// Split <think>…</think> reasoning from the answer
function splitThinking(text) {
  const open = text.indexOf('<think>');
  if (open === -1) return { think: null, answer: text };
  const close = text.indexOf('</think>', open);
  if (close === -1) return { think: text.slice(open + 7), answer: text.slice(0, open), thinking: true };
  return { think: text.slice(open + 7, close).trim(), answer: (text.slice(0, open) + text.slice(close + 8)).trim() };
}

// ---------------- UI: toast ----------------
let toastTimer;
function toast(msg, err = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('err', err);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), err ? 6000 : 2600);
}

// ---------------- conversations ----------------
function newConv() {
  return { id: uid(), title: '', created: Date.now(), updated: Date.now(), messages: [], docIds: [], preset: S.preset, system: presetPrompt(S.preset) };
}
async function loadConvs() {
  state.convs = (await db.all('convs')).sort((a, b) => b.updated - a.updated);
}
async function saveConv(c = state.conv) {
  if (!c || !c.messages.length) return;
  c.updated = Date.now();
  await db.put('convs', c);
  if (!state.convs.includes(c)) state.convs.unshift(c);
  state.convs.sort((a, b) => b.updated - a.updated);
  renderConvList();
}
function openConv(c) {
  if (state.generating) stopGen();
  state.conv = c;
  renderConvList();
  renderMessages();
  renderActiveDocs();
  renderDocList();
  syncConvSettings();
  closeSidebarMobile();
}
function startNewChat() {
  // reuse an existing empty chat
  if (state.conv && !state.conv.messages.length) { state.conv.system = presetPrompt(S.preset); state.conv.preset = S.preset; openConv(state.conv); }
  else openConv(newConv());
  $('#input').focus();
}

function renderConvList() {
  const q = $('#convSearch').value.trim().toLowerCase();
  const list = $('#convList');
  list.innerHTML = '';
  const now = Date.now(), day = 864e5;
  let lastGroup = '';
  for (const c of state.convs) {
    if (q && !(c.title.toLowerCase().includes(q) || c.messages.some((m) => m.content.toLowerCase().includes(q)))) continue;
    const age = now - c.updated;
    const g = age < day ? t('chat.today') : age < 7 * day ? t('chat.week') : t('chat.older');
    if (g !== lastGroup) { list.insertAdjacentHTML('beforeend', `<div class="conv-group">${esc(g)}</div>`); lastGroup = g; }
    const el = document.createElement('div');
    el.className = 'conv' + (state.conv?.id === c.id ? ' active' : '');
    el.innerHTML = `<span class="t">${esc(c.title || t('chat.untitled'))}</span>${c.docIds?.length ? `<span class="doc-mark" title="${esc(t('files.title'))}">◆</span>` : ''}
      <span class="acts">
        <button data-a="rename" title="${esc(t('chat.rename'))}"><svg viewBox="0 0 24 24" class="ic sm"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg></button>
        <button data-a="md" title="${esc(t('chat.export_md'))}"><svg viewBox="0 0 24 24" class="ic sm"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg></button>
        <button data-a="del" title="${esc(t('chat.delete'))}"><svg viewBox="0 0 24 24" class="ic sm"><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/></svg></button>
      </span>`;
    el.addEventListener('click', async (e) => {
      const a = e.target.closest('button')?.dataset.a;
      if (a === 'rename') {
        const n = prompt(t('chat.rename'), c.title);
        if (n !== null) { c.title = n.trim() || c.title; await db.put('convs', c); renderConvList(); }
      } else if (a === 'del') {
        if (!confirm(t('chat.delete_confirm'))) return;
        await db.del('convs', c.id);
        state.convs = state.convs.filter((x) => x !== c);
        if (state.conv?.id === c.id) openConv(state.convs[0] || newConv()); else renderConvList();
      } else if (a === 'md') download(`${slug(c.title)}.md`, convToMarkdown(c), 'text/markdown');
      else openConv(c);
    });
    list.append(el);
  }
  if (!list.children.length) list.innerHTML = `<div class="doc-empty" style="padding:10px">${esc(t(q ? 'chat.no_match' : 'chat.none'))}</div>`;
}

const slug = (s) => (s || 'chat').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 60) || 'chat';
function convToMarkdown(c) {
  let out = `# ${c.title || t('chat.untitled')}\n\n`;
  for (const m of c.messages) {
    out += `**${m.role === 'user' ? t('chat.you') : (m.model || 'Assistant')}:**\n\n${splitThinking(m.content).answer}\n\n`;
    if (m.sources?.length) out += m.sources.map((s, i) => `> [${i + 1}] ${s.docName}${s.page ? `, p.${s.page}` : ''}`).join('\n') + '\n\n';
  }
  return out;
}
function download(name, data, type) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------------- messages ----------------
function renderMessages() {
  const box = $('#messages');
  box.innerHTML = '';
  const c = state.conv;
  if (!c.messages.length) { box.append(emptyState()); return; }
  c.messages.forEach((m, i) => box.append(renderMsg(m, i)));
  box.scrollTop = box.scrollHeight;
}

function emptyState() {
  const el = document.createElement('div');
  el.className = 'empty';
  const flame = $('.logo').outerHTML.replace('class="logo"', 'class="flame"');
  const sugg = t('empty.suggestions');
  el.innerHTML = `${flame}
    <h1>${esc(t('empty.title'))}</h1>
    <p class="lead">${esc(t('empty.lead'))}</p>
    ${state.model ? '' : `<div class="cta"><button class="btn primary" id="ctaModel">${esc(t('empty.cta'))}</button></div>`}
    <div class="pillars">
      <div class="pillar"><b>${esc(t('empty.p1t'))}</b>${esc(t('empty.p1'))}</div>
      <div class="pillar"><b>${esc(t('empty.p2t'))}</b>${esc(t('empty.p2'))}</div>
      <div class="pillar"><b>${esc(t('empty.p3t'))}</b>${esc(t('empty.p3'))}</div>
    </div>
    <div class="suggest">${sugg.map((s) => `<button type="button">${esc(s)}</button>`).join('')}</div>`;
  el.querySelector('#ctaModel')?.addEventListener('click', openModels);
  el.querySelectorAll('.suggest button').forEach((b) => b.addEventListener('click', () => { $('#input').value = b.textContent; autosize(); $('#input').focus(); updateSend(); }));
  return el;
}

const ICON = {
  copy: '<svg viewBox="0 0 24 24" class="ic sm"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>',
  regen: '<svg viewBox="0 0 24 24" class="ic sm"><path d="M4 12a8 8 0 0 1 14-5.3L20 9M20 4v5h-5M20 12a8 8 0 0 1-14 5.3L4 15M4 20v-5h5"/></svg>',
  edit: '<svg viewBox="0 0 24 24" class="ic sm"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg>',
};

function renderMsg(m, i) {
  const el = document.createElement('div');
  el.className = `msg ${m.role}`;
  el.dataset.i = i;
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.dir = 'auto';
  el.append(bubble);
  if (m.role === 'user') {
    bubble.textContent = m.content;
    if (m.docs?.length) bubble.insertAdjacentHTML('beforeend', `<div style="font-size:12px;opacity:.7;margin-top:4px">◆ ${esc(m.docs.join(', '))}</div>`);
  } else fillAssistant(bubble, m, false);
  const meta = document.createElement('div');
  meta.className = 'meta';
  if (m.role === 'user') {
    meta.innerHTML = `<button data-a="copy" title="${esc(t('chat.copy'))}">${ICON.copy}</button><button data-a="edit" title="${esc(t('chat.edit'))}">${ICON.edit}</button>`;
  } else {
    const last = i === state.conv.messages.length - 1;
    const st = m.stats ? `<span class="st">${m.model ? esc(m.model) + ' · ' : ''}${m.stats.tps.toFixed(1)} tok/s · ${m.stats.tokens} tok</span>` : '';
    meta.innerHTML = `<button data-a="copy" title="${esc(t('chat.copy'))}">${ICON.copy}</button>${last ? `<button data-a="regen" title="${esc(t('chat.regen'))}">${ICON.regen}</button>` : ''}${st}`;
  }
  meta.addEventListener('click', (e) => {
    const a = e.target.closest('button')?.dataset.a;
    if (a === 'copy') { navigator.clipboard.writeText(m.role === 'user' ? m.content : splitThinking(m.content).answer); toast(t('chat.copied')); }
    if (a === 'regen') regenerate();
    if (a === 'edit') editFrom(i);
  });
  el.append(meta);
  return el;
}

function fillAssistant(bubble, m, streaming) {
  bubble.innerHTML = '';
  if (m.error) { bubble.innerHTML = `<div class="err">${esc(m.error)}</div>`; return; }
  if (m.status && !m.content) { bubble.innerHTML = `<div class="status-line"><div class="spinner"></div>${esc(m.status)}</div>`; return; }
  const { think, answer, thinking } = splitThinking(m.content || '');
  if (think !== null && think !== undefined) {
    const d = document.createElement('details');
    d.className = 'think';
    d.open = !!thinking;
    d.innerHTML = `<summary>${esc(thinking ? t('chat.reasoning_live') : t('chat.reasoning'))}</summary><div class="think-body"></div>`;
    d.querySelector('.think-body').textContent = think;
    bubble.append(d);
  }
  const body = md(answer || '');
  body.classList.add('md');
  if (streaming && !thinking) body.classList.add('caret');
  linkCitations(body, m.sources?.length || 0);
  bubble.append(body);
  if (!streaming && m.sources?.length) {
    const box = document.createElement('div');
    box.className = 'sources';
    m.sources.forEach((s, i) => {
      const b = document.createElement('button');
      b.className = 'source-chip';
      b.type = 'button';
      b.dataset.n = i + 1;
      b.innerHTML = `<b>${i + 1}</b><span>${esc(s.docName)}${s.page ? ` · p.${s.page}` : ''}${s.whole ? ` · ${esc(t('files.whole'))}` : ''}</span>`;
      box.append(b);
    });
    bubble.append(box);
  }
  bubble.onclick = (e) => {
    const c = e.target.closest('.cite, .source-chip');
    if (c) return showSource(m.sources[c.dataset.n - 1], +c.dataset.n);
    const cp = e.target.closest('.copy-code');
    if (cp) { navigator.clipboard.writeText(cp.parentElement.querySelector('code').innerText); cp.textContent = t('chat.copied'); setTimeout(() => (cp.textContent = t('chat.copy')), 1200); }
  };
}

function showSource(s, n) {
  if (!s) return;
  $('#sourceTitle').textContent = `[${n}] ${s.docName}`;
  $('#sourceBody').innerHTML = `<div class="meta">${s.page ? esc(t('files.page')) + ' ' + s.page : ''}${s.whole ? esc(t('files.whole')) : ''}</div><pre></pre>`;
  $('#sourceBody pre').textContent = s.text;
  $('#sourceDlg').showModal();
}

// ---------------- generation ----------------
function estTokens(s) {
  // rough: Latin ~4 chars/token, Arabic and others denser
  const nonLatin = (s.match(/[^\x00-\x7F]/g) || []).length;
  return Math.ceil((s.length - nonLatin) / 3.8 + nonLatin / 1.6);
}

async function send(text) {
  text = text.trim();
  if (!text || state.generating) return;
  if (!state.model) { pendingSend = text; openModels(); toast(t('model.pick_first')); return; }
  const c = state.conv;
  const activeDocs = state.docs.filter((d) => c.docIds.includes(d.id));
  c.messages.push({ role: 'user', content: text, docs: activeDocs.map((d) => d.name) });
  if (!c.title) c.title = text.slice(0, 60);
  $('#input').value = '';
  autosize();
  await generate();
}
let pendingSend = null;

async function generate() {
  const c = state.conv;
  const userMsg = c.messages[c.messages.length - 1];
  const a = { role: 'assistant', content: '', model: state.model.name, status: '' };
  c.messages.push(a);
  renderMessages();
  const box = $('#messages');
  const bubble = box.lastElementChild.querySelector('.bubble');
  const ctrl = new AbortController();
  state.generating = ctrl;
  updateSend();
  const repaint = () => { fillAssistant(bubble, a, true); if (stick) box.scrollTop = box.scrollHeight; };
  let stick = true;
  const onScroll = () => { stick = box.scrollHeight - box.scrollTop - box.clientHeight < 80; };
  box.addEventListener('scroll', onScroll);

  try {
    // retrieval
    let allSources = [];
    const activeDocs = state.docs.filter((d) => c.docIds.includes(d.id));
    if (activeDocs.length) {
      a.status = t('files.searching');
      repaint();
      await ensureEmbedder((p) => { a.status = `${t('files.loading_embed')} ${Math.round(p * 100)}%`; repaint(); });
      for (const d of activeDocs) {
        if (d.embedModel !== embedder.model.key) {
          await reindexDoc(d, embedder, (p) => { a.status = `${t('files.reindexing')} ${d.name} ${Math.round(p * 100)}%`; repaint(); });
        }
      }
      const budgetTok = Math.floor(ctxLimit() * 0.45);
      allSources = await retrieve(userMsg.content, activeDocs, embedder, { k: S.topK, budgetChars: budgetTok * 3 });
      allSources = allSources.map(({ docName, page, text, whole }) => ({ docName, page, text, whole }));
    }
    a.status = t('chat.thinking');
    repaint();

    // Assemble the prompt within the context budget. If the engine still reports an overflow
    // (token estimates are approximate), retry with fewer sources and less history.
    const sys = c.system?.trim();
    const build = (shrink) => {
      let sources = allSources;
      if (shrink > 0 && sources.length) {
        const keep = Math.max(1, Math.ceil(sources.length / (2 ** shrink)));
        const maxChars = Math.floor(ctxLimit() * 1.2 / (2 ** shrink));
        sources = sources.slice(0, keep).map((x) => ({ ...x, text: x.text.slice(0, Math.max(400, Math.floor(maxChars / keep))) }));
      }
      const ragText = buildContext(sources, true);
      const finalUser = ragText ? `${ragText}\n\n${t('files.question_label')}: ${userMsg.content}` : userMsg.content;
      const maxTok = Math.min(S.max_tokens, Math.floor(ctxLimit() / 2));
      const budget = (ctxLimit() - maxTok - 64) / (2 ** shrink);
      let used = estTokens(sys || '') + estTokens(finalUser);
      const hist = [];
      for (let i = c.messages.length - 3; i >= 0 && shrink < 2; i--) {
        const m = c.messages[i];
        if (m.error) continue;
        const content = m.role === 'assistant' ? splitThinking(m.content).answer : m.content;
        const n = estTokens(content) + 8;
        if (used + n > budget) break;
        used += n;
        hist.unshift({ role: m.role, content });
      }
      // drop a leading assistant turn so roles alternate cleanly
      while (hist.length && hist[0].role === 'assistant') hist.shift();
      return { sources, used, maxTok, messages: [...(sys ? [{ role: 'system', content: sys }] : []), ...hist, { role: 'user', content: finalUser }] };
    };

    let raf = 0, res;
    for (let shrink = 0; ; shrink++) {
      const p = build(shrink);
      a.sources = p.sources.length ? p.sources : undefined;
      updateCtxInfo(p.used);
      try {
        res = await state.engine.chat({
          messages: p.messages, signal: ctrl.signal,
          params: { temperature: S.temperature, top_p: S.top_p, max_tokens: p.maxTok, thinking: S.thinking },
          onToken: (txt) => {
            a.content = txt;
            a.status = '';
            if (!raf) raf = requestAnimationFrame(() => { raf = 0; repaint(); });
          },
        });
        break;
      } catch (e) {
        if (a.content || shrink >= 3 || !/context|too large|exceed/i.test(e?.message || '')) throw e;
        console.warn('prompt too long, retrying smaller', e?.message);
      }
    }
    cancelAnimationFrame(raf);
    a.content = res.text || a.content;
    a.stats = res.stats;
    delete a.status;
    if (!a.content.trim()) a.content = ctrl.signal.aborted ? `_${t('chat.stopped')}_` : `_${t('chat.empty_reply')}_`;
    showTps(res.stats);
  } catch (e) {
    console.error(e);
    delete a.status;
    if (!a.content) a.error = `${t('chat.error')}: ${e?.message || e}`;
  } finally {
    box.removeEventListener('scroll', onScroll);
    state.generating = null;
    updateSend();
    renderMessages();
    await saveConv(c);
  }
}

function ctxLimit() {
  const real = state.engine?.ctxSize?.();
  return real ? Math.min(real, S.ctx) : S.ctx;
}

function stopGen() { state.generating?.abort(); }

async function regenerate() {
  const c = state.conv;
  if (state.generating || !state.model) return;
  if (c.messages[c.messages.length - 1]?.role === 'assistant') c.messages.pop();
  if (c.messages[c.messages.length - 1]?.role !== 'user') return;
  await generate();
}
function editFrom(i) {
  if (state.generating) return;
  const c = state.conv;
  const m = c.messages[i];
  $('#input').value = m.content;
  c.messages.splice(i);
  renderMessages();
  autosize();
  updateSend();
  $('#input').focus();
}

function showTps(st) {
  if (!st) return;
  const el = $('#tps');
  el.hidden = false;
  el.textContent = `${st.tps.toFixed(1)} tok/s`;
  el.title = st.prefill ? `prefill ${st.prefill.toFixed(0)} tok/s` : '';
}
function updateCtxInfo(used) {
  $('#ctxInfo').textContent = used ? `${t('chat.context')} ~${used.toLocaleString()} / ${ctxLimit().toLocaleString()}` : '';
}

// ---------------- composer ----------------
function autosize() {
  const ta = $('#input');
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 220) + 'px';
}
function updateSend() {
  const gen = !!state.generating;
  $('#sendBtn').hidden = gen;
  $('#stopBtn').hidden = !gen;
  $('#sendBtn').disabled = !$('#input').value.trim();
}

// ---------------- models ----------------
let dlgEngine = null;

async function openModels() {
  const dlg = $('#modelsDlg');
  if (!dlg.open) dlg.showModal();
  dlgEngine ??= S.engineTab || (state.model?.engine) || (state.hw?.webgpu ? 'gpu' : 'cpu');
  renderHw();
  await renderModels();
  renderStorage();
}

function renderHw() {
  const hw = state.hw;
  const tags = [
    hw.webgpu ? [`WebGPU ✓${hw.gpuName ? ' · ' + hw.gpuName : ''}`, 'ok'] : [t('model.no_webgpu'), 'no'],
    hw.webgpu ? [hw.f16 ? 'shader-f16 ✓' : 'shader-f16 ✗', hw.f16 ? 'ok' : ''] : null,
    [`${hw.cores} ${t('model.threads')}${hw.isolated ? ' · multi-thread ✓' : ''}`, ''],
    hw.memGB ? [`RAM ≥ ${hw.memGB} GB`, ''] : null,
  ].filter(Boolean);
  $('#hwInfo').innerHTML = tags.map(([s, c]) => `<span class="tag ${c}">${esc(s)}</span>`).join('');
  $$('#engineTabs .tab').forEach((b) => {
    b.classList.toggle('active', b.dataset.engine === dlgEngine);
    if (b.dataset.engine === 'gpu') { b.disabled = !hw.webgpu; b.title = hw.webgpu ? '' : t('model.no_webgpu'); }
  });
  $('#engineDesc').textContent = t(dlgEngine === 'gpu' ? 'model.gpu_desc' : 'model.cpu_desc');
  $('#customBox').hidden = dlgEngine !== 'cpu';
}

async function renderModels() {
  const grid = $('#modelGrid');
  const list = dlgEngine === 'gpu' ? state.gpuList : CPU_MODELS;
  if (dlgEngine === 'gpu' && !state.gpuList.length) {
    grid.innerHTML = `<div class="status-line"><div class="spinner"></div>${esc(t('model.loading_list'))}</div>`;
    await ensureGpuList();
    return renderModels();
  }
  grid.innerHTML = '';
  for (const m of list) {
    const needMB = dlgEngine === 'gpu' ? m.vramMB : m.bytes / 1048576;
    const fit = fitFor(state.hw, needMB, dlgEngine);
    const card = document.createElement('div');
    card.className = 'mcard' + (state.model?.key === m.key ? ' current' : '');
    card.dataset.key = m.key;
    card.innerHTML = `
      <div class="top"><h4>${esc(m.name)}</h4>${m.recommended ? `<span class="rec">${esc(t('model.recommended'))}</span>` : ''}</div>
      <div class="facts">
        <span>${esc(m.params)} ${esc(t('model.params'))}</span>
        <span>${dlgEngine === 'gpu' ? `${esc(t('model.vram'))} ${fmtBytes(m.vramMB * 1048576)}` : `${esc(t('model.download'))} ${fmtBytes(m.bytes)}`}</span>
        <span>${esc(m.langs)}</span>
        ${m.thinking ? `<span>${esc(t('model.reasoning'))}</span>` : ''}
        ${m.note ? `<span>${esc(t('model.note_' + m.note.replace(/\W+/g, '_')))}</span>` : ''}
      </div>
      <div class="fit ${fit}">${esc(t('model.fit_' + fit))}</div>
      <div class="cached" hidden>✓ ${esc(t('model.cached'))}</div>
      <div class="mprog" hidden><i></i></div><div class="mtext" hidden></div>
      <div class="acts">
        <button class="btn sm primary" data-a="load">${esc(state.model?.key === m.key ? t('model.loaded') : t('model.load'))}</button>
        ${dlgEngine === 'cpu' ? `<button class="btn sm" data-a="dl">${esc(t('model.download_only'))}</button>` : ''}
        <button class="btn sm ghost danger" data-a="del" hidden>${esc(t('model.delete'))}</button>
      </div>`;
    if (state.model?.key === m.key) card.querySelector('[data-a=load]').disabled = true;
    card.addEventListener('click', (e) => {
      const a = e.target.closest('button')?.dataset.a;
      if (a === 'load') loadModel(m, dlgEngine);
      if (a === 'dl') prefetchCpu(m, card);
      if (a === 'del') deleteModel(m, dlgEngine);
    });
    grid.append(card);
    // cached?
    (dlgEngine === 'gpu' ? cache.gpuHas(m.modelId) : cache.cpuHas(m.url)).then((has) => {
      card.querySelector('.cached').hidden = !has;
      card.querySelector('[data-a=del]').hidden = !has || state.model?.key === m.key;
      const dl = card.querySelector('[data-a=dl]');
      if (dl) dl.hidden = has;
    });
  }
}

async function ensureGpuList() {
  if (state.gpuList.length) return;
  const w = await webllm();
  state.gpuList = GPU_MODELS.map((m) => resolveGpuModel(m, w.prebuiltAppConfig.model_list, state.hw.f16)).filter(Boolean)
    .map((m) => ({ ...m, engine: 'gpu' }));
}

function cardProgress(key, p, text) {
  const card = $(`.mcard[data-key="${key}"]`);
  if (!card) return;
  card.querySelector('.mprog').hidden = false;
  card.querySelector('.mprog i').style.width = `${Math.round(p * 100)}%`;
  const mt = card.querySelector('.mtext');
  mt.hidden = !text;
  mt.textContent = text || '';
}

function setLoadBar(p, text) {
  const bar = $('#loadBar');
  if (p === null) { bar.hidden = true; return; }
  bar.hidden = false;
  $('#loadFill').style.width = `${Math.round(p * 100)}%`;
  $('#loadText').textContent = text;
}

async function loadModel(m, engine) {
  if (state.loading) return toast(t('model.busy'));
  if (state.generating) stopGen();
  state.loading = true;
  navigator.storage?.persist?.().catch(() => {});
  setModelStatus('loading', m.name);
  const onProgress = ({ progress, text, loaded, total }) => {
    const pct = Math.round(progress * 100);
    const label = total ? `${fmtBytes(loaded)} / ${fmtBytes(total)}` : (text || '').replace(/\[.*?\]\s*/g, '').slice(0, 80);
    setLoadBar(progress, `${m.name} · ${pct}%`);
    cardProgress(m.key, progress, label);
  };
  try {
    // free the other engine's memory
    if (state.engine && state.engine.kind !== engine) await state.engine.unload();
    const eng = engine === 'gpu' ? gpu : cpu;
    await eng.load(m, onProgress, { ctx: S.ctx, gpuLayers: S.cpuOnly ? 0 : undefined });
    state.engine = eng;
    state.model = { ...m, engine };
    if (!m.file) { S.lastModel = { key: m.key, engine, url: m.url }; S.engineTab = engine; saveSettings(); }
    setModelStatus('ready');
    toast(t('model.ready', { name: m.name }));
    $('#modelsDlg').close();
    if (state.conv && !state.conv.messages.length) renderMessages();
    if (pendingSend) { const p = pendingSend; pendingSend = null; send(p); }
  } catch (e) {
    console.error(e);
    state.model = null; state.engine = null;
    setModelStatus('none');
    toast(`${t('model.failed')}: ${friendlyError(e)}`, true);
  } finally {
    state.loading = false;
    setLoadBar(null);
    if ($('#modelsDlg').open) { renderModels(); renderStorage(); }
  }
}

function friendlyError(e) {
  const msg = String(e?.message || e);
  if (/out of memory|OOM|allocation|Aborted\(OOM\)|memory access out of bounds/i.test(msg)) return t('model.err_memory');
  if (/fetch|network|Failed to fetch|NetworkError/i.test(msg)) return t('model.err_network');
  if (/quota|QuotaExceeded/i.test(msg)) return t('model.err_storage');
  return msg.slice(0, 200);
}

async function prefetchCpu(m, card) {
  card.querySelector('[data-a=dl]').disabled = true;
  try {
    navigator.storage?.persist?.().catch(() => {});
    await cache.cpuDownload(m.url, ({ progress }) => cardProgress(m.key, progress, `${Math.round(progress * 100)}%`));
    toast(t('model.downloaded', { name: m.name }));
  } catch (e) { toast(`${t('model.failed')}: ${friendlyError(e)}`, true); }
  renderModels(); renderStorage();
}

async function deleteModel(m, engine) {
  if (!confirm(t('model.delete_confirm', { name: m.name }))) return;
  try {
    if (engine === 'gpu') await cache.gpuDelete(m.modelId); else await cache.cpuDelete(m.url);
    toast(t('model.deleted'));
  } catch (e) { toast(String(e?.message || e), true); }
  renderModels(); renderStorage();
}

async function renderStorage() {
  const el = $('#storage');
  let est = {};
  try { est = await navigator.storage.estimate(); } catch { /* ignore */ }
  const persisted = await navigator.storage?.persisted?.().catch(() => false);
  const pct = est.quota ? Math.min(100, (est.usage / est.quota) * 100) : 0;
  el.innerHTML = `
    <div class="srow"><b>${esc(t('model.storage'))}</b><span>${fmtBytes(est.usage || 0)} ${esc(t('model.of'))} ${fmtBytes(est.quota || 0)}${persisted ? ' · ' + esc(t('model.persisted')) : ''}</span></div>
    <div class="sbar"><i style="width:${pct.toFixed(1)}%"></i></div>
    <div class="srow"><small>${esc(t('model.storage_note'))}</small><button class="btn sm ghost danger" id="clearAll">${esc(t('model.clear_all'))}</button></div>`;
  $('#clearAll').onclick = async () => {
    if (!confirm(t('model.clear_confirm'))) return;
    if (state.engine) await state.engine.unload();
    state.engine = null; state.model = null;
    setModelStatus('none');
    for (const m of state.gpuList) await cache.gpuDelete(m.modelId).catch(() => {});
    try { const cm = await cache.cpuManager(); await cm.clear(); } catch { /* ignore */ }
    try { for (const k of await caches.keys()) if (/webllm/i.test(k)) await caches.delete(k); } catch { /* ignore */ }
    toast(t('model.deleted'));
    renderModels(); renderStorage();
  };
}

function setModelStatus(s, name) {
  const dot = $('#modelDot');
  dot.className = 'dot' + (s === 'ready' ? ' ready' : s === 'loading' ? ' loading' : '');
  const badge = $('#engineBadge');
  if (s === 'ready') {
    $('#modelName').textContent = state.model.name;
    badge.hidden = false;
    badge.textContent = state.model.engine === 'gpu' ? 'WebGPU' : (cpu.isMultithread() ? 'Wasm · MT' : 'Wasm');
  } else if (s === 'loading') {
    $('#modelName').textContent = name;
    badge.hidden = true;
  } else {
    $('#modelName').textContent = t('model.none');
    badge.hidden = true;
  }
}

async function loadCustom(source) {
  const isFile = source instanceof File;
  const name = isFile ? source.name.replace(/\.gguf$/i, '') : decodeURIComponent(source.split('/').pop().split('?')[0]).replace(/\.gguf$/i, '');
  const m = { key: 'custom:' + name, name, params: '?', langs: '', engine: 'cpu', ...(isFile ? { file: source } : { url: source }) };
  await loadModel(m, 'cpu');
}

async function ensureEmbedder(onProgress) {
  const em = EMBED_MODELS.find((e) => e.key === S.embedKey) || EMBED_MODELS[0];
  await embedder.load(em, ({ progress }) => onProgress?.(progress));
}

// ---------------- files ----------------
async function loadDocs() {
  state.docs = (await db.all('docs')).sort((a, b) => b.added - a.added);
}

async function addFiles(files) {
  openDrawer('files');
  for (const file of files) {
    if (/\.gguf$/i.test(file.name)) { loadCustom(file); continue; }
    const tmp = uid();
    state.ingesting.set(tmp, { name: file.name, stage: 'read', p: 0 });
    renderDocList();
    renderActiveDocs();
    try {
      await ensureEmbedder((p) => { state.ingesting.set(tmp, { name: file.name, stage: 'model', p }); renderIngest(tmp); });
      const doc = await ingestFile(file, embedder, (stage, p) => { state.ingesting.set(tmp, { name: file.name, stage, p }); renderIngest(tmp); });
      state.docs.unshift(doc);
      if (!state.conv.docIds.includes(doc.id)) state.conv.docIds.push(doc.id);
      await saveConv();
      toast(t('files.added', { name: file.name }));
    } catch (e) {
      console.error(e);
      toast(e.message === 'NO_TEXT' ? t('files.no_text', { name: file.name }) : `${file.name}: ${friendlyError(e)}`, true);
    } finally {
      state.ingesting.delete(tmp);
      renderDocList();
      renderActiveDocs();
    }
  }
}

function stageLabel(s) {
  return s.stage === 'model' ? `${t('files.loading_embed')} ${Math.round(s.p * 100)}%`
    : s.stage === 'read' ? `${t('files.reading')} ${Math.round(s.p * 100)}%`
      : `${t('files.indexing')} ${Math.round(s.p * 100)}%`;
}
function renderIngest(tmp) {
  const s = state.ingesting.get(tmp);
  const row = $(`[data-tmp="${tmp}"]`);
  if (row && s) { row.querySelector('.s').textContent = stageLabel(s); row.querySelector('.prog i').style.width = `${Math.round(s.p * 100)}%`; }
  const chip = $(`[data-tmpchip="${tmp}"]`);
  if (chip && s) chip.querySelector('.bar i').style.width = `${Math.round(s.p * 100)}%`;
}

function renderDocList() {
  const box = $('#docList');
  box.innerHTML = '';
  for (const [tmp, s] of state.ingesting) {
    box.insertAdjacentHTML('beforeend', `<div class="doc" data-tmp="${tmp}"><div class="spinner"></div><div style="min-width:0"><div class="n">${esc(s.name)}</div><div class="s">${esc(stageLabel(s))}</div><div class="prog"><i></i></div></div><span></span></div>`);
  }
  for (const d of state.docs) {
    const on = state.conv?.docIds.includes(d.id);
    const row = document.createElement('label');
    row.className = 'doc';
    const stale = d.embedModel !== S.embedKey;
    row.innerHTML = `<input type="checkbox" ${on ? 'checked' : ''}>
      <div style="min-width:0"><div class="n" title="${esc(d.name)}">${esc(d.name)}</div>
      <div class="s ${stale ? 'warn' : ''}">${d.pages > 1 ? `${d.pages} ${esc(t('files.pages'))} · ` : ''}${d.chunks} ${esc(t('files.passages'))} · ${fmtBytes(d.size)}${stale ? ' · ' + esc(t('files.needs_reindex')) : ''}</div></div>
      <button class="icon-btn" title="${esc(t('files.remove'))}"><svg viewBox="0 0 24 24" class="ic sm"><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/></svg></button>`;
    row.querySelector('input').addEventListener('change', async (e) => {
      const ids = state.conv.docIds;
      if (e.target.checked) ids.push(d.id); else ids.splice(ids.indexOf(d.id), 1);
      await saveConv();
      renderActiveDocs();
    });
    row.querySelector('button').addEventListener('click', async (e) => {
      e.preventDefault();
      if (!confirm(t('files.remove_confirm', { name: d.name }))) return;
      await deleteDoc(d.id);
      state.docs = state.docs.filter((x) => x !== d);
      for (const c of state.convs) if (c.docIds?.includes(d.id)) { c.docIds = c.docIds.filter((x) => x !== d.id); await db.put('convs', c); }
      renderDocList(); renderActiveDocs();
    });
    box.append(row);
  }
  if (!box.children.length) box.innerHTML = `<div class="doc-empty">${esc(t('files.none'))}</div>`;
}

function renderActiveDocs() {
  const box = $('#activeDocs');
  box.innerHTML = '';
  for (const [tmp, s] of state.ingesting) {
    box.insertAdjacentHTML('beforeend', `<span class="chip" data-tmpchip="${tmp}"><span>${esc(s.name)}</span><span class="bar"><i></i></span></span>`);
  }
  const active = state.docs.filter((d) => state.conv?.docIds.includes(d.id));
  for (const d of active) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.innerHTML = `<span>◆ ${esc(d.name)}</span><button title="${esc(t('files.detach'))}">×</button>`;
    chip.querySelector('button').onclick = async () => {
      state.conv.docIds = state.conv.docIds.filter((x) => x !== d.id);
      await saveConv(); renderActiveDocs(); renderDocList();
    };
    box.append(chip);
  }
  const n = active.length;
  $('#filesCount').hidden = !n;
  $('#filesCount').textContent = n;
  $('#input').placeholder = n ? t('chat.placeholder_files') : t('chat.placeholder');
}

// ---------------- drawer & settings ----------------
function openDrawer(tab) {
  $('#drawer').classList.add('open');
  $$('#drawer .tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $$('#drawer .tab-panel').forEach((p) => p.classList.toggle('active', p.dataset.panel === tab));
  if (matchMedia('(max-width: 1100px)').matches) $('#scrim').hidden = false;
}
function closeDrawer() { $('#drawer').classList.remove('open'); if (!$('#sidebar').classList.contains('open')) $('#scrim').hidden = true; }
function toggleDrawer(tab) {
  const d = $('#drawer');
  if (d.classList.contains('open') && $(`#drawer .tab[data-tab="${tab}"]`).classList.contains('active')) closeDrawer();
  else openDrawer(tab);
}
function closeSidebarMobile() { $('#sidebar').classList.remove('open'); if (!$('#drawer').classList.contains('open')) $('#scrim').hidden = true; }

function syncConvSettings() {
  const c = state.conv;
  $('#presetSel').value = PRESETS.includes(c.preset) ? c.preset : 'custom';
  $('#sysPrompt').value = c.system ?? '';
}

function initSettings() {
  const bindRange = (id, key, outId, fmt = (v) => v) => {
    const el = $(id);
    el.value = S[key];
    $(outId).textContent = fmt(S[key]);
    el.addEventListener('input', () => { S[key] = parseFloat(el.value); $(outId).textContent = fmt(S[key]); saveSettings(); });
  };
  bindRange('#temp', 'temperature', '#tempOut', (v) => (+v).toFixed(2));
  bindRange('#topP', 'top_p', '#topPOut', (v) => (+v).toFixed(2));
  bindRange('#maxTok', 'max_tokens', '#maxTokOut');
  bindRange('#topK', 'topK', '#topKOut');
  $('#ctxSel').value = String(S.ctx);
  $('#ctxSel').onchange = (e) => { S.ctx = +e.target.value; saveSettings(); if (state.model) toast(t('settings.context_reload')); };
  for (const [id, key] of [['#thinking', 'thinking'], ['#cpuOnly', 'cpuOnly'], ['#autoLoad', 'autoLoad']]) {
    $(id).checked = !!S[key];
    $(id).onchange = (e) => { S[key] = e.target.checked; saveSettings(); };
  }
  $('#langSel').value = S.lang;
  $('#langSel').onchange = (e) => { S.lang = e.target.value; saveSettings(); applyLang(); };
  const syncTheme = () => $$('#themeSeg button').forEach((b) => b.classList.toggle('on', b.dataset.v === S.theme));
  $$('#themeSeg button').forEach((b) => b.onclick = () => {
    S.theme = b.dataset.v; saveSettings(); syncTheme();
    if (S.theme === 'system') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = S.theme;
  });
  syncTheme();
  $('#presetSel').onchange = (e) => {
    const v = e.target.value;
    state.conv.preset = v;
    if (v !== 'custom') { state.conv.system = presetPrompt(v); $('#sysPrompt').value = state.conv.system; S.preset = v; saveSettings(); }
    saveConv();
  };
  $('#sysPrompt').oninput = (e) => { state.conv.system = e.target.value; state.conv.preset = 'custom'; $('#presetSel').value = 'custom'; saveConv(); };
  $('#embedSel').onchange = (e) => { S.embedKey = e.target.value; saveSettings(); renderDocList(); };
  $('#shareBtn').onclick = () => {
    const u = new URL(location.href);
    u.hash = new URLSearchParams({ q: $('#input').value, sys: state.conv.system || '' }).toString();
    navigator.clipboard.writeText(u.toString());
    toast(t('settings.share_copied'));
  };
}

function fillSelects() {
  $('#presetSel').innerHTML = [...PRESETS, 'custom'].map((p) => `<option value="${p}">${esc(t('preset.' + p))}</option>`).join('');
  $('#embedSel').innerHTML = EMBED_MODELS.map((m) => `<option value="${m.key}">${esc(m.name)} · ${fmtBytes(m.bytes)} — ${esc(t('model.note_' + m.note.replace(/\W+/g, '_')))}</option>`).join('');
  $('#embedSel').value = S.embedKey;
}

function applyLang() {
  setLang(S.lang);
  document.documentElement.lang = S.lang;
  document.documentElement.dir = S.lang === 'ar' ? 'rtl' : 'ltr';
  applyI18n(document);
  fillSelects();
  if (state.conv) { syncConvSettings(); renderConvList(); renderMessages(); renderDocList(); renderActiveDocs(); }
  setModelStatus(state.model ? 'ready' : 'none');
  if ($('#modelsDlg').open) openModels();
}

// ---------------- boot ----------------
async function boot() {
  setLang(S.lang);
  applyI18n(document);
  fillSelects();
  initSettings();
  $('#fileInput').accept = ACCEPT + ',.gguf';

  state.hw = await detectHardware();
  await Promise.all([loadConvs(), loadDocs()]);

  // shared prompt link
  const hp = new URLSearchParams(location.hash.slice(1));
  state.conv = newConv();
  if (hp.get('sys')) { state.conv.system = hp.get('sys'); state.conv.preset = 'custom'; }
  if (hp.get('q')) $('#input').value = hp.get('q');
  if (hp.size) history.replaceState(null, '', location.pathname + location.search);
  openConv(state.conv);
  autosize(); updateSend();

  // events
  $('#newChat').onclick = startNewChat;
  $('#convSearch').oninput = renderConvList;
  $('#modelBtn').onclick = openModels;
  $('#filesBtn').onclick = () => toggleDrawer('files');
  $('#settingsBtn').onclick = () => toggleDrawer('settings');
  $('#drawerClose').onclick = closeDrawer;
  $$('#drawer .tab').forEach((b) => b.onclick = () => openDrawer(b.dataset.tab));
  $('#menuBtn').onclick = () => { $('#sidebar').classList.add('open'); $('#scrim').hidden = false; };
  $('#scrim').onclick = () => { closeSidebarMobile(); closeDrawer(); };
  $$('#engineTabs .tab').forEach((b) => b.onclick = () => { dlgEngine = b.dataset.engine; renderHw(); renderModels(); });
  $('#ggufUrlBtn').onclick = () => { const u = $('#ggufUrl').value.trim(); if (/^https?:\/\/.+\.gguf(\?.*)?$/i.test(u)) loadCustom(u); else toast(t('model.bad_url'), true); };
  $('#ggufFileBtn').onclick = () => $('#ggufFile').click();
  $('#ggufFile').onchange = (e) => { const f = e.target.files[0]; if (f) loadCustom(f); e.target.value = ''; };

  const input = $('#input');
  input.addEventListener('input', () => { autosize(); updateSend(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !matchMedia('(pointer: coarse)').matches) { e.preventDefault(); send(input.value); }
  });
  $('#composer').onsubmit = (e) => { e.preventDefault(); send(input.value); };
  $('#stopBtn').onclick = stopGen;
  $('#attachBtn').onclick = () => $('#fileInput').click();
  $('#dropzone').onclick = () => $('#fileInput').click();
  $('#dropzone').onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') $('#fileInput').click(); };
  $('#fileInput').onchange = (e) => { addFiles([...e.target.files]); e.target.value = ''; };

  // drag & drop anywhere
  let dragDepth = 0;
  addEventListener('dragenter', (e) => { if (e.dataTransfer?.types.includes('Files')) { dragDepth++; $('#dropHint').hidden = false; } });
  addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#dropHint').hidden = true; } });
  addEventListener('dragover', (e) => e.preventDefault());
  addEventListener('drop', (e) => {
    e.preventDefault(); dragDepth = 0; $('#dropHint').hidden = true;
    const files = [...(e.dataTransfer?.files || [])];
    if (files.length) addFiles(files);
  });
  addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])].filter((f) => !f.type.startsWith('image/'));
    if (files.length) { e.preventDefault(); addFiles(files); }
  });
  addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'o') { e.preventDefault(); startNewChat(); }
    if (e.key === 'Escape' && state.generating) stopGen();
  });

  // import / export
  $('#exportAll').onclick = async () => {
    const convs = await db.all('convs');
    download(`hearth-chats-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify({ app: 'hearth', version: 1, convs }, null, 2), 'application/json');
  };
  $('#importBtn').onclick = () => $('#importInput').click();
  $('#importInput').onchange = async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      const convs = (data.convs || []).filter((c) => c && c.id && Array.isArray(c.messages));
      for (const c of convs) { c.docIds = (c.docIds || []).filter((id) => state.docs.some((d) => d.id === id)); await db.put('convs', c); }
      await loadConvs();
      renderConvList();
      toast(t('chat.imported', { n: convs.length }));
    } catch { toast(t('chat.import_failed'), true); }
  };

  // service worker (offline + multi-thread headers)
  registerSW();

  // auto-load last model if it is cached
  if (S.autoLoad && S.lastModel) {
    const lm = S.lastModel;
    try {
      if (lm.engine === 'gpu' && state.hw.webgpu) {
        await ensureGpuList();
        const m = state.gpuList.find((x) => x.key === lm.key);
        if (m && await cache.gpuHas(m.modelId)) loadModel(m, 'gpu');
      } else if (lm.engine === 'cpu') {
        const m = CPU_MODELS.find((x) => x.key === lm.key);
        if (m && await cache.cpuHas(m.url)) loadModel({ ...m, engine: 'cpu' }, 'cpu');
      }
    } catch (e) { console.warn('auto-load skipped', e); }
  }
}

function registerSW() {
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
  // COEP credentialless lets us enable multi-threaded Wasm on static hosts (Chromium only).
  const coi = 'credentialless' in HTMLIFrameElement.prototype ? '1' : '0';
  navigator.serviceWorker.register(`sw.js?coi=${coi}`).then((reg) => {
    if (coi === '1' && !self.crossOriginIsolated && !sessionStorage.getItem('hearth.coi-reload')) {
      const reload = () => { sessionStorage.setItem('hearth.coi-reload', '1'); if (!state.model && !state.loading && !state.conv?.messages.length && !$('#input').value) location.reload(); };
      if (navigator.serviceWorker.controller) reload();
      else navigator.serviceWorker.addEventListener('controllerchange', reload, { once: true });
    }
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w?.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) toast(t('app.updated')); });
    });
  }).catch((e) => console.warn('SW registration failed', e));
}

boot().catch((e) => { console.error(e); toast(String(e?.message || e), true); });

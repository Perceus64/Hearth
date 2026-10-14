// Two chat engines with one interface, plus a local embedder.
//   GpuEngine  -> WebLLM (MLC) on WebGPU, runs in a Web Worker
//   CpuEngine  -> llama.cpp compiled to WebAssembly (wllama), GGUF models
// Interface: load(model, onProgress), chat({messages, params, signal, onToken}) -> {text, stats}, unload()

const WLLAMA_WASM = new URL('./wllama.wasm', document.baseURI).href;

let webllmMod;
export async function webllm() {
  webllmMod ??= await import('@mlc-ai/web-llm');
  return webllmMod;
}
let wllamaMod;
async function wllamaLib() {
  wllamaMod ??= await import('@wllama/wllama');
  return wllamaMod;
}

export class GpuEngine {
  kind = 'gpu';
  engine = null;
  model = null;

  async load(model, onProgress, { ctx = 4096 } = {}) {
    const w = await webllm();
    const chatOpts = { context_window_size: ctx };
    if (!this.engine) {
      const worker = new Worker(new URL('./webllm-worker.js', document.baseURI), { type: 'module' });
      this.engine = await w.CreateWebWorkerMLCEngine(worker, model.modelId, {
        initProgressCallback: (r) => onProgress?.({ progress: r.progress, text: r.text }),
        appConfig: w.prebuiltAppConfig,
      }, chatOpts);
    } else {
      this.engine.setInitProgressCallback?.((r) => onProgress?.({ progress: r.progress, text: r.text }));
      await this.engine.reload(model.modelId, chatOpts);
    }
    this.model = model;
  }

  async chat({ messages, params, signal, onToken }) {
    const onAbort = () => this.engine.interruptGenerate();
    signal?.addEventListener('abort', onAbort);
    const t0 = performance.now();
    let text = '', usage = null, first = null, n = 0;
    try {
      const stream = await this.engine.chat.completions.create({
        messages, stream: true, stream_options: { include_usage: true },
        temperature: params.temperature, top_p: params.top_p, max_tokens: params.max_tokens,
        ...(this.model?.thinking ? { extra_body: { enable_thinking: !!params.thinking } } : {}),
      });
      for await (const chunk of stream) {
        const d = chunk.choices?.[0]?.delta?.content;
        if (d) { first ??= performance.now(); text += d; n++; onToken(text); }
        if (chunk.usage) usage = chunk.usage;
      }
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
    const secs = (performance.now() - (first ?? t0)) / 1000;
    return {
      text,
      stats: {
        tps: usage?.extra?.decode_tokens_per_s ?? (n / Math.max(secs, 0.001)),
        prefill: usage?.extra?.prefill_tokens_per_s ?? null,
        tokens: usage?.completion_tokens ?? n,
        promptTokens: usage?.prompt_tokens ?? null,
      },
    };
  }

  async unload() {
    try { await this.engine?.unload(); } catch { /* ignore */ }
    this.model = null;
  }
}

export class CpuEngine {
  kind = 'cpu';
  w = null;
  model = null;

  async ensure() {
    if (this.w) return this.w;
    const { Wllama, LoggerWithoutDebug } = await wllamaLib();
    this.w = new Wllama({ default: WLLAMA_WASM }, { parallelDownloads: 3, logger: LoggerWithoutDebug });
    return this.w;
  }

  async load(model, onProgress, { ctx = 4096, gpuLayers } = {}) {
    if (this.w?.isModelLoaded()) await this.w.exit();
    this.w = null;
    const w = await this.ensure();
    const opts = {
      n_ctx: ctx,
      progressCallback: ({ loaded, total }) => onProgress?.({ progress: total ? loaded / total : 0, loaded, total }),
    };
    if (gpuLayers === 0) opts.n_gpu_layers = 0;
    if (model.file) await w.loadModel([model.file], opts); // user-supplied GGUF
    else await w.loadModelFromUrl(model.url, opts);
    this.model = model;
  }

  async chat({ messages, params, signal, onToken }) {
    const w = this.w;
    const t0 = performance.now();
    let text = '', timings = null, usage = null, first = null, n = 0;
    const stream = await w.createChatCompletion({
      messages, stream: true, abortSignal: signal,
      temperature: params.temperature, top_p: params.top_p, max_tokens: params.max_tokens,
      ...(this.model?.thinking ? { chat_template_kwargs: { enable_thinking: !!params.thinking } } : {}),
    });
    try {
      for await (const chunk of stream) {
        const d = chunk.choices?.[0]?.delta?.content;
        if (d) { first ??= performance.now(); text += d; n++; onToken(text); }
        if (chunk.timings) timings = chunk.timings;
        if (chunk.usage) usage = chunk.usage;
      }
    } catch (e) {
      if (!(signal?.aborted || e?.name === 'AbortError' || /abort/i.test(e?.message || ''))) throw e;
    }
    const secs = (performance.now() - (first ?? t0)) / 1000;
    return {
      text,
      stats: {
        tps: timings?.predicted_per_second ?? (n / Math.max(secs, 0.001)),
        prefill: timings?.prompt_per_second ?? null,
        tokens: timings?.predicted_n ?? usage?.completion_tokens ?? n,
        promptTokens: timings?.prompt_n ?? usage?.prompt_tokens ?? null,
      },
    };
  }

  isMultithread() { try { return this.w?.isMultithread(); } catch { return false; } }
  ctxSize() { try { const i = this.w?.getLoadedContextInfo(); return i ? Math.min(i.n_ctx, i.n_ctx_train || i.n_ctx) : null; } catch { return null; } }
  threads() { try { return this.w?.getNumThreads(); } catch { return 1; } }

  async unload() {
    try { await this.w?.exit(); } catch { /* ignore */ }
    this.w = null;
    this.model = null;
  }
}

// Local embedding model (separate llama.cpp instance).
export class Embedder {
  w = null;
  model = null;
  loading = null;

  async load(model, onProgress) {
    if (this.model?.key === model.key && this.w) return;
    if (this.loading) return this.loading;
    this.loading = (async () => {
      if (this.w) await this.w.exit().catch(() => {});
      const { Wllama, LoggerWithoutDebug } = await wllamaLib();
      this.w = new Wllama({ default: WLLAMA_WASM }, { logger: LoggerWithoutDebug });
      await this.w.loadModelFromUrl(model.url, {
        embeddings: true, pooling_type: 'mean', n_ctx: 512, n_batch: 512, n_ubatch: 512,
        progressCallback: ({ loaded, total }) => onProgress?.({ progress: total ? loaded / total : 0 }),
      });
      this.model = model;
    })();
    try { await this.loading; } finally { this.loading = null; }
  }

  async embed(texts, kind = 'passage') {
    const fmt = kind === 'query' ? this.model.query : this.model.passage;
    const out = [];
    for (let t of texts) {
      // the embedding model has a 512-token window; dense scripts can exceed it, so shrink and retry
      for (let attempt = 0; ; attempt++) {
        try {
          const r = await this.w.createEmbedding({ input: fmt(t) });
          out.push(normalize(Float32Array.from(r.data[0].embedding)));
          break;
        } catch (e) {
          if (attempt >= 5 || !/too large|batch size|context/i.test(e?.message || '')) throw e;
          t = t.slice(0, Math.floor(t.length * 0.6));
        }
      }
    }
    return out;
  }
}

function normalize(v) {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  s = Math.sqrt(s) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= s;
  return v;
}

// Cache helpers for the model manager
export const cache = {
  async gpuHas(modelId) {
    const w = await webllm();
    try { return await w.hasModelInCache(modelId, w.prebuiltAppConfig); } catch { return false; }
  },
  async gpuDelete(modelId) {
    const w = await webllm();
    await w.deleteModelAllInfoInCache(modelId, w.prebuiltAppConfig);
  },
  async cpuManager() {
    const { CacheManager } = await wllamaLib();
    cache._cm ??= new CacheManager();
    return cache._cm;
  },
  async cpuHas(url) {
    const cm = await cache.cpuManager();
    const name = await cm.getNameFromURL(url);
    const list = await cm.list();
    return list.some((e) => e.name === name || e.name.startsWith(name));
  },
  async cpuDelete(url) {
    const cm = await cache.cpuManager();
    await cm.delete(url);
  },
  async cpuDownload(url, onProgress) {
    const cm = await cache.cpuManager();
    await cm.download(url, { progressCallback: ({ loaded, total }) => onProgress?.({ progress: total ? loaded / total : 0 }) });
  },
};

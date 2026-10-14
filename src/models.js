// Curated model catalog.
// gpu: WebLLM (MLC) models, run on WebGPU. `id` is the WebLLM model_id without the q4f16/q4f32 suffix.
// cpu: GGUF models for llama.cpp (wllama), run in WebAssembly (uses WebGPU too when available).

export const GPU_MODELS = [
  { key: 'g-qwen25-05', name: 'Qwen2.5 0.5B', base: 'Qwen2.5-0.5B-Instruct', params: '0.5B', langs: 'en ar fr +', ctx: 4096, note: 'tiny, fast' },
  { key: 'g-gemma3-1', name: 'Gemma 3 1B', base: 'gemma3-1b-it', params: '1B', langs: 'en fr +', ctx: 4096, f16Only: true },
  { key: 'g-llama32-1', name: 'Llama 3.2 1B', base: 'Llama-3.2-1B-Instruct', params: '1B', langs: 'en fr +', ctx: 4096 },
  { key: 'g-qwen25-15', name: 'Qwen2.5 1.5B', base: 'Qwen2.5-1.5B-Instruct', params: '1.5B', langs: 'en ar fr +', ctx: 4096, recommended: true },
  { key: 'g-qwen3-17', name: 'Qwen3 1.7B', base: 'Qwen3-1.7B', params: '1.7B', langs: 'en ar fr +', ctx: 4096, thinking: true },
  { key: 'g-qwen25-3', name: 'Qwen2.5 3B', base: 'Qwen2.5-3B-Instruct', params: '3B', langs: 'en ar fr +', ctx: 4096 },
  { key: 'g-llama32-3', name: 'Llama 3.2 3B', base: 'Llama-3.2-3B-Instruct', params: '3B', langs: 'en fr +', ctx: 4096 },
  { key: 'g-qwen3-4', name: 'Qwen3 4B', base: 'Qwen3-4B', params: '4B', langs: 'en ar fr +', ctx: 4096, thinking: true },
  { key: 'g-phi35', name: 'Phi-3.5 mini', base: 'Phi-3.5-mini-instruct', params: '3.8B', langs: 'en', ctx: 4096 },
];

const HF = 'https://huggingface.co';
const hf = (repo, file) => `${HF}/${repo}/resolve/main/${file}`;

export const CPU_MODELS = [
  { key: 'c-qwen25-05', name: 'Qwen2.5 0.5B', params: '0.5B', langs: 'en ar fr +', bytes: 491400032,
    url: hf('Qwen/Qwen2.5-0.5B-Instruct-GGUF', 'qwen2.5-0.5b-instruct-q4_k_m.gguf'), note: 'tiny, fast' },
  { key: 'c-gemma3-1', name: 'Gemma 3 1B', params: '1B', langs: 'en fr +', bytes: 806058272,
    url: hf('unsloth/gemma-3-1b-it-GGUF', 'gemma-3-1b-it-Q4_K_M.gguf') },
  { key: 'c-llama32-1', name: 'Llama 3.2 1B', params: '1B', langs: 'en fr +', bytes: 807694464,
    url: hf('bartowski/Llama-3.2-1B-Instruct-GGUF', 'Llama-3.2-1B-Instruct-Q4_K_M.gguf') },
  { key: 'c-qwen25-15', name: 'Qwen2.5 1.5B', params: '1.5B', langs: 'en ar fr +', bytes: 1117320736, recommended: true,
    url: hf('Qwen/Qwen2.5-1.5B-Instruct-GGUF', 'qwen2.5-1.5b-instruct-q4_k_m.gguf') },
  { key: 'c-qwen3-17', name: 'Qwen3 1.7B', params: '1.7B', langs: 'en ar fr +', bytes: 1107409472, thinking: true,
    url: hf('unsloth/Qwen3-1.7B-GGUF', 'Qwen3-1.7B-Q4_K_M.gguf') },
];

export const EMBED_MODELS = [
  { key: 'e5-small', name: 'multilingual-e5-small', bytes: 131624960,
    url: hf('cstr/multilingual-e5-small-GGUF', 'multilingual-e5-small-q8_0.gguf'),
    query: (t) => 'query: ' + t, passage: (t) => 'passage: ' + t, note: '100+ languages, lighter' },
  { key: 'embeddinggemma', name: 'EmbeddingGemma 300M', bytes: 333590944,
    url: hf('ggml-org/embeddinggemma-300M-GGUF', 'embeddinggemma-300M-Q8_0.gguf'),
    query: (t) => 'task: search result | query: ' + t, passage: (t) => 'title: none | text: ' + t, note: 'better retrieval, larger' },
];

// Fill in size/VRAM data from WebLLM's prebuilt config (loaded lazily with the engine).
export function resolveGpuModel(m, list, f16) {
  const want = `${m.base}-${f16 || m.f16Only ? 'q4f16_1' : 'q4f32_1'}-MLC`;
  const rec = list.find((r) => r.model_id === want);
  return rec ? { ...m, modelId: rec.model_id, vramMB: rec.vram_required_MB } : null;
}

export const fmtBytes = (b) => {
  if (!b && b !== 0) return '—';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return `${b.toFixed(b >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
};

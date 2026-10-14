# Hearth

Private AI chat that runs entirely in the browser. No server, no account: the model, your chats and your files stay on your device.

- **Two engines, picked automatically.** WebLLM on WebGPU for speed; llama.cpp compiled to WebAssembly (wllama) everywhere else.
- **Chat with your files.** Drop in PDF, Word (.docx), Markdown, text, CSV, HTML or code. Files are parsed, chunked and embedded locally with a multilingual embedding model, and answers cite the passages they used. Click a citation to read the source.
- **Works offline.** Installable PWA. Once a model is downloaded it loads from the browser cache with no internet.
- **Model manager.** Curated small models with download size, memory needs and a "fits your device" estimate; download, delete and storage usage. Bring your own GGUF by URL or local file.
- **English, Arabic (RTL) and French** interface.
- Streaming replies, stop, regenerate, edit and resend, Markdown and code highlighting, collapsible reasoning for Qwen3, assistant presets, sampling controls, saved conversations, export/import, shareable prompt links.

## Run locally

```bash
npm ci
npm run dev        # builds to dist/ and serves http://localhost:8080
```

## Deploy to GitHub Pages with GitHub Actions

The workflow in `.github/workflows/pages.yml` installs, builds and publishes the site on every push to `main` (or `master`).

**With git (recommended)**

```bash
git init
git add .
git commit -m "Hearth"
git branch -M main
git remote add origin https://github.com/<you>/hearth.git
git push -u origin main
```

Then, once per repo: **Settings → Pages → Build and deployment → Source: GitHub Actions**. Open the **Actions** tab to watch the run; if the first run started before you changed that setting, click **Run workflow** to run it again.

The site is published at `https://<you>.github.io/hearth/`.

**If you upload files in the browser instead of using git**

The `.github` folder is hidden on most computers, so drag-and-drop uploads usually skip it, and then no workflow runs. Upload everything else, then add the workflow by hand:

1. In the repo, click **Add file → Create new file**.
2. Name it exactly `.github/workflows/pages.yml` (typing the slashes creates the folders).
3. Paste in the contents of `.github/workflows/pages.yml` from this folder and commit.

Also upload `package-lock.json`; the install step needs it.

**If a run fails**

| Message in the Actions log | Fix |
|---|---|
| `Get Pages site failed` / `Not Found` | Pages source is not set to **GitHub Actions** (Settings → Pages), then re-run. |
| `Dependencies lock file is not found` | `package-lock.json` was not uploaded. |
| `npm ci` says the lock file is out of sync | Run `npm install` locally and commit the updated `package-lock.json`. |
| `Branch "…" is not allowed to deploy to github-pages` | Settings → Environments → github-pages → allow your branch, or push to `main`. |

Every asset path is relative, so the site works from a project subpath (`<you>.github.io/<repo>/`) with no config.

## How it works

| Piece | Library | Notes |
|---|---|---|
| GPU engine | `@mlc-ai/web-llm` | Runs in a Web Worker. Uses `q4f16` models when the GPU supports `shader-f16`, otherwise `q4f32`. |
| Wasm engine | `@wllama/wllama` (llama.cpp) | GGUF models from Hugging Face. Uses WebGPU when present, otherwise CPU. |
| Embeddings | wllama + `multilingual-e5-small` or `EmbeddingGemma 300M` (GGUF) | 100+ languages, including Arabic and French. |
| PDF text | `pdfjs-dist` (legacy build) | Text layer only; scanned PDFs need OCR first. |
| Word | `fflate` | Reads `word/document.xml` directly. |
| Storage | IndexedDB (chats, files, vectors), Cache API and OPFS (models) | Everything is per-browser. |

**Retrieval.** Files are split into ~900-character passages with overlap, embedded, and stored with their page numbers. A question is embedded and scored against every passage (cosine similarity plus a small keyword-overlap boost); the best passages that fit the context budget are added to the prompt with numbered labels, and the model is told to cite them. Short files are passed whole, which works better for "summarize this".

**Multi-threading on a static host.** GitHub Pages cannot set the COOP/COEP headers that `SharedArrayBuffer` needs. The service worker adds them (`COEP: credentialless`) on Chromium browsers and reloads once, so llama.cpp can use several threads. Other browsers fall back to single-thread.

**Context.** The prompt is trimmed to fit the model's context window (history first, then fewer or shorter sources). If the engine still reports an overflow, Hearth retries with a smaller prompt automatically.

## Project layout

```
public/            static files (index.html, app.css, sw.js, manifest, icons)
src/main.js        UI and app logic
src/engines.js     GPU/Wasm engines, embedder, cache helpers
src/rag.js         parsing, chunking, indexing, retrieval
src/models.js      model catalog
src/i18n.js        UI strings (en/ar/fr) and assistant presets
src/hw.js          WebGPU/RAM detection and fit estimate
build.mjs          esbuild bundle + copy assets + service-worker precache list
```

## Limits

- Browsers do not report GPU memory, so "fits your device" is an estimate from system RAM.
- Model files over 2 GB need splitting for the Wasm engine.
- Small models make mistakes; check answers against the cited passages.

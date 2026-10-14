# Hearth

Private AI chat that runs entirely in your browser (WebGPU + WebAssembly). Chats, files and models stay on your device.

This folder is the finished site. There is nothing to install or build.

## Put it on GitHub Pages

1. Create a new repository on GitHub, for example `hearth`.
2. Click **Add file → Upload files**, drag in everything from this folder (including the `chunks` and `icons` folders), and commit to `main`.
3. Go to **Settings → Pages**. Under **Build and deployment**, set **Source** to **Deploy from a branch**, pick **main** and **/ (root)**, and save.
4. After a minute the site is live at `https://<your-username>.github.io/hearth/`.

To update the site later, upload the new files over the old ones.

## Notes

- Models download from Hugging Face the first time you load them, then work offline.
- On Chrome and Edge the page reloads once on the first visit. That turns on multi-threaded WebAssembly.
- The source code and build script are in a separate package.

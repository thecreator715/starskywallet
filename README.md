# Starsky wallet

Live site: https://thecreator715.github.io/starskywallet/ (`starsky-luma.org` forwards here).

- `index.html` is the built, self-contained site. GitHub Pages serves it from the repo root (Settings → Pages → Deploy from a branch → `main` / `(root)`).
- `source/` is the full source. To rebuild: `cd source && npm install && npx vite build -c vite.single.config.ts`, then copy `dist-single/index.html` over the root `index.html`, commit and push.
- The LUMA node addresses visitors connect to are in the `STARSKY_CONFIG` block near the top of `source/index.html` (and baked into the built `index.html`).

## Admin edition (on the node machine)
Double-click `Start Starsky Admin.command` (macOS). It opens Starsky at http://127.0.0.1:8096 wired straight to the LUMA nodes and control panels on this computer (Mainnet 6006 / panel 8090, Testnet 6106 / panel 8091), and starts the LUMA kit first if no node is running and the kit sits next to this folder.

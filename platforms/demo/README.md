# Demo platform

A static, no-login version of my-pmo for showing the app off (for example on GitHub Pages).

- **Data:** `sample-data.json`. Dates are `YYYY-MM-DD` or relative to today (`+10d`, `-40d`, `0d`), so the demo always looks current.
  Each entry has `notes` (with `at` as a relative day) and there is a `journal` array for the Notes page.
- **Sign-in and SQL:** bypassed. The visitor is "Demo visitor"; there is no Administration page.
- **Changes** a visitor makes are kept in their own browser tab (`sessionStorage`) and never leave it. *Reset demo* restores the samples.
- **Build:** `node platforms/demo/build.mjs` copies `core/`, `platform.js` and `sample-data.json` into `docs/` (and adds `.nojekyll`).
  It only replaces the files it made, so `docs/architecture.md` and `docs/design/` are untouched.
- **Publish:** the built `docs/` is committed on the `demo` branch; GitHub Pages serves that branch from `/docs`.

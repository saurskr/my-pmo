# Android platform (planned, not built)

| | |
|---|---|
| Runs as | an Android app wrapping `core/` |
| Data is stored in | Google Drive |
| Authentication | Google (Gmail) sign-in |

To build it, provide a `platform.js` that defines `window.pmoPlatform` (see `docs/architecture.md`): sign in with Google, and implement the
five data calls on top of the Drive API, keeping each person's diary private. `core/` needs no changes.

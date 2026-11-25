# Architecture: one source, several platforms

`core/` is the application: pages, behaviour and styling. It is plain HTML, CSS and JavaScript with no build step.
It contains **no** storage and **no** sign-in code. Everything platform-specific is reached through one object,
`window.pmoPlatform`, which each platform defines in its own `platform.js` (loaded by the core pages before anything else).

## The platform contract

```js
window.pmoPlatform = {
  name: 'web',                       // which platform this is
  api(method, path, body),           // the data calls below; resolves with JSON, rejects with Error (.status = HTTP-style code)
  ready,                             // Promise of the signed-in person {email, role: 'admin'|'user'}; the platform sends the
                                     //   browser to its sign-in if nobody is signed in
  nav,                               // optional extra sidebar links: [{ href, label, adminOnly }]
  signOut,                           // optional: end the session (omit when the platform has no sign-out)
};
```

### The data calls

The core app asks for data with these calls. A platform may implement them over HTTP, over a cloud API, or locally;
what matters is the shape.

| Call | Meaning | Response |
|---|---|---|
| `GET /api/data` | Everything shared: entries, labels | `{ initialized, items[], labels[], storage }` |
| `POST /api/data/sync` | Save changes | body `{ upserts[], deletes[], labels? }` |
| `PUT /api/data` | Replace everything (import, sample data, clear) | body `{ items[], labels[] }` |
| `GET /api/journal` | The signed-in person's private diary notes | `{ notes[] }` |
| `POST /api/journal/sync` | Save diary changes | body `{ upserts[], deletes[] }` |

An entry is `{ id, type, parentId, name, team, status, start, end, effort, focus, focusWhy, summary, details, notes[], createdAt, updatedAt }`.
The platform is responsible for **validating** what it stores (the web platform does this in `platforms/web/server/validate.js`)
and for **owner-scoping** the diary: a person only ever sees and changes their own notes.

## What each platform owns

| | Web | Android (planned) | Microsoft stack (planned) |
|---|---|---|---|
| Storage | SQL Server Express (schema `pmo`) | Google Drive | Dataverse |
| Sign-in | Login/password + SAML 2.0 | Google sign-in | Inherited from Power Platform |
| First-time setup | Wizard: connect, create or load a database, first administrator | — | Publishing creates the tables |
| Extra pages | `login`, `setup`, `admin` | — | — |

## How the web platform serves the app

`platforms/web/server.js` serves two folders as one site: `platforms/web/public` first (its `platform.js`, login, setup and
administration pages), then `core/`. The core pages ask for `platform.js` and get the web one. A different platform would ship its own
`platform.js` next to the same `core/` files.

## Adding a platform

1. Create `platforms/<name>/` with a `platform.js` that defines `window.pmoPlatform` as above.
2. Implement the five data calls over that platform's storage, with the same validation and diary scoping.
3. Provide whatever packaging the target needs (an app shell, a solution package) around `core/`.

## Open questions for the planned platforms

- **Android:** wrap `core/` in a WebView shell (for example Capacitor); Google Drive as the store means choosing between one JSON document
  (simple, last-write-wins) and per-entry files, and deciding who may share a Drive folder.
- **Microsoft stack:** Power Apps canvas apps are not HTML pages, so `core/` cannot be hosted in one directly. The options to evaluate are
  Power Apps *code apps* (a web app that uses the Power Platform's sign-in and Dataverse), a model-driven app with a custom page, or
  rebuilding the screens natively. Each Dataverse table would mirror the `pmo` schema (Item, Note, Label, JournalNote, plus per-user ownership).

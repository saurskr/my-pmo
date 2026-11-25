# my-pmo

A lightweight hub for IT leadership to keep a finger on many projects and major items at once —
without turning into a task tracker: status icons, labelled notes, a focus list of five, a timeline,
and a private diary with meeting names.

One source, several ways to run it. The app itself lives in `core/` and never talks to a database or
a sign-in system directly; each **platform** supplies those two things.

| Platform | Data is stored in | Authentication | Setup | Status |
|---|---|---|---|---|
| **Web** (`platforms/web`) | SQL Server Express | Login/password and SAML 2.0 (e.g. Microsoft Entra) | First-run wizard: connect, then create a new database or load an existing one | **Built** |
| **Android** (`platforms/android`) | Google Drive | Google (Gmail) sign-in | — | Planned |
| **Microsoft stack** (`platforms/powerapps`) | Dataverse | Inherited from Power Platform (Entra SSO) | Publishing creates the Dataverse tables | Planned |
| **Demo** (`platforms/demo`) | A sample JSON file (changes kept in the visitor's browser tab) | None: SQL and sign-in are bypassed | None | **Built** (published with GitHub Pages) |

See [`docs/architecture.md`](docs/architecture.md) for how the pieces fit and what a new platform has to provide.

## Run the web platform

You need **Node.js 18+** and **SQL Server Express** (free; install it yourself from
[Microsoft's download page](https://www.microsoft.com/en-us/sql-server/sql-server-downloads)).
In SQL Server Express, turn on **mixed-mode** authentication (so a SQL login can be used) and **TCP/IP**
(SQL Server Configuration Manager). For a named instance such as `localhost\SQLEXPRESS` the *SQL Server Browser*
service must be running, or use `localhost,<port>` instead.

```
cd platforms/web
npm install
node server.js
```

The terminal prints a **setup code** and the address (http://localhost:3000). Open `/setup.html` and:

1. enter the setup code (it proves you are the person who started the server),
2. enter the server, database name and SQL login, and press **Test connection**,
3. choose **Create a new database** or **Use an existing database** (an older my-pmo database is upgraded in place; its data is kept),
4. create the first administrator (skipped if the database already has one).

After that you land in the app, signed in. Everyone else signs in at the login page.
The SQL login needs the `dbcreator` role to create a database, or `db_owner` on a database that already exists.

### Settings

| Environment variable | Meaning | Default |
|---|---|---|
| `PORT` | Port to listen on | `3000` |
| `HOST` | Address to listen on. Set `0.0.0.0` so other computers can reach it | `127.0.0.1` (this computer only) |
| `COOKIE_SECURE` | Set `1` when users reach it over HTTPS (behind a proxy) | detected from the request |
| `PMO_DATA_DIR` | Where `config.json` (the database connection) is kept | `platforms/web/data` |

### Administration (administrators)

- **Users** — add people, set roles, reset passwords, delete accounts. The last administrator can't be removed or demoted.
- **Single sign-on (SAML 2.0)** — shows the Identifier, Reply URL and Sign-on URL to give your identity provider
  (also published as metadata at `/api/sso/metadata`); you paste back the Login URL, the identity provider's identifier and its
  signing certificate. For Microsoft Entra ID, create an enterprise application → Single sign-on → SAML and keep
  *Sign SAML assertion* on (its default). People who sign in this way get an account automatically (optional) with the
  *User* role; you can restrict by email domain. Password sign-in keeps working alongside it.
- **Database** — connection details and schema version, with an **Update schema** button after upgrading my-pmo.

### Command line

```
node server.js add-user <email> <password> [admin]   # create or reset an account (e.g. a forgotten password)
node server.js reconfigure                           # forget the database connection and run setup again (the database is untouched)
```

### Good to know

- **Data protection:** the SQL password is stored in `platforms/web/data/config.json` (readable only by the account that runs the server). Passwords are salted scrypt hashes in the database. Use a dedicated SQL login rather than `sa`.
- **HTTPS:** the server speaks plain HTTP; put it behind a reverse proxy for HTTPS when it is shared, and set the *Application URL* in Administration to the public address so the SAML URLs are right.
- **Sessions** are kept in memory: restarting the server signs everyone out. Sign-in is rate-limited after repeated failures.
- **Single sign-out** is not implemented: *Sign out* ends the my-pmo session only.
- **Edits to the same entry** by two people are last-write-wins; other people's changes appear when you reload or return to the tab.
- **Notes** (the diary) are private to each person in the app, but they are stored in the same database, so anyone with database access can read them.

## Demo (GitHub Pages)

`platforms/demo` runs the same app with no server, no SQL Server and no sign-in. The sample data is `platforms/demo/sample-data.json`
(dates can be relative, such as `+10d` or `-40d`, so the demo never looks out of date). A visitor can edit freely; changes live only in their
browser tab, and *Reset demo* brings back the original samples.

```
node platforms/demo/build.mjs      # builds the site into docs/
```

The built site is committed only on the **`demo`** branch, which GitHub Pages serves: *Settings → Pages → Deploy from a branch → `demo` → `/docs`*.
After changing `core/` or the sample file, rebuild on the `demo` branch (merge `main` into it first) and push. The site is then at
`https://<owner>.github.io/<repository>/`.

## Tests

```
cd platforms/web
PMO_TEST_SQL='localhost,1433|sa|<password>' npm test
```

The tests start the real server against a real SQL Server (they create and drop their own throwaway databases), and include a
mock SAML identity provider that signs real responses — good ones and forged, unsigned, replayed, expired and mis-addressed ones.
Without `PMO_TEST_SQL` the database tests are skipped.

## Layout

```
core/                    the app, shared by every platform
  index.html  notes.html   Summary and Notes pages
  app.js  notes.js  shell.js  status.js
  design-system/           vendored copy of github.com/saurskr/design-system (all styling)
platforms/
  web/                   Node host: setup wizard, sign-in, SAML, administration, SQL Server storage
  demo/                  static demo: sample JSON data, no sign-in (built into docs/ on the demo branch)
  android/  powerapps/   placeholders for later (see their READMEs)
docs/                    architecture notes and design mockups
```

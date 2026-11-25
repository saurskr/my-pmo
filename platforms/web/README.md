# my-pmo web platform

Node host for the shared app in `../../core`: first-run setup wizard, login/password and SAML 2.0 sign-in, administration,
and SQL Server Express storage. How to run it, its settings and its tests are in the [top-level README](../../README.md).

```
server.js          entry point and routes
server/
  sqlserver.js     connection checks, schema (versioned, upgrades in place) and the store
  setup.js         first-run wizard API (guarded by a one-time code)
  auth.js          passwords, sessions, sign-in throttling
  saml.js          SAML 2.0 service provider
  validate.js      cleans everything the browser sends
  http.js, config.js
public/            platform.js, login, setup and administration pages
test/              end-to-end tests (real server, real SQL Server, mock identity provider)
```

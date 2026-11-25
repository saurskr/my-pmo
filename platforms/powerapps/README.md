# Microsoft stack platform (planned, not built)

| | |
|---|---|
| Runs as | an app inside the Power Platform |
| Data is stored in | Dataverse |
| Authentication | inherited from the Power Platform (Microsoft Entra single sign-on) |
| Setup | publishing creates the Dataverse tables |

See "Open questions" in `docs/architecture.md`: Power Apps canvas apps cannot host `core/` as-is, so the hosting approach is to be decided first.
The data layer would mirror the web platform's `pmo` schema in Dataverse tables.

# What changed from the VisionFund repository

Every edit made when forking. Nothing else was touched — the controllers,
migrations, offline sync and business logic are byte-identical.

## Colour tokens were renamed, not just recoloured

`--orange` / `--navy` in the panel and `c.orange` / `c.navy` in the scanner
became `--brand` / `--deep` and `c.brand` / `c.deep`.

The rename matters more than the new hex. Those tokens were named after one
organisation's accent colour, and the value is going to change again: when
`organisation.primary_colour` exists, a tenant sets its own. A variable called
`--orange` holding a teal is the kind of thing that is still there in three
years, confusing everybody.

The CSS classes `badge-orange` and `badge-navy` became `badge-brand` and
`badge-deep`, which is why six JSX files appear in the list below.

## Backend

| File | Change |
|---|---|
| `src/server.js` | Root message; CORS points at the AssetHub panel |
| `src/controllers/dashboardController.js` | PDF heading and filename; accent colour |
| `src/controllers/assistantController.js` | System prompt; **asset-code pattern generalised** |
| `package.json` | `assethub-backend`; `test` now runs `node --test` |

The asset-code pattern is the one worth knowing about. It was
`(?:VFK|KDT|NC|EQP|C&P|F&F|INT)` — the seven prefixes in one organisation's
register — so the assistant would not recognise a code from any other tenant.
It is now `[A-Z][A-Z&]{1,5}` followed by 3–6 digits, which still matches all
seven and works for a new organisation on day one.

## Admin panel

Design tokens (`index.css`, `App.css`), `theme.js`, the chart palette in
`Dashboard.jsx`, logo alt text in three pages, the PDF download filename in
`api.js`, `index.html` title and icons, `config.js` API URL, and the badge
class rename across `Approvals`, `AssetDetail`, `AssetList`, `Clearances`,
`UserManagement` and `App`.

## Scanner

`theme.js` tokens, the hardcoded hexes in seven screens, the login title,
`config.js`, `db/localDb.js` (database filename), and `app.json`.

**`app.json` carries the app's identity and all of it changed:**

```
slug        vision-fund-scanner        -> assethub-scanner
package     ke.co.visionfundkenya...   -> com.assethub.scanner
bundleId    ke.co.visionfundkenya...   -> com.assethub.scanner
projectId   6754b836-...               -> REPLACE-VIA-EAS-INIT
```

Changing these on the *original* repository would have been a mistake: a new
package name makes it a new app rather than an upgrade, and officers would lose
their queued offline scans. In a fork it is correct, because this is a
different app. The old VisionFund scanner keeps its identity, its EAS project
and its update channel.

**Run `eas init` before your first build.** The old `projectId` is deliberately
invalid, so that `eas update` from this repository cannot publish to
VisionFund's installs by accident.

`db/localDb.js` opens `assethub_offline.db` instead of
`visionfund_offline.db`. On a fresh install that is simply the filename; on an
upgrade it would orphan queued scans, which is another reason the fork gets a
new package name.

## New files

`README.md`, `.env.example`, `docs/README.md`, `docs/brand/`,
`backend/scripts/README.md`, and this file.

## Deliberately left alone

- `backend/scripts/` — 30 one-off VisionFund data repairs. They are history,
  not product. `scripts/README.md` explains which two graduate into features.
- The comment in `importController.js` about `"VFK-Elnino 2"`. It documents a
  real bug — a stray hyphen turning a label into a negative number — and the
  example is what makes it comprehensible.
- Everything under `migrations/`.

## Still to do

Two placeholders, both flagged in the files:

```
ASSETHUB-API-URL.onrender.com     backend/src/server.js, both config.js
ASSETHUB-ADMIN-URL.onrender.com   backend/src/server.js
REPLACE-VIA-EAS-INIT              frontend-scanner/app.json
```

And `migrations/000_baseline.sql`, which does not exist yet and should before
any multi-tenant migration is written.

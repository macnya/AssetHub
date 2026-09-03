# AssetHub — from pushed repo to running system

Everything from where you are now (code on GitHub, `npm install` done) to a
deployed system ready for the multi-tenant work.

Ten parts. Each ends with something you can check, so a mistake surfaces at the
step that caused it rather than three steps later.

> The Supabase and Render interfaces change. Where a click path here does not
> match what you see, the *thing* you are looking for is described as well as
> where it was — find that instead of following the path literally.

---

## Part 0 — Tidy the remote

GitHub redirected your push because the repo is `AssetHub` and you pushed to
`assethub`. It worked, but fix the URL so it stops redirecting:

```powershell
cd C:\Users\ADMIN\AssetHub
git remote set-url origin https://github.com/macnya/AssetHub.git
git remote -v
```

**Check:** both lines read `AssetHub.git`.

---

## Part 1 — Install the PostgreSQL client tools

You will need `pg_dump`, `pg_restore` and `psql` locally. Not optional: the
schema cannot be rebuilt from the repository, so the only way to populate a new
database is to copy the existing one.

```powershell
winget install PostgreSQL.PostgreSQL.17
```

Close and reopen PowerShell, then:

```powershell
pg_dump --version
```

**Check:** it prints `pg_dump (PostgreSQL) 17.x`. If the command is still not
found, the installer put it somewhere off PATH — find it and add it:

```powershell
Get-ChildItem "C:\Program Files\PostgreSQL" -Recurse -Filter pg_dump.exe -ErrorAction SilentlyContinue | Select-Object FullName
$env:Path += ";C:\Program Files\PostgreSQL\17\bin"
```

Version 17 matters. Supabase runs 17, and `pg_dump` refuses to dump from a
server newer than itself — the workflow in this repo has a whole step
about that mistake.

---

## Part 2 — Create the AssetHub Supabase project

1. New project. Name it `assethub`. **Choose the same Postgres major version
   as the VisionFund project** or the restore in Part 4 may complain.
2. Save the database password somewhere immediately — Supabase shows it once.
3. Find the connection strings: the **Connect** button in the top bar.

You need two of them and they are not interchangeable:

| Which | Port | For |
|---|---|---|
| **Session pooler** | 5432 | `pg_dump`, `pg_restore`, `psql`, and migrations |
| **Transaction pooler** | 6543 | the API, later, once connection count matters |

Start the API on the session pooler. Move it to the transaction pooler only
when you have enough tenants to need it — and read the note in Part 9 first,
because `SET` behaves differently there.

**Check:**

```powershell
psql "SESSION-POOLER-URI-HERE" -c "SELECT version();"
```

It prints a PostgreSQL version banner.

---

## Part 3 — Copy the VisionFund data across

Your development database should hold real data. Multi-tenancy work needs the
2,117 assets with their messy spellings, the 112 shared serials, the three
person-named locations. A clean database lets bugs through that real data
catches.

**Dump the old one** (session pooler URI from the *VisionFund* project):

```powershell
cd C:\Users\ADMIN
pg_dump "VISIONFUND-SESSION-URI" --format=custom --schema=public --no-owner --no-privileges --file=vf-seed.dump
```

**Check:** the file is more than 1 MB.

```powershell
Get-Item vf-seed.dump | Select-Object Length
```

**Restore into the new one:**

```powershell
pg_restore --dbname="ASSETHUB-SESSION-URI" --no-owner --no-privileges --clean --if-exists vf-seed.dump
```

Some notices and "does not exist, skipping" lines are normal on a fresh
database. Errors mentioning `must be owner` or `permission denied for schema`
are not — those mean you are connecting as the wrong role.

**Check:**

```powershell
psql "ASSETHUB-SESSION-URI" -c "SELECT count(*) FROM asset;"
```

Expect **2311**.

```powershell
psql "ASSETHUB-SESSION-URI" -c "SELECT status, count(*) FROM asset GROUP BY status ORDER BY 1;"
```

Expect Assigned 772, Disposed 170, In Stock 1354, Lost 16.

---

## Part 4 — The baseline migration

This is the thing that has cost the most so far. Migrations 001–003, 005 and
006 were never committed, so nobody can rebuild this database from the
repository. Every schema surprise — `location.branch` being NOT NULL,
`import_batch`'s real column names, the `programme` column, `scan_log`
referencing `location` twice — was found by running a query and reading an
error.

You are about to write a migration that touches sixteen tables. Do it blind and
it will fail halfway.

```powershell
cd C:\Users\ADMIN\AssetHub\backend
pg_dump "ASSETHUB-SESSION-URI" --schema-only --schema=public --no-owner --no-privileges --file=migrations/000_baseline.sql
```

Put a header on it explaining what it is, so a bare dump in a migrations folder
is not confusing:

```sql
-- Baseline: the schema as it stood when AssetHub was forked.
--
-- Migrations 001-003, 005 and 006 were never committed to the original
-- repository, so this file is the only complete record. Run it first on an
-- empty database, then 004, 007, 008, 009 in order.
--
-- Regenerate after any schema change:
--   pg_dump "$DATABASE_URL" --schema-only --schema=public \
--     --no-owner --no-privileges --file=migrations/000_baseline.sql
```

**Check:** the constraint that stopped an import is in there.

```powershell
Select-String -Path migrations\000_baseline.sql -Pattern "CREATE TABLE public.location" -Context 0,12
```

You want `branch character varying(...) NOT NULL` in that block.

```powershell
Select-String -Path migrations\000_baseline.sql -Pattern "CREATE TABLE" | Measure-Object
```

Expect 16 or so.

Then commit it — this is the single most valuable file you will add this week:

```powershell
cd ..
git add backend/migrations/000_baseline.sql
git commit -m "Add a schema baseline the repository can be rebuilt from"
git push
```

---

## Part 5 — The app_user role

Row-level security is the whole basis of the multi-tenant plan, and **Supabase's
default `postgres` role has BYPASSRLS**. If the API connects as that role, every
policy you write later is decorative.

Create the role now, before any code depends on it. In the Supabase SQL editor:

```sql
CREATE ROLE app_user LOGIN PASSWORD 'pick-something-long';

GRANT USAGE ON SCHEMA public TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user;

-- Tables created later must be reachable too, or the next migration silently
-- produces a table the API cannot read.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO app_user;
```

**Check that it cannot bypass RLS:**

```sql
SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'app_user';
```

Both `rolsuper` and `rolbypassrls` must be **false**. If either is true, the
isolation you build later is not real.

Build the API's connection string by taking the session-pooler URI and
replacing the username and password with `app_user` and its password.

**Check it works and can see data:**

```powershell
psql "APP-USER-URI" -c "SELECT count(*) FROM asset;"
```

---

## Part 6 — Run it locally

Before involving deployment, prove the rename did not break the wiring.

```powershell
cd C:\Users\ADMIN\AssetHub\backend
Copy-Item ..\.env.example .env
notepad .env
```

Fill in:

- `DATABASE_URL` — the **app_user** session-pooler URI
- `MIGRATION_DATABASE_URL` — the **postgres** session-pooler URI
- `JWT_SECRET` — new and long. Generate one:
  ```powershell
  -join ((1..64) | ForEach-Object { '{0:x}' -f (Get-Random -Max 16) })
  ```
- `GROQ_API_KEY` — a new key, not VisionFund's
- `BOT_SERVICE_SECRET` — another random string
- `PORT=5000`

```powershell
npm run dev
```

**Check:** open `http://localhost:5000` — it says **AssetHub API running**.
That single line proves dotenv loaded, express started, and the rename did not
break the entry point.

Then the panel, in a second terminal:

```powershell
cd C:\Users\ADMIN\AssetHub\frontend-admin
```

Temporarily point it at your local API — edit `src/config.js`:

```js
export const API_BASE_URL = 'http://localhost:5000';
```

```powershell
npm run dev
```

**Check:** the login page shows the AssetHub cube and wordmark, buttons are
teal, and you can sign in with a VisionFund account (the data came across in
Part 3). The dashboard should read 2,311 assets across 34 branches.

Put `config.js` back to the placeholder before committing, or set it from an
environment variable — see Part 8.

---

## Part 7 — Deploy the API to Render

New **Web Service**, connected to the `AssetHub` repository.

| Setting | Value |
|---|---|
| Root directory | `backend` |
| Build command | `npm install` |
| Start command | `npm start` |
| Instance type | Free to begin with |

Environment variables: everything from your `.env` **except** `PORT` — Render
sets that itself, and `server.js` already reads `process.env.PORT`.

Do **not** paste `MIGRATION_DATABASE_URL` into Render. The API has no business
holding a superuser connection string.

**Check:** open the Render URL. It says **AssetHub API running**.

Note the hostname. That is your `ASSETHUB-API-URL`.

> The free instance spins down when idle, so the first request after a quiet
> period takes 50 seconds or more. That is expected now and worth paying to
> remove before any prospective tenant sees it.

---

## Part 8 — The three placeholders, and the panel deploy

```powershell
cd C:\Users\ADMIN\AssetHub
Get-ChildItem -Recurse -Include *.js,*.json | Where-Object { $_.FullName -notlike "*node_modules*" } | Select-String "ASSETHUB-.*-URL|REPLACE-VIA-EAS-INIT"
```

Four hits across four files:

| File | Replace |
|---|---|
| `backend/src/server.js` | `ASSETHUB-ADMIN-URL` — the panel's Render hostname |
| `frontend-admin/src/config.js` | `ASSETHUB-API-URL` |
| `frontend-scanner/config.js` | `ASSETHUB-API-URL` |
| `frontend-scanner/app.json` | `REPLACE-VIA-EAS-INIT` — see Part 10 |

The panel's own hostname does not exist until you deploy it, so deploy first
and come back for `server.js`.

New **Static Site** on Render, same repository:

| Setting | Value |
|---|---|
| Root directory | `frontend-admin` |
| Build command | `npm install; npm run build` |
| Publish directory | `dist` |

Then set `ASSETHUB-ADMIN-URL` in `server.js` to that hostname, commit, push, and
let the API redeploy — otherwise CORS blocks the panel and every request fails
with nothing useful in the console.

```powershell
git add -A
git commit -m "Point the deployments at each other"
git push
```

**Check:** open the panel's URL, sign in, load the dashboard. If requests fail,
open DevTools → Network and look for a CORS error — that means `server.js` has
the wrong hostname or the API has not finished redeploying.

---

## Part 9 — Verify, properly

Six things, each of which has actually gone wrong at least once:

**1. The API is talking to the right database.**
```sql
SELECT current_database(), current_user, inet_server_addr();
```
Run it through the app, not the SQL editor — the assistant endpoint or a quick
temporary route. `current_user` must be `app_user`.

**2. Nothing points at VisionFund's database.** Check Render's environment
variables by eye. A development deployment reaching a live register is the
mistake that costs the most and announces itself the least.

**3. The scanner's offline tests pass.**
```powershell
cd frontend-scanner; npm test
```
Expect 6/6.

**4. The import works end to end.** Upload the cleaned register through the
panel. Expect 2,117 rows, 70 rejections, and — because the data is already
there — almost everything "unchanged".

**5. The nightly backup runs.** The workflow needs its secret:
Repo → Settings → Secrets and variables → Actions → `BACKUP_DATABASE_URL`, set
to the **session pooler** URI. The workflow refuses a `:6543` string outright.
Then Actions → Backup database → Run workflow, and confirm it goes green.

**6. Rotate what needs rotating.** `JWT_SECRET`, `GROQ_API_KEY` and
`BOT_SERVICE_SECRET` should all be new values, not copies of VisionFund's.
You are about to hold other organisations' data.

---

## Part 10 — The scanner

Its identity is entirely new — `slug`, `package` and `bundleIdentifier` all
changed in the fork — so it needs its own EAS project.

```powershell
cd C:\Users\ADMIN\AssetHub\frontend-scanner
npx eas login
npx eas init
```

`eas init` writes a real `projectId` over the `REPLACE-VIA-EAS-INIT`
placeholder. **That placeholder is deliberately invalid**, so that
`eas update` from this repository cannot publish to VisionFund's installed apps
by accident.

Icons are native assets, so the first release must be a build, not an update:

```powershell
npx eas build --platform android --profile preview
```

Only after a build has been installed does `eas update` do anything useful.

**Check:** install the APK. The icon is the teal cube, the login screen says
**AssetHub Scanner**, and signing in reaches the AssetHub API rather than
VisionFund's.

---

## Then: the multi-tenant work

`docs/going-multi-tenant.md` has the design. Phase 1 is:

1. `organisation` table, VisionFund inserted as org 1
2. `org_id` on the sixteen tenant tables, defaulting to
   `current_setting('app.org_id')::int`
3. Composite unique indexes — two organisations will both have an `EQP/001`
4. RLS enabled and forced, policies written
5. `backend/src/db/context.js`, and the controllers switched from `pool` to `db`

The product looks identical when Phase 1 lands. That is the point: verify
nothing broke before anything depends on the isolation.

Bring me the output of this before we write the migration, because the unique
and primary key constraints decide half of it:

```sql
SELECT conrelid::regclass AS table_name, conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE contype IN ('u','p') AND connamespace = 'public'::regnamespace
ORDER BY 1;
```

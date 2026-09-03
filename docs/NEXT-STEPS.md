# After the first deployment

Three things, in order. The first two take twenty minutes. The third is real
work and is written to be done over more than one sitting.

---

# 1. Point backups at the new database

`.github/workflows/backup-database.yml` runs nightly and reads a repository
secret called `BACKUP_DATABASE_URL`. That secret currently holds the VisionFund
connection string, so the workflow is faithfully backing up somebody else's
database into your repository's artifacts.

## Step 1.1 — Change the secret

1. GitHub → the **AssetHub** repository → **Settings**
2. Left sidebar: **Secrets and variables** → **Actions**
3. Find `BACKUP_DATABASE_URL` → **Update**
4. Paste the AssetHub connection string, with the password included
5. **Update secret**

It must end in **`:5432`**. The workflow refuses `6543` and tells you why.

Use the `postgres` connection string here, not `app_user`. A backup has to read
every table, and once row-level security is on, `app_user` sees only what its
organisation context allows — which for a script with no context is nothing.
A backup that silently dumps zero rows is worse than no backup, because it
looks like protection.

## Step 1.2 — Run it once by hand

1. **Actions** tab → **Backup database** → **Run workflow**
2. Wait for the green tick

The workflow fails deliberately if the dump is under 50KB or holds fewer than
eight tables, so a green tick means the backup is real. This is the check most
backup arrangements do not have, and it is the reason you find out today rather
than on the day you need to restore.

## Step 1.3 — Look inside the artifact

Download it from the run page and open the zip. Three files:

| File | What it is |
|---|---|
| `assethub-DATE.dump` | Everything, compressed. This is what you restore from. |
| `assethub-DATE.sql.gz` | The same, as readable SQL |
| `schema-DATE.sql` | Structure only |

Worth doing once so that the first time you open one of these is not the day
something has gone wrong.

## Something to fix before you have customers

The artifact contains the whole database, including `it_staff` password hashes,
and anyone with read access to the repository can download it for ninety days.
Acceptable for one organisation you run yourself. Not acceptable once you hold
other people's registers — that becomes object storage with encryption at rest
and a much shorter retention.

---

# 2. Put something in

An empty register proves the plumbing but not the product. Twenty minutes of
real data will surface more than an hour of reading.

## The quick version: one asset by hand

Sign in, **Assets** → **New asset**. Give it a code and a description; the rest
can wait.

Then walk it round the loop the whole system is built for:

1. **Assets** → open it → the detail page
2. Print or note its code
3. **Map** → find it → request a custody change to a branch and a person
4. **Approvals** → the request is waiting. Try to approve your own: it refuses.
   That is the maker-checker control working, not a fault.
5. **Activity** → the request appears in the trail

You now know the custody path works end to end, which is the thing that most
often breaks after a deployment.

## The real version: import a spreadsheet

**Import** → choose a file. It needs an `ASSET CODE` column and a `DESCRIPTION`
column; everything else is optional.

Nothing is written until you confirm. The preview shows four numbers — new,
would change, already correct, unreadable — and a tab for each. Read the
**Unreadable** and **Warnings** tabs before pressing the button; they are where
the surprises live.

If you have no spreadsheet to hand, make one with three columns and five rows.
The point is to see the preview, not to load real data.

> **The importer expects one organisation's column names.** `FIELDS` in
> `importController.js` is a hardcoded list of the header spellings that appear
> in VisionFund's workbook — including `NAM E OF USER`, which has a typo in it.
> A different organisation's file will not match, and making that a mapping
> screen rather than a hardcoded list is the single highest-value thing to
> build after multi-tenancy.

## Then take a backup

Now that there is data:

**Actions** → **Backup database** → **Run workflow**

And keep that artifact. It is the state you can return to if the next section
goes wrong.

---

# 3. Phase 1 of multi-tenancy

The goal: every row belongs to an organisation, and the database — not the
application — enforces it.

Nothing about the product changes. Same screens, same data, one organisation.
What changes is that a second one becomes possible without a rewrite.

**Take a backup first.** This alters sixteen tables.

## What you are working with

- Two migrations, `010_organisations.sql` and `011_row_level_security.sql`
- One new module, `src/db/context.js`
- Sixteen controller files needing a one-line import change

The migrations are written as loops over a list of table names rather than
sixteen repeated blocks, so a table cannot be missed by a slip of the eye. Both
are safe to run twice.

---

## Step 3.1 — Add org_id everywhere

```powershell
cd C:\Users\ADMIN\AssetHub\backend
$env:PGPASSWORD = 'YOUR_POSTGRES_PASSWORD'
$PG = "postgresql://postgres.YOURPROJECTREF@YOURHOST.pooler.supabase.com:5432/postgres"

psql $PG -f migrations\010_organisations.sql
```

Expect sixteen `NOTICE: org_id added to ...` lines.

Check it:

```powershell
psql $PG -c "SELECT c.relname, a.attnotnull FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid WHERE a.attname = 'org_id' AND c.relkind = 'r' ORDER BY 1;"
```

Sixteen rows, `attnotnull` true on all of them.

```powershell
psql $PG -c "SELECT id, code, name, status FROM organisation;"
```

One row: `1 | visionfund | VisionFund Kenya | active`. Rename it later if you
would rather the first organisation was called something else — nothing depends
on the name, only on the id.

## Step 3.2 — Fix the unique constraints

**This is the step that cannot be automated, and skipping it means the second
organisation cannot have an asset called EQP/001.**

```powershell
psql $PG -c "SELECT conrelid::regclass AS tbl, conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE contype='u' AND connamespace='public'::regnamespace ORDER BY 1;"
```

```powershell
psql $PG -c "SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname='public' AND indexdef LIKE '%UNIQUE%' ORDER BY 1;"
```

Read both lists. Anything unique that does not already begin with `org_id` has
to be rebuilt to include it. Two you can expect to find:

```sql
-- Asset codes: unique within an organisation, not across all of them.
DROP INDEX IF EXISTS asset_asset_code_key;
CREATE UNIQUE INDEX asset_code_per_org ON asset (org_id, asset_code);

-- One open custody request per asset, per organisation.
DROP INDEX IF EXISTS idx_one_open_request_per_asset;
CREATE UNIQUE INDEX idx_one_open_request_per_asset
  ON custody_request (org_id, asset_id) WHERE status = 'pending';
```

The names in your database may differ — use what the queries actually printed.

**`it_staff.email` deserves a decision rather than a reflex.** Unique across
the whole table means one person cannot work for two organisations. Unique per
organisation means sign-in needs the organisation code to tell two accounts
apart — which is the design anyway, and it allows the consultants, auditors and
shared finance staff who genuinely exist:

```sql
DROP INDEX IF EXISTS it_staff_email_key;
CREATE UNIQUE INDEX staff_email_per_org ON it_staff (org_id, LOWER(email));
```

## Step 3.3 — Turn isolation on

```powershell
psql $PG -f migrations\011_row_level_security.sql
```

Sixteen `NOTICE: isolation on ...` lines.

## Step 3.4 — Prove it, as app_user

**As `app_user`, not `postgres`.** The postgres role bypasses row-level
security, so every check below passes for it whether the policies work or not.
That is the easiest way to convince yourself of something untrue.

```powershell
$env:PGPASSWORD = 'YOUR_APP_USER_PASSWORD'
$AU = "postgresql://app_user.YOURPROJECTREF@YOURHOST.pooler.supabase.com:5432/postgres"

psql $AU -c "SELECT current_user;"
psql $AU -c "SET app.org_id = 1; SELECT count(*) FROM asset;"
psql $AU -c "SET app.org_id = 2; SELECT count(*) FROM asset;"
psql $AU -c "SELECT count(*) FROM asset;"
```

| Query | Expected |
|---|---|
| `current_user` | `app_user` |
| org 1 | your real asset count |
| org 2 | **0** |
| no setting at all | **0** |

The last one matters most. It is the behaviour that turns a forgotten filter
from a silent breach into a visible bug.

Then try to write across the boundary:

```powershell
psql $AU -c "SET app.org_id = 1; INSERT INTO asset_category (name, org_id) VALUES ('x', 2);"
```

Must fail with `new row violates row-level security policy`. If it succeeds,
`WITH CHECK` is missing and reads are protected while writes are not.

## Step 3.5 — Give the application its context

**The API is now broken.** Every query runs on a connection with no
`app.org_id`, so every screen shows nothing. That is correct and temporary.

Three changes.

**Put `org_id` in the token.** In `src/controllers/authController.js`, the
`login` and `refreshToken` queries against `it_staff` need `org_id` in their
`SELECT`, and it goes into the signed payload and the returned user object.

**Read it back on every request.** In `src/middleware/authMiddleware.js`,
`verifyToken` already re-reads the account from the database rather than
trusting the token — add `org_id` to that `SELECT` and to `req.user`. The
comment there explains why the database wins over the token, and the reasoning
carries over unchanged.

**Mount the middleware.** In `src/server.js`, after the routes are required:

```js
const { orgContextMiddleware } = require('./db/context');
```

and after `express.json` but before the route mounts:

```js
app.use(orgContextMiddleware);
```

**Then swap the import in sixteen controllers.** In each of
`src/controllers/*.js` and `src/utils/scope.js`:

```js
-const pool = require('../db/pool');
+const { db } = require('../db/context');
```

and change `pool.` to `db.` within that file. 107 call sites, all mechanical.

Find any you missed:

```powershell
Get-ChildItem -Recurse src\controllers,src\utils -Include *.js | Select-String "pool\."
```

Should come back empty. Anything left will throw
`No organisation context for this query` the first time it runs, which is by
design — a query outside a request must fail where the mistake is, not where it
shows.

## Step 3.6 — The scripts

Everything under `scripts/` connects with `pool` directly and has no
organisation context. After 011 they will see an empty database.

`createFirstAdmin.js` is the one that matters, and its job has changed: on a
multi-tenant system the first act is creating an organisation *and* its first
admin together. The rest can be fixed as you need them, by wrapping their work:

```js
const { runInOrgContext } = require('../src/db/context');

runInOrgContext(1, async () => {
  // the script's existing body
});
```

## Step 3.7 — Check the whole thing still works

Locally first:

```powershell
cd backend
npm run dev
```

Sign in through the panel at `http://localhost:5173`. You should see exactly
what you saw before: same assets, same counts. Nothing about the product has
changed — only who is allowed to see it, and that is now the database's opinion
rather than the application's.

If a screen is empty, that screen's controller still uses `pool`.

Then push, let Render redeploy, and check the deployed panel.

---

## What comes after Phase 1

`docs/going-multi-tenant.md` has the rest: the organisation code on the login
form, self-serve registration, the per-organisation settings that replace the
hardcoded currency and conditions and policy references, and the column-mapping
import that a second organisation will need on its first day.

Phase 2 in that document — *prove the boundary* — is worth doing properly.
Create a second organisation by hand, seed it, log in as each, and try to reach
across. An isolation bug found there costs an afternoon. The same bug found in
production costs a customer.

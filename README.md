# AssetHub

A fixed asset register that organisations can sign up for: what you own, where
it is, who has it, and what it is worth.

Built from a single-tenant system written for VisionFund Kenya, which becomes
the first organisation on it.

---

## What is here

```
backend/            Express API, Postgres
  src/
    controllers/    One per resource. 232 SQL queries live here.
    routes/         Mount points and role gates.
    middleware/     verifyToken, requireRole, rate limits.
    utils/          scope.js — how a Branch Administrator is confined.
    constants/      Vocabularies that are about to become per-organisation.
    db/             Connection pool.
  migrations/       Numbered SQL. Run in order.
  scripts/          Operational tools. See scripts/README.md.

frontend-admin/     React + Vite. The desk-based panel.
frontend-scanner/   Expo. The phone app officers carry, works offline.

docs/               Design notes and history. Read before changing SQL.
```

## Running it

```bash
cd backend && npm install && cp ../.env.example .env   # then fill it in
npm run dev

cd frontend-admin && npm install && npm run dev
cd frontend-scanner && npm install && npx expo start
```

## Before you change anything that touches SQL

The schema is the part most likely to surprise you. Read the real thing rather
than inferring it from the code:

```sql
SELECT table_name, column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
ORDER BY table_name, ordinal_position;
```

And for anything that deletes rows, ask the catalog which tables point at what
you are deleting, rather than listing them by hand. `location` is referenced by
six columns across four tables, and two of them are easy to forget.

`docs/session-notes-2026-08-21.md` records what happened the last time somebody
guessed.

## Where this is going

`docs/going-multi-tenant.md` — the design and the sequencing. In short: one
shared schema, an `org_id` on every tenant table, and Postgres row-level
security doing the enforcement so that a forgotten filter returns nothing
rather than everything.

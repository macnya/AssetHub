// One organisation per request, set once, applied to every query it runs.
//
// WHY IT LOOKS LIKE THIS
// The controllers all do `require('../db/pool')` and call `pool.query`. Nobody
// passes a client around. That accident of style is what makes multi-tenancy
// tractable: change what this module exports and 232 call sites inherit the
// behaviour without being edited.
//
// pool.query checks out a different connection each time, so a setting applied
// to one query would not be there for the next. Instead a single connection is
// held for the life of the request, with app.org_id set on it, and every query
// in that request runs down the same wire.
//
// The setting is applied with set_config(..., true) — the LOCAL form, scoped
// to the transaction. Session-level SET does not survive Supabase's
// transaction-mode pooler on port 6543; this form works on both poolers and on
// a direct connection, which is worth having before the port ever changes.
//
// A side effect worth naming: every request is now a transaction. A request
// that fails halfway leaves nothing behind. The import already depended on
// that; now everything does.

const { AsyncLocalStorage } = require('node:async_hooks');
const pool = require('./pool');

const orgContext = new AsyncLocalStorage();

async function runInOrgContext(orgId, fn) {
  if (!Number.isInteger(orgId)) {
    throw new Error(`runInOrgContext needs an integer org id, got ${orgId}`);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', ['app.org_id', String(orgId)]);
    const result = await orgContext.run({ client, orgId, depth: 0 }, fn);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    // The rollback can itself fail if the connection died. Swallowing that
    // keeps the original error — the useful one — from being replaced.
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Eight controllers open their own transaction: connect(), BEGIN, work,
// COMMIT, release(). That was right when each request had no transaction of
// its own. It is wrong now — a second checkout would get a different
// connection, one with no app.org_id on it, and every query would quietly see
// nothing.
//
// What those controllers actually want is to undo their own work on failure
// without destroying the whole request. That is a savepoint. So connect()
// hands back the request's existing client with BEGIN, COMMIT and ROLLBACK
// rewritten as savepoint operations, and release() doing nothing because the
// connection is not theirs to return.
//
// The controllers are left exactly as they are. Their comments about
// atomicity stay true, which matters: the import's rollback-on-any-row-failing
// and the delete's refusal to half-remove an asset both still hold.
function savepointClient(client, store) {
  return {
    query(text, params) {
      if (typeof text === 'string') {
        const sql = text.trim().toUpperCase();
        if (sql === 'BEGIN') {
          store.depth += 1;
          return client.query(`SAVEPOINT sp_${store.depth}`);
        }
        if (sql === 'COMMIT') {
          const name = `sp_${store.depth}`;
          store.depth = Math.max(0, store.depth - 1);
          return client.query(`RELEASE SAVEPOINT ${name}`);
        }
        if (sql === 'ROLLBACK') {
          const name = `sp_${store.depth}`;
          store.depth = Math.max(0, store.depth - 1);
          return client.query(`ROLLBACK TO SAVEPOINT ${name}`);
        }
      }
      return client.query(text, params);
    },
    // Deliberately nothing. Returning this connection to the pool mid-request
    // would strand every query that came after it.
    release() {},
  };
}

const db = {
  query(text, params) {
    const store = orgContext.getStore();

    // Throwing rather than falling back to the pool is the entire point.
    // A query with no organisation context would run against a connection
    // where app.org_id is unset; the row-level security policies would then
    // return nothing, and the caller would see an empty register rather than
    // an error. Better to fail where the mistake is than where it shows.
    if (!store) {
      throw new Error(
        'No organisation context for this query. Requests get one from the ' +
        'orgContext middleware; scripts and jobs must wrap their work in ' +
        'runInOrgContext(orgId, fn).'
      );
    }

    return store.client.query(text, params);
  },

  currentOrgId() {
    return orgContext.getStore()?.orgId ?? null;
  },

  // The transaction pattern, redirected onto the request's own connection.
  async connect() {
    const store = orgContext.getStore();
    if (!store) {
      throw new Error('No organisation context for this transaction.');
    }
    return savepointClient(store.client, store);
  },

  // For the few places that legitimately run before an organisation is known:
  // looking one up by its code at sign-in, and the health check. These must
  // never touch a tenant table — the policies would return nothing anyway, but
  // reaching for this is the moment to ask why.
  unscoped: pool,
};

// Express middleware. Mount after verifyToken, before the routes.
//
// The promise resolves when the response finishes, which is what keeps the
// transaction open for the whole request rather than closing the moment next()
// returns. 'close' is there as well as 'finish' because a client that hangs up
// mid-response fires only the former, and without it the connection would be
// held until the pool timed it out.
function orgContextMiddleware(req, res, next) {
  if (!req.user?.org_id) return next();

  runInOrgContext(req.user.org_id, () => new Promise((resolve) => {
    res.on('finish', resolve);
    res.on('close', resolve);
    next();
  })).catch(next);
}

module.exports = { db, runInOrgContext, orgContextMiddleware, orgContext };
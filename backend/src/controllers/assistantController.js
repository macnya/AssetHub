const Groq = require('groq-sdk');
const { db } = require('../db/context');
const { branchScopeFor } = require('../utils/scope');
const { ROLES, canonicalRole } = require('../middleware/authMiddleware');

// POST /assistant â€” a natural-language front door to the register.
//
// WHY THIS LIVES IN THE BACKEND
// The Slack bot answered the same questions with its own copy of the queries,
// its own scope handling and its own way of working out who was asking. Adding
// a third copy for the admin panel and a fourth for the scanner is how a system
// starts contradicting itself â€” which is exactly what happened to asset.status
// and the custody records.
//
// Here, verifyToken has already established who the caller is, what role they
// hold and which branch they are scoped to. The assistant inherits all of it.
//
// THE MODEL NEVER TOUCHES THE DATABASE. It receives the result of a query and
// turns it into a sentence. It cannot write SQL, cannot choose a table, and
// cannot see anything the caller's own role would not already show them. A
// prompt-injection attempt reaches a summariser, not a query planner.

// Constructed lazily. The SDK throws if the key is missing, and doing that at
// module load took the ENTIRE backend down â€” the register stopped serving 2,311
// assets because an optional assistant had no credential. One endpoint
// returning a clear error is the right failure mode; the API falling over is
// not.
let groq = null;

function getGroq() {
  if (!process.env.GROQ_API_KEY) return null;
  if (!groq) groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
  return groq;
}

// Retired models 404 at runtime rather than at build time, so this is
// configurable without a code change.
const MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-20b';

const SYSTEM_PROMPT = `You are the AssetHub asset register assistant.

You are given DATA retrieved from the register and a QUESTION. Answer only from
the DATA. Be brief â€” two or three sentences.

If the DATA says nothing was found, say so plainly and suggest what to try
instead. Never invent an asset, a figure, a policy or a person's name. Never
guess at a number. If the DATA is empty, say you could not find it rather than
offering a general answer, because a plausible wrong answer about company
property is worse than no answer.

Amounts are Kenyan shillings. Write them as "KES 1,234".`;

// ---------------------------------------------------------------------------
// Retrieval. Each of these applies the caller's branch scope, so an answer can
// never contain more than the panel would show the same person.
// ---------------------------------------------------------------------------

// Branch names are matched against the register rather than parsed out of the
// question. Nothing the user types reaches a query as an identifier.
let branchCache = null;
let branchCacheExpiry = 0;

async function knownBranches() {
  if (branchCache && Date.now() < branchCacheExpiry) return branchCache;
  const { rows } = await db.query(
    `SELECT DISTINCT branch FROM location WHERE branch IS NOT NULL AND branch <> ''`
  );
  branchCache = rows.map((r) => r.branch);
  branchCacheExpiry = Date.now() + 10 * 60 * 1000;
  return branchCache;
}

async function findBranch(text) {
  const lower = text.toLowerCase();
  const branches = await knownBranches();
  // Longest match first, so "Eldoret East" is not mistaken for "Eldoret".
  return branches
    .slice()
    .sort((a, b) => b.length - a.length)
    .find((b) => lower.includes(b.toLowerCase())) || null;
}

async function assetByCode(text, scope) {
  const match = text.toUpperCase().match(/\b([A-Z][A-Z&]{1,5}[\s\-\/]?\d{3,6})\b/);
  if (!match) return null;
  const code = match[1].replace(/[\s\-]/g, '');

  const { rows } = await db.query(
    `SELECT a.asset_code, a.description, a.status, a.condition, a.purchase_price,
            ac.name AS category, e.name AS holder,
            l.branch, l.department, l.physical_location
     FROM asset a
     LEFT JOIN asset_category ac ON ac.id = a.asset_category_id
     LEFT JOIN assignment ag ON ag.asset_id = a.id AND ag.returned_date IS NULL
     LEFT JOIN employee e ON e.id = ag.employee_id
     LEFT JOIN location l ON l.id = ag.location_id
     WHERE a.asset_code = $1
       AND a.approval_status = 'approved'
       AND ($2::text IS NULL OR l.branch = $2)`,
    [code, scope]
  );

  // "Not in the register" and "not at your branch" give the same answer.
  // Distinguishing them would let a scoped user map the register one code at a
  // time.
  return { code, asset: rows[0] || null };
}

async function branchSummary(branch, scope) {
  const { rows } = await db.query(
    `SELECT COALESCE(ac.name, 'Uncategorised') AS category,
            COUNT(DISTINCT a.id)::int AS assets,
            COALESCE(SUM(a.purchase_price), 0)::numeric AS value
     FROM asset a
     JOIN assignment ag ON ag.asset_id = a.id AND ag.returned_date IS NULL
     JOIN location l ON l.id = ag.location_id
     LEFT JOIN asset_category ac ON ac.id = a.asset_category_id
     WHERE l.branch = $1
       AND a.approval_status = 'approved'
       AND ($2::text IS NULL OR l.branch = $2)
     GROUP BY ac.name
     ORDER BY assets DESC`,
    [branch, scope]
  );
  return rows;
}

// Employees are matched against the table for the same reason branches are.
// Two name parts minimum, and a tie refuses â€” there are several Graces, and
// answering about the wrong person's equipment is worse than asking.
async function findEmployee(text, scope) {
  const words = text.toLowerCase().replace(/[^a-z\s'-]/g, ' ').split(/\s+/).filter((w) => w.length > 2);
  if (words.length < 2) return null;

  const { rows } = await db.query(
    `SELECT DISTINCT e.id, e.name, e.branch, e.department, e.employment_status
     FROM employee e
     LEFT JOIN assignment ag ON ag.employee_id = e.id AND ag.returned_date IS NULL
     LEFT JOIN location l ON l.id = ag.location_id
     WHERE e.name IS NOT NULL
       AND ($1::text IS NULL OR l.branch = $1 OR e.branch = $1)`,
    [scope]
  );

  const scored = rows
    .map((e) => {
      const parts = e.name.toLowerCase().split(/\s+/).filter((p) => p.length > 2);
      return { e, hits: parts.filter((p) => words.includes(p)).length };
    })
    .filter((s) => s.hits >= 2)
    .sort((a, b) => b.hits - a.hits);

  if (!scored.length) return null;
  if (scored.length > 1 && scored[0].hits === scored[1].hits) {
    return { ambiguous: scored.slice(0, 4).map((s) => s.e.name) };
  }
  return { employee: scored[0].e };
}

async function employeeHoldings(employeeId, scope) {
  const { rows } = await db.query(
    `SELECT a.asset_code, a.description, a.condition, a.purchase_price,
            ac.name AS category, l.branch
     FROM assignment ag
     JOIN asset a ON a.id = ag.asset_id
     LEFT JOIN asset_category ac ON ac.id = a.asset_category_id
     LEFT JOIN location l ON l.id = ag.location_id
     WHERE ag.employee_id = $1
       AND ag.returned_date IS NULL
       AND a.approval_status = 'approved'
       AND ($2::text IS NULL OR l.branch = $2)
     ORDER BY a.purchase_price DESC NULLS LAST`,
    [employeeId, scope]
  );
  return rows;
}

async function registerTotals(scope) {
  const { rows } = await db.query(
    `SELECT a.status,
            COUNT(DISTINCT a.id)::int AS assets,
            COALESCE(SUM(a.purchase_price), 0)::numeric AS value
     FROM asset a
     LEFT JOIN assignment ag ON ag.asset_id = a.id AND ag.returned_date IS NULL
     LEFT JOIN location l ON l.id = ag.location_id
     WHERE a.approval_status = 'approved'
       AND ($1::text IS NULL OR l.branch = $1)
     GROUP BY a.status`,
    [scope]
  );
  return rows;
}

async function policyAnswer(question) {
  const terms = question.toLowerCase().replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/).filter((t) => t.length > 2);
  if (!terms.length) return [];

  // Ranked by how many of the asker's words each entry actually matches.
  //
  // An earlier version used LIMIT 3 with no ORDER BY, which returns whichever
  // rows Postgres finds first â€” insertion order. The leave entries were seeded
  // first, so "what do I do with company assets when I leave" got three
  // annual-leave answers and never saw the clearance entry that matched it
  // exactly. The model then correctly said it had nothing, which looked like a
  // gap in the knowledge base rather than a bug in the query.
  const { rows } = await db.query(
    `SELECT question, answer,
            (SELECT COUNT(*) FROM unnest($1::text[]) AS t
             WHERE LOWER(question) LIKE '%' || t || '%')
          + (SELECT COUNT(*) FROM unnest($1::text[]) AS t
             WHERE EXISTS (SELECT 1 FROM unnest(keywords) AS k
                           WHERE LOWER(k) LIKE '%' || t || '%'))
            AS score
     FROM knowledge_base
     WHERE keywords && $1::text[]
        OR EXISTS (SELECT 1 FROM unnest($1::text[]) AS t
                   WHERE LOWER(question) LIKE '%' || t || '%')
     ORDER BY score DESC, id
     LIMIT 3`,
    [terms]
  );

  // Only the best match and anything close to it. Passing three loosely-related
  // entries makes the answer vaguer, not better.
  if (!rows.length) return [];
  const best = Number(rows[0].score);
  return rows.filter((r) => Number(r.score) >= best - 1);
}

// Assets in a given condition. "Show me the faulty equipment" is a question the
// register can answer and previously could not.
async function byCondition(condition, scope) {
  const { rows } = await db.query(
    `SELECT a.asset_code, a.description, a.condition,
            ac.name AS category, l.branch, e.name AS holder
     FROM asset a
     LEFT JOIN asset_category ac ON ac.id = a.asset_category_id
     LEFT JOIN assignment ag ON ag.asset_id = a.id AND ag.returned_date IS NULL
     LEFT JOIN employee e ON e.id = ag.employee_id
     LEFT JOIN location l ON l.id = ag.location_id
     WHERE a.condition = $1
       AND a.approval_status = 'approved'
       AND ($2::text IS NULL OR l.branch = $2)
     ORDER BY a.purchase_price DESC NULLS LAST
     LIMIT 25`,
    [condition, scope]
  );
  return rows;
}

// How far through verification the organisation is. The register's own answer
// to "has anybody actually looked at any of this?"
async function verificationCoverage(scope) {
  const { rows } = await db.query(
    `SELECT COALESCE(l.branch, 'No branch recorded') AS branch,
            COUNT(DISTINCT a.id)::int AS total,
            COUNT(DISTINCT a.id) FILTER (WHERE a.condition IS NOT NULL)::int AS verified
     FROM asset a
     LEFT JOIN assignment ag ON ag.asset_id = a.id AND ag.returned_date IS NULL
     LEFT JOIN location l ON l.id = ag.location_id
     WHERE a.approval_status = 'approved'
       AND ($1::text IS NULL OR l.branch = $1)
     GROUP BY l.branch
     ORDER BY total DESC
     LIMIT 15`,
    [scope]
  );
  return rows;
}

// Totals by category, so "which category is worth most" has an answer.
async function byCategory(scope) {
  const { rows } = await db.query(
    `SELECT COALESCE(ac.name, 'Uncategorised') AS category,
            COUNT(DISTINCT a.id)::int AS assets,
            COALESCE(SUM(a.purchase_price), 0)::numeric AS value
     FROM asset a
     LEFT JOIN asset_category ac ON ac.id = a.asset_category_id
     LEFT JOIN assignment ag ON ag.asset_id = a.id AND ag.returned_date IS NULL
     LEFT JOIN location l ON l.id = ag.location_id
     WHERE a.approval_status = 'approved'
       AND ($1::text IS NULL OR l.branch = $1)
     GROUP BY ac.name
     ORDER BY value DESC NULLS LAST`,
    [scope]
  );
  return rows;
}

// Every branch ranked, for "which branch has the most" questions.
async function branchRanking(scope) {
  const { rows } = await db.query(
    `SELECT l.branch,
            COUNT(DISTINCT a.id)::int AS assets,
            COALESCE(SUM(a.purchase_price), 0)::numeric AS value
     FROM asset a
     JOIN assignment ag ON ag.asset_id = a.id AND ag.returned_date IS NULL
     JOIN location l ON l.id = ag.location_id
     WHERE a.approval_status = 'approved'
       AND ($1::text IS NULL OR l.branch = $1)
     GROUP BY l.branch
     ORDER BY assets DESC
     LIMIT 15`,
    [scope]
  );
  return rows;
}

// Assets held by people who have left, or are leaving. Directly the question
// HR Manual 8.10.2 makes somebody answer.
async function heldByLeavers(scope) {
  const { rows } = await db.query(
    `SELECT e.name, e.employment_status, e.last_working_day,
            COUNT(a.id)::int AS assets,
            COALESCE(SUM(a.purchase_price), 0)::numeric AS value
     FROM assignment ag
     JOIN employee e ON e.id = ag.employee_id
     JOIN asset a ON a.id = ag.asset_id
     LEFT JOIN location l ON l.id = ag.location_id
     WHERE ag.returned_date IS NULL
       AND e.employment_status <> 'active'
       AND a.approval_status = 'approved'
       AND ($1::text IS NULL OR l.branch = $1)
     GROUP BY e.id, e.name, e.employment_status, e.last_working_day
     ORDER BY value DESC`,
    [scope]
  );
  return rows;
}

// ---------------------------------------------------------------------------

const money = (v) =>
  v == null || Number(v) === 0
    ? 'no value recorded'
    : `KES ${Number(v).toLocaleString('en-KE', { maximumFractionDigits: 2 })}`;

// Recognised in a question so "show me the faulty equipment" reaches a query
// rather than a phrase pattern.
const CONDITIONS = [
  { match: 'faulty',            value: 'Faulty' },
  { match: 'broken',            value: 'Faulty' },
  { match: 'good with issues',  value: 'Good with issues' },
  { match: 'needs repair',      value: 'Good with issues' },
  { match: 'in good condition', value: 'Good' },
];

const POLICY_WORDS = [
  'leave', 'holiday', 'maternity', 'paternity', 'sick', 'compassionate',
  'bereavement', 'remote', 'work from home', 'exam', 'notice period', 'resign',
  'clearance', 'allowance', 'policy', 'entitled', 'entitlement', 'password',
  'monitor', 'backup', 'install', 'software', 'breach', 'keys', 'damaged',
];

async function ask(req, res) {
  const { question } = req.body;

  if (!question || !String(question).trim()) {
    return res.status(400).json({ error: 'A question is required' });
  }
  if (String(question).length > 500) {
    return res.status(400).json({ error: 'That question is too long' });
  }

  const client = getGroq();
  if (!client) {
    return res.status(503).json({
      error: 'The assistant is not available on this server. GROQ_API_KEY is not configured.',
    });
  }

  const text = String(question).trim();
  const lower = text.toLowerCase();
  const scope = branchScopeFor(req);
  const role = canonicalRole(req.user.role);

  try {
    let data = '';
    let sources = [];

    // ROUTING, MOST SPECIFIC FIRST.
    //
    // An earlier version tested phrase patterns before looking for a branch
    // name, so "what assets are at Head Office?" matched the people pattern,
    // went looking for an employee called Head Office, and failed. Anything
    // that names a concrete thing â€” an asset code, a branch, a condition â€” now
    // wins over a phrase, because a named thing is better evidence of intent
    // than a form of words.

    const branch = await findBranch(text);
    const hasCode = /\b[a-z][a-z&]{1,5}[\s\-\/]?\d{3,6}\b/i.test(text);
    const condition = CONDITIONS.find((cn) => lower.includes(cn.match));
    const isPolicy = POLICY_WORDS.some((w) => lower.includes(w)) && !branch && !hasCode;

    // ---- 1. a specific asset code -----------------------------------------
    if (hasCode) {
      const found = await assetByCode(text, scope);
      if (!found?.asset) {
        data = `${found?.code || 'That code'} is not in the records available to you.`;
      } else {
        const a = found.asset;
        data =
          `${a.asset_code} â€” ${a.description}\n` +
          `Category: ${a.category || 'uncategorised'}\n` +
          `Status: ${a.status}\n` +
          `Condition: ${a.condition || 'not yet verified'}\n` +
          `Value: ${money(a.purchase_price)}\n` +
          `Held by: ${a.holder || 'nobody â€” in storage'}\n` +
          `Location: ${[a.branch, a.department, a.physical_location].filter(Boolean).join(' Â· ') || 'not recorded'}`;
        sources = [a.asset_code];
      }
    }

    // ---- 2. policy ---------------------------------------------------------
    else if (isPolicy) {
      const entries = await policyAnswer(text);
      data = entries.length
        ? entries.map((e) => `Q: ${e.question}\nA: ${e.answer}`).join('\n\n')
        : 'NOTHING FOUND. Say this is not documented here and suggest asking P&C or ICT.';
      sources = entries.map((e) => e.question);
    }

    // ---- 3. assets in a given condition ------------------------------------
    else if (condition) {
      const rows = await byCondition(condition.value, scope);
      data = rows.length
        ? `${rows.length}${rows.length === 25 ? '+' : ''} assets recorded as ${condition.value}` +
          `${scope ? ` at ${scope}` : ''}:\n` +
          rows.slice(0, 15).map((r) =>
            `${r.asset_code} â€” ${r.description} (${r.branch || 'no branch'}${r.holder ? `, ${r.holder}` : ''})`
          ).join('\n')
        : `No assets are recorded as ${condition.value}${scope ? ` at ${scope}` : ''}.`;
    }

    // ---- 4. how much has been verified -------------------------------------
    else if (/verif|inspect|checked|coverage/i.test(lower)) {
      const rows = await verificationCoverage(scope);
      const total = rows.reduce((s2, r) => s2 + r.total, 0);
      const done = rows.reduce((s2, r) => s2 + r.verified, 0);
      data =
        `Verification coverage: ${done} of ${total} assets have a recorded condition.\n` +
        rows.map((r) => `${r.branch}: ${r.verified} of ${r.total}`).join('\n') +
        `\n\nNOTE: a condition set at import is not the same as an inspection. ` +
        `Assets confirmed in person are those with a verification record.`;
    }

    // ---- 5. assets held by people who have left ----------------------------
    else if (/left|leaver|departed|exit|resigned|no longer/i.test(lower)) {
      const rows = await heldByLeavers(scope);
      const total = rows.reduce((s2, r) => s2 + Number(r.value || 0), 0);
      data = rows.length
        ? `${rows.length} people who are leaving or have left still hold assets, worth ${money(total)}:\n` +
          rows.map((r) =>
            `${r.name} (${r.employment_status}${r.last_working_day ? `, last day ${r.last_working_day}` : ''}) â€” ` +
            `${r.assets} asset${r.assets === 1 ? '' : 's'}, ${money(r.value)}`
          ).join('\n')
        : 'Nobody recorded as leaving or departed is currently holding assets.';
    }

    // ---- 6. by category ----------------------------------------------------
    else if (/categor|type of asset|what kind|breakdown/i.test(lower) && !branch) {
      const rows = await byCategory(scope);
      const total = rows.reduce((s2, r) => s2 + Number(r.value || 0), 0);
      data =
        `${scope ? `${scope}, by` : 'The whole register, by'} category â€” total ${money(total)}:\n` +
        rows.map((r) => `${r.category}: ${r.assets} assets, ${money(r.value)}`).join('\n');
    }

    // ---- 7. which branch has the most --------------------------------------
    else if (/which branch|most assets|largest|ranking|compare branch/i.test(lower)) {
      const rows = await branchRanking(scope);
      data = rows.length
        ? 'Branches by number of assets currently assigned:\n' +
          rows.map((r) => `${r.branch}: ${r.assets} assets, ${money(r.value)}`).join('\n')
        : 'No branch holdings found.';
    }

    // ---- 8. a named branch -------------------------------------------------
    else if (branch) {
      if (scope && branch.toLowerCase() !== scope.toLowerCase()) {
        data = `NOT PERMITTED. This user can only be told about ${scope}. Say so plainly.`;
      } else {
        const rows = await branchSummary(branch, scope);
        const total = rows.reduce((s2, r) => s2 + Number(r.value || 0), 0);
        const count = rows.reduce((s2, r) => s2 + r.assets, 0);
        data = rows.length
          ? `${branch}: ${count} assets currently assigned, worth ${money(total)}.\n` +
            rows.map((r) => `${r.assets}x ${r.category} (${money(r.value)})`).join('\n')
          : `No assets are currently assigned at ${branch}.`;
        sources = [branch];
      }
    }

    // ---- 9. a named person -------------------------------------------------
    else if (/what (?:assets?|equipment|devices?|items?)|who (?:has|holds)|assigned to|issued to|holding/i.test(lower)) {
      const match = await findEmployee(text, scope);
      if (!match) {
        data = 'No staff member matched that name. A full name is needed â€” a first name alone is too ambiguous.';
      } else if (match.ambiguous) {
        data = `Several people match: ${match.ambiguous.join(', ')}. Ask again with the full name.`;
      } else {
        const held = await employeeHoldings(match.employee.id, scope);
        const total = held.reduce((s2, h) => s2 + Number(h.purchase_price || 0), 0);
        data = held.length
          ? `${match.employee.name} (${match.employee.branch || 'branch not recorded'}) holds ` +
            `${held.length} asset${held.length === 1 ? '' : 's'}, worth ${money(total)}:\n` +
            held.map((h) => `${h.asset_code} â€” ${h.description} (${h.condition || 'not verified'})`).join('\n') +
            (match.employee.employment_status !== 'active'
              ? `\nNOTE: this person is recorded as ${match.employee.employment_status}.`
              : '')
          : `${match.employee.name} has no assets currently assigned.`;
        sources = held.map((h) => h.asset_code);
      }
    }

    // ---- 10. the register as a whole ---------------------------------------
    else {
      const rows = await registerTotals(scope);
      const total = rows.reduce((s2, r) => s2 + Number(r.value || 0), 0);
      data =
        (scope ? `Figures for ${scope} only.\n` : 'Whole register.\n') +
        rows.map((r) => `${r.status}: ${r.assets} assets (${money(r.value)})`).join('\n') +
        `\nTotal recorded value: ${money(total)}`;
    }

    const completion = await client.chat.completions.create({
      model: MODEL,
      max_tokens: 400,
      temperature: 0.2,   // low: this is reporting, not writing
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `QUESTION: ${text}\n\nDATA:\n${data}` },
      ],
    });

    const answer = completion.choices[0]?.message?.content?.trim()
      || 'I could not put that into words. Please try rephrasing.';

    // Who asked what, and under what scope. A log recording the question but
    // not the scope is of little use if anyone later asks what was disclosed.
    await db.query(
      `INSERT INTO bot_query_log
         (platform_user_id, username, staff_id, query, intent, response, scoped_to_branch, refused)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [`web:${req.user.id}`, req.user.email, req.user.id, text, 'assistant',
       answer, scope || null, data.startsWith('NOT PERMITTED')]
    ).catch((err) => console.error('Could not log the assistant query:', err.message));

    res.json({ answer, sources, scoped_to: scope || null, role });
  } catch (err) {
    console.error('Assistant failed:', err);
    res.status(500).json({ error: 'The assistant could not answer that. Please try again.' });
  }
}

module.exports = { ask };
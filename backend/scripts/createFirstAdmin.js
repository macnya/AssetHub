// Creates an organisation and its first Admin, on a database that has neither.
//
// WHY THIS EXISTS
// /auth/register requires an authenticated Admin to call it, which is correct
// once there is one — but on a fresh database there is nobody to authenticate
// as. Without this script a new deployment has a working API and no way to log
// into it.
//
// WHY IT CONNECTS AS postgres AND NOT app_user
// Two consequences of row-level security. organisation has a read policy and
// no write policy, so app_user cannot create one. And it_staff fills org_id
// from a connection setting that only a request ever has — a script has no
// request. Both are solved by connecting as the owner and naming the
// organisation explicitly, which is also honest about what this is: an
// administrative act, not something the application does.
//
//   node scripts/createFirstAdmin.js "Your Name" you@example.com
//   node scripts/createFirstAdmin.js "Your Name" you@example.com --org "Acme Ltd" --code acme
//
// With one organisation already present it joins that one. With none, --org
// and --code are required. With several, --code says which.
//
// The password is asked for rather than taken as an argument, because anything
// typed on the command line is kept in the shell's history file.
//
// Safe to re-run: it refuses if that organisation already has an Admin.

require('dotenv').config();
const bcrypt = require('bcrypt');
const readline = require('node:readline');
const { Pool } = require('pg');

const MIN_PASSWORD_LENGTH = 8;

// MIGRATION_DATABASE_URL if it is set, because DATABASE_URL is app_user and
// app_user deliberately cannot do what this script does.
const connectionString =
  process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

function arg(flag) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? null : process.argv[i + 1];
}

// Reads a line without echoing it. Node's readline has no built-in masking, so
// the prompt is redrawn over each keystroke.
function askHidden(prompt) {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const onData = (char) => {
      if (['\n', '\r', '\u0004'].includes(char.toString())) return;
      process.stdout.clearLine(0);
      process.stdout.cursorTo(0);
      process.stdout.write(prompt);
    };
    process.stdin.on('data', onData);
    rl.question('', (answer) => {
      process.stdin.removeListener('data', onData);
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

function fail(message) {
  console.error(`\n${message}`);
  process.exit(1);
}

async function main() {
  // Positional arguments are the ones that are neither a flag nor the value
  // following a flag.
  const argv = process.argv.slice(2);
  const positional = argv.filter((a, i) =>
    !a.startsWith('--') && !(argv[i - 1] || '').startsWith('--'));
  const [name, email] = positional;

  const orgName = arg('--org');
  const orgCode = arg('--code');

  if (!name || !email) {
    fail('Usage: node scripts/createFirstAdmin.js "Your Name" you@example.com [--org "Name" --code code]');
  }

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    fail(`"${email}" does not look like an email address.`);
  }

  // Fail before asking for a password if the database is unreachable, or if we
  // are connected as a role that cannot do the work — both are more likely on
  // a first run than anything else.
  try {
    const { rows } = await pool.query('SELECT current_user');
    if (rows[0].current_user === 'app_user') {
      fail(
        'Connected as app_user, which cannot create organisations.\n' +
        'Set MIGRATION_DATABASE_URL in backend/.env to the postgres connection string.'
      );
    }
  } catch (err) {
    fail(`Could not reach the database.\n${err.message}`);
  }

  // ---- which organisation -------------------------------------------------
  let org;
  const { rows: orgs } = await pool.query(
    'SELECT id, code, name FROM organisation ORDER BY id');

  if (orgCode) {
    org = orgs.find((o) => o.code === orgCode.toLowerCase());
    if (!org && !orgName) {
      fail(`No organisation with code "${orgCode}". Pass --org "Name" as well to create it.`);
    }
  } else if (orgs.length === 1) {
    org = orgs[0];
  } else if (orgs.length > 1) {
    fail(
      'There is more than one organisation. Say which with --code:\n  ' +
      orgs.map((o) => `${o.code}  (${o.name})`).join('\n  ')
    );
  }

  if (!org) {
    if (!orgName || !orgCode) {
      fail('No organisation exists yet. Create one with --org "Name" --code code');
    }
    if (!/^[a-z0-9-]{3,20}$/.test(orgCode.toLowerCase())) {
      fail('The code must be 3-20 characters: lowercase letters, digits or hyphens.');
    }
    const { rows } = await pool.query(
      'INSERT INTO organisation (code, name) VALUES (LOWER($1), $2) RETURNING id, code, name',
      [orgCode, orgName]
    );
    org = rows[0];
    console.log(`Created organisation #${org.id}: ${org.name} (${org.code})`);
  }

  // ---- is there already an admin? -----------------------------------------
  const { rows: admins } = await pool.query(
    `SELECT email FROM it_staff
     WHERE org_id = $1 AND role IN ('Admin', 'IT Admin') LIMIT 1`,
    [org.id]
  );
  if (admins.length) {
    fail(
      `${org.name} already has an Admin (${admins[0].email}).\n` +
      'Create further accounts from Staff accounts in the panel.'
    );
  }

  const { rows: clash } = await pool.query(
    'SELECT id FROM it_staff WHERE org_id = $1 AND LOWER(email) = LOWER($2)',
    [org.id, email]
  );
  if (clash.length) {
    fail(`${email} is already registered in ${org.name}, but not as an Admin.`);
  }

  // ---- the password -------------------------------------------------------
  const password = await askHidden('Choose a password: ');
  if (password.length < MIN_PASSWORD_LENGTH) {
    fail(`Too short — at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  const again = await askHidden('Type it again:    ');
  if (password !== again) {
    fail('Those did not match. Nothing was created.');
  }

  const password_hash = await bcrypt.hash(password, 10);

  // org_id is named rather than left to the column default, because that
  // default reads a connection setting which only a request ever has.
  //
  // must_change_password is false here, unlike /auth/register: you chose this
  // password yourself, so there is nothing to replace.
  const { rows } = await pool.query(
    `INSERT INTO it_staff
       (org_id, name, email, password_hash, role, must_change_password, password_changed_at)
     VALUES ($1, $2, $3, $4, 'Admin', false, NOW())
     RETURNING id, name, email, role`,
    [org.id, name, email.trim().toLowerCase(), password_hash]
  );

  console.log(`\nCreated Admin #${rows[0].id}: ${rows[0].name} <${rows[0].email}>`);
  console.log(`Organisation: ${org.name} (code "${org.code}")`);
  console.log('\nSign in at the admin panel with that email and the password you chose.');
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
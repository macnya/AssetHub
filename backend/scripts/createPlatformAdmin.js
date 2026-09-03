// Creates an operator account: someone who runs AssetHub, as distinct from
// someone who works for one of the organisations on it.
//
//   node scripts/createPlatformAdmin.js "Your Name" you@example.com
//
// Connects as postgres, because platform_admin has a read policy and no write
// policy — the application can check an operator's password but cannot mint
// one, which is the right way round.
//
// The password is asked for rather than taken as an argument: anything typed
// on the command line is kept in the shell's history file.

require('dotenv').config();
const bcrypt = require('bcrypt');
const readline = require('node:readline');
const { Pool } = require('pg');

const MIN_PASSWORD_LENGTH = 12;   // longer than a tenant's: more authority

const pool = new Pool({
  connectionString: process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

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
  const [name, email] = process.argv.slice(2);

  if (!name || !email) {
    fail('Usage: node scripts/createPlatformAdmin.js "Your Name" you@example.com');
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    fail(`"${email}" does not look like an email address.`);
  }

  try {
    const { rows } = await pool.query('SELECT current_user');
    if (rows[0].current_user === 'app_user') {
      fail('Connected as app_user, which cannot create operator accounts.\n' +
           'Set MIGRATION_DATABASE_URL in backend/.env to the postgres connection string.');
    }
  } catch (err) {
    fail(`Could not reach the database.\n${err.message}`);
  }

  const { rows: clash } = await pool.query(
    'SELECT id FROM platform_admin WHERE LOWER(email) = LOWER($1)', [email]);
  if (clash.length) fail(`${email} is already an operator account.`);

  const password = await askHidden('Choose a password: ');
  if (password.length < MIN_PASSWORD_LENGTH) {
    fail(`Too short — at least ${MIN_PASSWORD_LENGTH} characters for an operator account.`);
  }
  const again = await askHidden('Type it again:    ');
  if (password !== again) fail('Those did not match. Nothing was created.');

  const password_hash = await bcrypt.hash(password, 10);

  const { rows } = await pool.query(
    `INSERT INTO platform_admin (name, email, password_hash)
     VALUES ($1, $2, $3) RETURNING id, name, email`,
    [name, email.trim().toLowerCase(), password_hash]
  );

  console.log(`\nCreated operator #${rows[0].id}: ${rows[0].name} <${rows[0].email}>`);
  console.log('Sign in at /platform on the API host.');
  console.log('\nThis account is separate from any organisation account you hold.');
  await pool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });

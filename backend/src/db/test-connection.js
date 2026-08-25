const pool = require('./pool');

pool.query('SELECT NOW()', (err, res) => {
  if (err) {
    console.error('Connection failed:', err);
  } else {
    console.log('Connected! Server time:', res.rows[0].now);
  }
  pool.end();
});
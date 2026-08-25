const pool = require('../db/pool');

async function getAllEmployees(req, res) {
  try {
    const result = await pool.query('SELECT * FROM employee ORDER BY name');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch employees' });
  }
}

async function createEmployee(req, res) {
  const { name, department, branch, email } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });

  try {
    const result = await pool.query(
      `INSERT INTO employee (name, department, branch, email) VALUES ($1,$2,$3,$4) RETURNING *`,
      [name, department || null, branch || null, email || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create employee' });
  }
}

module.exports = { getAllEmployees, createEmployee };
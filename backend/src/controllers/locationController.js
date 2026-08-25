const pool = require('../db/pool');
const { branchScopeFor } = require('../utils/scope');

async function getAllLocations(req, res) {
  try {
    const result = await pool.query('SELECT * FROM location ORDER BY branch, physical_location');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch locations' });
  }
}

async function createLocation(req, res) {
  const { branch, department, physical_location } = req.body;
  if (!branch) return res.status(400).json({ error: 'branch is required' });

  try {
    const result = await pool.query(
      `INSERT INTO location (branch, department, physical_location) VALUES ($1,$2,$3) RETURNING *`,
      [branch, department || null, physical_location || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create location' });
  }
}

// GET /locations/branches — the structure, with live asset counts.
//
// Returns one entry per branch, each carrying its region and the departments,
// programmes and places beneath it. The admin panel uses this for a view of
// "what have we got and where", which the flat location list can't show now
// that there are five levels to it.
//
// Counts are of assets with a LIVE assignment. An asset in storage has no
// assignment and therefore no branch, so branch totals will not sum to the
// register total — that gap is itself worth seeing.
async function getBranchTree(req, res) {
  const scopeBranch = branchScopeFor(req);

  try {
    const { rows } = await pool.query(
      `SELECT
          l.region,
          l.branch,
          l.department,
          l.programme,
          l.physical_location,
          COUNT(DISTINCT ag.asset_id) FILTER (WHERE ag.returned_date IS NULL)::int AS assets
       FROM location l
       LEFT JOIN assignment ag ON ag.location_id = l.id
       WHERE ($1::text IS NULL OR l.branch = $1)
       GROUP BY l.region, l.branch, l.department, l.programme, l.physical_location
       ORDER BY l.branch, l.department NULLS LAST, l.programme NULLS LAST, l.physical_location NULLS LAST`,
      [scopeBranch]
    );

    const branches = new Map();

    for (const r of rows) {
      if (!r.branch) continue;

      const b = branches.get(r.branch) || {
        branch: r.branch,
        region: null,
        assets: 0,
        departments: new Map(),
        programmes: new Map(),
        places: [],
      };

      // Region is recorded on only some rows, so take the first one that has it
      // rather than whichever happens to sort last.
      if (r.region && !b.region) b.region = r.region;

      b.assets += r.assets;

      if (r.department) {
        b.departments.set(r.department, (b.departments.get(r.department) || 0) + r.assets);
      }
      if (r.programme) {
        b.programmes.set(r.programme, (b.programmes.get(r.programme) || 0) + r.assets);
      }
      if (r.physical_location) {
        b.places.push({ name: r.physical_location, assets: r.assets });
      }

      branches.set(r.branch, b);
    }

    const toList = (m) =>
      [...m.entries()].map(([name, assets]) => ({ name, assets })).sort((a, b) => b.assets - a.assets);

    res.json(
      [...branches.values()]
        .map((b) => ({
          branch: b.branch,
          region: b.region,
          assets: b.assets,
          departments: toList(b.departments),
          programmes: toList(b.programmes),
          places: b.places.sort((a, b2) => b2.assets - a.assets),
        }))
        .sort((a, b) => b.assets - a.assets)
    );
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch the branch structure' });
  }
}

module.exports = { getAllLocations, createLocation, getBranchTree };
require('dotenv').config();
const express = require('express');
const cors = require('cors');

const authRoutes = require('./routes/authRoutes');
const assetRoutes = require('./routes/assetRoutes');
const assignmentRoutes = require('./routes/assignmentRoutes');
const employeeRoutes = require('./routes/employeeRoutes');
const locationRoutes = require('./routes/locationRoutes');
const disposalRoutes = require('./routes/disposalRoutes');
const lostAssetRoutes = require('./routes/lostAssetRoutes');
const dashboardRoutes = require('./routes/dashboardRoutes');
const verificationRoutes = require('./routes/verificationRoutes');

const app = express();
app.set('trust proxy', 1);
app.use(cors({
  origin: [
    'https://ASSETHUB-ADMIN-URL.onrender.com',
    'http://localhost:5173',
  ],
}));
// 25mb, and registered HERE rather than below the routes.
//
// The import posts back every parsed row on confirm, which for the full
// register is ~1MB of JSON. This limit was previously added after the routes,
// where it did nothing: body-parser sets req._body once a body has been read
// and skips on every later pass, so the 100kb default was still what applied.
// A full-register import failed with "Server error" and no explanation.
app.use(express.json({ limit: '25mb' }));

app.get('/', (req, res) => res.send('AssetHub API running'));
app.get('/health', (req, res) => res.status(200).json({ status: 'ok', time: new Date().toISOString() }));

app.use('/auth', authRoutes);

// Mounted at /verifications, not at root. Mounting at '/' put the verification
// report on the site root and made router.patch('/:id') catch any PATCH to any
// path — which would have collided with the asset routes sooner or later.
app.use('/verifications', verificationRoutes);

app.use('/assets', assetRoutes);
app.use('/assignments', assignmentRoutes);
app.use('/employees', employeeRoutes);
app.use('/locations', locationRoutes);
app.use('/disposals', disposalRoutes);
app.use('/lost-assets', lostAssetRoutes);
app.use('/dashboard', dashboardRoutes);
app.use('/clearances', require('./routes/clearanceRoutes'));
app.use('/assistant', require('./routes/assistantRoutes'));
app.use('/finance', require('./routes/financeRoutes'));
app.use('/custody', require('./routes/custodyRoutes'));
app.use('/activity', require('./routes/activityRoutes'));
app.use('/import', require('./routes/importRoutes'));


// 404 for unknown routes
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Catch malformed JSON bodies and any other errors, return JSON instead of Express's default HTML page
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Invalid JSON in request body' });
  }

  // Over the limit set above. Without this the client is told "Server error",
  // which sends whoever hit it looking for a fault that isn't there.
  if (err.type === 'entity.too.large') {
    return res.status(413).json({
      error: 'That request is too large to send in one go. Try importing one sheet at a time.',
    });
  }

  // multer's own failures: the 15MB cap and the extension filter on
  // /import/preview. Both are the user's to fix, so both are 4xx.
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'That file is larger than 15MB.' });
  }
  if (err.code && String(err.code).startsWith('LIMIT_')) {
    return res.status(400).json({ error: err.message });
  }
  if (/can be imported$/.test(err.message || '')) {
    return res.status(400).json({ error: err.message });
  }

  console.error(err);
  res.status(500).json({ error: 'Server error' });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
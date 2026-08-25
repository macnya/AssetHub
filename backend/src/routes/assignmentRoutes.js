const express = require('express');
const router = express.Router();

const { getAssetHistory } = require('../controllers/assignmentController');

const { verifyToken } = require('../middleware/authMiddleware');

router.use(verifyToken);

// The two write routes that were here are gone.
//
// POST / and PATCH /:id/return wrote straight to the assignment table with no
// approval, while /custody/request holds the same change for a second person
// to review. HR 9.3a requires permission before equipment moves, and the
// scanner's api.js removed its equivalents for exactly this reason - but the
// admin panel kept calling these, so anything an officer was prevented from
// doing in the field could still be done from a desk.
//
// createAssignment and returnAssignment are left in the controller: the
// custody approval path is what should call them, not a route.
router.get('/history/:asset_id', getAssetHistory);

module.exports = router;
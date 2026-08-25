const express = require('express');
const router = express.Router();

const {
  getAllAssets,
  getAssetByCode,
  createAsset,
  updateAsset,
  getAllCategories,
  getAllConditions,
  getFilterOptions,
  getPendingAssets,
  reviewAsset,
} = require('../controllers/assetController');

// Deletion lives in its own controller because it is a different kind of act:
// it only ever removes assets with no history, and refuses the rest.
const { checkDeletable, deleteAsset, deleteBatch } = require('../controllers/deleteController');

const { verifyAsset } = require('../controllers/verificationController');
const { getAssetBarcode } = require('../controllers/barcodeController');
const { verifyToken, requireRole, ROLES } = require('../middleware/authMiddleware');

router.use(verifyToken);

router.get('/', getAllAssets);
router.get('/categories', getAllCategories);
router.get('/conditions', getAllConditions);
router.get('/filters', getFilterOptions);

// Fixed paths must come before /:asset_code, or Express reads "pending" and
// "delete-batch" as asset codes.
router.get('/pending', requireRole(ROLES.ADMIN), getPendingAssets);
router.post('/delete-batch', requireRole(ROLES.ADMIN), deleteBatch);

router.get('/:asset_code/barcode', getAssetBarcode);

// Asked before the delete button is shown, so nobody is offered an action that
// will be refused.
router.get('/:asset_code/deletable', requireRole(ROLES.ADMIN), checkDeletable);

router.get('/:asset_code', getAssetByCode);

// Officers scan unrecognised barcodes in the field and are routed straight to
// "add asset", so they need to finish that flow. Branch Administrators may now
// register equipment arriving at their own branch; the controller holds theirs
// as pending.
router.post('/', requireRole(ROLES.ADMIN, ROLES.OFFICER, ROLES.BRANCH_ADMIN), createAsset);

// Verifying is a field action. Branch Administrators can now do it for their
// own branch; the scope check in the controller enforces that. Every
// verification is held pending regardless of who made it.
router.post('/:asset_code/verify',
  requireRole(ROLES.ADMIN, ROLES.OFFICER, ROLES.BRANCH_ADMIN), verifyAsset);

router.post('/:asset_code/approve', requireRole(ROLES.ADMIN), reviewAsset);
router.post('/:asset_code/reject', requireRole(ROLES.ADMIN), reviewAsset);

// Correcting the register itself remains an Admin action.
router.patch('/:asset_code', requireRole(ROLES.ADMIN), updateAsset);

// Deleting removes a mistake, never a real asset. Anything with history is
// refused with a pointer to disposal or write-off, which keep the record.
router.delete('/:asset_code', requireRole(ROLES.ADMIN), deleteAsset);

module.exports = router;
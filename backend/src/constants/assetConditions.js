// Single source of truth for the asset condition vocabulary.
//
// Previously the mobile "Add New Asset" picker offered Good / Fair / Faulty
// while verification only accepted Good / Good with issues / Faulty, so assets
// could be created with a condition that no verification could ever produce or
// overwrite — and they were invisible to the condition filter on the
// verification report. Both writers now validate against this list.
const ASSET_CONDITIONS = ['Good', 'Good with issues', 'Faulty'];

const DEFAULT_CONDITION = 'Good';

function isValidCondition(value) {
  return ASSET_CONDITIONS.includes(value);
}

module.exports = { ASSET_CONDITIONS, DEFAULT_CONDITION, isValidCondition };
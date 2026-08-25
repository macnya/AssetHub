// Mirrors backend/src/constants/assetConditions.js.
//
// These must match: the "Add New Asset" picker used to offer Good / Fair /
// Faulty while the backend only accepted Good / Good with issues / Faulty, so
// "Fair" assets were rejected on create and invisible to the condition filter
// on the verification report.
//
// GET /assets/conditions serves the authoritative list if you'd rather fetch
// it at runtime; this constant is the offline-safe fallback.
export const ASSET_CONDITIONS = ['Good', 'Good with issues', 'Faulty'];

export const DEFAULT_CONDITION = 'Good';
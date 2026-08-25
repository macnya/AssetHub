import api, { fetchEmployees, fetchLocations, verifyAsset, requestCustodyChange } from '../api';
import {
  cacheAsset, getCachedAsset,
  cacheEmployees, getCachedEmployees,
  cacheLocations, getCachedLocations,
  queueAction, getPendingCountForAsset,
} from '../db/localDb';

// Network errors from axios have no `err.response`. A 404/400/etc DOES have
// `err.response`, meaning the server was reached — that's a real error, not
// an offline condition, so we only fall back to offline handling when
// `err.response` is missing.
function isOffline(err) {
  return !err.response;
}

// ---- Reads ----

export async function getAssetByCodeOffline(assetCode) {
  try {
    const res = await api.get(`/assets/${encodeURIComponent(assetCode)}`);
    cacheAsset(assetCode, res.data);
    return { data: res.data, fromCache: false };
  } catch (err) {
    if (!isOffline(err)) throw err;
    const cached = getCachedAsset(assetCode);
    if (!cached) throw err; // never seen this asset before — nothing to show offline
    return { data: cached, fromCache: true, pendingCount: getPendingCountForAsset(assetCode) };
  }
}

export async function fetchEmployeesOffline() {
  try {
    const data = await fetchEmployees();
    cacheEmployees(data);
    return data;
  } catch (err) {
    if (!isOffline(err)) throw err;
    return getCachedEmployees();
  }
}

export async function fetchLocationsOffline() {
  try {
    const data = await fetchLocations();
    cacheLocations(data);
    return data;
  } catch (err) {
    if (!isOffline(err)) throw err;
    return getCachedLocations();
  }
}

// ---- Writes ----
// Each: try the real request. If it fails because we're offline, queue it and
// patch the local cache so the UI reflects what is known, with a "pending sync"
// flag the UI can show.

export async function verifyAssetOffline(assetCode, payload) {
  try {
    return await verifyAsset(assetCode, payload);
  } catch (err) {
    if (!isOffline(err)) throw err;
    queueAction('verify', assetCode, payload);
    const cached = getCachedAsset(assetCode);
    if (cached) {
      cached.asset.condition = payload.condition;
      cached.pendingSync = true;
      cacheAsset(assetCode, cached);
    }
    return { queued: true, ...payload };
  }
}

// Requesting a custody change, offline-safe.
//
// This replaced assignAssetOffline and checkInOffline. Custody no longer moves
// when an officer records it: HR 9.3a requires permission from the head of
// department or branch manager before equipment moves, so an administrator
// approves the request first.
//
// NOTE WHAT IS DELIBERATELY ABSENT. The old assign flow optimistically wrote
// the new holder into the cache, so the screen showed the asset as moved. That
// is now false — nothing has moved until approval — and showing an officer a
// change that has not happened is the same false confirmation that had one
// asset verified three times in six minutes. The cache records that a request
// is waiting, and nothing more.
export async function requestCustodyOffline(assetCode, payload) {
  try {
    return await requestCustodyChange(payload);
  } catch (err) {
    if (!isOffline(err)) throw err;
    queueAction('custody', assetCode, payload);

    const cached = getCachedAsset(assetCode);
    if (cached) {
      cached.pendingCustodyRequest = true;
      cached.pendingSync = true;
      cacheAsset(assetCode, cached);
    }

    return { queued: true };
  }
}
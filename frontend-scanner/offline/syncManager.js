import NetInfo from '@react-native-community/netinfo';
import { classifyError } from './classifyError';
import { verifyAsset, requestCustodyChange } from '../api';
import {
  getPendingActions,
  markActionSynced,
  markActionFailed,
  getTotalPendingCount,
  getTotalFailedCount,
  getFailedActions,
  retryFailedActions,
  discardFailedAction,
  discardAllFailedActions,
} from '../db/localDb';

let syncing = false;

// Set when the server rejects a sync attempt because the session is no longer
// valid. The queue is left untouched in that case — the officer just needs to
// log in again, after which the next sync picks up exactly where it stopped.
let needsReauth = false;

const listeners = new Set();

function emit() {
  const state = getSyncState();
  listeners.forEach((fn) => {
    try {
      fn(state);
    } catch {
      // A broken listener shouldn't take the sync down with it.
    }
  });
}

export function getSyncState() {
  return {
    pending: getTotalPendingCount(),
    failed: getTotalFailedCount(),
    needsReauth,
  };
}

export function subscribeToSyncState(fn) {
  listeners.add(fn);
  fn(getSyncState());
  return () => listeners.delete(fn);
}

export function clearReauthFlag() {
  needsReauth = false;
  emit();
}

async function runAction(action) {
  const { type, asset_code, payload } = action;
  if (type === 'verify') {
    return verifyAsset(asset_code, payload);
  }
  // Assigning and returning both became custody requests: they change the
  // register only once approved.
  if (type === 'custody') {
    return requestCustodyChange(payload);
  }

  // Queued on an older version of the app, before custody needed approval.
  // Replayed as requests rather than discarded — the work was done in the
  // field and losing it to a deploy would be worse than replaying it late.
  if (type === 'assign') {
    return requestCustodyChange({ ...payload, kind: 'assign' });
  }
  if (type === 'checkin') {
    return requestCustodyChange({
      asset_id: payload.asset_id,
      kind: 'return',
      latitude: payload.latitude,
      longitude: payload.longitude,
    });
  }

  throw new Error(`Unknown queued action type: ${type}`);
}

function errorMessage(err) {
  return (
    err?.response?.data?.error ||
    err?.message ||
    'Rejected by the server'
  );
}

// Processes the queue oldest-first. Anything transient stops the run without
// touching the remaining items, so they're retried next time. Only a genuine
// server rejection parks an action as 'failed', and even then it's retained
// and surfaced in the UI rather than discarded.
export async function processPendingActions(onProgress) {
  if (syncing) return { synced: 0, failed: 0, stopped: null };
  syncing = true;

  let synced = 0;
  let failed = 0;
  let stopped = null;

  try {
    const actions = getPendingActions();

    for (const action of actions) {
      try {
        await runAction(action);
        markActionSynced(action.id);
        synced += 1;
        onProgress?.({ synced, failed, total: actions.length });
        emit();
      } catch (err) {
        const outcome = classifyError(err);

        if (outcome === 'reauth') {
          needsReauth = true;
          stopped = 'reauth';
          emit();
          break;
        }

        if (outcome === 'retry') {
          stopped = 'offline';
          break;
        }

        markActionFailed(action.id, errorMessage(err));
        failed += 1;
        onProgress?.({ synced, failed, total: actions.length });
        emit();
      }
    }
  } finally {
    syncing = false;
    emit();
  }

  return { synced, failed, stopped };
}

// Moves failed actions back into the queue and immediately attempts a sync.
export async function retryFailed(onProgress) {
  const restored = retryFailedActions();
  emit();
  if (restored === 0) return { synced: 0, failed: 0, stopped: null };
  return processPendingActions(onProgress);
}

// Call once near app startup. Returns an unsubscribe function.
export function startAutoSync(onProgress) {
  let wasOffline = false;

  const unsubscribe = NetInfo.addEventListener((state) => {
    const online = !!(state.isConnected && state.isInternetReachable !== false);
    if (online && wasOffline && !needsReauth) {
      processPendingActions(onProgress);
    }
    wasOffline = !online;
  });

  // Also attempt once at startup in case actions were queued last session
  processPendingActions(onProgress);

  return unsubscribe;
}

export {
  getTotalPendingCount,
  getTotalFailedCount,
  getFailedActions,
  discardFailedAction,
  discardAllFailedActions,
};
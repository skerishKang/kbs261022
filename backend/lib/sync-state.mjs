/**
 * Sync state management for CGI product -> Naver/ERP synchronization.
 *
 * Tracks per-product, per-target sync status. Supports:
 * - Status tracking (pending, in_progress, success, failed, retry_pending)
 * - Retry counting with backoff
 * - Change hash tracking
 * - Concurrency guard (one sync per product at a time)
 * - Partial failure handling (ERP success + Naver failure is tracked separately)
 */

export const SYNC_TARGETS = ['erp', 'naver'];
export const SYNC_STATUSES = ['pending', 'in_progress', 'success', 'failed', 'retry_pending', 'skipped'];

export const SYNC_STATES = {
  PENDING: 'pending',
  IN_PROGRESS: 'in_progress',
  SUCCESS: 'success',
  FAILED: 'failed',
  RETRY_PENDING: 'retry_pending',
  SKIPPED: 'skipped',
};

/**
 * Create a fresh sync state for a product.
 */
export function createSyncState(cgiId, changeHash = null) {
  const targets = {};
  for (const target of SYNC_TARGETS) {
    targets[target] = {
      status: SYNC_STATES.PENDING,
      lastSuccessAt: null,
      lastAttemptAt: null,
      lastError: null,
      retryCount: 0,
      changeHash,
      transmitted: false,
    };
  }
  return {
    cgiId,
    changeHash,
    targets,
    locked: false,
    lockedAt: null,
    lockedBy: null,
  };
}

/**
 * Acquire a lock for a product. Returns true if lock acquired, false if already locked.
 */
export function acquireLock(state, lockerId = 'default') {
  if (state.locked) return false;
  state.locked = true;
  state.lockedAt = new Date().toISOString();
  state.lockedBy = lockerId;
  return true;
}

/**
 * Release a lock for a product.
 */
export function releaseLock(state) {
  state.locked = false;
  state.lockedAt = null;
  state.lockedBy = null;
}

/**
 * Update sync status for a specific target.
 */
export function updateTargetStatus(state, target, status, { error = null, transmitted = false } = {}) {
  if (!SYNC_TARGETS.includes(target)) throw new Error(`unknown target: ${target}`);
  if (!SYNC_STATUSES.includes(status)) throw new Error(`unknown status: ${status}`);
  const t = state.targets[target];
  t.status = status;
  t.lastAttemptAt = new Date().toISOString();
  if (status === SYNC_STATES.SUCCESS) {
    t.lastSuccessAt = t.lastAttemptAt;
    t.lastError = null;
    t.transmitted = true;
  }
  if (status === SYNC_STATES.FAILED) {
    t.lastError = error;
    t.retryCount += 1;
  }
  if (transmitted) t.transmitted = true;
  if (error) t.lastError = error;
}

/**
 * Check if a target needs re-sync (change detected or never synced).
 */
export function needsSync(state, target, currentHash) {
  const t = state.targets[target];
  if (t.status === SYNC_STATES.PENDING) return true;
  if (t.status === SYNC_STATES.FAILED) return true;
  if (t.status === SYNC_STATES.RETRY_PENDING) return true;
  if (t.changeHash !== currentHash) return true;
  return false;
}

/**
 * Check if all targets are successfully synced.
 */
export function isFullySynced(state) {
  return SYNC_TARGETS.every((t) => state.targets[t].status === SYNC_STATES.SUCCESS);
}

/**
 * Get the overall sync status for a product.
 */
export function overallStatus(state) {
  const statuses = SYNC_TARGETS.map((t) => state.targets[t].status);
  if (statuses.every((s) => s === SYNC_STATES.SUCCESS)) return SYNC_STATES.SUCCESS;
  if (statuses.some((s) => s === SYNC_STATES.IN_PROGRESS)) return SYNC_STATES.IN_PROGRESS;
  if (statuses.some((s) => s === SYNC_STATES.FAILED)) return SYNC_STATES.FAILED;
  if (statuses.some((s) => s === SYNC_STATES.RETRY_PENDING)) return SYNC_STATES.RETRY_PENDING;
  if (statuses.every((s) => s === SYNC_STATES.SKIPPED)) return SYNC_STATES.SKIPPED;
  return SYNC_STATES.PENDING;
}

/**
 * Get targets that need retry.
 */
export function retryableTargets(state) {
  return SYNC_TARGETS.filter((t) => {
    const s = state.targets[t].status;
    return s === SYNC_STATES.FAILED || s === SYNC_STATES.RETRY_PENDING;
  });
}

/**
 * Reset a target for retry.
 */
export function resetTargetForRetry(state, target) {
  const t = state.targets[target];
  t.status = SYNC_STATES.RETRY_PENDING;
  t.transmitted = false;
}

/**
 * Serialize sync state to a plain object (for persistence).
 */
export function serializeState(state) {
  return JSON.parse(JSON.stringify(state));
}

/**
 * Deserialize sync state from a plain object.
 */
export function deserializeState(obj) {
  return JSON.parse(JSON.stringify(obj));
}

/**
 * In-memory sync state store.
 */
export function createSyncStore() {
  const states = new Map();
  return {
    get(cgiId) {
      return states.get(cgiId) || null;
    },
    set(cgiId, state) {
      states.set(cgiId, state);
    },
    has(cgiId) {
      return states.has(cgiId);
    },
    delete(cgiId) {
      return states.delete(cgiId);
    },
    size() {
      return states.size;
    },
    all() {
      return [...states.values()];
    },
    clear() {
      states.clear();
    },
  };
}

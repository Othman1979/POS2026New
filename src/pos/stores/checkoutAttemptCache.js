const CACHE_KEY = 'pos_checkout_attempt';
const CACHE_VERSION = 2;
const PENDING_KEY = 'pos_pending_checkout';
const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000;

const fingerprint = (value) => {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `v${CACHE_VERSION}:${(hash >>> 0).toString(16)}`;
};

const safeRemove = (storage) => {
  try { storage.removeItem(CACHE_KEY); } catch (_) {}
};

const read = ({ storage, now, ttlMs }) => {
  try {
    const raw = storage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const expired = !parsed?.savedAt || now - Number(parsed.savedAt) > ttlMs;
    if (parsed?.version !== CACHE_VERSION || !parsed.key || !parsed.fingerprint || expired) {
      safeRemove(storage);
      return null;
    }
    return parsed;
  } catch (_) {
    safeRemove(storage);
    return null;
  }
};

export const resolveCheckoutAttemptKey = ({
  storage = localStorage,
  now = Date.now(),
  ttlMs = DEFAULT_TTL_MS,
  activeKey = '',
  fingerprintSource,
  makeKey
}) => {
  const nextFingerprint = fingerprint(JSON.stringify(fingerprintSource));
  const cached = read({ storage, now, ttlMs });
  let key = activeKey;

  if (key && cached?.key === key && cached.fingerprint !== nextFingerprint) key = '';
  if (!key && cached?.fingerprint === nextFingerprint) key = cached.key;
  if (!key) key = makeKey();

  try {
    storage.setItem(CACHE_KEY, JSON.stringify({
      version: CACHE_VERSION,
      key,
      fingerprint: nextFingerprint,
      savedAt: now
    }));
  } catch (_) {
    // Current-tab idempotency still works through the caller's active key.
  }
  return key;
};

export const clearCheckoutAttempt = (storage = localStorage) => {
  safeRemove(storage);
};

export const CHECKOUT_ATTEMPT_CACHE_KEY = CACHE_KEY;
export const CHECKOUT_ATTEMPT_CACHE_VERSION = CACHE_VERSION;

// A sent request has an unknown outcome until the server answers definitively.
// Draft resets and the speculative-key TTL must not discard that request.
// Each cashier owns their own record, so a second cashier on the same device
// can sell without overwriting the first cashier's unconfirmed sale.
const pendingKey = (userId) => `${PENDING_KEY}:${userId}`;
const isValidPending = (value) => Boolean(value?.frozen?.payload?.idempotency_key && value.draftId);
// An unreadable record is kept for forensics under a quarantine key and no
// longer blocks Pay. Returns true when something was quarantined.
const quarantine = (key, raw, storage) => {
  try { storage.setItem(`${PENDING_KEY}:quarantine:${Date.now()}`, raw); } catch (_) {}
  storage.removeItem(key);
  return true;
};
const parse = (raw) => { try { return JSON.parse(raw); } catch (_) { return null; } };

// Returns { record, quarantined }. Never throws on bad storage content.
export const readPendingCheckout = (userId, storage = localStorage) => {
  let quarantined = false;
  const legacy = storage.getItem(PENDING_KEY);
  if (legacy) {
    const value = parse(legacy);
    const owner = value?.frozen?.payload?.user_id;
    if (!isValidPending(value) || owner == null) quarantined = quarantine(PENDING_KEY, legacy, storage);
    else if (storage.getItem(pendingKey(owner))) quarantined = quarantine(PENDING_KEY, legacy, storage);
    else { storage.setItem(pendingKey(owner), legacy); storage.removeItem(PENDING_KEY); }
  }
  if (userId == null) return { record: null, quarantined };
  const raw = storage.getItem(pendingKey(userId));
  if (!raw) return { record: null, quarantined };
  const value = parse(raw);
  if (!isValidPending(value)) return { record: null, quarantined: quarantine(pendingKey(userId), raw, storage) };
  return { record: value, quarantined };
};
export const savePendingCheckout = (value, storage = localStorage) => storage.setItem(
  pendingKey(value.frozen.payload.user_id),
  JSON.stringify({ savedAt: Date.now(), ...value })
);
export const clearPendingCheckout = (userId, key, storage = localStorage) => {
  if (readPendingCheckout(userId, storage).record?.frozen.payload.idempotency_key === key) storage.removeItem(pendingKey(userId));
};

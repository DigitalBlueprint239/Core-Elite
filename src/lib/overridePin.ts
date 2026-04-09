/**
 * overridePin.ts
 * Offline-safe admin override PIN management.
 *
 * Security model:
 *   - The raw PIN is fetched from events.override_pin exactly once, while online.
 *   - It is immediately hashed with PBKDF2-SHA256 (Web Crypto API — zero external deps).
 *   - Only the hash is persisted, to IndexedDB via the event_config store.
 *   - The raw PIN is never stored anywhere after the hash is computed.
 *   - On override, the entered PIN is hashed identically and compared against the
 *     stored hash. No network request is required.
 *
 * PBKDF2 parameters:
 *   - Hash:       SHA-256
 *   - Salt:       "core-elite-override:<eventId>" — domain-separated, event-scoped
 *   - Iterations: 100,000  — NIST SP 800-132 minimum for interactive login
 *   - Key length: 256 bits
 *
 * These parameters make offline brute-force impractical on a tablet.
 * A 4-digit PIN has only 10,000 candidates; at ~100ms per PBKDF2 op on mobile
 * hardware, exhausting the space takes ~1,000 seconds per device.
 * Combined with the 3-attempt lockout in the UI, this is adequate for an
 * on-site event tool.
 */

import { setEventConfig, getEventConfig, deleteEventConfig } from './offline';

const CONFIG_KEY_PREFIX = 'override_pin';

function pinKey(eventId: string): string {
  return `${CONFIG_KEY_PREFIX}:${eventId}`;
}

/**
 * Hash a PIN using PBKDF2-SHA256 with the event_id baked into the salt.
 * Deterministic: hashOverridePin(pin, id) === hashOverridePin(pin, id) always.
 * Exported so callers can test round-trip correctness without touching IDB.
 */
export async function hashOverridePin(pin: string, eventId: string): Promise<string> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(pin),
    'PBKDF2',
    false,             // not extractable
    ['deriveBits'],
  );

  const derivedBits = await crypto.subtle.deriveBits(
    {
      name:       'PBKDF2',
      hash:       'SHA-256',
      salt:       new TextEncoder().encode(`core-elite-override:${eventId}`),
      iterations: 100_000,
    },
    keyMaterial,
    256,               // 32 bytes → 64-char hex string
  );

  return Array.from(new Uint8Array(derivedBits))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Seed — call when online (station load, or on reconnect).
 *
 * Fetches the raw PIN from the caller, hashes it, and stores the hash in IDB.
 * Safe to call repeatedly; each call overwrites with a fresh hash (handles PIN rotation).
 *
 * @param eventId  The active event UUID.
 * @param rawPin   The plaintext override PIN from events.override_pin.
 */
export async function seedOverridePin(eventId: string, rawPin: string): Promise<void> {
  if (!rawPin?.trim()) return;  // No PIN configured — nothing to cache

  const hash = await hashOverridePin(rawPin.trim(), eventId);

  await setEventConfig({
    id:                pinKey(eventId),
    override_pin_hash: hash,
    event_id:          eventId,
    seeded_at:         Date.now(),
  });
}

/**
 * Verify — fully offline-safe.
 *
 * Hashes the entered PIN with the same parameters and compares against the
 * stored hash. Returns { valid: true } on match.
 *
 * @param eventId    The active event UUID.
 * @param enteredPin The PIN the staff member typed into the override modal.
 */
export async function verifyOverridePin(
  eventId:     string,
  enteredPin:  string,
): Promise<{ valid: boolean; reason?: string }> {
  const record = await getEventConfig(pinKey(eventId));

  if (!record?.override_pin_hash) {
    return {
      valid:  false,
      reason:
        'Override PIN not cached on this device. ' +
        'Connect to the network, then re-open this station to load it.',
    };
  }

  // Hash the entered value with identical parameters
  let enteredHash: string;
  try {
    enteredHash = await hashOverridePin(enteredPin.trim(), eventId);
  } catch {
    return { valid: false, reason: 'Hash computation failed. Try again.' };
  }

  return enteredHash === record.override_pin_hash
    ? { valid: true }
    : { valid: false, reason: 'Incorrect PIN.' };
}

/**
 * Returns true if a hash is cached for this event.
 * Use to drive the PIN status badge in the station UI.
 */
export async function isOverridePinSeeded(eventId: string): Promise<boolean> {
  const record = await getEventConfig(pinKey(eventId));
  return !!record?.override_pin_hash;
}

/**
 * Clear the cached hash (call on event close or staff sign-out).
 */
export async function clearOverridePin(eventId: string): Promise<void> {
  await deleteEventConfig(pinKey(eventId));
}

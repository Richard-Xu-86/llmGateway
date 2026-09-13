import { createHash, timingSafeEqual } from 'node:crypto';

export interface ApiKey {
  id: string;
  name: string;
  /** sha256 of the secret. The secret itself is never stored. */
  hash: string;
  /**
   * Last four characters, for display — "demo-app · …ey_1".
   *
   * A *leading* prefix is the tempting choice and it is wrong: a short key is
   * then stored almost in full. The tail of a key identifies it to whoever
   * already has it and is useless to anyone who does not.
   */
  last4: string;
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * SHA-256 rather than bcrypt/argon2, deliberately.
 *
 * Slow hashing exists to make *guessing* expensive, which matters for
 * human-chosen passwords. These are 128+ bits of random, checked on every
 * proxied request. A slow KDF here would add latency to the hot path and buy
 * nothing against a secret that cannot be guessed.
 */
export function parseKeySpec(spec: string): ApiKey[] {
  return spec
    .split(',')
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair) => {
      const idx = pair.indexOf(':');
      const name = idx === -1 ? 'unnamed' : pair.slice(0, idx).trim();
      const secret = idx === -1 ? pair : pair.slice(idx + 1).trim();
      return {
        id: sha256(secret).slice(0, 16),
        name,
        hash: sha256(secret),
        last4: secret.slice(-4),
      };
    });
}

export function authenticate(keys: ApiKey[], authorizationHeader?: string): ApiKey | null {
  if (!authorizationHeader) return null;
  const match = /^Bearer\s+(.+)$/i.exec(authorizationHeader.trim());
  const presented = match?.[1];
  if (!presented) return null;

  const presentedHash = Buffer.from(sha256(presented), 'hex');
  for (const key of keys) {
    const candidate = Buffer.from(key.hash, 'hex');
    if (candidate.length === presentedHash.length && timingSafeEqual(candidate, presentedHash)) {
      return key;
    }
  }
  return null;
}

import { createHmac, randomBytes } from 'node:crypto';
import type { ReleaseDiagnosticIdentity } from './types';

const processKey = randomBytes(32).toString('hex');
// This independent boundary accepts safe detail identifiers, never HTTP API or
// download routes. It does not decide whether an identifier may be ingested.
export function diagnosticIdentity(
  guid: string | null,
  infohash: string | null,
  title: string | null,
  secrets: readonly string[] = []
): ReleaseDiagnosticIdentity {
  const safe = (value: string) => {
    let decoded = value;
    try {
      for (let i = 0; i < 4; i++) decoded = decodeURIComponent(decoded);
    } catch {
      return false;
    }
    return (
      !/[<>]/.test(decoded) &&
      ![...decoded].some(
        (character) =>
          character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
      ) &&
      !secrets.some(
        (key) => key && decoded.toLowerCase().includes(key.toLowerCase())
      )
    );
  };
  let safeGuid: string | null = null;
  if (guid && guid.length <= 2048 && safe(guid) && !/[\s%\\?#]/.test(guid)) {
    if (
      /^[a-z0-9._:-]+$/i.test(guid) &&
      !/^(?:https?|magnet):/i.test(guid) &&
      !/(?:apikey|passkey|token|password|secret|authorization)[:=]/i.test(guid)
    )
      safeGuid = guid;
    else
      try {
        const url = new URL(guid);
        if (
          url.protocol === 'https:' &&
          !url.username &&
          !url.password &&
          !url.port &&
          url.href === guid &&
          /^\/torrents?\/[a-z0-9._-]+$/i.test(url.pathname) &&
          !/\.(?:torrent|xml)$/i.test(url.pathname)
        )
          safeGuid = guid;
      } catch {
        /* Unsafe identifiers are represented only by HMAC. */
      }
  }
  return {
    guid: safeGuid,
    infohash:
      infohash &&
      /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(infohash) &&
      safe(infohash)
        ? infohash.toLowerCase()
        : null,
    title:
      title &&
      safe(title) &&
      !/(?:%|https?:|magnet:|apikey\s*[=:]|passkey\s*[=:])/i.test(title)
        ? title.replace(/\s+/g, ' ').trim().slice(0, 256) || null
        : null,
    // Configured authentication material is never serialized. It provides a
    // stable keyed fingerprint across normal adapter restarts. Key rotation
    // conservatively leaves the previous opaque rejection unresolved.
    fingerprint: guid
      ? createHmac('sha256', secrets[0] || processKey)
          .update(guid)
          .digest('hex')
      : null,
  };
}

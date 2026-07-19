// Display formatters used across the MVP. Kept in one place so the
// hash-truncation style and cost rendering stay consistent.

const NANOS_PER_USD = 1_000_000_000n;

/**
 * Format a nanoUSD integer (sent over the wire as a stringified bigint)
 * as a human-friendly USD amount with 4 decimal places. AI calls are
 * cheap enough that 4 decimals matters.
 */
export function formatNanosAsUsd(nanos: string | bigint, decimals = 4): string {
  const big = typeof nanos === 'bigint' ? nanos : BigInt(nanos);
  const negative = big < 0n;
  const absVal = negative ? -big : big;
  const dollars = absVal / NANOS_PER_USD;
  const remainder = absVal % NANOS_PER_USD;
  // Pad remainder to 9 digits, then take leading `decimals` for the
  // fractional part.
  const remainderStr = remainder.toString().padStart(9, '0').slice(0, decimals);
  return `${negative ? '-' : ''}$${dollars.toString()}.${remainderStr}`;
}

/**
 * Show the first 8 and last 8 hex chars of a hash, with an ellipsis in
 * the middle. Long-press / hover to see the full hash in tooltips.
 */
export function truncateHash(hash: string | null | undefined): string {
  if (!hash) return '—';
  if (hash.length <= 18) return hash;
  return `${hash.slice(0, 8)}…${hash.slice(-8)}`;
}

/**
 * Human-friendly chain id. user-primary chains include a UUID we can
 * shorten; platform chains stay as-is.
 */
export function shortChainId(chainId: string): string {
  if (chainId.startsWith('user-primary:')) {
    const uuid = chainId.slice('user-primary:'.length);
    return `user-primary:${uuid.slice(0, 8)}…`;
  }
  return chainId;
}

/**
 * Format ISO timestamp as "2026-05-20 23:14:01 UTC" — readable but
 * unambiguous, no library needed.
 */
export function formatTimestamp(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(
    d.getUTCHours(),
  )}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC`;
}

/** Stringified bigint → number with `n.nm` / `n.nk` shorthand for large counts. */
export function formatCount(value: string | number | bigint): string {
  const n = typeof value === 'bigint' ? Number(value) : Number(value);
  if (!Number.isFinite(n)) return String(value);
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toString();
}

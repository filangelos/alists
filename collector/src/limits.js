/* The two bounds every endpoint here shares.
 *
 * Neither of them prevents anything. A per-address throttle bounds one loud
 * source and is deliberately permissive; a daily cap turns "fill the database"
 * into "ruin one day", which is recoverable and, on the free tier, free.
 * Absorb, bound, detect, reverse -- see the note at the top of worker.js.
 */

/* Hashed so that no raw address exists in this Worker beyond the line that
   reads it -- a limiter only ever needs an address to be distinct, not to be
   an address. Per-location and approximate, so this bounds one loud source
   rather than a distributed one; the daily cap is what covers the rest. */
export async function throttled(limiter, ip) {
  if (!limiter || !ip) return false;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ip));
  const key = [...new Uint8Array(digest).slice(0, 16)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  const { success } = await limiter.limit({ key });
  return !success;
}

/* Incremented first, and its new value decides whether the caller writes at
   all, so the cap cannot be raced past by a burst of concurrent requests the
   way a read-then-write would be.

   `prefix` keeps the counters apart: events and recommendations are different
   volumes with different ceilings, and one filling up must not stop the other.
   Events use no prefix, because their rows predate this and a renamed key
   would start the count over mid-day. */
export async function overCap(env, prefix, at, cap) {
  const day = prefix + new Date(at).toISOString().slice(0, 10);

  const counter = await env.DB.prepare(
    `INSERT INTO counters (day, n) VALUES (?, 1)
       ON CONFLICT (day) DO UPDATE SET n = n + 1
     RETURNING n`,
  )
    .bind(day)
    .first();

  if (counter && counter.n > cap) {
    // Logged once per event past the cap, which is itself the alarm: a day that
    // hits this in normal traffic is a day worth looking at.
    console.warn(JSON.stringify({ at: 'cap', day, n: counter.n }));
    return true;
  }
  return false;
}

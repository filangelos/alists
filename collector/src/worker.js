/* The collector behind alists.
 *
 * The page that talks to this is static, public and open-source, so the URL
 * below is known to everyone and there is no secret that could ever be put in
 * front of it -- a token in client JS is not a token. That is the whole design
 * constraint, and it is not one you can engineer away: anyone can POST here.
 *
 * So nothing here tries to prove an event is genuine. What it does instead is
 * make a forged one worthless:
 *
 *   - every field comes from a closed set, so a forger can only say things the
 *     site itself could have said -- no arbitrary strings ever reach the table,
 *     which is what makes the data safe to render later and keeps the
 *     cardinality bounded;
 *   - a daily cap turns "fill the database" into "ruin one day of counts",
 *     which is recoverable and, on the free tier, free;
 *   - rows are append-only with a server timestamp, so an attack is a
 *     contiguous range you delete in one statement.
 *
 * Absorb, bound, detect, reverse. Not prevent.
 */

const KINDS = new Set(['view', 'search', 'open']);

// Fixed buckets rather than a count, because a count of results is a fact
// about the query, and enough facts about a query start to describe the query.
const BUCKETS = new Set(['none', 'few', 'some', 'many']);

const SLUG = /^[a-z0-9]{1,24}$/;
const MAX_BODY = 512;
const MAX_LABEL = 80;

/* Written before the insert, so the cap holds even when many requests land at
 * once. 20k events a day is far past anything this site will see honestly, and
 * far below D1's free ceiling of 100k row writes -- each event costs two. */
const DAILY_CAP = 20000;

const BOT =
  /bot|crawl|spider|slurp|curl|wget|headless|monitor|uptime|preview|scrape|python-requests|axios|okhttp|gptbot|claudebot|facebookexternalhit/i;
const MOBILE = /mobile|android|iphone|ipad|ipod/i;

/* The vocabulary is the site's own data, read from the deployed site rather
 * than pinned here, because `refresh` adds cities on its own and a hardcoded
 * list would start silently dropping the newest one. Module scope is safe for
 * this and only this: it is immutable public config derived from a URL, not
 * anything belonging to a request. The fetch is edge-cached on top, so the
 * 539 KB is parsed at most once an hour per isolate. */
let vocab = null;
const VOCAB_TTL = 3600 * 1000;

async function vocabulary(env) {
  if (vocab && Date.now() - vocab.at < VOCAB_TTL) return vocab;

  try {
    const res = await fetch(env.LISTS_URL, {
      cf: { cacheTtl: 3600, cacheEverything: true },
    });
    if (!res.ok) throw new Error(`lists.json responded ${res.status}`);
    const data = await res.json();

    const paths = new Set();
    for (const city of data.cities || []) paths.add(city.key);
    for (const cat of data.categories || []) paths.add(cat.key);

    const places = new Set();
    for (const place of data.places || []) places.add(place.name);

    if (!paths.size || !places.size) throw new Error('lists.json looks empty');
    vocab = { at: Date.now(), paths, places };
  } catch (err) {
    /* Serve the stale copy rather than dropping the day's data over a blip. If
       there is no copy at all -- a cold isolate during an outage -- validation
       has nothing to check against, so events are refused instead of being let
       through unchecked. Failing shut is the right way round: the cost is a
       gap in a chart. */
    console.error(JSON.stringify({ at: 'vocabulary', error: String(err), stale: !!vocab }));
    if (!vocab) return null;
  }

  return vocab;
}

const hostOf = (url) => {
  try {
    return new URL(url).host.slice(0, 64);
  } catch {
    return null;
  }
};

function classify(ua) {
  if (!ua) return 'other';
  if (BOT.test(ua)) return 'bot';
  if (MOBILE.test(ua)) return 'mobile';
  return 'desktop';
}

/* A path is at most a city and a category, in that order, and both have to be
   real keys. This is the check that does the most work: the site's path space
   is closed -- 38 cities, 10 categories -- so a forger cannot invent a page,
   only inflate one that exists. That is a far smaller problem, and a visible
   one. */
function validPath(path, known) {
  if (typeof path !== 'string' || !path.startsWith('/') || path.length > 52) return false;
  const segs = path.slice(1).split('/');
  if (segs.length > 2) return false;
  return segs.every((seg) => SLUG.test(seg) && known.has(seg));
}

function validate(body, known) {
  if (!body || typeof body !== 'object') return null;

  const { kind, path, label } = body;
  if (!KINDS.has(kind)) return null;

  // The root is a real view and has no path; anything else must name a page.
  const cleanPath = path === undefined || path === null || path === '' ? null : path;
  if (cleanPath !== null && !validPath(cleanPath, known.paths)) return null;

  let cleanLabel = null;
  if (kind === 'open') {
    // Checked against the real place names, so this column cannot be used to
    // store a string of someone else's choosing -- which is what would
    // otherwise turn a future dashboard into a stored-XSS target aimed at
    // whoever built it.
    if (typeof label !== 'string' || label.length > MAX_LABEL) return null;
    if (!known.places.has(label)) return null;
    cleanLabel = label;
  } else if (kind === 'search') {
    if (typeof label !== 'string' || !BUCKETS.has(label)) return null;
    cleanLabel = label;
  } else if (label !== undefined && label !== null) {
    return null;
  }

  return { kind, path: cleanPath, label: cleanLabel };
}

/* Two statements, in this order. The counter is incremented first and its new
   value decides whether the event is written at all, so the cap cannot be
   raced past by a burst of concurrent requests the way a read-then-write
   would be. */
async function record(env, event) {
  const day = new Date(event.at).toISOString().slice(0, 10);

  const counter = await env.DB.prepare(
    `INSERT INTO counters (day, n) VALUES (?, 1)
       ON CONFLICT (day) DO UPDATE SET n = n + 1
     RETURNING n`,
  )
    .bind(day)
    .first();

  if (counter && counter.n > DAILY_CAP) {
    // Logged once per event past the cap, which is itself the alarm: a day that
    // hits this in normal traffic is a day worth looking at.
    console.warn(JSON.stringify({ at: 'cap', day, n: counter.n }));
    return;
  }

  await env.DB.prepare(
    `INSERT INTO events (at, kind, path, label, ref, country, agent)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(event.at, event.kind, event.path, event.label, event.ref, event.country, event.agent)
    .run();
}

// Never tells the caller anything. Same empty 204 for a good event, a forged
// one, a rate-limited one and a dropped one, so the endpoint cannot be probed
// to find out what it accepts.
const accepted = (origin) =>
  new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': origin,
      'cache-control': 'no-store',
    },
  });

export default {
  async fetch(request, env, ctx) {
    const allowed = [env.SITE_ORIGIN, env.DEV_ORIGIN].filter(Boolean);
    const origin = request.headers.get('origin');
    const echo = allowed.includes(origin) ? origin : allowed[0];

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'access-control-allow-origin': echo,
          'access-control-allow-methods': 'POST',
          'access-control-allow-headers': 'content-type',
          'access-control-max-age': '86400',
        },
      });
    }

    if (request.method !== 'POST') {
      return new Response(null, { status: 405, headers: { allow: 'POST, OPTIONS' } });
    }

    try {
      /* Forgeable with two seconds of curl, and kept anyway: it costs nothing
         and it removes every drive-by that goes through a browser. It is a
         doormat, not a lock, and nothing below it assumes otherwise. */
      if (!allowed.includes(origin)) return accepted(echo);

      /* Bounded before reading rather than after. `sendBeacon` always sets a
         length, so a request without one is not the page talking. */
      const length = Number(request.headers.get('content-length'));
      if (!Number.isFinite(length) || length <= 0 || length > MAX_BODY) return accepted(echo);

      const ip = request.headers.get('cf-connecting-ip') || '';
      if (env.RATE_LIMITER && ip) {
        /* Hashed so that no raw address exists in this Worker beyond the line
           that reads it -- the limiter only ever needs the address to be
           distinct, not to be an address. Note the limiter is per-location and
           deliberately permissive, so this bounds one loud source rather than a
           distributed one; the daily cap is what covers the rest. */
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ip));
        const key = [...new Uint8Array(digest).slice(0, 16)]
          .map((b) => b.toString(16).padStart(2, '0'))
          .join('');
        const { success } = await env.RATE_LIMITER.limit({ key });
        if (!success) return accepted(echo);
      }

      let body;
      try {
        body = JSON.parse(await request.text());
      } catch {
        return accepted(echo);
      }

      const known = await vocabulary(env);
      if (!known) return accepted(echo);

      const clean = validate(body, known);
      if (!clean) {
        console.warn(JSON.stringify({ at: 'reject', kind: body && body.kind }));
        return accepted(echo);
      }

      const event = {
        ...clean,
        // Everything below is taken from the request, never from the body. A
        // client that can set its own country and user agent class can also
        // set them to whatever makes the chart it wants.
        at: Date.now(),
        ref: hostOf(request.headers.get('referer')),
        country: (request.cf && request.cf.country) || null,
        agent: classify(request.headers.get('user-agent')),
      };

      // The write does not affect the response -- it is 204 either way -- so it
      // goes behind the beacon rather than in front of it. `ctx` is not
      // destructured; that loses its binding and throws at runtime.
      ctx.waitUntil(
        record(env, event).catch((err) =>
          console.error(JSON.stringify({ at: 'record', error: String(err) })),
        ),
      );

      return accepted(echo);
    } catch (err) {
      console.error(JSON.stringify({ at: 'fetch', error: String(err) }));
      return accepted(echo);
    }
  },
};

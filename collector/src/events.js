/* Three numbers: a page opened, a search made, a place opened in Maps.
 *
 * This is the endpoint `count.js` beacons at, and it is unchanged from when it
 * was the whole of this Worker. Every field comes from a closed set, so a
 * forger can only say something the site itself could have said -- no
 * arbitrary string ever reaches this table, which is what makes the data safe
 * to render later and keeps the cardinality bounded.
 *
 * It never tells the caller anything: the same empty 204 for a good event, a
 * forged one, a rate-limited one and a dropped one, so the endpoint cannot be
 * probed to find out what it accepts. `suggest.js` deliberately breaks that
 * rule, and says why.
 */

import { validPath, vocabulary } from './lists.js';
import { overCap, throttled } from './limits.js';

const KINDS = new Set(['view', 'search', 'open']);

// Fixed buckets rather than a count, because a count of results is a fact
// about the query, and enough facts about a query start to describe the query.
const BUCKETS = new Set(['none', 'few', 'some', 'many']);

const MAX_BODY = 512;
const MAX_LABEL = 80;

/* 20k events a day is far past anything this site will see honestly, and far
 * below D1's free ceiling of 100k row writes -- each event costs two. */
const DAILY_CAP = 20000;

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

async function record(env, event) {
  if (await overCap(env, '', event.at, DAILY_CAP)) return;

  await env.DB.prepare(
    `INSERT INTO events (at, kind, path, label, ref, country, agent)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(event.at, event.kind, event.path, event.label, event.ref, event.country, event.agent)
    .run();
}

const accepted = (headers) => new Response(null, { status: 204, headers });

export async function count(request, env, ctx, site) {
  if (!site.fromSite) return accepted(site.headers);

  /* Bounded before reading rather than after. `sendBeacon` always sets a
     length, so a request without one is not the page talking. */
  const length = Number(request.headers.get('content-length'));
  if (!Number.isFinite(length) || length <= 0 || length > MAX_BODY) return accepted(site.headers);

  if (await throttled(env.RATE_LIMITER, site.ip)) return accepted(site.headers);

  let body;
  try {
    body = JSON.parse(await request.text());
  } catch {
    return accepted(site.headers);
  }

  const known = await vocabulary(env);
  if (!known) return accepted(site.headers);

  const clean = validate(body, known);
  if (!clean) {
    console.warn(JSON.stringify({ at: 'reject', kind: body && body.kind }));
    return accepted(site.headers);
  }

  // Everything in `site.facts` is taken from the request, never from the body.
  // A client that can set its own country and user agent class can also set
  // them to whatever makes the chart it wants.
  const event = { ...clean, ...site.facts };

  // The write does not affect the response -- it is 204 either way -- so it
  // goes behind the beacon rather than in front of it. `ctx` is not
  // destructured; that loses its binding and throws at runtime.
  ctx.waitUntil(
    record(env, event).catch((err) =>
      console.error(JSON.stringify({ at: 'record', error: String(err) })),
    ),
  );

  return accepted(site.headers);
}

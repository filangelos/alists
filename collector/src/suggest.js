/* Somebody else's recommendation, on its way in.
 *
 * This is the one endpoint here that stores a string a stranger chose, and it
 * is worth being plain about that: `note` and `who` are free text and nothing
 * can make them not be. What the design does instead is make them the *only*
 * two, and give them nowhere to go. They are never rendered into the public
 * site -- a recommendation is not a place until it has been added in Maps by
 * hand -- and the one page that does render them (review.js) escapes
 * everything and runs under a CSP with no script source at all.
 *
 * The place itself is not free text. A recommendation has to arrive as a
 * Google Maps link, and what gets stored is not the link that was pasted: it
 * is a URL rebuilt from the one identifier parsed out of it -- a CID or a
 * place id, both of which are bounded tokens. So the column that will be
 * clicked can only ever hold a Google Maps URL of this Worker's own
 * construction. That is the same trick the events table plays with its closed
 * sets, applied to a link instead of an enum, and it is why requiring the link
 * is a safety property rather than a nuisance.
 *
 * It also answers, which the counting endpoint deliberately does not. A count
 * is fire-and-forget and a silent 204 is the right shape for it; a
 * recommendation is something a person is standing there waiting on, and a
 * form that swallows what you typed is broken. So this one says what happened
 * -- including "already saved", which is the most useful thing it can say.
 */

import { validPath, vocabulary } from './lists.js';
import { overCap, throttled } from './limits.js';

const MAX_BODY = 4096;
const MAX_LINK = 2048;
const MAX_NOTE = 240;
const MAX_WHO = 40;
const MAX_NAME = 80;

/* Two orders of magnitude below the events cap, because these are typed by
   hand one at a time. A day that reaches 200 is not people recommending
   restaurants. */
const DAILY_CAP = 200;

/* Not the browser UA the fetcher sends for the list endpoint, and for the
   opposite reason: to a browser, maps.app.goo.gl answers 200 with a JavaScript
   interstitial that performs the hop client-side, so the destination never
   appears in the response at all. To anything else it answers a plain 30x. */
const BOT_UA = 'alists-recommend (+https://github.com/filangelos/alists)';

// The only hosts this Worker will make an outbound request to. A link is
// followed because it is short, and shortness is a property of these three
// domains -- everything else is parsed where it stands, so a pasted URL can
// never turn this into a fetcher pointed at somewhere of the sender's choosing.
const SHORT_HOSTS = new Set(['maps.app.goo.gl', 'goo.gl', 'share.google']);

const GOOGLE = /^(?:www\.|maps\.|consent\.)?google\.[a-z]{2,3}(?:\.[a-z]{2})?$/;

const isGoogle = (host) => SHORT_HOSTS.has(host) || GOOGLE.test(host);

// Sentences rather than codes: this endpoint answers a person, and the page
// prints what it says. Nothing here names an internal state.
const SAYS = {
  link: 'that does not look like a Google Maps link',
  place:
    'that link does not name a place — open the place in Maps, ' +
    'then share it from there',
  note: 'a note cannot contain a link',
  long: 'that is longer than this form takes',
  busy: 'too many just now — try again in a minute',
  down: 'could not read that link just now — try again in a minute',
};

// ------------------------------------------------------------------- text

/* Reject rather than truncate. Cutting somebody's sentence in half and storing
   the front of it puts words in their mouth, and the form already says how
   long the field is. Bidi overrides and zero-width characters go because they
   are invisible in a review page and are how a name is made to read backwards.
*/
function clean(value, max) {
  if (value === undefined || value === null || value === '') return { text: null };
  if (typeof value !== 'string') return { bad: true };
  const text = value
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return { text: null };
  if (text.length > max) return { bad: true };
  return { text };
}

/* A note never needs a URL: the place is already carried by the link field,
   which is checked against Google. So "contains a link" is not a heuristic
   about what spam looks like -- it is a statement that the message has a part
   with no legitimate use here, and it removes essentially every drive-by. */
const LINKY = /(?:https?:|www\.|\/\/|[\w.+-]+@[\w-]+\.[a-z]{2,})/i;

// ------------------------------------------------------------------- links

const signed = (hex) => BigInt.asIntN(64, BigInt(`0x${hex}`)).toString();

function decoded(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/* Follow a short link to whatever it points at, one hop at a time and never
   off Google. `redirect: 'manual'` rather than `follow` so each destination is
   checked before the next request is made rather than after all of them. */
async function resolve(url) {
  for (let hop = 0; hop < 4; hop += 1) {
    if (!SHORT_HOSTS.has(url.host)) return url;
    const res = await fetch(url.toString(), {
      redirect: 'manual',
      headers: { 'user-agent': BOT_UA, 'accept-language': 'en' },
      signal: AbortSignal.timeout(5000),
    });
    const next = res.headers.get('location');
    if (!next) return url;
    let to;
    try {
      to = new URL(next, url);
    } catch {
      return url;
    }
    if (!isGoogle(to.host)) return url;
    /* An EU-located Worker gets bounced to the consent wall, which is not a
       dead end: it carries the destination it was going to allow. */
    if (to.host.startsWith('consent.')) {
      const on = to.searchParams.get('continue');
      if (on) {
        try {
          const real = new URL(on);
          if (isGoogle(real.host)) to = real;
        } catch {
          /* keep the consent URL and let `identify` find nothing in it */
        }
      }
    }
    url = to;
  }
  return url;
}

/* Everything worth having out of a Maps URL. Only `cid` and `placeId` are
   load-bearing -- they are what the stored link is rebuilt from. The rest is
   for the review page to read, and none of it is trusted: `name` in
   particular is whatever the URL's own path segment says, which for a link
   pasted from an address bar is a string the sender controls. It is stored as
   free text alongside the note, and treated as such. */
function identify(url) {
  const href = decoded(url.toString());
  const id = { cid: null, placeId: null, mid: null, lat: null, lng: null, name: null };

  const param = url.searchParams.get('cid');
  if (param && /^-?\d{1,20}$/.test(param)) id.cid = param;

  // The two halves of the feature id. The second is the CID that
  // `maps.google.com/?cid=` resolves -- the most durable deep link there is
  // without a Places API key, and the same identifier data/lists.json holds.
  const ftid = /0x[0-9a-f]{1,16}:0x([0-9a-f]{1,16})/i.exec(href);
  if (!id.cid && ftid) {
    try {
      id.cid = signed(ftid[1]);
    } catch {
      /* a hex string too long to be a feature id is not one */
    }
  }

  const pid = /place_id[:=]([A-Za-z0-9_-]{20,128})/.exec(href);
  if (pid) id.placeId = pid[1];

  const mid = /!(?:16s|1s)(\/[gm]\/[a-z0-9_]{4,24})/i.exec(href);
  if (mid) id.mid = mid[1];

  // `!3d!4d` is the place's own point; `@` is only where the map was centred.
  const point =
    /!3d(-?\d{1,3}\.\d+)!4d(-?\d{1,3}\.\d+)/.exec(href) ||
    /@(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+)/.exec(href);
  if (point) {
    id.lat = Number(point[1]);
    id.lng = Number(point[2]);
  }

  const segs = url.pathname.split('/').filter(Boolean);
  const at = segs.indexOf('place');
  if (at >= 0 && segs[at + 1] && !/^(?:@|data=)/.test(segs[at + 1])) {
    const name = clean(decoded(segs[at + 1].replace(/\+/g, ' ')), MAX_NAME);
    if (name.text && !/^-?\d+\.\d+,/.test(name.text)) id.name = name.text;
  }

  return id;
}

/* The three shapes somebody might paste, normalised the way lists.txt
   normalises a share link into a list id: a short link, a full URL, or the
   bare identifier out of the middle of one. */
function bare(text) {
  if (/^-?\d{6,20}$/.test(text)) return { cid: text, placeId: null, mid: null };
  const ftid = /^0x[0-9a-f]{1,16}:0x([0-9a-f]{1,16})$/i.exec(text);
  if (ftid) return { cid: signed(ftid[1]), placeId: null, mid: null };
  if (/^Ch[A-Za-z0-9_-]{20,128}$/.test(text)) return { cid: null, placeId: text, mid: null };
  return null;
}

// Built entirely out of one bounded token, which is the whole point: whatever
// was pasted, what lands in the table is a URL this file wrote.
const canonical = (id) =>
  id.cid
    ? `https://maps.google.com/?cid=${id.cid}`
    : `https://www.google.com/maps/place/?q=place_id:${id.placeId}`;

async function place(link) {
  const direct = bare(link);
  if (direct) return { ...direct, lat: null, lng: null, name: null };

  let url;
  try {
    url = new URL(link);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (!isGoogle(url.host)) return null;

  const id = identify(await resolve(url));
  return id.cid || id.placeId ? id : { ...id, missing: true };
}

// ------------------------------------------------------------------ answer

const reply = (headers, status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, 'content-type': 'application/json; charset=utf-8' },
  });

export async function recommend(request, env, ctx, site) {
  const said = (text) => reply(site.headers, 200, { ok: false, says: text });

  // The doormat, and here it can say so: a form that is not the site's form is
  // a form nobody is waiting on an answer from.
  if (!site.fromSite) return reply(site.headers, 403, { ok: false, says: SAYS.busy });

  const length = Number(request.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_BODY) return said(SAYS.long);

  if (await throttled(env.SUGGEST_LIMITER || env.RATE_LIMITER, site.ip)) return said(SAYS.busy);

  // Checked again after reading, because `content-length` is a header and this
  // endpoint answers `fetch` rather than `sendBeacon` -- a caller that omits
  // it is not stopped by a bound that was only ever read off the envelope.
  const raw = await request.text();
  if (raw.length > MAX_BODY) return said(SAYS.long);

  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return said(SAYS.link);
  }
  if (!body || typeof body !== 'object') return said(SAYS.link);

  const link = clean(body.link, MAX_LINK);
  if (link.bad || !link.text) return said(link.bad ? SAYS.long : SAYS.link);

  const note = clean(body.note, MAX_NOTE);
  if (note.bad) return said(SAYS.long);
  if (note.text && LINKY.test(note.text)) return said(SAYS.note);

  const who = clean(body.who, MAX_WHO);
  if (who.bad) return said(SAYS.long);
  if (who.text && LINKY.test(who.text)) return said(SAYS.note);

  const known = await vocabulary(env);
  if (!known) return said(SAYS.down);

  // Where they were standing when they pressed the button. Same closed set the
  // events table checks against, so this column cannot hold a page the site
  // does not have.
  const path =
    typeof body.path === 'string' && validPath(body.path, known.paths) ? body.path : null;

  let id;
  try {
    id = await place(link.text);
  } catch (err) {
    console.error(JSON.stringify({ at: 'resolve', error: String(err) }));
    return said(SAYS.down);
  }
  if (!id) return said(SAYS.link);
  if (id.missing) return said(SAYS.place);

  /* The most useful answer this endpoint has, and it costs nothing: the
     vocabulary it already holds for validating events is also every CID in the
     collection. Somebody recommending a place that is already on a list should
     be told so at the moment they press the button, not left waiting for a
     reply that is never coming -- and it keeps the queue to things that are
     actually new. */
  let saved = null;
  if (id.cid && known.cids.has(id.cid)) saved = known.cids.get(id.cid);
  else if (id.mid && known.mids.has(id.mid)) saved = id.name;
  if (saved !== null) {
    return reply(site.headers, 200, { ok: true, state: 'already', name: saved });
  }

  if (await overCap(env, 'rec:', site.facts.at, DAILY_CAP)) return said(SAYS.busy);

  await env.DB.prepare(
    `INSERT INTO suggestions (at, url, cid, mid, lat, lng, name, note, who, path, country, agent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      site.facts.at,
      canonical(id),
      id.cid,
      id.mid,
      id.lat,
      id.lng,
      id.name,
      note.text,
      who.text,
      path,
      site.facts.country,
      site.facts.agent,
    )
    .run();

  return reply(site.headers, 200, { ok: true, state: 'received', name: id.name });
}

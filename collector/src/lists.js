/* The site's own data, read back.
 *
 * Every closed set this Worker checks against is derived from the deployed
 * `lists.json` rather than pinned here, because `refresh` adds cities, places
 * and CIDs on its own and a hardcoded copy would start silently disagreeing
 * with the site it is supposed to describe. Module scope is safe for this and
 * only this: it is immutable public config derived from a URL, not anything
 * belonging to a request. The fetch is edge-cached on top, so the 539 KB is
 * parsed at most once an hour per isolate.
 */

const VOCAB_TTL = 3600 * 1000;

let vocab = null;

const SLUG = /^[a-z0-9]{1,24}$/;

/* A path is at most a city and a category, in that order, and both have to be
   real keys. This is the check that does the most work: the site's path space
   is closed -- 38 cities, 10 categories -- so a forger cannot invent a page,
   only inflate one that exists. That is a far smaller problem, and a visible
   one. */
export function validPath(path, known) {
  if (typeof path !== 'string' || !path.startsWith('/') || path.length > 52) return false;
  const segs = path.slice(1).split('/');
  if (segs.length > 2) return false;
  return segs.every((seg) => SLUG.test(seg) && known.has(seg));
}

/* `labels` is the one field here that is not a gate. It exists so the review
   page can say "🇬🇷 Athens › ☕️ Coffee" instead of "/athens/coffee" -- the same
   words the person was looking at when they pressed the button. */
function build(data) {
  const paths = new Set();
  const labels = new Map();
  for (const city of data.cities || []) {
    paths.add(city.key);
    labels.set(city.key, `${city.flag || ''} ${city.name}`.trim());
  }
  for (const cat of data.categories || []) {
    paths.add(cat.key);
    labels.set(cat.key, `${cat.emoji || ''} ${cat.name}`.trim());
  }

  const places = new Set();
  const cids = new Map(); // cid -> name, so "already saved" can say which place
  const mids = new Set();
  for (const place of data.places || []) {
    places.add(place.name);
    if (place.cid) cids.set(String(place.cid), place.name);
    if (place.mid) mids.add(String(place.mid));
  }

  if (!paths.size || !places.size) throw new Error('lists.json looks empty');
  return { at: Date.now(), paths, labels, places, cids, mids };
}

export async function vocabulary(env) {
  if (vocab && Date.now() - vocab.at < VOCAB_TTL) return vocab;

  try {
    const res = await fetch(env.LISTS_URL, {
      cf: { cacheTtl: 3600, cacheEverything: true },
    });
    if (!res.ok) throw new Error(`lists.json responded ${res.status}`);
    vocab = build(await res.json());
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

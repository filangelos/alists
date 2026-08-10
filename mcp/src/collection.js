/* The collection, read out of R2 and held in memory.
 *
 * `lists.json` is 2218 places and about 750 KB. That is small enough that the
 * whole of it fits in an isolate and every question below is answered by a
 * scan, which is why there is no database here and no schema to keep in step
 * with the file. D1 was the obvious alternative and would have bought
 * indexing this does not need: a radius query over 2218 rows is a couple of
 * hundred microseconds of arithmetic, and the second copy of the data would
 * have been a second thing that can disagree with `data/lists.json`. Past
 * roughly a hundred thousand places that trade flips; nothing else about this
 * file would have to change when it does.
 *
 * The text handling is lifted from `app.js` rather than reimplemented, and it
 * matters that it is the same code: an agent asking for `cafe` and a person
 * typing `cafe` into the search box should get the same places back, and two
 * independently written folds would drift apart on the first Greek name.
 */

/* Long enough that a busy isolate is not re-reading a 750 KB object, short
   enough that the daily refresh is visible within the hour it lands. The
   `head` below makes the common case cheap regardless: the object is only
   re-read and re-parsed when its etag actually moved. */
const TTL = 300 * 1000;

let cached = null;

// ------------------------------------------------------------------- text

/* Fold accents and case, exactly as app.js does, so `cafe` finds `Café` and
   `ανοιξη` finds `Άνοιξη`. It does not transliterate: `anoixi` finds nothing
   and a Greek name has to be asked for in Greek. Final sigma folds onto the
   medial one so the two spellings of one street stay one word. */
export const fold = (s) =>
  (s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\u03c2/g, '\u03c3');

const tokens = (s) =>
  fold(s)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

/* Score a place against the words, -1 for no match. Every word has to land
   somewhere, and where it lands decides the rank: a name match beats an
   address match. `_rest` does not contain the city's own name -- see the
   `strip` set in `build` -- so asking for `london` returns the places actually
   called London rather than all 507 whose address contains the word. */
function score(place, words) {
  if (!words.length) return 0;
  let total = 0;
  for (const word of words) {
    const inName = place._name.indexOf(word);
    if (inName === 0) total += 100;
    else if (inName > 0) total += place._nameWords.has(word) ? 70 : 50;
    else if (place._rest.includes(word)) total += 10;
    else return -1;
  }
  return total;
}

// --------------------------------------------------------------- distance

const EARTH_KM = 6371;
const rad = (deg) => (deg * Math.PI) / 180;

/* Great-circle distance, the same as the page's. Not driving distance: the
   question is which places are near enough to walk to, and "as the crow flies"
   orders a neighbourhood correctly without a routing call per place. A radius
   answer is therefore a lower bound on how far you will actually walk, which
   is the honest way round for it to be wrong. */
export function haversine(a, b) {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

// ------------------------------------------------------------------ index

/* The mark that holds a place out of the collection. `data/lists.json` names
   it, and the one thing this server must not do is quietly ignore it: every
   place in the tree is somewhere the owner has been and would send you to,
   and a marked one is somewhere heard about and still owed a visit. Folding
   the two together would answer a question about recommendations with a
   to-do list. So `been` defaults to `yes` in every tool that takes it. */
const UNVISITED = 'unverified';

const been = (place) => !(place.marks || []).includes(UNVISITED);

function build(data) {
  const listNames = new Map((data.lists || []).map((l) => [l.id, l.name]));

  const cities = (data.cities || []).map((c) => ({
    key: c.key,
    name: c.name,
    flag: c.flag || '',
    lat: c.lat,
    lng: c.lng,
    total: c.count,
  }));

  const categories = (data.categories || []).map((c) => ({
    key: c.key,
    name: c.name,
    emoji: c.emoji || '',
  }));

  const cityByName = new Map(cities.map((c) => [c.name, c]));

  const places = (data.places || []).map((p) => {
    const city = cityByName.get(p.city) || null;
    const place = {
      name: p.name,
      address: p.address || '',
      note: p.note || '',
      city: p.city,
      cityKey: city ? city.key : null,
      flag: city ? city.flag : '',
      type: p.type,
      lat: typeof p.lat === 'number' ? p.lat : null,
      lng: typeof p.lng === 'number' ? p.lng : null,
      cid: p.cid ? String(p.cid) : null,
      mid: p.mid ? String(p.mid) : null,
      added: p.added || null,
      far: !!p.far,
      been: been(p),
      lists: (p.lists || []).map((id) => listNames.get(id)).filter(Boolean),
    };
    place._name = fold(place.name);
    place._nameWords = new Set(place._name.split(/[^\p{L}\p{N}]+/u).filter(Boolean));
    return place;
  });

  /* The city's own name comes out of its places' searchable text, token by
     token and never as a substring -- `uk` inside `Duke St` and `lon` inside
     `Colonnade` are real words in real addresses. Done per city rather than
     once, because the token to strip differs per city. */
  const strip = new Map(cities.map((c) => [c.name, new Set([...tokens(c.name), ...tokens(c.key)])]));
  for (const place of places) {
    const skip = strip.get(place.city) || new Set();
    place._rest = tokens([place.address, place.note, ...place.lists].join(' '))
      .filter((t) => !skip.has(t))
      .join(' ');
  }

  if (!places.length) throw new Error('lists.json holds no places');

  /* Counts are recomputed rather than read from `count` in the file, because
     the file's number is the total and every count this server reports has to
     move with the `been` filter that produced it. A number counting rows the
     caller cannot see is the same lie here as it is on the page. */
  for (const city of cities) {
    city.count = places.filter((p) => p.city === city.name).length;
    city.countBeen = places.filter((p) => p.city === city.name && p.been).length;
  }
  for (const cat of categories) {
    cat.count = places.filter((p) => p.type === cat.key).length;
    cat.countBeen = places.filter((p) => p.type === cat.key && p.been).length;
  }

  return {
    at: Date.now(),
    generated: data.generated || null,
    owner: data.owner || null,
    places,
    cities: cities.filter((c) => c.count > 0),
    categories: categories.filter((c) => c.count > 0),
  };
}

/* Read the object, and re-parse it only when it has actually changed.
 *
 * `head` costs a class B operation and answers the only question worth asking
 * most of the time -- the data moves once a day and this cache expires twelve
 * times in between. When the etag matches, the parse is skipped and the
 * existing index keeps its place in memory.
 *
 * Failing shut rather than open: with no index there is nothing to answer
 * from, and an empty list of places is a worse answer than an error, because
 * an agent reads "no coffee near you" as a fact about the neighbourhood. */
export async function collection(env) {
  const key = env.LISTS_KEY || 'lists.json';
  if (cached && Date.now() - cached.index.at < TTL) return cached.index;

  if (cached) {
    try {
      const head = await env.LISTS.head(key);
      if (head && head.etag === cached.etag) {
        cached.index.at = Date.now();
        return cached.index;
      }
    } catch (err) {
      // A failed head is not a reason to throw away a good index; fall
      // through to the full read, which has its own stale-copy path.
      console.error(JSON.stringify({ at: 'head', error: String(err) }));
    }
  }

  try {
    const object = await env.LISTS.get(key);
    if (!object) throw new Error(`no ${key} in the bucket`);
    cached = { etag: object.etag, index: build(await object.json()) };
  } catch (err) {
    console.error(JSON.stringify({ at: 'collection', error: String(err), stale: !!cached }));
    if (!cached) throw err;
    // Serve the copy in hand rather than dropping the hour over a blip.
    cached.index.at = Date.now();
  }

  return cached.index;
}

// ----------------------------------------------------------------- naming

/* Resolve what somebody wrote to one of a closed set.
 *
 * Three passes, narrowing: the key, the name, then a unique substring. The
 * last one is what makes `san francisco`, `SF`-less prose and `Coffee ` all
 * land, and it is deliberately unique-or-nothing -- an ambiguous word comes
 * back as an error naming the candidates, because guessing between Athens and
 * Athens-something is how an agent ends up confidently reporting the wrong
 * city's coffee. */
export function resolve(items, written, what) {
  const wanted = fold(String(written || '')).trim();
  if (!wanted) return { error: `no ${what} given` };

  const exact = items.find((i) => fold(i.key) === wanted || fold(i.name) === wanted);
  if (exact) return { value: exact };

  const near = items.filter((i) => fold(i.name).includes(wanted) || fold(i.key).includes(wanted));
  if (near.length === 1) return { value: near[0] };
  if (near.length > 1) {
    return {
      error: `"${written}" matches more than one ${what}: ${near.map((i) => i.name).join(', ')}`,
    };
  }
  return {
    error: `no ${what} called "${written}". Known ${what}s: ${items.map((i) => i.key).join(', ')}`,
  };
}

/* Where to measure from. A city centre or a place already in the collection,
   both of which this file knows the coordinates of -- and nothing else.
   Free-form addresses are not geocoded here on purpose: it would mean an API
   key, a per-call network hop and a second opinion about where places are,
   and the caller who has an address can pass its latitude and longitude. */
export function origin(index, { near, latitude, longitude }) {
  const hasPoint = typeof latitude === 'number' && typeof longitude === 'number';

  if (hasPoint && near) {
    return { error: 'give either `near` or a latitude/longitude pair, not both' };
  }

  if (hasPoint) {
    if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
      return { error: 'latitude must be within ±90 and longitude within ±180' };
    }
    return { value: { lat: latitude, lng: longitude, label: `${latitude}, ${longitude}` } };
  }

  if (!near) return { error: 'give either `near` or a latitude/longitude pair' };

  const city = resolve(index.cities, near, 'city');
  if (city.value && city.value.lat != null) {
    return { value: { lat: city.value.lat, lng: city.value.lng, label: city.value.name } };
  }

  const wanted = fold(near);
  const exact = index.places.filter((p) => p._name === wanted && p.lat != null);
  const hits = exact.length
    ? exact
    : index.places.filter((p) => p._name.includes(wanted) && p.lat != null);

  if (hits.length === 1) {
    return { value: { lat: hits[0].lat, lng: hits[0].lng, label: hits[0].name } };
  }
  if (hits.length > 1) {
    // Several saved places share a name across cities -- there are two
    // Prufrocks and several Da Marios. Say which, rather than picking one.
    const names = hits.slice(0, 8).map((p) => `${p.name} (${p.city})`);
    return {
      error:
        `"${near}" matches ${hits.length} saved places: ${names.join('; ')}` +
        (hits.length > 8 ? ', …' : '') +
        '. Name the city instead, or pass a latitude and longitude.',
    };
  }

  return {
    error:
      `"${near}" is not a city in the collection or a place saved in it, and ` +
      'addresses are not geocoded here. Pass a latitude and longitude, or use ' +
      'list_cities to see what can be named.',
  };
}

// ---------------------------------------------------------------- queries

/* The one filter every tool shares. `been` is an enum rather than a boolean
   because there are three honest answers and only two of them fit in a flag:
   what is recommended, what is still owed a visit, and everything. */
export function filter(index, { city, category, been: wanted = 'yes', added_since: since }) {
  let places = index.places;
  const applied = {};

  if (city) {
    const found = resolve(index.cities, city, 'city');
    if (found.error) return { error: found.error };
    applied.city = found.value;
    places = places.filter((p) => p.city === found.value.name);
  }

  if (category) {
    const found = resolve(index.categories, category, 'category');
    if (found.error) return { error: found.error };
    applied.category = found.value;
    places = places.filter((p) => p.type === found.value.key);
  }

  if (wanted === 'yes') places = places.filter((p) => p.been);
  else if (wanted === 'no') places = places.filter((p) => !p.been);
  else if (wanted !== 'either') {
    return { error: '`been` must be one of "yes", "no", "either"' };
  }

  if (since) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) {
      return { error: '`added_since` must be a date of the form YYYY-MM-DD' };
    }
    /* Undated places are the 1649 that predate the record rather than places
       known to be old, so they are excluded from a "since" question rather
       than assumed to fail it. The README has the reasoning: the dates were
       seeded from the git history of `data/lists.json`, which knows when each
       place appeared and nothing about the years before it. */
    places = places.filter((p) => p.added && p.added >= since);
  }

  return { places, applied };
}

export function matching(places, query) {
  const words = fold(String(query || ''))
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return places;

  const hits = [];
  for (const place of places) {
    const value = score(place, words);
    if (value >= 0) hits.push({ place, value });
  }
  // Stable by construction: ties keep the curated order they arrived in.
  hits.sort((a, b) => b.value - a.value);
  return hits.map((h) => h.place);
}

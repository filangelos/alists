/* The five questions this collection can answer.
 *
 * A tool description is read by a model deciding whether to call it, so these
 * say what the answer will mean rather than what the arguments are named. The
 * one that needs saying most often is the `been` default: everything in this
 * collection is somewhere the owner has been and would send you to, except the
 * places carrying the `next` mark, which are the opposite -- heard about,
 * saved, not visited. Every tool defaults to leaving those out, because
 * "recommend me a coffee place" answered with a to-do list is a wrong answer
 * that reads like a right one.
 *
 * Every result also carries `generated`, the timestamp of the refresh that
 * wrote the data. An agent that knows the collection is four days old can say
 * so; one that does not will present it as today's.
 */

import { collection, filter, matching, origin, haversine, resolve } from './collection.js';

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 25;

/* The same URL the page builds. A CID addresses the place itself, so it
   survives a rename and lands on the entry rather than on a search for its
   name; the fallback is for the rare place saved without one. */
const mapsUrl = (place) =>
  place.cid
    ? `https://maps.google.com/?cid=${place.cid}`
    : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
        place.lat != null ? `${place.lat},${place.lng}` : place.name
      )}`;

/* Empty fields are dropped rather than sent as `""` and `null`. Twenty-five
   places is twenty-five copies of every key, and a note nobody wrote is not
   information. */
function shape(place, distanceKm) {
  const out = {
    name: place.name,
    city: place.city,
    category: place.type,
    been: place.been,
    maps_url: mapsUrl(place),
  };
  if (place.address) out.address = place.address;
  if (place.lat != null) {
    out.latitude = place.lat;
    out.longitude = place.lng;
  }
  if (place.note) out.note = place.note;
  if (place.added) out.added = place.added;
  if (place.lists.length) out.lists = place.lists;
  // Only ever true, and only on the 74 places filed by nearest city centre
  // from more than 12 km away. The page draws these with a `~`.
  if (place.far) out.city_uncertain = true;
  if (distanceKm != null) out.distance_km = Math.round(distanceKm * 100) / 100;
  return out;
}

const km = (v) => (v < 1 ? `${Math.round(v * 1000)} m` : v < 10 ? `${v.toFixed(1)} km` : `${Math.round(v)} km`);

/* The text block, which is what a client shows when it shows anything. Built
   to read like a row of the page it comes from: a filled bullet for somewhere
   the owner has been, a hollow one for somewhere still owed a visit. */
function render(index, places, distances) {
  const cats = new Map(index.categories.map((c) => [c.key, c]));
  const cities = new Map(index.cities.map((c) => [c.name, c]));
  return places
    .map((place, i) => {
      const cat = cats.get(place.type);
      const city = cities.get(place.city);
      const trail = [
        `${city && city.flag ? city.flag + ' ' : ''}${place.city}${place.far ? ' ~' : ''}`,
        `${cat && cat.emoji ? cat.emoji + ' ' : ''}${cat ? cat.name : place.type}`,
      ].join(' › ');
      const tail = [trail];
      if (distances) tail.push(km(distances[i]));
      tail.push(mapsUrl(place));
      return (
        `${place.been ? '●' : '○'} ${place.name}` +
        (place.address ? `\n  ${place.address}` : '') +
        (place.note ? `\n  ${place.note}` : '') +
        `\n  ${tail.join(' · ')}`
      );
    })
    .join('\n\n');
}

// ------------------------------------------------------------------ schema

const PLACE_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    address: { type: 'string' },
    city: { type: 'string' },
    category: { type: 'string', description: 'A category key, as listed by list_categories.' },
    been: {
      type: 'boolean',
      description:
        'True for a place the owner has been to and recommends. False for one saved and not yet visited.',
    },
    latitude: { type: 'number' },
    longitude: { type: 'number' },
    note: { type: 'string' },
    added: {
      type: 'string',
      description:
        'The day this place first appeared in the data. Absent for places that predate the record.',
    },
    lists: {
      type: 'array',
      items: { type: 'string' },
      description: 'The Google Maps lists the place is saved on.',
    },
    city_uncertain: {
      type: 'boolean',
      description:
        'Present only when the city was inferred from the nearest city centre more than 12 km away.',
    },
    distance_km: { type: 'number', description: 'Great-circle distance from the origin asked about.' },
    maps_url: { type: 'string' },
  },
  required: ['name', 'city', 'category', 'been', 'maps_url'],
};

const BEEN = {
  type: 'string',
  enum: ['yes', 'no', 'either'],
  default: 'yes',
  description:
    'Which places to include. "yes" (the default) returns only places the owner has been to and ' +
    'recommends. "no" returns only the ones saved but not yet visited. "either" returns both. ' +
    'Use "yes" unless the question is specifically about what is still unvisited.',
};

const CITY = {
  type: 'string',
  description: 'Restrict to one city, by key ("newyork") or name ("New York"). See list_cities.',
};

const CATEGORY = {
  type: 'string',
  description: 'Restrict to one category, by key ("coffee") or name ("Coffee"). See list_categories.',
};

const LIMIT = {
  type: 'integer',
  minimum: 1,
  maximum: MAX_LIMIT,
  default: DEFAULT_LIMIT,
  description: `Most places to return. The count of all matches is reported separately, so a small limit does not hide how many there were.`,
};

const listResult = (extra = {}) => ({
  type: 'object',
  properties: {
    generated: { type: 'string', description: 'When the underlying data was last refreshed.' },
    total: { type: 'integer', description: 'How many places matched, before the limit.' },
    returned: { type: 'integer' },
    places: { type: 'array', items: PLACE_SCHEMA },
    ...extra,
  },
  required: ['total', 'returned', 'places'],
});

export const TOOLS = [
  {
    name: 'search_places',
    title: 'Search saved places',
    description:
      'Search the collection by free text and by city, category and visited state. Text is matched ' +
      'against the name, address, note and Google Maps list names, folding accents and case, so ' +
      '"cafe" finds "Café". It does not transliterate: a Greek name has to be asked for in Greek. ' +
      'Use this for "somewhere for dinner in Athens" or "that bakery with the pastel front"; use ' +
      'places_near when the question is about distance from a point.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Free text. Every word must match somewhere; a name match ranks above an address match. ' +
            'Omit it to list everything the other filters allow.',
        },
        city: CITY,
        category: CATEGORY,
        been: BEEN,
        added_since: {
          type: 'string',
          pattern: '^\\d{4}-\\d{2}-\\d{2}$',
          description:
            'Only places first seen on or after this date (YYYY-MM-DD). Places with no date predate ' +
            'the record and are excluded rather than assumed old.',
        },
        limit: LIMIT,
      },
      additionalProperties: false,
    },
    outputSchema: listResult(),
  },

  {
    name: 'places_near',
    title: 'Places within a radius',
    description:
      'Every saved place within a radius of a point, nearest first, optionally narrowed to one ' +
      'category. This is the tool for "coffee within 2 km of here" or "what is near the Acropolis". ' +
      'The point is given either as a latitude and longitude, or by naming a city or a place already ' +
      'in the collection. Free-form addresses are not geocoded — geocode them yourself and pass ' +
      'coordinates. Distances are great-circle, so they are a floor on how far you will walk.',
    inputSchema: {
      type: 'object',
      properties: {
        near: {
          type: 'string',
          description:
            'Where to measure from, named: a city ("Athens") or a place saved in the collection ' +
            '("Prufrock Coffee"). Give this or a latitude/longitude pair, not both.',
        },
        latitude: { type: 'number', minimum: -90, maximum: 90 },
        longitude: { type: 'number', minimum: -180, maximum: 180 },
        radius_km: {
          type: 'number',
          exclusiveMinimum: 0,
          maximum: 20000,
          default: 2,
          description: 'How far out to look, in kilometres. 2 is a walk; 15 covers a city.',
        },
        city: CITY,
        category: CATEGORY,
        been: BEEN,
        limit: LIMIT,
      },
      oneOf: [{ required: ['near'] }, { required: ['latitude', 'longitude'] }],
      additionalProperties: false,
    },
    outputSchema: listResult({
      from: {
        type: 'object',
        description: 'The point the distances were measured from, as this server resolved it.',
        properties: {
          label: { type: 'string' },
          latitude: { type: 'number' },
          longitude: { type: 'number' },
        },
      },
      radius_km: { type: 'number' },
    }),
  },

  {
    name: 'get_place',
    title: 'Get one place',
    description:
      'Everything known about a single place, by name or by Google Maps CID. Use it after a search ' +
      'to get the note, the lists it is saved on and the day it was added.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'The place name. An exact match wins; otherwise a unique partial match is used.',
        },
        cid: { type: 'string', description: 'The Google Maps CID, as returned in maps_url.' },
        city: CITY,
      },
      anyOf: [{ required: ['name'] }, { required: ['cid'] }],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: { generated: { type: 'string' }, place: PLACE_SCHEMA },
      required: ['place'],
    },
  },

  {
    name: 'list_cities',
    title: 'List cities',
    description:
      'Every city in the collection with its place count and centre coordinates. Call this first ' +
      'when you need to know what the collection covers, or to turn a city a person named into the ' +
      'key the other tools take.',
    inputSchema: {
      type: 'object',
      properties: { been: BEEN },
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        generated: { type: 'string' },
        total_places: { type: 'integer' },
        cities: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              key: { type: 'string' },
              name: { type: 'string' },
              flag: { type: 'string' },
              count: { type: 'integer' },
              latitude: { type: 'number' },
              longitude: { type: 'number' },
            },
            required: ['key', 'name', 'count'],
          },
        },
      },
      required: ['cities'],
    },
  },

  {
    name: 'list_categories',
    title: 'List categories',
    description:
      'The categories places are filed under, with counts. "Other" is where the classifier declined ' +
      'rather than where the worse places are: only some places carry a category list in Google ' +
      'Maps, the rest are typed by reading the name, and a good restaurant is called "Palma" rather ' +
      'than "Palma Restaurant". Do not treat Other as a quality signal.',
    inputSchema: {
      type: 'object',
      properties: { been: BEEN, city: CITY },
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        generated: { type: 'string' },
        categories: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              key: { type: 'string' },
              name: { type: 'string' },
              emoji: { type: 'string' },
              count: { type: 'integer' },
            },
            required: ['key', 'name', 'count'],
          },
        },
      },
      required: ['categories'],
    },
  },
];

export const INSTRUCTIONS =
  'This server exposes one person\'s Google Maps saves: places they have been to and would send ' +
  'you to, filed by city and by category. It is a recommendation list, not a directory — it is ' +
  'small, opinionated and covers only the cities in list_cities, so "no results" means "nothing ' +
  'saved there", never "nowhere to eat there". Places carrying the `next` mark are the exception: ' +
  'saved, not yet visited, not recommended. Every tool leaves them out unless asked. Categories ' +
  'below "Other" are guessed from place names and are approximate; cities are derived from ' +
  'coordinates and are reliable.';

// ------------------------------------------------------------------ calling

const fail = (text) => ({ content: [{ type: 'text', text }], isError: true });

const ok = (text, structured) => ({
  content: [{ type: 'text', text }],
  structuredContent: structured,
});

const bounded = (n) =>
  Math.max(1, Math.min(MAX_LIMIT, Number.isFinite(n) ? Math.floor(n) : DEFAULT_LIMIT));

export async function call(env, name, args) {
  const index = await collection(env);
  const a = args && typeof args === 'object' ? args : {};
  const generated = index.generated;

  if (name === 'search_places' || name === 'places_near') {
    const near = name === 'places_near';

    let from = null;
    if (near) {
      const resolved = origin(index, a);
      if (resolved.error) return fail(resolved.error);
      from = resolved.value;
    }

    const chosen = filter(index, a);
    if (chosen.error) return fail(chosen.error);

    let places = chosen.places;
    let distances = null;

    if (near) {
      const radius = typeof a.radius_km === 'number' && a.radius_km > 0 ? a.radius_km : 2;
      const within = [];
      for (const place of places) {
        if (place.lat == null) continue;
        const d = haversine(from, place);
        if (d <= radius) within.push({ place, d });
      }
      within.sort((x, y) => x.d - y.d);
      places = within.map((w) => w.place);
      distances = within.map((w) => w.d);

      const limit = bounded(a.limit);
      const shown = places.slice(0, limit);
      const shownD = distances.slice(0, limit);
      const body = {
        generated,
        from: { label: from.label, latitude: from.lat, longitude: from.lng },
        radius_km: radius,
        total: places.length,
        returned: shown.length,
        places: shown.map((p, i) => shape(p, shownD[i])),
      };
      const head = places.length
        ? `${places.length} place${places.length === 1 ? '' : 's'} within ${km(radius)} of ${from.label}` +
          (places.length > shown.length ? `, nearest ${shown.length}` : '') +
          ':'
        : `Nothing saved within ${km(radius)} of ${from.label}.`;
      return ok(shown.length ? `${head}\n\n${render(index, shown, shownD)}` : head, body);
    }

    places = matching(places, a.query);
    const limit = bounded(a.limit);
    const shown = places.slice(0, limit);
    const body = {
      generated,
      total: places.length,
      returned: shown.length,
      places: shown.map((p) => shape(p)),
    };
    const head = places.length
      ? `${places.length} match${places.length === 1 ? '' : 'es'}` +
        (places.length > shown.length ? `, showing ${shown.length}` : '') +
        ':'
      : 'Nothing saved matches that.';
    return ok(shown.length ? `${head}\n\n${render(index, shown)}` : head, body);
  }

  if (name === 'get_place') {
    let hits = index.places;
    if (a.city) {
      const city = resolve(index.cities, a.city, 'city');
      if (city.error) return fail(city.error);
      hits = hits.filter((p) => p.city === city.value.name);
    }

    if (a.cid) {
      const wanted = String(a.cid);
      const hit = hits.find((p) => p.cid === wanted);
      if (!hit) return fail(`No saved place has the CID ${wanted}.`);
      return ok(render(index, [hit]), { generated, place: shape(hit) });
    }

    if (!a.name) return fail('give either `name` or `cid`');

    const found = matching(hits, a.name);
    const exact = found.filter((p) => p.name.toLowerCase() === String(a.name).toLowerCase());
    const candidates = exact.length ? exact : found;

    if (!candidates.length) return fail(`Nothing saved is called "${a.name}".`);
    if (candidates.length > 1) {
      const names = candidates.slice(0, 10).map((p) => `${p.name} (${p.city})`);
      return fail(
        `"${a.name}" matches ${candidates.length} saved places: ${names.join('; ')}` +
          (candidates.length > 10 ? ', …' : '') +
          '. Narrow it with `city`, or use the CID.'
      );
    }
    return ok(render(index, candidates), { generated, place: shape(candidates[0]) });
  }

  if (name === 'list_cities') {
    const chosen = filter(index, { been: a.been });
    if (chosen.error) return fail(chosen.error);
    const counts = new Map();
    for (const place of chosen.places) counts.set(place.city, (counts.get(place.city) || 0) + 1);

    const cities = index.cities
      .filter((c) => counts.get(c.name))
      .map((c) => ({
        key: c.key,
        name: c.name,
        flag: c.flag,
        count: counts.get(c.name),
        latitude: c.lat,
        longitude: c.lng,
      }))
      .sort((x, y) => y.count - x.count);

    const text = cities
      .map((c) => `${c.flag ? c.flag + ' ' : ''}${c.name} (${c.key}) — ${c.count}`)
      .join('\n');
    return ok(text, { generated, total_places: chosen.places.length, cities });
  }

  if (name === 'list_categories') {
    const chosen = filter(index, { been: a.been, city: a.city });
    if (chosen.error) return fail(chosen.error);
    const counts = new Map();
    for (const place of chosen.places) counts.set(place.type, (counts.get(place.type) || 0) + 1);

    // The file's own order, which puts Other last on purpose.
    const categories = index.categories
      .filter((c) => counts.get(c.key))
      .map((c) => ({ key: c.key, name: c.name, emoji: c.emoji, count: counts.get(c.key) }));

    const text = categories
      .map((c) => `${c.emoji ? c.emoji + ' ' : ''}${c.name} (${c.key}) — ${c.count}`)
      .join('\n');
    return ok(text, { generated, categories });
  }

  return null; // no such tool; the caller turns this into a protocol error
}

/* What this Worker is supposed to do, run against the real data.
 *
 * `node test.js`, no install and no network. The only thing stubbed is R2,
 * which is stubbed with the actual `data/lists.json` out of the repository --
 * so a change to `derive.py` that renames a category or drops a field fails
 * here rather than in front of an agent. Wrangler is not needed to run it,
 * which is the point: the checks below are about this code, not about whether
 * a deploy happened.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import worker from './src/worker.js';
import { LATEST, LEGACY } from './src/rpc.js';

const here = dirname(fileURLToPath(import.meta.url));
const bytes = readFileSync(join(here, '..', 'data', 'lists.json'));
const ETAG = 'a1b2c3';

const env = {
  LISTS_KEY: 'lists.json',
  LISTS: {
    async head() {
      return { etag: ETAG };
    },
    async get(key, options) {
      const asked = options && options.onlyIf && options.onlyIf.get('if-none-match');
      const base = { etag: ETAG, httpEtag: `"${ETAG}"`, writeHttpMetadata() {} };
      if (asked && asked.replace(/"/g, '') === ETAG) return { ...base, body: null };
      return {
        ...base,
        body: new Uint8Array(bytes),
        async json() {
          return JSON.parse(bytes.toString('utf8'));
        },
      };
    },
  },
};

const ORIGIN = 'https://alists-mcp.example.workers.dev';

let id = 0;

/* Builds the request the way a conforming client would, so the header checks
   are exercised by the happy path rather than only by the tests aimed at
   them. `raw` overrides let a test send a wrong one on purpose. */
function rpc(method, params = {}, { version = LATEST, raw = {}, path = '/mcp' } = {}) {
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  const body = { jsonrpc: '2.0', id: ++id, method, params };

  if (version) {
    headers['mcp-protocol-version'] = version;
    headers['mcp-method'] = method;
    if (version === LATEST) {
      body.params._meta = {
        'io.modelcontextprotocol/protocolVersion': version,
        'io.modelcontextprotocol/clientInfo': { name: 'alists-test', version: '1.0' },
        'io.modelcontextprotocol/clientCapabilities': {},
      };
      const named = method === 'tools/call' ? params.name : null;
      if (named) headers['mcp-name'] = named;
    }
  }

  /* `null` deletes rather than overrides. An undefined value handed to
     `Request` is stringified to the word "undefined", which is a *wrong*
     header rather than a missing one -- and the two take different branches
     in `era`, so a test that meant to drop a header and quietly sent
     "undefined" instead would pass without checking anything. */
  for (const [key, value] of Object.entries(raw)) {
    if (value === null) delete headers[key];
    else headers[key] = value;
  }

  return new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

const send = (...args) => worker.fetch(rpc(...args), env);

const tool = async (name, args, options) => {
  const res = await send('tools/call', { name, arguments: args }, options);
  const body = await res.json();
  return { res, body, result: body.result, structured: body.result && body.result.structuredContent };
};

let passed = 0;
const failures = [];

function check(what, condition, detail) {
  if (condition) {
    passed++;
    return;
  }
  failures.push(detail ? `${what}\n      ${detail}` : what);
}

const eq = (what, got, want) =>
  check(what, Object.is(got, want), `expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);

// ------------------------------------------------------------------ shape

{
  const res = await send('server/discover');
  const body = await res.json();
  eq('discover: 200', res.status, 200);
  eq('discover: resultType', body.result.resultType, 'complete');
  eq('discover: cacheScope', body.result.cacheScope, 'public');
  check('discover: ttlMs is a non-negative integer', Number.isInteger(body.result.ttlMs) && body.result.ttlMs >= 0);
  check('discover: advertises the current revision', body.result.supportedVersions.includes(LATEST));
  check('discover: declares tools', !!body.result.capabilities.tools);
  check('discover: carries serverInfo', !!body.result._meta['io.modelcontextprotocol/serverInfo']);
  check('discover: has instructions', (body.result.instructions || '').length > 100);
}

{
  const res = await send('tools/list');
  const body = await res.json();
  eq('tools/list: 200', res.status, 200);
  eq('tools/list: five tools', body.result.tools.length, 5);
  eq('tools/list: resultType', body.result.resultType, 'complete');
  check('tools/list: cacheable', body.result.ttlMs > 0 && body.result.cacheScope === 'public');
  for (const t of body.result.tools) {
    check(`tools/list: ${t.name} has an object inputSchema`, t.inputSchema.type === 'object');
    check(`tools/list: ${t.name} has a description`, (t.description || '').length > 40);
    check(`tools/list: ${t.name} declares an outputSchema`, !!t.outputSchema);
  }
}

// ----------------------------------------------------------------- queries

{
  const { res, structured } = await tool('search_places', { query: 'prufrock' });
  eq('search: 200', res.status, 200);
  check('search: finds Prufrock Coffee', structured.places.some((p) => /prufrock/i.test(p.name)));
  check('search: reports the total', Number.isInteger(structured.total));
  check('search: says when the data was generated', /^\d{4}-\d{2}-\d{2}/.test(structured.generated));
}

{
  // Accent folding: the site promises `cafe` finds `Café`, and this server
  // has to agree with it or the two answer the same question differently.
  const { structured } = await tool('search_places', { query: 'cafe', limit: 200, been: 'either' });
  check(
    'search: folds accents',
    structured.places.some((p) => /caf[ée]/i.test(p.name) && /é/.test(p.name))
  );
}

{
  const been = await tool('search_places', { city: 'london', limit: 1 });
  const either = await tool('search_places', { city: 'london', been: 'either', limit: 1 });
  const not = await tool('search_places', { city: 'london', been: 'no', limit: 1 });
  check(
    'been: the default holds back the unvisited places',
    been.structured.total < either.structured.total
  );
  eq(
    'been: yes + no accounts for either',
    been.structured.total + not.structured.total,
    either.structured.total
  );
  check('been: default returns only visited places', been.structured.places.every((p) => p.been));
  check('been: "no" returns only unvisited places', not.structured.places.every((p) => !p.been));
}

{
  // The question this server was built for.
  const { res, structured, result } = await tool('places_near', {
    near: 'London',
    radius_km: 2,
    category: 'coffee',
  });
  eq('near: 200', res.status, 200);
  eq('near: named the origin it used', structured.from.label, 'London');
  eq('near: echoed the radius', structured.radius_km, 2);
  check('near: found coffee', structured.total > 0);
  check('near: every place is a coffee place', structured.places.every((p) => p.category === 'coffee'));
  check('near: every place is inside the radius', structured.places.every((p) => p.distance_km <= 2));
  check(
    'near: sorted nearest first',
    structured.places.every((p, i, all) => i === 0 || all[i - 1].distance_km <= p.distance_km)
  );
  check('near: the text block names the places', result.content[0].text.includes(structured.places[0].name));
}

{
  const wide = await tool('places_near', { near: 'London', radius_km: 20, category: 'coffee' });
  const tight = await tool('places_near', { near: 'London', radius_km: 1, category: 'coffee' });
  check('near: a wider radius cannot find fewer', wide.structured.total >= tight.structured.total);
}

{
  // Coordinates rather than a name: 51.5138/-0.0984 is roughly St Paul's.
  const { structured } = await tool('places_near', {
    latitude: 51.5138,
    longitude: -0.0984,
    radius_km: 1,
  });
  check('near: accepts a latitude and longitude', structured.total > 0);
  eq('near: labels an unnamed origin with its coordinates', structured.from.latitude, 51.5138);
}

{
  const { result } = await tool('places_near', { near: 'London', latitude: 51.5, longitude: -0.1 });
  check('near: refuses both an origin name and coordinates', result.isError === true);
}

{
  const { result } = await tool('places_near', { near: 'Narnia', radius_km: 2 });
  check('near: says an unknown origin is unknown', result.isError === true);
  check('near: explains that addresses are not geocoded', /geocod/i.test(result.content[0].text));
}

{
  const { result } = await tool('search_places', { city: 'Atlantis' });
  check('filter: an unknown city is an isError result, not a protocol error', result.isError === true);
  check('filter: names the cities it does know', /london/.test(result.content[0].text));
}

{
  const cities = await tool('list_cities', {});
  const categories = await tool('list_categories', {});
  const all = await tool('search_places', { limit: 1 });
  eq(
    'counts: list_cities sums to the same total search_places reports',
    cities.structured.cities.reduce((n, c) => n + c.count, 0),
    all.structured.total
  );
  eq(
    'counts: list_categories sums to the same total',
    categories.structured.categories.reduce((n, c) => n + c.count, 0),
    all.structured.total
  );
  check('list_cities: London is in there', cities.structured.cities.some((c) => c.key === 'london'));
  check(
    'list_cities: cities carry a centre',
    cities.structured.cities.every((c) => typeof c.latitude === 'number')
  );
  check(
    'list_categories: Other sorts last',
    categories.structured.categories[categories.structured.categories.length - 1].key === 'other'
  );
}

{
  const { structured } = await tool('get_place', { name: 'Prufrock Coffee' });
  eq('get_place: found it', structured.place.name, 'Prufrock Coffee');
  check('get_place: carries a maps url', /^https:\/\/maps\.google\.com\/\?cid=/.test(structured.place.maps_url));
}

{
  const { result } = await tool('get_place', { name: 'a' });
  check('get_place: an ambiguous name lists the candidates', result.isError === true);
}

{
  const { structured } = await tool('search_places', { added_since: '2026-08-01', been: 'either' });
  check('added_since: returns something', structured.total > 0);
  check(
    'added_since: every place is dated on or after the day asked for',
    structured.places.every((p) => p.added >= '2026-08-01')
  );
}

// ---------------------------------------------------------------- protocol

{
  const res = await worker.fetch(
    rpc('tools/list', {}, { raw: { 'mcp-method': 'tools/call' } }),
    env
  );
  const body = await res.json();
  eq('headers: a wrong Mcp-Method is 400', res.status, 400);
  eq('headers: with a HeaderMismatch code', body.error.code, -32020);
}

{
  const res = await worker.fetch(rpc('tools/list', {}, { raw: { 'mcp-method': null } }), env);
  const body = await res.json();
  eq('headers: a missing Mcp-Method is 400', res.status, 400);
  eq('headers: with a HeaderMismatch code', body.error.code, -32020);
}

{
  const res = await worker.fetch(
    rpc('tools/call', { name: 'list_cities', arguments: {} }, { raw: { 'mcp-name': 'search_places' } }),
    env
  );
  const body = await res.json();
  eq('headers: an Mcp-Name that disagrees with the body is 400', res.status, 400);
  eq('headers: with a HeaderMismatch code', body.error.code, -32020);
}

{
  // The Base64 sentinel. `list_cities` is plain ASCII and would never need it,
  // which is exactly why it is a safe thing to encode in a test: the server
  // has to decode before comparing, or this fails.
  const encoded = `=?base64?${Buffer.from('list_cities', 'utf8').toString('base64')}?=`;
  const res = await worker.fetch(
    rpc('tools/call', { name: 'list_cities', arguments: {} }, { raw: { 'mcp-name': encoded } }),
    env
  );
  eq('headers: a Base64-encoded Mcp-Name is decoded before comparing', res.status, 200);
}

{
  const res = await worker.fetch(
    rpc('tools/list', {}, { raw: { 'mcp-protocol-version': '1900-01-01' } }),
    env
  );
  const body = await res.json();
  eq('version: an unknown revision is 400', res.status, 400);
  eq('version: with an UnsupportedProtocolVersion code', body.error.code, -32022);
  check('version: listing what the server does speak', body.error.data.supported.includes(LATEST));
  eq('version: echoing what was asked for', body.error.data.requested, '1900-01-01');
}

{
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/list',
    params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2025-06-18' } },
  });
  const res = await worker.fetch(
    new Request(`${ORIGIN}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'mcp-protocol-version': LATEST,
        'mcp-method': 'tools/list',
      },
      body,
    }),
    env
  );
  const answer = await res.json();
  eq('version: a _meta version that contradicts the header is 400', res.status, 400);
  eq('version: with a HeaderMismatch code', answer.error.code, -32020);
}

{
  const res = await send('resources/list');
  const body = await res.json();
  eq('method: an unimplemented method is 404', res.status, 404);
  eq('method: with a MethodNotFound code', body.error.code, -32601);
}

{
  const res = await send('initialize', { protocolVersion: LATEST });
  const body = await res.json();
  eq('initialize: refused on the current revision', res.status, 404);
  eq('initialize: as MethodNotFound', body.error.code, -32601);
}

{
  const res = await worker.fetch(
    new Request(`${ORIGIN}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    }),
    env
  );
  eq('notification: accepted with 202 and no body', res.status, 202);
}

{
  const res = await worker.fetch(
    new Request(`${ORIGIN}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{ not json',
    }),
    env
  );
  const body = await res.json();
  eq('malformed: parse error is 400', res.status, 400);
  eq('malformed: with a ParseError code', body.error.code, -32700);
}

{
  const res = await worker.fetch(
    new Request(`${ORIGIN}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'tools/list' }]),
    }),
    env
  );
  eq('batch: refused', res.status, 400);
}

// ------------------------------------------------------------------ legacy

{
  const res = await send('initialize', { protocolVersion: LEGACY[0] }, { version: LEGACY[0] });
  const body = await res.json();
  eq('legacy: initialize answers', res.status, 200);
  eq('legacy: agreeing on the revision asked for', body.result.protocolVersion, LEGACY[0]);
  check('legacy: with serverInfo', body.result.serverInfo.name === 'alists');
  check('legacy: and no resultType', body.result.resultType === undefined);
}

{
  const res = await worker.fetch(
    new Request(`${ORIGIN}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'mcp-protocol-version': LEGACY[1] },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    }),
    env
  );
  const body = await res.json();
  eq('legacy: tools/list without the new headers answers', res.status, 200);
  eq('legacy: with the same five tools', body.result.tools.length, 5);
  check('legacy: and no caching hints', body.result.ttlMs === undefined);
}

{
  // No version header at all: the pre-2025-06-18 shape, which is a client
  // that has not been told what this server speaks rather than a broken one.
  const res = await worker.fetch(
    new Request(`${ORIGIN}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    }),
    env
  );
  eq('legacy: a request with no version header is answered', res.status, 200);
}

// ------------------------------------------------------------------- http

{
  const res = await worker.fetch(new Request(`${ORIGIN}/lists.json`), env);
  eq('blob: 200', res.status, 200);
  eq('blob: json', res.headers.get('content-type'), 'application/json; charset=utf-8');
  eq('blob: open to any origin', res.headers.get('access-control-allow-origin'), '*');
  check('blob: carries an etag', !!res.headers.get('etag'));
  const data = await res.json();
  check('blob: is the collection', Array.isArray(data.places) && data.places.length > 1000);
}

{
  const res = await worker.fetch(
    new Request(`${ORIGIN}/lists.json`, { headers: { 'if-none-match': `"${ETAG}"` } }),
    env
  );
  eq('blob: an unchanged etag is 304', res.status, 304);
}

{
  const res = await worker.fetch(new Request(`${ORIGIN}/mcp`), env);
  eq('http: GET on the endpoint is 405', res.status, 405);
  eq('http: naming what it does accept', res.headers.get('allow'), 'POST, OPTIONS');
}

{
  const res = await worker.fetch(new Request(`${ORIGIN}/mcp`, { method: 'DELETE' }), env);
  eq('http: DELETE on the endpoint is 405', res.status, 405);
}

{
  const res = await worker.fetch(new Request(`${ORIGIN}/`), env);
  eq('http: the bare origin explains itself', res.status, 200);
  check('http: naming the endpoint', (await res.text()).includes('/mcp'));
}

{
  const res = await worker.fetch(new Request(`${ORIGIN}/mcp`, { method: 'OPTIONS' }), env);
  eq('http: preflight', res.status, 204);
  eq('http: allows POST', res.headers.get('access-control-allow-methods').includes('POST'), true);
}

{
  // The bare origin is an MCP endpoint too, because half of all client
  // configs will be a URL pasted without the path.
  const res = await worker.fetch(rpc('tools/list', {}, { path: '/' }), env);
  eq('http: the bare origin answers MCP as well', res.status, 200);
}

{
  const res = await worker.fetch(new Request(`${ORIGIN}/nope`), env);
  eq('http: an unknown path is 404', res.status, 404);
}

// -----------------------------------------------------------------------

console.log(`${passed} checks passed`);
if (failures.length) {
  console.error(`\n${failures.length} failed:\n`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}

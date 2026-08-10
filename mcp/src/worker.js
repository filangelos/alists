/* alists, for agents.
 *
 * Two things live at this origin and they are the same data twice:
 *
 *   GET  /lists.json   the blob, as the page loads it
 *   POST /mcp          the same places as five MCP tools
 *
 * `data/lists.json` is still committed to the repository and is still the
 * record -- the refresh reads yesterday's file to work out what is new, the
 * derived city and category for every place land in a diff where a wrong guess
 * can be seen and corrected, and the page can still be opened from disk. What
 * changed is where it is *served* from: the refresh publishes the committed
 * file to R2, and this Worker is the origin for both readers of it.
 *
 * This is a separate deploy from `collector/`, which is the other Worker here.
 * That one argues for keeping three jobs together because they share a
 * database, an origin and every bound in `src/limits.js`. This shares none of
 * them: it holds no database, it writes nothing, its callers are agents rather
 * than browsers, and the worst thing it can do when it fails is stop
 * answering. Folding it into the collector would put a public endpoint that
 * anything on the internet will crawl in the same failure domain as the form
 * that receives recommendations, and buy nothing.
 *
 * There is no authentication, which is a decision rather than an omission.
 * Every place here is already on a public page and in a public repository, the
 * server writes nothing and holds nothing belonging to a caller, so a token
 * would guard data anybody can already download while adding a secret to paste
 * into every client config. What bounds it instead is the same thing that
 * bounds the collector: a rate limit, a free plan, and nothing to steal.
 */

import { TOOLS, INSTRUCTIONS, call } from './tools.js';
import {
  LATEST,
  LEGACY,
  SUPPORTED,
  METHOD_NOT_FOUND,
  INVALID_PARAMS,
  INVALID_REQUEST,
  PARSE_ERROR,
  INTERNAL_ERROR,
  era,
  error,
  result,
  cacheable,
  complete,
} from './rpc.js';

const NAME = 'alists';
const VERSION = '1.0.0';

/* A day. The data moves once a day and the tool list moves when this file is
   deployed, so both are told to a client as "ask again tomorrow" -- which is
   the same number twice by coincidence rather than by sharing a meaning. */
const DAY = 24 * 60 * 60 * 1000;

/* Open to every origin, deliberately.
 *
 * The transport spec requires a server to validate `Origin` to stop DNS
 * rebinding, and the attack it defends against is a browser being tricked into
 * spending a *local* MCP server's ambient authority -- the filesystem, the
 * network the machine is on, a logged-in session. None of that exists here.
 * This server is remote, unauthenticated, read-only, and serves a public file;
 * a page that tricked a browser into calling it would learn exactly what it
 * could have learned by fetching the same URL itself. An allowlist would
 * prevent nothing and would break browser-based clients, so the honest
 * configuration is the permissive one, said out loud rather than defaulted
 * into. */
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': '*',
  'access-control-expose-headers': '*',
  'access-control-max-age': '86400',
};

const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...CORS, ...extra },
  });

const help = (origin) => `alists -- saved places, as an MCP server.

  POST ${origin}/mcp          the MCP endpoint (Streamable HTTP, stateless)
  GET  ${origin}/lists.json   the whole collection as one JSON object

Tools             ${TOOLS.map((t) => t.name).join(', ')}
Protocol          ${SUPPORTED.join(', ')}
Authentication    none: everything here is already public

https://github.com/filangelos/alists
`;

/* One loud caller is what this bounds, and only approximately -- the limiter
   is per-location. There is nothing to corrupt behind it and, on the free
   plan, no bill to run up, so the ceiling is generous: it is here to stop a
   runaway agent crowding out everybody else, not to ration access. */
async function limited(env, request) {
  if (!env.RATE_LIMITER) return false;
  const key = request.headers.get('cf-connecting-ip') || 'unknown';
  try {
    const { success } = await env.RATE_LIMITER.limit({ key });
    return !success;
  } catch (err) {
    console.error(JSON.stringify({ at: 'ratelimit', error: String(err) }));
    return false;
  }
}

/* The blob, served straight out of R2 with the caller's conditional request
   passed through. `onlyIf` hands back an object with no body when the etag
   still matches, which is a 304 -- so the page's reload of 750 KB is usually a
   few hundred bytes. */
async function blob(request, env) {
  const key = env.LISTS_KEY || 'lists.json';
  const object = await env.LISTS.get(key, { onlyIf: request.headers });
  if (!object) {
    return json({ error: `no ${key} in the bucket -- publish it with the refresh workflow` }, 503);
  }

  const headers = new Headers(CORS);
  object.writeHttpMetadata(headers);
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('etag', object.httpEtag);
  /* Five minutes, then revalidate. The data changes once a day but at a time
     nobody reading is thinking about, and an hour of staleness would put
     yesterday's counts under today's date in the footer. */
  headers.set('cache-control', 'public, max-age=300, must-revalidate');

  const body = 'body' in object ? object.body : null;
  if (!body) return new Response(null, { status: 304, headers });
  return new Response(request.method === 'HEAD' ? null : body, { headers });
}

async function dispatch(env, message, mode) {
  const { id, method } = message;
  const params = message.params || {};

  if (method === 'server/discover') {
    return result(
      id,
      cacheable(
        mode,
        {
          supportedVersions: SUPPORTED,
          capabilities: { tools: {} },
          instructions: INSTRUCTIONS,
          _meta: { 'io.modelcontextprotocol/serverInfo': { name: NAME, version: VERSION } },
        },
        DAY
      )
    );
  }

  /* The handshake the current revision deleted. Answered on the legacy branch
     only: a client that announced 2026-07-28 and then asked to initialize is
     confused about which protocol it is speaking, and being told so is more
     use to it than being played along with. */
  if (method === 'initialize') {
    if (mode === 'modern') {
      return error(
        id,
        METHOD_NOT_FOUND,
        `initialize was removed in ${LATEST}; call server/discover instead`
      );
    }
    const asked = params.protocolVersion;
    return result(id, {
      protocolVersion: LEGACY.includes(asked) ? asked : LEGACY[0],
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: NAME, version: VERSION },
      instructions: INSTRUCTIONS,
    });
  }

  if (method === 'tools/list') {
    return result(id, cacheable(mode, { tools: TOOLS }, DAY));
  }

  if (method === 'tools/call') {
    const answer = await call(env, params.name, params.arguments);
    /* A tool that could not find the city you named reports it inside its own
       result with `isError`, so the model reads it and corrects itself. A tool
       that does not exist is not that: it is the caller and this server
       disagreeing about what is on offer, and it belongs in a protocol error
       where retrying with different arguments cannot help. */
    if (answer === null) {
      return error(id, INVALID_PARAMS, `No such tool: ${params.name}`, {
        available: TOOLS.map((t) => t.name),
      });
    }
    return result(id, complete(mode, answer));
  }

  return error(id, METHOD_NOT_FOUND, `Method not found: ${method}`);
}

async function mcp(request, env) {
  let message;
  try {
    message = await request.json();
  } catch {
    return json(error(null, PARSE_ERROR, 'Parse error'), 400);
  }

  if (Array.isArray(message)) {
    // Batching left the protocol in 2025-06-18, and every revision this
    // server speaks is later than that.
    return json(error(null, INVALID_REQUEST, 'Batched requests are not supported'), 400);
  }
  if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0' || !message.method) {
    return json(error(null, INVALID_REQUEST, 'Invalid Request'), 400);
  }

  /* A notification -- no id, no answer expected. This server defines none and
     needs none. The only one that arrives is `notifications/initialized` from
     a client on an older revision, and the right response to it is to accept
     it and say nothing. */
  if (message.id === undefined) return new Response(null, { status: 202, headers: CORS });

  const speaking = era(request, message);
  if (speaking.body) return json(speaking.body, speaking.status);

  /* 404 for a method this server does not implement, not 400: the spec asks
     for it specifically so that a client can tell "this endpoint speaks MCP
     and not that method" from "there is no MCP endpoint here". */
  const answer = await dispatch(env, message, speaking.era);
  const status = answer.error && answer.error.code === METHOD_NOT_FOUND ? 404 : 200;
  return json(answer, status);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    // The bare origin answers too. Clients are configured by pasting a URL,
    // and half of them will be pasted without the path.
    const endpoint = path === '/mcp' || path === '/';

    try {
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

      if (await limited(env, request)) {
        return json({ error: 'too many requests' }, 429, { 'retry-after': '60' });
      }

      if (request.method === 'POST' && endpoint) return await mcp(request, env);

      if (request.method === 'GET' || request.method === 'HEAD') {
        if (path === '/lists.json') return await blob(request, env);
        if (path === '/') {
          const body = help(url.origin);
          return new Response(request.method === 'HEAD' ? null : body, {
            headers: { 'content-type': 'text/plain; charset=utf-8', ...CORS },
          });
        }
      }

      /* The revision removed the GET stream and the DELETE that ended a
         session, and says to answer a client that has not noticed with a 405
         rather than with an open connection. */
      if (endpoint) {
        return new Response(null, { status: 405, headers: { allow: 'POST, OPTIONS', ...CORS } });
      }

      return json({ error: 'not found', see: url.origin }, 404);
    } catch (err) {
      console.error(JSON.stringify({ at: 'fetch', path, error: String(err) }));
      /* Never the reason: a 500 that explains itself is a 500 you can read,
         and the only thing behind this one is a bucket that did not answer. */
      return json(error(null, INTERNAL_ERROR, 'Internal error'), 500);
    }
  },
};

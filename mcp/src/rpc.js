/* The envelope: JSON-RPC over one HTTP POST, per MCP 2026-07-28.
 *
 * This is written out rather than pulled from an SDK, and the reason is the
 * same one that keeps `scripts/fetch.py` on the standard library. What the
 * 2026-07-28 revision asks of a server like this one is a POST, a switch on
 * three method names and a handful of header checks -- there are no sessions
 * to keep, no handshake to complete and no stream to hold open, because the
 * revision deleted all three. A beta dependency to do that would be a thing
 * that can rot between one refresh and the next, in a Worker whose entire job
 * is to still be answering in a year.
 *
 * What the revision changed, and why it suits a Worker:
 *
 *   - No `initialize`. Every request carries its own protocol version and
 *     client capabilities in `params._meta`, so any isolate can answer any
 *     request and nothing has to be remembered between them.
 *   - No `Mcp-Session-Id`, no resumable streams, no GET endpoint.
 *   - `Mcp-Method` and `Mcp-Name` mirror the body into headers so a proxy can
 *     route without parsing JSON -- and the server MUST reject a request whose
 *     headers and body disagree, because otherwise the router and the server
 *     are acting on two different requests.
 *
 * The older, `initialize`-based revisions are answered too. Not out of
 * completeness: today most clients still speak them, and a server that is
 * correct against a spec nobody has shipped yet is a server nobody can call.
 * `era` below is the whole of the difference, it is decided per request from
 * the version header, and the legacy branch can be deleted in one commit when
 * the clients have moved.
 */

export const LATEST = '2026-07-28';

/* The `initialize` era. 2025-03-26 spoke this shape too, but it did not send
   the version header, and a request that names no version at all is answered
   as the oldest one here rather than guessed at. */
export const LEGACY = ['2025-11-25', '2025-06-18'];

export const SUPPORTED = [LATEST, ...LEGACY];

export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;
export const HEADER_MISMATCH = -32020;
export const UNSUPPORTED_PROTOCOL_VERSION = -32022;

/* Methods that name the thing they act on, and therefore carry `Mcp-Name`.
   Only the first is implemented here; the other two are listed because the
   check is about the header contract rather than about what this server
   happens to offer, and a server that grows resources later should not have
   to remember to come back and add them. */
const NAMED = {
  'tools/call': (params) => params && params.name,
  'resources/read': (params) => params && params.uri,
  'prompts/get': (params) => params && params.name,
};

/* A header value may arrive Base64-encoded when it cannot be written in plain
   ASCII -- a Greek tool name, a URI with a space. The sentinel is exact and
   lowercase, and a value that merely looks like one is encoded too, so
   decoding is unambiguous. Returns null for a sentinel that will not decode,
   which is a malformed header rather than a mismatched one; both are -32020,
   so the caller does not have to tell them apart. */
export function decodeHeader(raw) {
  if (raw == null) return null;
  const match = /^=\?base64\?([A-Za-z0-9+/=]*)\?=$/.exec(raw);
  if (!match) return raw;
  try {
    return new TextDecoder().decode(Uint8Array.from(atob(match[1]), (c) => c.charCodeAt(0)));
  } catch {
    return null;
  }
}

export const error = (id, code, message, data) => ({
  jsonrpc: '2.0',
  id: id === undefined ? null : id,
  error: data === undefined ? { code, message } : { code, message, data },
});

export const result = (id, value) => ({ jsonrpc: '2.0', id, result: value });

/* Which revision this request is speaking, and whether it is well formed
   under it. Returns `{ era }` or `{ status, body }` ready to send.
 *
 * The order matters: the version decides which rules apply, so it is settled
 * before any of them are applied. */
export function era(request, message) {
  const id = message && message.id !== undefined ? message.id : null;
  const header = request.headers.get('mcp-protocol-version');

  /* No version header at all. The revisions before 2025-06-18 did not define
     one, so this is an older client rather than a broken one, and it is
     answered on the legacy branch -- which begins with `initialize`, where it
     will name its version and be told what this server speaks. */
  if (!header) return { era: 'legacy' };

  if (!SUPPORTED.includes(header)) {
    return {
      status: 400,
      body: error(id, UNSUPPORTED_PROTOCOL_VERSION, 'Unsupported protocol version', {
        supported: SUPPORTED,
        requested: header,
      }),
    };
  }

  if (header !== LATEST) return { era: 'legacy' };

  const method = message.method;
  const params = message.params || {};

  const seen = request.headers.get('mcp-method');
  if (seen !== method) {
    return {
      status: 400,
      body: error(
        id,
        HEADER_MISMATCH,
        seen === null
          ? 'Header mismatch: Mcp-Method is required'
          : `Header mismatch: Mcp-Method header value '${seen}' does not match body value '${method}'`
      ),
    };
  }

  if (Object.prototype.hasOwnProperty.call(NAMED, method)) {
    const want = NAMED[method](params);
    const got = decodeHeader(request.headers.get('mcp-name'));
    if (got !== want) {
      return {
        status: 400,
        body: error(
          id,
          HEADER_MISMATCH,
          got === null
            ? 'Header mismatch: Mcp-Name is required, and must be a decodable value'
            : `Header mismatch: Mcp-Name header value '${got}' does not match body value '${want}'`
        ),
      };
    }
  }

  /* The version is required in `_meta` as well as in the header, and the two
     must agree. A request that omits it is let through anyway: a missing
     field is not a disagreement, and the header is the copy an intermediary
     would have routed on, so it is the one worth insisting about. A field
     that is present and says something else is a real conflict and is
     refused. */
  const meta = params._meta || {};
  const stated = meta['io.modelcontextprotocol/protocolVersion'];
  if (stated !== undefined && stated !== header) {
    return {
      status: 400,
      body: error(
        id,
        HEADER_MISMATCH,
        `Header mismatch: MCP-Protocol-Version header value '${header}' does not match ` +
          `body value '${stated}'`
      ),
    };
  }

  return { era: 'modern' };
}

/* Caching hints, which only the current revision defines. Every result this
   server returns is the same for everyone who asks -- there is no
   authorization context here to vary by -- so the scope is always public.
 *
 * The TTL is the refresh interval rather than something smaller. `lists.json`
 * is rewritten once a day at 05:17 UTC and the tool list changes only when
 * this file is redeployed, so a client that re-asks more often than that is
 * paying for an answer it already has. */
export const cacheable = (era, value, ttlMs) =>
  era === 'modern' ? { ...value, resultType: 'complete', ttlMs, cacheScope: 'public' } : value;

export const complete = (era, value) =>
  era === 'modern' ? { ...value, resultType: 'complete' } : value;

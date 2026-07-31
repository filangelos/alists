/* The collector behind alists.
 *
 * The page that talks to this is static, public and open-source, so the URL is
 * known to everyone and there is no secret that could ever be put in front of
 * it -- a token in client JS is not a token. That is the whole design
 * constraint, and it is not one you can engineer away: anyone can POST here.
 *
 * So nothing here tries to prove a request is genuine. What it does instead is
 * make a forged one worthless:
 *
 *   - every field comes from a closed set, so a forger can only say things the
 *     site itself could have said -- no arbitrary strings ever reach the
 *     tables, which is what makes the data safe to render later and keeps the
 *     cardinality bounded;
 *   - a daily cap turns "fill the database" into "ruin one day", which is
 *     recoverable and, on the free tier, free;
 *   - rows are append-only with a server timestamp, so an attack is a
 *     contiguous range you delete in one statement.
 *
 * Absorb, bound, detect, reverse. Not prevent.
 *
 * Three jobs, one deploy, because they share a database, an origin and every
 * bound above -- splitting them into three Workers would triple the deploy and
 * change nothing else:
 *
 *   POST /            counting        events.js   silent, closed sets only
 *   POST /recommend   somebody else's suggest.js  the one free-text column
 *   /review           yours           review.js   what is still waiting, openly
 *
 * `/recommend` is the one that breaks the rule in the first paragraph -- a
 * recommendation is a sentence a stranger wrote -- and suggest.js opens with
 * what is done about that.
 */

import { count } from './events.js';
import { recommend } from './suggest.js';
import { review } from './review.js';

const BOT =
  /bot|crawl|spider|slurp|curl|wget|headless|monitor|uptime|preview|scrape|python-requests|axios|okhttp|gptbot|claudebot|facebookexternalhit/i;
const MOBILE = /mobile|android|iphone|ipad|ipod/i;

function classify(ua) {
  if (!ua) return 'other';
  if (BOT.test(ua)) return 'bot';
  if (MOBILE.test(ua)) return 'mobile';
  return 'desktop';
}

const hostOf = (url) => {
  try {
    return new URL(url).host.slice(0, 64);
  } catch {
    return null;
  }
};

export default {
  async fetch(request, env, ctx) {
    const allowed = [env.SITE_ORIGIN, env.DEV_ORIGIN].filter(Boolean);
    const origin = request.headers.get('origin');
    const echo = allowed.includes(origin) ? origin : allowed[0];
    const headers = { 'access-control-allow-origin': echo, 'cache-control': 'no-store' };

    const path = new URL(request.url).pathname.replace(/\/+$/, '') || '/';

    /* Everything below is taken from the request, never from a body. A client
       that can set its own country and user agent class can also set them to
       whatever makes the chart it wants. */
    const site = {
      headers,
      ip: request.headers.get('cf-connecting-ip') || '',
      /* Forgeable with two seconds of curl, and kept anyway: it costs nothing
         and it removes every drive-by that goes through a browser. It is a
         doormat, not a lock, and nothing below it assumes otherwise. */
      fromSite: allowed.includes(origin),
      facts: {
        at: Date.now(),
        ref: hostOf(request.headers.get('referer')),
        country: (request.cf && request.cf.country) || null,
        agent: classify(request.headers.get('user-agent')),
      },
    };

    try {
      // Before the method and origin gates, because this one is a page rather
      // than an endpoint: it is opened by hand from a browser's address bar,
      // same-origin, and it carries its own authentication.
      if (path === '/review') return await review(request, env, ctx, site);

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

      if (path === '/recommend') return await recommend(request, env, ctx, site);

      // Anything else is an event. `count.js` beacons at the bare origin, and
      // has since before there were paths here at all.
      return await count(request, env, ctx, site);
    } catch (err) {
      console.error(JSON.stringify({ at: 'fetch', path, error: String(err) }));
      /* The counting endpoint answers 204 even here, because "the same empty
         response whatever happened" is a property of it rather than a
         convenience -- a 500 only the malformed requests get is a probe. The
         other two have somebody waiting on an answer, so they get a real one.
         Never the reason, though: a 500 that explains itself is a 500 you can
         read. */
      const silent = path !== '/recommend' && path !== '/review';
      return new Response(null, { status: silent ? 204 : 500, headers });
    }
  },
};

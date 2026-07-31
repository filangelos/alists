/* The queue, and the two decisions.
 *
 * The point of this page is one link per recommendation. Adding a place to a
 * list happens in Google Maps, by hand, the way it always has -- so what this
 * owes you is the pin, not a workflow. Press the name, land on the place, hit
 * save, pick a list. The next daily `refresh` finds it and the tree grows a
 * row. `keep` here changes nothing about the site; it is bookkeeping, and the
 * page says so by checking `lists.json` and telling you when a suggestion has
 * already turned up in the collection on its own.
 *
 * No JavaScript, deliberately, and it is not austerity: this is the one page
 * anywhere in this repo that renders a string a stranger typed. With no script
 * source at all in the CSP, a mistake in the escaping below is a mistake that
 * cannot execute. Forms and links are enough for two buttons, they work on a
 * phone, and the passphrase rides in a hidden field rather than in a URL that
 * would end up in history, in a referrer and in a screenshot.
 *
 * The passphrase is the whole of the authentication and it is compared as a
 * hash, so neither its length nor its prefix leaks through the time the
 * comparison takes. There is no session and no cookie: there is nothing to
 * steal that is not the passphrase itself, and nothing to expire.
 */

import { vocabulary } from './lists.js';
import { throttled } from './limits.js';

const PAGE = 200;

// ------------------------------------------------------------------- html

const esc = (value) =>
  String(value === null || value === undefined ? '' : value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]),
  );

// Marks a string as already-safe markup. Everything interpolated into `html`
// that is not wrapped in this is escaped, so the default is the safe one and
// the exceptions are visible at the call site.
const raw = (value) => ({ html: String(value) });

const piece = (value) => {
  if (Array.isArray(value)) return value.map(piece).join('');
  if (value && typeof value === 'object' && 'html' in value) return value.html;
  return esc(value);
};

/* Returns marked-up markup rather than a string, which is the whole of what
   makes nesting safe: a fragment built by `html` interpolates into another
   `html` untouched, while a bare string -- which is what everything out of the
   database is -- is escaped wherever it lands. Getting this backwards is the
   ordinary way these templates fail, and it fails silently in the safe
   direction until the day something needs to nest. */
const html = (strings, ...values) =>
  raw(strings.reduce((out, str, i) => out + piece(values[i - 1]) + str));

const STYLE = `
:root { color-scheme: light dark;
  --bg:#fff; --surface:#fff; --hairline:rgba(0,0,0,.1); --ink:#4b4a45;
  --ink-strong:#2f2e2a; --muted:#96907e; --faint:#c9c2ac; --accent:#3d7fd6;
  --accent-soft:rgba(61,127,214,.09); --good:#237a4f; --good-soft:rgba(35,122,79,.1);
  --code:#f4f3ef; }
@media (prefers-color-scheme: dark) { :root {
  --bg:#14151a; --surface:#1b1d23; --hairline:rgba(255,255,255,.12); --ink:#d6d3cb;
  --ink-strong:#f2efe8; --muted:#8b8677; --faint:#5d5a52; --accent:#6ea8f0;
  --accent-soft:rgba(110,168,240,.14); --good:#5ec98d; --good-soft:rgba(94,201,141,.15);
  --code:#262931; } }
* { box-sizing:border-box }
body { margin:0; background:var(--bg); color:var(--ink); font-size:14px; line-height:1.5;
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace; -webkit-text-size-adjust:100% }
main { max-width:720px; margin:0 auto; padding:24px 20px 64px }
h1 { font-size:14px; font-weight:700; color:var(--ink-strong); margin:0 }
.sub { color:var(--muted); font-size:12px; margin:2px 0 20px }
ul { list-style:none; margin:0; padding:0 }
.card { border:1px solid var(--hairline); border-radius:8px; background:var(--surface);
  padding:12px 14px; margin-bottom:10px }
.card h2 { margin:0; font-size:14px; font-weight:700; line-height:1.35 }
a { color:var(--accent); text-decoration:none; overflow-wrap:anywhere }
a:hover { text-decoration:underline }
.note { margin:8px 0 0; padding-left:8px; border-left:2px solid var(--accent-soft);
  color:var(--ink); overflow-wrap:anywhere }
.meta { margin:8px 0 0; color:var(--muted); font-size:12px; overflow-wrap:anywhere }
.tag { display:inline-block; font-size:11px; line-height:16px; padding:1px 8px;
  border:1px solid var(--hairline); border-radius:10px; color:var(--muted); margin-left:6px;
  vertical-align:1px }
.tag.is-saved { color:var(--good); border-color:var(--good); background:var(--good-soft) }
.acts { margin-top:10px; display:flex; gap:8px; flex-wrap:wrap }
button { font-family:inherit; font-size:12px; line-height:16px; padding:6px 12px;
  background:none; border:1px solid var(--hairline); border-radius:12px; color:var(--muted);
  cursor:pointer }
button:hover { border-color:var(--accent); color:var(--accent) }
button.keep:hover { border-color:var(--good); color:var(--good) }
.empty { color:var(--muted); padding:32px 0 }
.gate { max-width:340px; margin:18vh auto; padding:0 20px }
input[type=password] { width:100%; font-family:inherit; font-size:16px; padding:8px 10px;
  background:var(--code); color:var(--ink); border:1px solid var(--hairline); border-radius:8px }
.gate button { margin-top:10px; font-size:13px; padding:8px 16px }
.wrong { color:var(--ink-strong); font-size:12px; margin-top:8px }
.foot { margin-top:24px; color:var(--faint); font-size:12px }
`;

function page(title, body) {
  return html`<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow">
<title>${title}</title>
<style>${raw(STYLE)}</style>
</head><body>${body}</body></html>`;
}

const respond = (body, status = 200) =>
  new Response(body.html, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex, nofollow',
      'referrer-policy': 'no-referrer',
      // No script source at all, so nothing rendered below can run even if the
      // escaping above were wrong. `form-action 'self'` keeps the passphrase
      // from being posted anywhere else by injected markup.
      'content-security-policy':
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; " +
        "base-uri 'none'; frame-ancestors 'none'",
    },
  });

// The 404 a missing REVIEW_KEY gets, which is the same 404 a wrong path gets:
// an instance with no passphrase set has no review page, rather than one that
// says so.
const missing = () => new Response('Not found', { status: 404 });

// -------------------------------------------------------------------- auth

async function digest(text) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return new Uint8Array(bytes);
}

/* Both sides hashed first, so the comparison is over two fixed 32-byte strings
   and gives away neither the length of the secret nor how far a guess got. */
async function correct(given, secret) {
  if (typeof given !== 'string' || !given) return false;
  const [a, b] = await Promise.all([digest(given), digest(secret)]);
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

const gate = (wrong) =>
  page(
    'alists · review',
    html`<main class="gate">
    <h1>alists</h1>
    <p class="sub">recommendations</p>
    <form method="post">
      <input type="password" name="key" autocomplete="current-password"
             aria-label="Passphrase" autofocus>
      <button type="submit">open</button>
      ${wrong ? raw('<p class="wrong">no.</p>') : ''}
    </form>
  </main>`,
  );

// ------------------------------------------------------------------ render

const when = (at) => new Date(at).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';

/* `/athens/coffee` back into the words the person was looking at when they
   pressed the button. Falls back to the path itself, which is still true. */
function where(path, known) {
  if (!path) return null;
  const segs = path.slice(1).split('/');
  const named = segs.map((seg) => (known && known.labels.get(seg)) || seg);
  return named.join(' › ');
}

/* One card per place, not per row. The same restaurant recommended by three
   people is one decision and three reasons to make it -- and the count is the
   most useful thing on the page, so it should not be spread over three cards
   you have to notice are the same. Rows with no CID group by their URL, which
   for a place id is the same thing. */
function group(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = row.cid || row.url;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  /* Cards keep the newest-first order the query came in, so a place somebody
     mentioned this morning is at the top. Inside a card the order flips: the
     reasons read oldest first, because the second person to recommend
     somewhere is answering the first one and "second this" above the thing it
     seconds is a conversation printed backwards. */
  return [...groups.values()].map((rows) => rows.slice().reverse());
}

function card(rows, known, key, show) {
  const first = rows[0];
  const saved = first.cid && known ? known.cids.get(first.cid) : null;
  // Whichever sighting carried a name; a link pasted bare has none, and the
  // same place shared from the Maps app does.
  const named = rows.find((row) => row.name);
  const name = saved || (named && named.name) || 'an unnamed place';
  const ids = rows.map((row) => row.id).join(',');

  const notes = rows
    .filter((row) => row.note)
    .map((row) => html`<p class="note">${row.note}</p>`);

  const from = rows
    .map((row) => {
      const bits = [
        row.who ? html`<strong>${row.who}</strong>` : raw('someone'),
        when(row.at),
        where(row.path, known),
        row.country,
      ].filter(Boolean);
      return html`<p class="meta">${raw(bits.map(piece).join(' · '))}</p>`;
    });

  return html`<li class="card">
    <h2><a href="${first.url}" target="_blank" rel="noreferrer noopener">${name}</a>${
      rows.length > 1 ? raw(`<span class="tag">×${rows.length}</span>`) : ''
    }${saved ? raw('<span class="tag is-saved">already saved</span>') : ''}</h2>
    ${notes}
    ${from}
    <div class="acts">
      <form method="post">
        <input type="hidden" name="key" value="${key}">
        <input type="hidden" name="ids" value="${ids}">
        <input type="hidden" name="show" value="${show}">
        ${
          show === 'decided'
            ? raw(
                '<button type="submit" name="decide" value="new">put it back</button>',
              )
            : raw(
                '<button class="keep" type="submit" name="decide" value="kept">' +
                  (saved ? 'done' : 'keep') +
                  '</button>' +
                  '<button type="submit" name="decide" value="passed">pass</button>',
              )
        }
      </form>
    </div>
  </li>`;
}

function queue(rows, known, key, show) {
  const groups = group(rows);
  const other = show === 'decided' ? 'new' : 'decided';

  const body = groups.length
    ? html`<ul>${groups.map((g) => card(g, known, key, show))}</ul>`
    : html`<p class="empty">${
        show === 'decided' ? 'nothing decided yet.' : 'nothing waiting.'
      }</p>`;

  return page(
    'alists · review',
    html`<main>
    <h1>alists</h1>
    <p class="sub">${show === 'decided' ? 'decided' : 'waiting'} · ${
      groups.length
    } ${groups.length === 1 ? 'place' : 'places'}</p>
    ${body}
    <form method="post" class="foot">
      <input type="hidden" name="key" value="${key}">
      <input type="hidden" name="show" value="${other}">
      <button type="submit">${other === 'decided' ? 'see what I decided' : 'back to waiting'}</button>
    </form>
  </main>`,
  );
}

// ----------------------------------------------------------------- handler

const STATES = new Set(['kept', 'passed', 'new']);

async function decide(env, ids, state, at) {
  const wanted = String(ids)
    .split(',')
    .map((id) => Number(id))
    .filter((id) => Number.isInteger(id) && id > 0)
    .slice(0, 50);
  if (!wanted.length || !STATES.has(state)) return;

  const holes = wanted.map(() => '?').join(',');
  await env.DB.prepare(
    `UPDATE suggestions SET state = ?, decided = ? WHERE id IN (${holes})`,
  )
    .bind(state, state === 'new' ? null : at, ...wanted)
    .run();
}

export async function review(request, env, ctx, site) {
  if (!env.REVIEW_KEY) return missing();

  if (request.method === 'GET') return respond(gate(false));
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'GET, POST' } });

  // A passphrase form is the one thing here worth guessing at, so it is
  // throttled on its own binding and far harder than the event endpoint.
  if (await throttled(env.REVIEW_LIMITER || env.RATE_LIMITER, site.ip)) {
    return respond(gate(true), 429);
  }

  const form = await request.formData();
  const key = String(form.get('key') || '');
  if (!(await correct(key, env.REVIEW_KEY))) {
    console.warn(JSON.stringify({ at: 'review', country: site.facts.country }));
    return respond(gate(true), 401);
  }

  const show = form.get('show') === 'decided' ? 'decided' : 'new';
  const decision = form.get('decide');
  if (decision) await decide(env, form.get('ids') || '', String(decision), site.facts.at);

  const { results } = await env.DB.prepare(
    show === 'decided'
      ? `SELECT * FROM suggestions WHERE state != 'new' ORDER BY decided DESC, id DESC LIMIT ?`
      : `SELECT * FROM suggestions WHERE state = 'new' ORDER BY id DESC LIMIT ?`,
  )
    .bind(PAGE)
    .all();

  // Only for the "already saved" badge and for naming a path, so a collector
  // that cannot reach lists.json still shows the queue.
  const known = await vocabulary(env);

  return respond(queue(results || [], known, key, show));
}

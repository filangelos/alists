/* The queue, and the one decision left in it.
 *
 * There used to be two buttons here. There is one, because *keeping* a
 * recommendation is not a thing anybody needs to record: adding the place to a
 * list in Google Maps is the whole of accepting it, and the next daily
 * `refresh` puts it in `data/lists.json`, which this page already reads. So a
 * recommendation stops being one the moment the collection contains it, and it
 * leaves the queue by itself. A `kept` button would have been a second place to
 * store a fact the site already holds, and the two would eventually disagree.
 *
 * What is left is `pass` -- somewhere I am not going to add -- because nothing
 * else can ever clear that, and a queue you cannot say no in is a queue you
 * stop opening.
 *
 * No passphrase. The page is readable by anyone who has the URL, which is a
 * decision rather than an oversight: there is nothing here that is not already
 * a public Google Maps link plus a sentence somebody chose to send. The cost is
 * that `pass` is public too, so it is built to be survivable rather than
 * trusted -- nothing is ever deleted, a passed card keeps its own view and a
 * way back, and the write is rate limited.
 *
 * No JavaScript either, and that is not austerity: this is the one page
 * anywhere in this repo that renders a string a stranger typed, and with no
 * script source at all in the CSP, a mistake in the escaping below is a mistake
 * that cannot execute.
 */

import { vocabulary } from './lists.js';
import { throttled } from './limits.js';

/* Newest first, so what falls off the end is the oldest -- and the oldest are
   overwhelmingly ones already added, which is the half of the queue nobody is
   looking for. If this ever bites, `pass` is the pressure valve. */
const PAGE = 500;

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
.sub { color:var(--muted); font-size:12px; margin:2px 0 4px }
.lede { color:var(--muted); font-size:12px; margin:0 0 20px; max-width:60ch }
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
.acts { margin-top:10px }
button { font-family:inherit; font-size:12px; line-height:16px; padding:6px 12px;
  background:none; border:1px solid var(--hairline); border-radius:12px; color:var(--muted);
  cursor:pointer }
button:hover { border-color:var(--accent); color:var(--accent) }
.empty { color:var(--muted); padding:32px 0 }
details { margin-top:22px; color:var(--muted); font-size:12px }
summary { cursor:pointer; color:var(--good) }
details ul { margin-top:8px }
details li { padding:2px 0 }
.foot { margin-top:24px; color:var(--faint); font-size:12px }
.foot a { color:var(--faint) }
.foot a:hover { color:var(--accent) }
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

const HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  // Readable by anyone with the URL, but not something a search engine should
  // be putting in front of people who were looking for something else.
  'x-robots-tag': 'noindex, nofollow',
  'referrer-policy': 'no-referrer',
  // No script source at all, so nothing rendered below can run even if the
  // escaping above were wrong. `form-action 'self'` keeps the buttons from
  // being pointed anywhere else by injected markup.
  'content-security-policy':
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; " +
    "base-uri 'none'; frame-ancestors 'none'",
};

const respond = (body, status = 200) =>
  new Response(body.html, { status, headers: HEADERS });

// ------------------------------------------------------------------ render

const when = (at) => new Date(at).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';

/* `/athens/coffee` back into the words the person was looking at when they
   pressed the button. Falls back to the path itself, which is still true. */
function where(path, known) {
  if (!path) return null;
  const segs = path.slice(1).split('/');
  return segs.map((seg) => (known && known.labels.get(seg)) || seg).join(' › ');
}

/* Whether the collection already contains this, which is the only definition
   of "kept" there is. Returns the saved name, or null for still-waiting.

   A suggestion that arrived as a bare place id has neither a CID nor an MID and
   so can never match: `lists.json` is keyed on what Google's list payload
   gives, and a place id is not in it. Those are what `pass` is for. */
function saved(row, known) {
  if (!known) return null;
  if (row.cid && known.cids.has(row.cid)) return known.cids.get(row.cid) || row.name || '';
  if (row.mid && known.mids.has(row.mid)) return row.name || '';
  return null;
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

function card(rows, known, show) {
  const first = rows[0];
  // Whichever sighting carried a name; a link pasted bare has none, and the
  // same place shared from the Maps app does.
  const named = rows.find((row) => row.name);
  const name = (named && named.name) || 'an unnamed place';
  const ids = rows.map((row) => row.id).join(',');

  const notes = rows.filter((row) => row.note).map((row) => html`<p class="note">${row.note}</p>`);

  const from = rows.map((row) => {
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
    }</h2>
    ${notes}
    ${from}
    <div class="acts">
      <form method="post" action="${show === 'passed' ? '/review?show=passed' : '/review'}">
        <input type="hidden" name="ids" value="${ids}">
        <button type="submit" name="decide" value="${show === 'passed' ? 'new' : 'passed'}">${
          show === 'passed' ? 'put it back' : 'pass'
        }</button>
      </form>
    </div>
  </li>`;
}

const LEDE =
  'Nothing here needs accepting. Open the place, save it to a list in Maps, ' +
  'and it leaves this page by itself once the daily refresh has been round. ' +
  'Pass is for the ones that are never going on a list.';

function queue({ waiting, taken, known, show }) {
  const groups = group(waiting);

  const body = groups.length
    ? html`<ul>${groups.map((g) => card(g, known, show))}</ul>`
    : html`<p class="empty">${show === 'passed' ? 'nothing passed.' : 'nothing waiting.'}</p>`;

  /* The proof that the loop closed, and the reason there is no `keep` button:
     these left the queue because the collection grew, not because anybody
     pressed anything. Folded away because it is reassurance rather than work. */
  const added =
    taken.length && show !== 'passed'
      ? html`<details>
      <summary>${taken.length} added to a list since</summary>
      <ul>${taken.map((row) => html`<li>${row.name || 'an unnamed place'}</li>`)}</ul>
    </details>`
      : '';

  return page(
    'alists · recommendations',
    html`<main>
    <h1>alists</h1>
    <p class="sub">${show === 'passed' ? 'passed' : 'waiting'} · ${groups.length} ${
      groups.length === 1 ? 'place' : 'places'
    }</p>
    <p class="lede">${LEDE}</p>
    ${body}
    ${added}
    <p class="foot">${
      show === 'passed'
        ? raw('<a href="/review">back to what is waiting</a>')
        : raw('<a href="/review?show=passed">see what I passed on</a>')
    }</p>
  </main>`,
  );
}

// ----------------------------------------------------------------- handler

// `kept` is deliberately not one of these. See the note at the top of the file.
const STATES = new Set(['passed', 'new']);

async function decide(env, ids, state, at) {
  const wanted = String(ids)
    .split(',')
    .map((id) => Number(id))
    .filter((id) => Number.isInteger(id) && id > 0)
    .slice(0, 50);
  if (!wanted.length || !STATES.has(state)) return;

  const holes = wanted.map(() => '?').join(',');
  await env.DB.prepare(`UPDATE suggestions SET state = ?, decided = ? WHERE id IN (${holes})`)
    .bind(state, state === 'new' ? null : at, ...wanted)
    .run();
}

export async function review(request, env, ctx, site) {
  const url = new URL(request.url);
  const show = url.searchParams.get('show') === 'passed' ? 'passed' : 'waiting';

  if (request.method === 'POST') {
    // The one write on a page anyone can open, so it is the one thing throttled.
    if (!(await throttled(env.REVIEW_LIMITER || env.RATE_LIMITER, site.ip))) {
      const form = await request.formData();
      await decide(env, form.get('ids') || '', String(form.get('decide') || ''), site.facts.at);
    }
    /* 303 rather than rendering the result, so the browser lands on a GET: a
       refresh re-reads the queue instead of re-deciding it, and the back button
       does not offer to resubmit. */
    return new Response(null, {
      status: 303,
      headers: { location: show === 'passed' ? '/review?show=passed' : '/review', 'cache-control': 'no-store' },
    });
  }

  if (request.method !== 'GET') {
    return new Response(null, { status: 405, headers: { allow: 'GET, POST' } });
  }

  const known = await vocabulary(env);

  const { results } = await env.DB.prepare(
    show === 'passed'
      ? `SELECT * FROM suggestions WHERE state = 'passed' ORDER BY decided DESC, id DESC LIMIT ?`
      : `SELECT * FROM suggestions WHERE state = 'new' ORDER BY id DESC LIMIT ?`,
  )
    .bind(PAGE)
    .all();

  /* The split that replaces the keep button. Everything still marked `new` is
     partitioned by whether the collection now holds it -- a question
     `lists.json` answers and this table therefore never has to. The passed view
     has nothing to partition: it is a list of decisions, not of candidates. */
  const rows = results || [];
  const waiting = show === 'passed' ? rows : rows.filter((row) => saved(row, known) === null);
  const taken = show === 'passed' ? [] : rows.filter((row) => saved(row, known) !== null);

  return respond(queue({ waiting, taken, known, show }));
}

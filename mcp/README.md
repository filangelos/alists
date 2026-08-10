# mcp

The places, where an agent can reach them: one R2 bucket holding the same
`lists.json` the page loads, and a Worker that answers questions about it.

```
data/lists.json ──refresh──▶  R2  ──▶  GET  /lists.json   the page
   (committed)                    └──▶  POST /mcp          agents
```

This is not part of the site either. `alists` is still four static files and a
blob of JSON, and the blob is still committed — `app.js` reads it from here and
falls back to `./data/lists.json` when this is not answering, so a bucket that
was never created leaves a page that works off the copy in the tree.

## Why the file is still in git

Moving the data to Cloudflare and moving it *off* GitHub are two different
changes, and only the first one is worth making. Three things in this
repository read the committed file rather than a served one:

- `scripts/fetch.py` diffs against yesterday's `data/lists.json` to decide what
  is new. That file is the whole of what `added` means, and the `◷ new this
  week` list with it.
- The city and category for every place are *guesses*, made in the fetcher
  precisely so they land in a diff where a wrong one is visible and can be
  corrected by hand.
- A broken deploy can be reproduced by opening `index.html` from disk.

So git keeps the record and R2 serves it. The publish step in `refresh.yml`
runs after the commit, uploads the identical bytes, and does it whether or not
the places changed — a PUT a day is one class A operation, and gating it on
`changed` means a bucket that was emptied or re-created stays wrong until the
data happens to move.

## Deploying

```bash
cd mcp && npm install
```

```bash
npx wrangler login
```

Create the bucket. The name is in [`wrangler.jsonc`](wrangler.jsonc); change it
in both places if you want another:

```bash
npm run bucket
```

Put the current data in it, so there is something to serve before tomorrow's
refresh:

```bash
npm run publish-data
```

```bash
npm run deploy
```

That prints the Worker's URL. Put `<url>/lists.json` in the `alists-data` meta
tag in [`index.html`](../index.html), and give the URL itself to whatever is
going to call it.

For the daily publish, the `refresh` workflow needs two repository secrets —
**Settings → Secrets and variables → Actions**:

| | |
|---|---|
| `CLOUDFLARE_ACCOUNT_ID` | the id in the URL of your Cloudflare dashboard |
| `CLOUDFLARE_API_TOKEN` | a token with **Workers R2 Storage: Edit**, and nothing else |

The token wants that one permission and no more. It is used for exactly one
command, `r2 object put`, and a token that could also deploy Workers or read D1
would be a token that can take down the collector from a workflow that has no
business touching it.

Without the secrets the step is skipped rather than failed, so a clone of this
repository refreshes its own data and publishes nothing.

## Connecting an agent

The endpoint is `POST https://your-worker.workers.dev/mcp`, and the bare origin
answers too, because half of all client configs are a URL pasted without the
path. There is no token, no OAuth and nothing to log in to.

```bash
curl -s https://your-worker.workers.dev/mcp \
  -H 'content-type: application/json' \
  -H 'mcp-protocol-version: 2026-07-28' \
  -H 'mcp-method: tools/list' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

## The tools

| | |
|---|---|
| `search_places` | free text, plus city, category, visited state and a date |
| `places_near` | everything within a radius of a point, nearest first |
| `get_place` | one place, by name or by CID |
| `list_cities` | what the collection covers, with counts and centres |
| `list_categories` | what the categories are, with counts |

The one worth reading the description of is `places_near`, which takes its
origin either as a latitude and longitude or as the *name* of a city or of a
place already saved here. It does not geocode: an address is not a thing this
repository knows how to turn into a point, and pretending otherwise would mean
an API key, a network hop per call and a second opinion about where places are.
A caller holding an address can geocode it and pass coordinates.

Distances are great-circle, the same as the page's `near me`, so a radius
answer is a floor on how far you will actually walk.

**`been` defaults to `yes` in every tool that takes it**, and that is the one
piece of this whose default carries an argument. Everything in this collection
is somewhere the owner has been and would send you to, except the places
carrying the `next` mark, which are the opposite: heard about, saved, not
visited. The page holds them out from behind a button for that reason. A server
that quietly folded them in would answer "recommend me somewhere for dinner"
with a to-do list, and the answer would look exactly like a right one.

## Why there is no database

`lists.json` is 2218 places and about 750 KB. That fits in an isolate, so every
query here is a scan and there is no schema to keep in step with the file. D1
was the obvious alternative and would have bought indexing this does not need —
a radius query over 2218 rows is a couple of hundred microseconds of arithmetic
— at the price of a second copy of the data that can disagree with
`data/lists.json`. Past roughly a hundred thousand places that trade flips.
Nothing outside [`src/collection.js`](src/collection.js) would have to change
when it does.

The text matching is lifted out of `app.js` rather than rewritten, and that
matters more than it looks: an agent asking for `cafe` and a person typing
`cafe` into the search box should get the same places, and two independently
written accent folds would drift apart on the first Greek name.

## Why there is no authentication

Every place here is already on a public page and in a public repository. This
Worker writes nothing, holds nothing belonging to a caller, and has no write
binding to the bucket at all — there is no code path in the deploy that could
change the data, which is worth more than any check that it does not. A token
would guard data anybody can already download, at the cost of a secret to paste
into every client config.

What bounds it is what bounds the collector: a rate limit, the free plan, and
nothing to steal.

The transport spec's `Origin` requirement is answered the same way, and
deliberately in the permissive direction — see the note in
[`src/worker.js`](src/worker.js). The attack it exists to stop is a browser
being tricked into spending a *local* server's ambient authority. There is none
here to spend.

## The protocol

Written against **2026-07-28**, which is the revision that made MCP stateless:
no `initialize` handshake, no `Mcp-Session-Id`, no GET stream, no resumable
anything. Every request carries its own protocol version and client
capabilities in `params._meta`, which is why this fits a Worker so exactly —
there is nothing to remember between two requests, so any isolate can answer
any of them.

It is written out rather than pulled from an SDK, for the reason
`scripts/fetch.py` is standard-library only: what the revision asks of a server
like this one is a POST, a switch on three method names and a handful of header
checks, and a beta dependency to do that is a thing that can rot between one
refresh and the next.

The `initialize`-era revisions — `2025-11-25` and `2025-06-18` — are answered
from the same endpoint. Not for completeness: most clients still speak them
today, and a server that is correct against a spec nobody has shipped is a
server nobody can call. `era` in [`src/rpc.js`](src/rpc.js) is the whole of the
difference, it is decided per request from the version header, and the legacy
branch comes out in one commit when the clients have moved.

## Tests

```bash
npm test
```

No install, no network and no wrangler: the only thing stubbed is R2, and it is
stubbed with the actual `data/lists.json` out of the repository. So a change to
`derive.py` that renames a category or drops a field fails here rather than in
front of an agent.

It covers both directions. The queries — that a radius really bounds the
results, that they come back nearest-first, that `been` accounts for itself,
that the counts `list_cities` reports and the counts `search_places` reports
are the same number. And the envelope — that a mismatched `Mcp-Method` is a
`-32020`, that a Base64-encoded `Mcp-Name` is decoded before it is compared,
that an unknown revision comes back as a `-32022` naming the ones that work,
that an unimplemented method is a 404 and not a 400, that GET on the endpoint
is a 405.

## When something goes wrong

```bash
npx wrangler tail
```

A `503` from `/lists.json` means the bucket has no object under `LISTS_KEY` —
run the publish, or the `refresh` workflow. Everything else logs a single JSON
line naming where it happened: `collection` for a bucket read, `ratelimit`,
`fetch` for anything that reached the outermost catch.

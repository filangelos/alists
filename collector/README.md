# collector

A count of what gets looked at, kept somewhere I own.

This is not part of the site. `alists` is still four static files and a blob of
JSON served straight off Pages, and it stays that way whether or not anything
here is running -- `count.js` is loaded separately and every call into it from
`app.js` is guarded, so a Worker that is down, blocked or never deployed leaves
a page that works and does not count.

```
count.js ──sendBeacon──▶ src/worker.js ──▶ D1 (alists-count)
(the page)               (validate, cap)     (raw events, kept)
```

## Deploying

```bash
cd collector && npm install
```

```bash
npx wrangler login
```

Create the database, then paste the `database_id` it prints into
[`wrangler.jsonc`](wrangler.jsonc):

```bash
npx wrangler d1 create alists-count
```

Create the tables on the remote database -- `--remote` matters, the default is
a local file that the deployed Worker never sees:

```bash
npm run schema
```

```bash
npm run deploy
```

That prints the Worker's URL. Put it in [`count.js`](../count.js) in place of
`YOUR-SUBDOMAIN`, and nothing is counted until you do: the file checks for the
placeholder and returns.

If `wrangler` rejects the `ratelimits` block, delete it. The Worker checks for
the binding and carries on without it, and the daily cap in
[`schema.sql`](schema.sql) is the backstop that actually bounds the damage.

## Reading it

There is no dashboard on purpose. A dashboard built before you know what you
want to look at is a dashboard you build twice, and the data is raw and
append-only precisely so that deciding later costs nothing.

```bash
npx wrangler d1 execute alists-count --remote --command "SELECT path, COUNT(*) n FROM events WHERE kind='view' AND agent!='bot' GROUP BY path ORDER BY n DESC LIMIT 20"
```

```bash
npx wrangler d1 execute alists-count --remote --command "SELECT label, COUNT(*) n FROM events WHERE kind='open' AND agent!='bot' GROUP BY label ORDER BY n DESC LIMIT 20"
```

```bash
npx wrangler d1 execute alists-count --remote --command "SELECT label, COUNT(*) n FROM events WHERE kind='search' GROUP BY label"
```

Filter `agent != 'bot'` on anything you intend to believe. Crawlers are
recorded rather than dropped, because a row you never wrote is a row you cannot
change your mind about, and early on they will be most of the traffic.

## When something goes wrong

```bash
npx wrangler tail
```

Rejected events log `{"at":"reject"}` and a day that hits the cap logs
`{"at":"cap"}` on every event past it. The second one is the alarm worth having:
20,000 events in a day is not this site.

An attack is a contiguous range of a column you own, so it comes out in one
statement:

```bash
npx wrangler d1 execute alists-count --remote --command "DELETE FROM events WHERE at BETWEEN 1730000000000 AND 1730003600000"
```

## What it stores

`at`, `kind`, `path`, `label`, referrer host, country, and a bot/mobile/desktop
class. Every one of those is either assigned by the Worker or checked against a
closed set read from the site's own `lists.json` -- the 38 city keys, the 10
category keys, the 1651 place names, four search buckets. No string a visitor
chose ever reaches the table.

There is no IP, no cookie, no visitor id and no search text. That is what keeps
this on the right side of a consent banner, and it is also why an attacker who
forges a million events has taken nothing: the worst case is a bad number.

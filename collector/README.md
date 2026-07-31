# collector

A count of what gets looked at, and a queue of what other people think I should
go to. Both kept somewhere I own.

This is not part of the site. `alists` is still four static files and a blob of
JSON served straight off Pages, and it stays that way whether or not anything
here is running -- `count.js` is loaded separately and every call into it from
`app.js` is guarded, so a Worker that is down, blocked or never deployed leaves
a page that works, does not count, and whose recommend button says it could not
reach anything rather than pretending to have sent something.

```
count.js  ──sendBeacon──▶  POST /            ──▶ D1  events
(the page)                 src/events.js         (closed sets only)

app.js    ──fetch───────▶  POST /recommend  ──▶ D1  suggestions
(the form)                 src/suggest.js        (the one free-text table)

you       ──a browser───▶  /review          ◀──     src/review.js
                           (a passphrase)           (keep, or pass)
```

Three jobs, one Worker, because they share a database, an origin and every
bound in `src/limits.js`. Splitting them would triple the deploy and change
nothing else.

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

Set the passphrase for `/review`. Make it long: it is the whole of the
authentication, and a short one is a short one whatever else is in front of it.
Until it is set, `/review` answers 404 -- an instance with no passphrase has no
review page, rather than one that announces itself as locked.

```bash
npm run key
```

```bash
npm run deploy
```

That prints the Worker's URL. Put it in the `alists-collector` meta tag in
[`index.html`](../index.html) in place of `YOUR-SUBDOMAIN`, and nothing happens
until you do: `count.js` counts nothing and `app.js` removes the recommend
chip entirely rather than offering a button that posts into somebody else's
database.

If `wrangler` rejects the `ratelimits` block, delete it. The Worker checks for
each binding and carries on without it, and the daily caps in
[`schema.sql`](schema.sql) are the backstop that actually bounds the damage.

## Reading the counts

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

## Reading the queue

This one *does* have a page, and for the opposite reason: a recommendation is
not a number to look at later, it is a link to press now. Open
`https://your-worker.workers.dev/review`, type the passphrase, and every waiting
place is one card with its Maps link, whatever was said about it, and two
buttons.

Pressing the name opens the place in Google Maps. Save it there, to whichever
list it belongs on, exactly as you would any other place. That is the whole of
"accepting" a recommendation: nothing here writes to the site, the next daily
`refresh` finds the place because it is now on one of your lists, and the review
page notices on its own and marks the card **already saved** the next time you
look.

So `keep` and `pass` are bookkeeping -- they clear the card, they do not publish
anything. Two people recommending the same place is one card with both reasons
on it and a `×2`, and one press decides all of it.

The page has no JavaScript at all, which is not austerity. It is the one page
in this repo that renders a string a stranger typed, and with no script source
in its CSP a mistake in the escaping is a mistake that cannot execute.

If you would rather read it as rows:

```bash
npx wrangler d1 execute alists-count --remote --command "SELECT id, name, url, note, who FROM suggestions WHERE state='new' ORDER BY id DESC"
```

## When something goes wrong

```bash
npx wrangler tail
```

Rejected events log `{"at":"reject"}`, a wrong passphrase logs
`{"at":"review"}`, and a day that hits a cap logs `{"at":"cap"}` on every event
past it. The last one is the alarm worth having: 20,000 events in a day is not
this site, and 200 recommendations in a day is not people recommending
restaurants.

An attack is a contiguous range of a column you own, so it comes out in one
statement:

```bash
npx wrangler d1 execute alists-count --remote --command "DELETE FROM events WHERE at BETWEEN 1730000000000 AND 1730003600000"
```

```bash
npx wrangler d1 execute alists-count --remote --command "DELETE FROM suggestions WHERE at BETWEEN 1730000000000 AND 1730003600000"
```

## What it stores

**`events`**: `at`, `kind`, `path`, `label`, referrer host, country, and a
bot/mobile/desktop class. Every one of those is either assigned by the Worker or
checked against a closed set read from the site's own `lists.json` -- the 38
city keys, the 10 category keys, the place names, four search buckets. No string
a visitor chose ever reaches this table. There is no IP, no cookie, no visitor
id and no search text, which is what keeps it on the right side of a consent
banner and also why an attacker who forges a million events has taken nothing:
the worst case is a bad number.

**`suggestions`** is where that sentence stops being true, and it is worth
being plain about it. `note` and `who` are free text. So is `name` when it came
out of a URL somebody pasted rather than out of `lists.json`. Nothing can make
free text not be free text.

What is done instead is give it nowhere to go. It is bounded (240, 40 and 80
characters, rejected rather than truncated, because half of somebody's sentence
is words in their mouth). It cannot contain a link -- not as a guess about what
spam looks like, but because the place already arrives in its own field and a
note with a URL in it has a part with no legitimate use here. It never reaches
the public site, which only ever shows places you saved in Maps yourself. And
the one page that renders it runs with no script source at all.

The place itself is not free text either, which is the reason the form insists
on a Google Maps link. What gets stored is not the link that was pasted: the
Worker parses one identifier out of it -- a CID or a place id, both bounded
tokens -- and rebuilds the URL from that. The column you are going to click can
only ever hold a Google Maps URL this repo's own code wrote. That is the same
trick `events` plays with its closed sets, applied to a link instead of an enum.

Short links are the one thing here that makes an outbound request, and only to
`maps.app.goo.gl`, `goo.gl` and `share.google`. Every redirect is followed one
hop at a time and checked before the next one is made, so a pasted URL cannot
turn this into a fetcher pointed at somewhere of the sender's choosing.

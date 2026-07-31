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
                           (open to anyone)         (a GET, and nothing else)

                                 what is still waiting =
                                 suggestions - data/lists.json - passed.txt
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

```bash
npm run deploy
```

That prints the Worker's URL. Put it in the `alists-collector` meta tag in
[`index.html`](../index.html) in place of `YOUR-SUBDOMAIN`, and nothing happens
until you do: `count.js` counts nothing and `app.js` removes the recommend
chip entirely rather than offering a button that posts into somebody else's
database.

There is no secret to set anywhere in this. `/review` is readable by anyone who
has the URL, and the only thing that can take a recommendation off it is a
commit -- see [Reading the queue](#reading-the-queue).

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
`https://your-worker.workers.dev/review` and every waiting place is one card
with its Maps link and whatever was said about it. Two people recommending the
same place is one card with both reasons on it and a `×2`.

There is nothing on the page to press, and that is the design rather than what
is left of one. A recommendation leaves the queue two ways:

**You add it.** Press the name; Google Maps opens on the place; save it to
whichever list it belongs on, exactly as you would any other place. You are
done. The next daily `refresh` writes it into `data/lists.json`, which is the
file this page reads to build its vocabulary, so the card is gone the next time
you look and a folded-away line accounts for it.

**You pass on it.** Put its identifier in [`passed.txt`](../passed.txt) and
commit. Every card prints the exact line to paste -- a CID and the place's name
as a comment -- and the page turns the words `passed.txt` into a link straight
to GitHub's editor if `PASSED_EDIT_URL` is set. The Worker re-reads that file
every five minutes, so a commit takes effect about as fast as the Pages deploy
that publishes it.

So the table stores nothing about what became of a row. Both answers are facts
already written down somewhere else, and a `state` column would be a third copy
of them -- copies of a fact become separate facts the moment one is wrong.

**Anyone with the URL can open it**, which is a decision rather than an
oversight. Nothing on it is private: a public Google Maps link, and a sentence
somebody typed into a public form in order to send it to you. It is also why
saying no lives in the repo. A button on a page anyone can open is a button
anyone can press; a commit is not. `/review` answers GET and nothing else.

The page has no JavaScript either, which is not austerity. It is the one page
in this repo that renders a string a stranger typed, and with no script source
in its CSP a mistake in the escaping is a mistake that cannot execute.

If you would rather read the queue as rows:

```bash
npm run queue
```

## Getting rid of something

`passed.txt` is for places you are not adding. It is not for spam, and the
difference matters: that file is public and names the place, which is precisely
what somebody posting rubbish wanted. Delete the row instead.

```bash
npx wrangler d1 execute alists-count --remote --command "DELETE FROM suggestions WHERE id = 42"
```

`npm run queue` prints the ids. A whole bad afternoon is a contiguous range, the
same as it is for events:

```bash
npx wrangler d1 execute alists-count --remote --command "DELETE FROM suggestions WHERE at BETWEEN 1730000000000 AND 1730003600000"
```

## When something goes wrong

```bash
npx wrangler tail
```

Rejected events log `{"at":"reject"}`, and a day that hits a cap logs
`{"at":"cap"}` on every event past it. The second one is the alarm worth having:
20,000 events in a day is not this site, and 200 recommendations in a day is not
people recommending restaurants.

An attack is a contiguous range of a column you own, so it comes out in one
statement:

```bash
npx wrangler d1 execute alists-count --remote --command "DELETE FROM events WHERE at BETWEEN 1730000000000 AND 1730003600000"
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

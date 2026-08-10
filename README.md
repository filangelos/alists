# alists

Every place saved to my Google Maps lists, as a tree of city then category.

The lists are how the places are *organised* in Maps; they are not how they are
browsed here. Half of them are named after private jokes, and the largest place
in the collection — London, 319 places — has no list at all, only five ordering
scratchpads and a neighbourhood. So the fetcher works out a city and a category
for every place and the page browses that: 38 cities you walk into, a trail and
a back button to come out of them by, and a search box.

```
‹  All places › 🇬🇧 London › ☕️ Coffee                     39 places
   ● Prufrock Coffee
     23-25 Leather Ln, London EC1N 7TE, United Kingdom
```

## How it works

Google Maps serves a shared list's contents from `/maps/preview/entitylist/getlist`,
which needs no API key, no cookie and no consent click. So there is no server
here and no build step:

```
lists.txt  ──scripts/fetch.py──▶  data/lists.json ──┬─▶  index.html + app.js
(52 links)   + scripts/derive.py    (1649 places)   │      (static, on Pages)
                (once a day)      (38 cities, 10 types)
                                                    └─▶  R2 ─▶  GET  /lists.json
                                                        (mcp/)   POST /mcp
```

`data/lists.json` is committed, so the page is four static files plus a blob of
JSON, and the committed file is still the record: it is what tomorrow's refresh
diffs against to know what is new, it is where a wrong guess about a city shows
up in a diff, and it is why a broken deploy can be reproduced by opening
`index.html` from disk.

What lives on Cloudflare is where those bytes are *served* from. The refresh
commits the file and then publishes the same file to an R2 bucket; the page
loads it from there and falls back to the copy in the tree when it does not
answer. That is a change of origin and not a change of truth, which is the only
version of this change worth making — see [For agents](#for-agents).

Three things here talk to a server. [`count.js`](count.js), which is the fourth
file; the recommend form in `app.js`; and the data load, which is the only one
the page would miss, and only until the fallback fires. See
[Counting](#counting), [Somewhere I should go](#somewhere-i-should-go) and
[For agents](#for-agents).

## The two derived levels

Neither the city nor the category is in Google's payload; both are worked out in
[`scripts/derive.py`](scripts/derive.py), in the fetcher rather than the browser,
so that a wrong guess lands in the committed JSON where it shows up in a diff and
can be corrected by hand.

**City** is the reliable one. Every place has coordinates, a place on two city
lists never disagrees about which city it is in, so the tree is a strict
partition and the counts sum to exactly 1649. The 116 places filed only under a
category — including 35 in Athens — are placed by their nearest city centre,
which is what makes them reachable at all; the six that land more than 12 km out
are marked `~` rather than passed off as certain.

**Category** is the guess. Only 340 places carry one of the eight category
lists, so the other four in five are typed by reading the name for venue words.
That gets 908 of 1649, at roughly six correct in seven measured against the
places already filed by hand. `Other` holds the rest and sorts last: it is where
the guess declined, not where the places are worse — most of the best
restaurants are in it, because a good restaurant is called `Palma`, not
`Palma Restaurant`.

Words like *garden*, *square* and *market* are trusted only when the address has
no street number, because otherwise `Dishoom Covent Garden` files as a park.

**The flag** in front of a city is the one thing here that is neither in the
payload nor inferred from it. The address is the only field that names a country
and it does not name Greece: of the 443 places across Athens and the sixteen
Greek islands, four mention it, and Crete's thirty have no address at all. An
inference would therefore be confidently wrong about the half of the collection
it matters most for, so `COUNTRIES` in `derive.py` states it instead — 38 lines
of ISO codes that never change for a city once written. `warn_countries` holds
them up against whatever the addresses *do* say and complains when the majority
disagrees, which is what would catch `IE` typed for Barcelona. Niagara Falls is
the honest edge: six addresses in Canada, four in the United States, one flag.

## The list that files nothing

`next` is the places I have not eaten in, drunk at or walked around yet: things
heard about, saved, and still owed a visit. They are real places in real cities
and the one thing they are not is *recommended*, which is the only claim the
rest of the page makes. Folding them in silently would have been the cheap
change and the wrong one — the collection would quietly stop meaning what it
says.

So `next` is a **mark** rather than a city or a category. A city list says where
a place is; a category list says what it is; both file it somewhere in the tree.
A mark files nothing. Its places are held out of the tree until the
`○ not been yet` button is pressed, and drawn with a hollow bullet instead of a
filled one once they are — the button carries the same glyph, so the control is
its own legend.

```
   ● Prufrock Coffee          been, and worth going
   ○ Somewhere Else           saved, not yet
```

Every count moves with the button, the one in the header included: a number
counting rows nobody can see is the same lie as a folder that disagrees with
what is inside it. And it is a view rather than a gesture, so
`…/#%2Funverified` is a link to the collection with the unvisited places folded
in, exactly as `…/#%2Flondon%2Fcoffee` is a link to a folder. `/next` — the
list's own name — resolves to the same page, like every other list slug.

A marked place is still a place: it is filed by whichever city list it is on,
and by its nearest city centre when it is on none, marked `~` if that lands
more than 12 km out.

## What arrived this week

`◷ new this week` is the change list: press it and the tree holds only the
places saved in the last seven days, still filed by city and category, with
every count moving to match. It is a view like any other — `…/#%2Fnew` is a link
to it, `/london /new` is a link to the week in one city, and `/recent` spells
the same thing for whoever types the word rather than presses the button.

Google's payload does not say when a place was saved. The endpoint hands back a
list, not a history, so the only date available is the day a place first turned
up in a refresh — which is what `added` is, and why it is *carried* out of the
committed JSON rather than recomputed:

```json
{ "name": "Prufrock Coffee", "city": "London", "added": "2026-08-01" }
```

`data/lists.json` is the record. Yesterday's file is what says a place is not
new, so a run that ignored it would re-date all 2156 places to whenever the job
last happened to run. A place the previous file has never seen is stamped with
today; a place it has seen but never dated stays undated, because it predates
the record and a guess would put the entire collection into a list meant to hold
a week. That is why the 1649 places of the first commit carry no date at all:
the dates here were seeded from the git history of `data/lists.json`, which
knows when each place appeared and nothing about the years before it.

Seven days measured from `generated` rather than from your clock. The file
cannot know about anything that happened after the refresh that wrote it, so a
page sitting on a fortnight-old blob shows that blob's last week instead of
quietly emptying the list to prove the clock has moved. The footer says which
week it means. In a week that saved nothing there is no button — the same rule
the marks and the recommend form follow, and for the same reason.

The marks stop applying while it is on, and `○ not been yet` dims to say so.
Nearly everything saved in a given week is somewhere I have not been yet — that
is what saving it means — so a change list that also held those places back
would answer "what arrived this week" with a tenth of what arrived. They keep
their hollow bullet, which is the honest way to show them: the row still says I
have not been, the week still says it is new.

A list added to `lists.txt` lands all of its places in the change list on the
day it is added, because that is the day this file first saw them. It is the
truthful answer and a lopsided one — 485 places arrived on 2026-07-31 that way,
and they age out of the window like anything else.

## Adding a list

Append the share link to [`lists.txt`](lists.txt) and push. Short
(`maps.app.goo.gl/…`), long, or the bare list id all work. The `refresh`
workflow re-fetches on push, commits the new `data/lists.json`, and redeploys.

To do it locally instead:

```bash
python3 scripts/fetch.py
```

Stdlib only — no `pip install`, no virtualenv, nothing to keep current.

A new list becomes a city unless it is declared a category or a mark. If you add
one that is really a kind of place, the fetcher notices — anything whose members
span more than 200 km gets a warning naming the file to edit.

A new city also needs a line in `COUNTRIES` for its flag: `"Lisbon": "PT"`. The
fetcher warns until it gets one, and the city browses perfectly well in the
meantime with a gap where the flag goes — missing reads as *not said yet*, which
is what it is, where a wrong flag would read as a claim.

## Adding a category

One entry in `CATEGORIES` in [`scripts/derive.py`](scripts/derive.py), in the
order you want it matched:

```python
Category(
    "museums", "Museums", "🏛",
    lists=("Museums",),          # a Maps list that *is* this category, if one exists
    strong=r"museum|μουσει|gallery",   # trusted anywhere in a name
    weak=r"collection|archive",        # trusted only without a street number
),
```

Nothing else changes. `lists` is authoritative and beats every pattern, because
it is a judgement you actually made; the patterns are the guess for everything
else. Splitting one category in two, or renaming one, is the same edit.

## Adding a mark

One entry in `MARKS` in [`scripts/derive.py`](scripts/derive.py), and the page
grows a second button:

```python
Mark(
    "closed", "gone now", "×",
    lists=("RIP",),          # the Maps list that carries the mark
),
```

The name is matched on its letters and digits alone — `next`, `Next` and
`next 🔜` are one intention, because a mark is named by whoever made the list
rather than by this taxonomy. The fetcher says so when a mark names a list that
`lists.txt` does not have, because that failure is otherwise silent in the worst
way: the list would file itself as a *city*, its places would scatter under a
heading named after a to-do list, and the button would never appear at all.

## Using it

| | |
|---|---|
| click a city | walk into it — 319 places across nine categories, opened |
| the triangle | peek inside a folder without leaving where you are standing |
| `‹`, any step of the trail, or the browser's own back button | come back out |
| type anything | filters on name, address, note and list name, wherever you are |
| `◷ new this week` | only the places saved in the last seven days |
| `near me` | sort by distance from you — asks for your location |
| `○ not been yet` | fold in the places I have not been to yet, hollow-bulleted |
| `+ recommend` | send me somewhere you think should be here — a Maps link, and why |
| `everywhere` | that category in every city: the one view no city contains |
| `↑` `↓` | move the selection |
| `→` | open the folder, then step into it |
| `←` | close the folder, then climb out of it, then leave the level entirely |
| `Enter` | walk into a folder, or open that place in Google Maps |
| `Esc` | up one level; in the search box, clear the search first |

Any letter typed anywhere lands in the search box, so narrowing 1649 places
never needs the mouse — that is also what the tree owes type-ahead, and
filtering is a better answer than jumping to the next row starting with `p`.

There used to be a prompt instead: one input at the bottom, `/london/coffee` as
a path, a completion menu over it. It was a good interface for whoever wrote the
grammar and a wall for everyone else — a page of saved restaurants should not
open by asking you to learn a command line. The query it built is untouched, and
that is the point of the rewrite rather than a side effect of it: the hash still
holds `/london/coffee flat white`, so every link ever shared still resolves. It
is written by clicks now.

`near me` asks for location **only when you press it**, never on load — an
unprompted permission prompt gets reflexively denied, and a denial is sticky.
When it works it says so once, in the footer, because the distances in the rows
are the real answer and a banner over them would only push the first result
down. Waiting and declined report in the same place, and a decline leaves the
tree in its usual order rather than re-asking.

It sorts rather than filters: cities by how close their nearest place is, places
by distance within their category, so the structure holds and the nearest thing
floats to the top of it. Distances are great-circle, not driving
distance: enough to order a neighbourhood correctly without a network call per
place. Every city carries its centre in `data/lists.json`, so sorting from
somewhere other than where you are standing is a second branch in
`resolveOrigin` and nothing more.

## What is open, and why nothing is remembered

What is expanded is a pure function of where you are and what you typed. A node
is open if you are standing in it, if it was pruned by a filter, or if it holds
most of what survived — that last one so searching for a city answers with its
places rather than with its name.

The triangles are the one exception, and they are deliberately not part of the
state: they are a peek, they leave the address bar alone, and they are dropped
the moment the query changes. A URL cannot honestly carry which folders happened
to be open, so it carries the view instead, and `…/#%2Flondon%2Fcoffee` being the
whole of what you are looking at is the reason there is no share button.

Every view is a URL, and every link shared before the tree existed still
resolves: `/nyc` is New York, `/aθens` is Athens, `/lonfood` widens to London.
Category links widen the same way — `/pizza` is now the whole Food branch. An
alias is rewritten into the slugs the trail is showing, once, on arrival, so the
address bar and the page agree about which view they are on.

Walking into a city is a history entry and typing is not: the browser's back
button retraces the tree rather than the last thirty keystrokes.

## Matching

Matching folds accents and case, so `cafe` finds `Café` and `ανοιξη` finds
`Άνοιξη`. It does not transliterate — `anoixi` finds nothing, and a Greek name
has to be typed in Greek. Slugs are the exception and *are* transliterated, so
`/athens` works from any keyboard; addressing and matching are different jobs,
and a slug is something a person retypes out of an address bar.

A city's own name is removed from its places' searchable text, token by token.
Before, `london` matched 317 places because every London address contains the
word; now it matches the fifteen actually *called* London and the folder holds
the rest. Removed by token and never as a substring, or `uk` would eat `Duke St`.

## Deploying

Once, in **Settings → Pages**, set **Source** to **GitHub Actions**. After that:

- **`pages`** — publishes the repo root. Runs on push to `main`.
- **`refresh`** — re-fetches daily at 05:17 UTC, on `workflow_dispatch`, and
  whenever `lists.txt` changes. Commits only if the places actually changed, then
  *calls* `pages` rather than relying on its push trigger: a push made with
  `GITHUB_TOKEN` does not start another workflow, so a triggered deploy would
  never fire and both jobs would report success over stale data.

`refresh` also publishes `data/lists.json` to R2, which needs two repository
secrets — `CLOUDFLARE_ACCOUNT_ID`, and a `CLOUDFLARE_API_TOKEN` holding **Workers
R2 Storage: Edit** and nothing else. Without them the step is skipped rather than
failed, so a clone refreshes its own data and publishes nowhere. Unlike the
commit, the publish is unconditional: a PUT a day costs one operation, and
gating it on "did the places change" leaves a bucket that was emptied or
re-created broken until they do. [`mcp/README.md`](mcp/README.md) has the setup.

GitHub disables scheduled workflows after ~60 days without repository activity.
It emails first, and the `workflow_dispatch` button covers the gap.

## Somewhere I should go

Everything in the tree is a place I have been to and would send you to. That is
the only claim this page makes, and it is why `next` is a mark rather than a
folder. So somebody else's recommendation cannot be a row here — it is the
opposite of one: a place I have *not* been, vouched for by someone who has.

It is a queue instead. `+ recommend` is the one chip that is not the accent
colour, because it is the one control on the page that writes rather than
filters, and it opens a form where the tree was. What it asks for is a Google
Maps link.

```
somebody's link ──▶ /recommend ──▶  D1  ──▶ /review ──▶ me, in Google Maps
                                             ▲    ▲           │
                              data/lists.json ┘    └ passed.txt
                                     ▲
                                  refresh ◀────────────────────┘
```

**A link rather than a name**, for three reasons that turn out to be one
reason. It makes reviewing a press instead of a search. It lets the collector
answer *SMOKESTAK is on a list already — thank you anyway* while the person is
still standing there, because the CID in a Maps link is the same identifier
`data/lists.json` holds for every place in it. And it means the URL that gets
stored is not a string anybody typed: the Worker parses one bounded token out
of the link and rebuilds the address from that, so the thing I am going to
click can only ever be a Maps URL this repo's own code wrote.

Somewhere I already have is worth being told about and is kept like anything
else. Refusing it was the first thing this did and the wrong shape twice over:
it threw away what somebody had written about a place that *is* worth going to,
and it answered a kindness with a no. The queue folds it away by itself, so
saying yes costs nothing.

The `why` and the `you` are free text, and nothing can make free text not be
free text. What there is instead is nowhere for it to go: bounded lengths,
rejected rather than truncated; no links, because the place already arrives in
its own field; never rendered into this page; and the one page that does render
it has no script source at all.
[`collector/README.md`](collector/README.md) has the reasoning.

**The queue has no buttons on it at all**, and that is the part worth saying
out loud. A recommendation leaves it two ways, and both of them are facts kept
somewhere else:

| | |
|---|---|
| I add it | I press the name, Maps opens, I save it to a list the way I save everything else. Tomorrow's `refresh` writes it into `data/lists.json`, which is the file the queue reads — so the card is simply not there next time. |
| I pass on it | its number goes in [`passed.txt`](passed.txt), which the queue also reads. The page prints the exact line to paste under every card. |

So accepting a recommendation and adding a place are the same act, and
declining one is a commit — which is what every other judgement in this repo
already is. It shows up in a diff, it comes back by deleting a line, and the
table behind all this never stores what became of a row. A `kept` or `passed`
column would be a third copy of a fact two files already hold, and copies of a
fact become separate facts the moment one is wrong.

It also settles who can do it. There is no passphrase — everything on that page
is a public Maps link and a sentence somebody chose to send, so anyone with the
URL can read it — and a button on a page anyone can open is a button anyone can
press. With the one destructive gesture living in the repo, saying no is
something only whoever can push here can do, and the page is a plain GET that
changes nothing.

And if I save it without having been yet, it goes on `next` and arrives here
hollow-bulleted behind the `○ not been yet` button — which is exactly what it
then is: somewhere heard about, saved, and still owed a visit.

## Counting

Three numbers, on a Cloudflare Worker writing to a D1 database I own: a page
opened, a search made, a place opened in Maps. The same Worker carries the
recommendation queue above — [`collector/`](collector/) is one deploy doing
three jobs, because they share a database, an origin and every bound in it. It
is a separate deploy from the site and can be down, blocked or never set up at
all without the tree stopping working — the page is still what is in this repo.

What is stored is `at`, `kind`, `path`, a label, the referrer's host, a country
and a bot/mobile/desktop class. **No IP, no cookie, no visitor id, and never the
search text** — the search box is the one place a stranger writes free text into
this page, and how many results they got is as much as anyone needs to know. So
there is nothing to put behind a consent banner. `count.js` answers Global
Privacy Control and stops; it does not answer `DNT`, which has meant nothing
since the group defining it closed in 2019.

The URL that receives all this is in a public file in a public repo, which means
anybody can post to it and no amount of cleverness changes that. Nothing tries
to. Instead every field is checked against a closed set read from this repo's own
`lists.json` — the 38 city keys, the 10 category keys, the 1651 place names, four
search buckets — so a forged event can only say something the site could have
said itself, and a daily cap turns filling the database into losing one day of
counts. `collector/README.md` has the reasoning and the queries.

## For agents

The same places, where something that is not a browser can ask about them. A
second Cloudflare Worker — [`mcp/`](mcp/) — holds the R2 bucket the page now
loads its data from, and answers the [Model Context
Protocol](https://modelcontextprotocol.io) over it:

```
GET  /lists.json    the whole collection, one object, as app.js loads it
POST /mcp           five tools, for whatever is asking
```

| | |
|---|---|
| `search_places` | free text, plus city, category, visited state and a date |
| `places_near` | everything within a radius of a point, nearest first |
| `get_place` | one place, by name or by CID |
| `list_cities` | what the collection covers, with counts and centres |
| `list_categories` | what the categories are, with counts |

`places_near` is the one the rest exists around: *coffee within two kilometres
of here* is the question a saved-places list is actually for, and it is the one
the page can only answer by sorting. Its origin is a latitude and longitude, or
the name of a city or of a place already in the collection. It does not geocode
an address — that would mean an API key, a network hop per call and a second
opinion about where places are, and a caller holding an address can geocode it
themselves. Distances are great-circle, like `near me`, so an answer is a floor
on how far you will walk.

**Nothing is folded in that the page holds back.** Every tool that can see the
`next` mark defaults to leaving it out, for the reason
[the list that files nothing](#the-list-that-files-nothing) exists at all: those
places are the opposite of a recommendation, and an agent asked for somewhere to
eat would present them as one. The same argument, one layer down — a count that
includes rows the caller cannot see is the same lie here as it is in a folder
header, so every count moves with the filter that produced it.

There is no authentication, and that is the same decision `/review` makes.
Everything here is already a public page and a public repository, the Worker
writes nothing and has no write binding to the bucket at all, so a token would
guard data anybody can download while adding a secret to paste into every
client config.

It speaks MCP **2026-07-28**, the revision that made the protocol stateless —
no handshake, no session header, no held-open stream — which is why it fits in
a Worker with nothing behind it: any isolate can answer any request, because
there is nothing to remember between two of them. The `initialize`-era
revisions are answered from the same endpoint until clients have moved off
them. [`mcp/README.md`](mcp/README.md) has the deploy, the tools and the
reasoning; `npm test` in that directory checks both the queries and the wire
format against the real `data/lists.json`, with nothing stubbed but the bucket.

## Caveats

The endpoint is undocumented and its response is a positionally-indexed array,
so every field read in `scripts/fetch.py` is a magic number. They are named once,
in the `_FIELD` constants at the top of the file; if Google reorders the payload,
that block is what changes. The fetcher tolerates missing fields rather than
crashing on them, so a shape change degrades to blank addresses before it
degrades to no site.

The category is inferred, and an inference is visible when it is wrong — about
one typed place in seven is, and unlike a missing category a wrong one is
confidently wrong. `OVERRIDES` in `derive.py` pins a place by CID when the fix
does not belong in a pattern.

Only public lists work. A list has to be shared with "anyone with the link" —
the fetcher sends no credentials and cannot see a private one.

`added` is the day this repository first saw a place, not the day it was saved
in Maps. Nothing knows the second date, and the first is only as good as the
refresh history: a place saved and unsaved between two runs is never seen at
all, and one that disappears from a list and comes back is dated by its return.
A place that predates the record is undated and therefore never new, which is
the failure mode worth having — the change list can miss something, but it
cannot claim a five-year-old restaurant arrived on Tuesday.

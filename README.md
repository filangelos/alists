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
lists.txt  ──scripts/fetch.py──▶  data/lists.json  ──▶  index.html + app.js
(51 links)   + scripts/derive.py    (1649 places)         (static, on Pages)
                (once a day)      (38 cities, 10 types)
```

`data/lists.json` is committed, so the page is four static files plus a blob of
JSON. What is deployed is exactly what is in the tree — a broken deploy can be
reproduced by opening `index.html` from disk.

The fourth file is [`count.js`](count.js), which is the only thing here that
talks to a server. It is deliberately not part of the page: see
[Counting](#counting).

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

## Adding a list

Append the share link to [`lists.txt`](lists.txt) and push. Short
(`maps.app.goo.gl/…`), long, or the bare list id all work. The `refresh`
workflow re-fetches on push, commits the new `data/lists.json`, and redeploys.

To do it locally instead:

```bash
python3 scripts/fetch.py
```

Stdlib only — no `pip install`, no virtualenv, nothing to keep current.

A new list becomes a city unless it is declared a category. If you add one that
is really a kind of place, the fetcher notices — anything whose members span
more than 200 km gets a warning naming the file to edit.

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

## Using it

| | |
|---|---|
| click a city | walk into it — 319 places across nine categories, opened |
| the triangle | peek inside a folder without leaving where you are standing |
| `‹`, any step of the trail, or the browser's own back button | come back out |
| type anything | filters on name, address, note and list name, wherever you are |
| `near me` | sort by distance from you — asks for your location |
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

GitHub disables scheduled workflows after ~60 days without repository activity.
It emails first, and the `workflow_dispatch` button covers the gap.

## Counting

Three numbers, on a Cloudflare Worker writing to a D1 database I own: a page
opened, a search made, a place opened in Maps. The Worker and its schema are in
[`collector/`](collector/), which is a separate deploy from the site and can be
down, blocked or never set up at all without the tree stopping working — the
page is still what is in this repo.

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

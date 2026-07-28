# alists

Every place saved to my Google Maps lists, as a tree of city then category.

The lists are how the places are *organised* in Maps; they are not how they are
browsed here. Half of them are named after private jokes, and the largest place
in the collection — London, 319 places — has no list at all, only five ordering
scratchpads and a neighbourhood. So the fetcher works out a city and a category
for every place and the page browses that. There is one input, at the bottom,
and it does everything.

```
❯ /london/coffee                                        39 matches
▾ London                                                       39
└─ ▾ ☕️ Coffee                                                  39
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

`data/lists.json` is committed, so the page is three static files plus a blob of
JSON. What is deployed is exactly what is in the tree — a broken deploy can be
reproduced by opening `index.html` from disk.

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
| type anything | filters on name, address, note and list name |
| `/` | opens the index of cities and categories; `Tab` or `Enter` completes |
| `/london` | just London — 319 places across nine categories |
| `/london/coffee` | one cell of it |
| `/coffee` | every coffee place, in every city |
| `/naxos bakery` | words still narrow inside a path |
| `/near` | sort by distance from you — asks for your location |
| `↑` `↓` | move the selection |
| `Enter` | open a folder, or open that place in Google Maps |
| `→` | open a folder, when the caret is at the end of the line |
| `Esc` | widen one step: the words, then the category, then the city |
| click | the same as `Enter` on that row |

`←` is deliberately unbound: the prompt is a text field you are editing, and
stealing the left arrow would make it feel broken.

`/near` asks for location **only when you type it**, never on load — an
unprompted permission prompt gets reflexively denied, and a denial is sticky.
When it works it says nothing: `/near` is sitting in the prompt and the
distances are in the rows, so a banner would only restate them. Waiting and
declined both report in the footer, and a decline leaves the tree in its usual
order rather than re-asking.

It sorts rather than filters: cities by how close their nearest place is, places
by distance within their category, so the structure holds and the nearest thing
floats to the top of it. Distances are great-circle, not driving
distance: enough to order a neighbourhood correctly without a network call per
place. Every city carries its centre in `data/lists.json`, so sorting from
somewhere other than where you are standing is a second branch in
`resolveOrigin` and nothing more.

## What is open, and why nothing is remembered

What is expanded is a pure function of the query. A node is open if you are
standing on it, if it was pruned by a filter, or if it holds most of what
survived — that last one so typing a city's name answers with its places rather
than with its name.

Nothing is stored, because the hash *is* the prompt. Any state a click could
create but typing could not would be lost the moment the URL was shared, and
`…/#%2Flondon%2Fcoffee` being the whole of what you are looking at is the reason
there is no share button.

Every filter is a URL, and every link shared before the tree existed still
resolves: `/nyc` is New York, `/aθens` is Athens, `/lonfood` widens to London.
Category links widen the same way — `/pizza` is now the whole Food branch.

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

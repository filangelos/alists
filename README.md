# alists

One filterable stream of every place saved to my Google Maps lists.

The lists are how the places are *organised* in Maps; they are not how they are
browsed here. A place appears once, tagged with every list that claims it, and
the lists are a facet you can narrow to rather than a level you have to navigate
through. There is one input, at the bottom, and it does everything.

```
❯ /near bagel                                             4 matches
● KURO BAGELS                                     3.9 km  🥖
  5 Hillgate St, London W8 7SP, United Kingdom
```

## How it works

Google Maps serves a shared list's contents from `/maps/preview/entitylist/getlist`,
which needs no API key, no cookie and no consent click. So there is no server
here and no build step:

```
lists.txt  ──scripts/fetch.py──▶  data/lists.json  ──▶  index.html + app.js
(51 links)      (once a day)        (1649 places)         (static, on Pages)
```

`data/lists.json` is committed, so the page is three static files plus a blob of
JSON. What is deployed is exactly what is in the tree — a broken deploy can be
reproduced by opening `index.html` from disk.

## Adding a list

Append the share link to [`lists.txt`](lists.txt) and push. Short
(`maps.app.goo.gl/…`), long, or the bare list id all work. The `refresh`
workflow re-fetches on push, commits the new `data/lists.json`, and redeploys.

To do it locally instead:

```bash
python3 scripts/fetch.py
```

Stdlib only — no `pip install`, no virtualenv, nothing to keep current.

## Using it

| | |
|---|---|
| type anything | filters on name, address, note and list name |
| `/` | opens the menu of commands and lists; `Tab` or `Enter` completes |
| `/nyc bagel` | the NYC list **and** the word bagel |
| `/all-lists` | every list A–Z; opening one opens it in Google Maps |
| `/near` | sort by distance from you — asks for your location |
| `/near /baker` | the nearest bakeries |
| `↑` `↓` | move the selection |
| `Enter` / click | open that place (or list) in Google Maps |
| `Esc` | clear |
| tap a chip (🥙 💂‍♂️) | scope to that list |

`/near` asks for location **only when you type it**, never on load — an
unprompted permission prompt gets reflexively denied, and a denial is sticky.
When it works it says nothing: `/near` is sitting in the prompt and the
distances are in the rows, so a banner would only restate them and push the
first result down. Waiting and declined both report in the footer, and a
decline leaves the results in their usual order rather than re-asking.

Distances are great-circle, not driving distance: enough to order a
neighbourhood correctly without a network call per place.

Matching folds accents and case, so `cafe` finds `Café` and `ανοιξη` finds
`Άνοιξη`. It does not transliterate — `anoixi` finds nothing, and a Greek name
has to be typed in Greek. A name match outranks an address match, so `london`
surfaces places *called* London before the 238 merely in it.

A `/scope` that names a list exactly means only that list; anything shorter is
a prefix and matches every list starting with it. So `/bar` is the 49 cocktail
bars and not also the 31 places in Barcelona, while `/b` is deliberately both.

Every filter is a URL. `…/#%2Fbaker` is the bakeries; the address bar is the
share button, so there isn't one.

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

Only public lists work. A list has to be shared with "anyone with the link" —
the fetcher sends no credentials and cannot see a private one.

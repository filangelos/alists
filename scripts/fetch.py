#!/usr/bin/env python3
"""Turn the share links in lists.txt into data/lists.json.

Google Maps serves a shared list's contents from an undocumented endpoint,
`/maps/preview/entitylist/getlist`, which needs no key, no cookie and no
consent -- so the whole pipeline is one HTTP GET per list and the page it
feeds can stay a static file. The response is a positionally-indexed array
rather than an object, so every field access here is a magic number; the
`_FIELD` constants below are the only place they appear, and `probe.py`
re-derives them from a live response when Google moves one.

Stdlib only, deliberately: the refresh workflow then needs no install step
and cannot break on a transitive dependency while nobody is watching.
"""

from __future__ import annotations

import json
import pathlib
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

ROOT = pathlib.Path(__file__).resolve().parent.parent
LISTS_TXT = ROOT / "lists.txt"
OUT = ROOT / "data" / "lists.json"

UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)
BOT_UA = "glists-fetch (+https://github.com/filangelos/glists)"
ENDPOINT = "https://www.google.com/maps/preview/entitylist/getlist"

# Ask for far more places than any hand-curated list holds, so one request is
# always the whole list and there is no pagination cursor to carry.
PAGE_SIZE = 2000

# Offsets into the response array. Named once here; see the module docstring.
_LIST_OWNER, _LIST_NAME, _LIST_DESC = 3, 4, 5
_LIST_ITEMS, _LIST_TOTAL, _LIST_EMOJI = 8, 12, 17
_ITEM_META, _ITEM_NAME, _ITEM_NOTE = 1, 2, 3
_META_ADDRESS, _META_GEO, _META_FTID, _META_MID = 4, 5, 6, 7
_GEO_LAT, _GEO_LNG = 2, 3


class FetchError(RuntimeError):
    pass


def _get(url: str) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Language": "en"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.read().decode("utf-8", "replace")


def _resolve(url: str) -> str:
    """Follow a short link to its destination.

    Deliberately *not* sending the browser UA: to a browser, maps.app.goo.gl
    answers 200 with a JavaScript interstitial that performs the hop
    client-side, so the destination never appears in the response at all. To
    anything else it answers a plain 30x, which urllib follows for us.
    """
    req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": BOT_UA})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.geturl()


# ---------------------------------------------------------------- link parsing

_ID_IN_URL = re.compile(r"!2s([A-Za-z0-9_-]+)")
_BARE_ID = re.compile(r"^[A-Za-z0-9_-]{16,}$")


def list_id(link: str) -> str:
    """Normalise any of the three shapes a user might paste into a list id.

    A short link carries no id at all -- it has to be resolved against Google
    first -- so this is the one step that costs a network round trip, and it is
    why `lists.txt` holding long links makes a refresh faster.
    """
    link = link.strip()
    if _BARE_ID.match(link) and "/" not in link:
        return link
    if "maps.app.goo.gl" in link or "goo.gl/maps" in link:
        link = _resolve(link)
    match = _ID_IN_URL.search(link)
    if match:
        return match.group(1)
    # placelists/list/<id> is the canonical form the endpoint itself hands back.
    match = re.search(r"placelists/list/([A-Za-z0-9_-]+)", link)
    if match:
        return match.group(1)
    raise FetchError(f"no list id in {link!r}")


# ------------------------------------------------------------------- fetching


def fetch_list(lid: str) -> list:
    # `!` is legal unencoded but Google's own client percent-encodes it, and an
    # intermediary that normalises the path would otherwise corrupt the payload.
    pb = f"!1m4!1s{lid}!2e1!3m1!1e1!2e2!3e2!4i{PAGE_SIZE}!28e2!16b1"
    query = urllib.parse.urlencode({"authuser": 0, "hl": "en", "gl": "gb", "pb": pb})
    body = _get(f"{ENDPOINT}?{query}")
    # XSSI guard: the response opens with `)]}'` on its own line.
    if body.startswith(")]}'"):
        body = body[body.index("\n") + 1 :]
    try:
        return json.loads(body)[0]
    except (ValueError, IndexError) as exc:
        raise FetchError(f"list {lid}: unparseable response ({exc})") from exc


def fetch_complete(lid: str, attempts: int = 4) -> list:
    """Fetch a list, insisting on all of it.

    Under load the endpoint degrades in two ways, both answered 200 with no
    error of any kind: a short page (fewer items than the total it states in
    the same response), or a stub with no name, no total and no items at all.
    Left alone either is the worst possible failure here -- the refresh job
    succeeds, commits a file quietly missing places, and deploys it.

    Both are detectable. A short page contradicts its own stated total, and a
    real list always has a name, so a nameless response is a stub rather than
    an empty list. An empty list *with* a name is legitimate and passes.
    """
    problem = "no response"
    for attempt in range(attempts):
        if attempt:
            time.sleep(2.0 * attempt)  # the failures are load-shedding; back off
        raw = fetch_list(lid)
        name = _at(raw, _LIST_NAME, default="")
        total = _at(raw, _LIST_TOTAL, default=0)
        got = len(_at(raw, _LIST_ITEMS, default=[]))

        if not isinstance(name, str) or not name.strip():
            problem = "no list name in response"
        elif total and got < total:
            problem = f"only {got} of {total} places"
        else:
            return raw

        print(f"  ~ {problem}, retrying", file=sys.stderr)

    raise FetchError(
        f"list {lid}: {problem} after {attempts} attempts; "
        "refusing to write a file that would drop places"
    )


def _at(seq, *path, default=None):
    """Index a nested list positionally, yielding `default` on any miss.

    Google omits trailing nulls and prunes empty branches, so a place with no
    note has a *shorter* array than one with a note rather than a null in that
    slot. Every read has to tolerate the array simply ending early.
    """
    cur = seq
    for key in path:
        if not isinstance(cur, list) or key >= len(cur) or cur[key] is None:
            return default
        cur = cur[key]
    return cur


def parse_place(raw: list, lid: str) -> dict | None:
    name = _at(raw, _ITEM_NAME, default="").strip()
    if not name:
        return None  # a place delisted from Maps still occupies a slot
    meta = _at(raw, _ITEM_META, default=[])
    # The two halves of the feature id; the second is the CID that
    # `maps.google.com/?cid=` resolves, which is the most durable deep link
    # available without a Places API key.
    cid = _at(meta, _META_FTID, 1)
    lat = _at(meta, _META_GEO, _GEO_LAT)
    lng = _at(meta, _META_GEO, _GEO_LNG)
    return {
        "name": name,
        "address": (_at(meta, _META_ADDRESS, default="") or "").strip(),
        "note": (_at(raw, _ITEM_NOTE, default="") or "").strip(),
        "lat": lat,
        "lng": lng,
        "cid": cid,
        "mid": _at(meta, _META_MID),
        "lists": [lid],
    }


def parse_list(lid: str, raw: list) -> tuple[dict, list[dict]]:
    items = _at(raw, _LIST_ITEMS, default=[])
    places = [p for p in (parse_place(item, lid) for item in items) if p]
    meta = {
        "id": lid,
        "name": _at(raw, _LIST_NAME, default=lid),
        "description": (_at(raw, _LIST_DESC, default="") or "").strip(),
        "emoji": _at(raw, _LIST_EMOJI, default=""),
        "owner": _at(raw, _LIST_OWNER, 0, default=""),
        "url": f"https://www.google.com/maps/placelists/list/{lid}",
        "count": len(places),
    }
    return meta, places


# -------------------------------------------------------------------- merging


def place_key(place: dict) -> str:
    """Identity for cross-list dedup.

    The same restaurant saved to two lists must collapse to one row carrying
    both tags, or a search for it returns visual duplicates. CID is the real
    identifier; name+coords is the fallback for the rare place that has none.
    """
    if place["cid"]:
        return f"cid:{place['cid']}"
    return f"nm:{place['name'].casefold()}@{place['lat']},{place['lng']}"


def build(links: list[str]) -> dict:
    lists: list[dict] = []
    merged: dict[str, dict] = {}
    order: list[str] = []

    seen_lists: set[str] = set()

    for link in links:
        lid = list_id(link)
        # Maps hands out a fresh short link every time you share, so the same
        # list pasted twice arrives as two different URLs. Without this they
        # would both be fetched and both appear in `lists`, giving two entries
        # with one slug -- and `/that-slug` would then mean whichever came last.
        if lid in seen_lists:
            print(f"  · duplicate of a list already fetched, skipping: {link}")
            continue
        seen_lists.add(lid)

        raw = fetch_complete(lid)
        meta, places = parse_list(lid, raw)
        print(f"  {meta['emoji'] or '·'} {meta['name']} -- {len(places)} places")
        lists.append(meta)
        for place in places:
            key = place_key(place)
            if key in merged:
                if lid not in merged[key]["lists"]:
                    merged[key]["lists"].append(lid)
            else:
                merged[key] = place
                order.append(key)
        # The endpoint sheds load rather than rate-limiting outright -- it
        # answers 200 with a stub - so pacing is what keeps the data whole.
        time.sleep(1.0)

    owners = {meta["owner"] for meta in lists if meta["owner"]}
    return {
        "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "owner": sorted(owners)[0] if len(owners) == 1 else "",
        "lists": lists,
        "places": [merged[key] for key in order],
    }


def read_links() -> list[str]:
    if not LISTS_TXT.exists():
        raise FetchError(f"{LISTS_TXT} not found")
    links = []
    for line in LISTS_TXT.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#"):
            links.append(line)
    if not links:
        raise FetchError(f"{LISTS_TXT} has no links")
    return links


def main() -> int:
    try:
        links = read_links()
        print(f"fetching {len(links)} lists")
        data = build(links)
    except (FetchError, urllib.error.URLError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    OUT.parent.mkdir(parents=True, exist_ok=True)

    # Carry the old timestamp forward when nothing else moved. `generated`
    # changes on every run by definition, so without this the daily refresh
    # would produce a commit every day whose entire content is a new date --
    # and the deploy that commit triggers would ship byte-identical places.
    if OUT.exists():
        try:
            previous = json.loads(OUT.read_text(encoding="utf-8"))
        except ValueError:
            previous = None
        if previous and {k: v for k, v in previous.items() if k != "generated"} == {
            k: v for k, v in data.items() if k != "generated"
        }:
            data["generated"] = previous.get("generated", data["generated"])
            print("  (unchanged)")

    # Sorted keys and a trailing newline keep the diff to what actually changed.
    OUT.write_text(
        json.dumps(data, ensure_ascii=False, indent=1, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(f"\n{len(data['places'])} places across {len(data['lists'])} lists -> {OUT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

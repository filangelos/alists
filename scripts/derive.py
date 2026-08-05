"""Everything the page needs that Google does not say.

Google hands back a name, an address, a point and nothing else -- no type, no
neighbourhood, no country. The page browses places as a tree of city then
category, and neither of those levels exists in the payload, so both are worked
out here and written into `data/lists.json`.

Derived in the fetcher rather than in the browser on purpose. A guess that is
wrong should be *visible* -- it lands in the committed JSON where it shows up in
a diff, can be read without opening devtools, and can be corrected by hand
against `OVERRIDES` below. Doing it at load time would hide every one of those.

Four tables are meant to be edited, and nothing else in this file is:

    CATEGORIES  the second level of the tree. Adding one -- "Museums",
                "Bakery", "Markets" -- is one entry, in the order you want it
                matched. Nothing else changes.
    MARKS       lists that say something about the places on them rather than
                where or what they are. One entry, and the page grows a button.
    CITIES      display names for lists whose own name is a private joke, and
                the groups of lists that are really one place.
    COUNTRIES   which country each city is in, for the flag in front of it.

Stdlib only, like the fetcher that imports it.
"""

from __future__ import annotations

import collections
import math
import re
import statistics
import sys
import unicodedata
from typing import NamedTuple


class Category(NamedTuple):
    """One node of the tree's second level.

    `lists` names the Maps lists that *are* this category; membership in one is
    authoritative and beats every pattern below, because it is a judgement the
    owner actually made.

    The two pattern fields are the guess, and they are separated because venue
    words differ in how much they can be trusted inside a name:

    `strong` is trusted anywhere. "Museum", "Cathedral", "Bakery" name what a
    place *is* wherever they appear.

    `weak` is trusted only when the address does not begin with a street
    number. "Garden", "Square", "Market" and "Park" are as often part of an
    address a restaurant was named after -- Covent Garden, Golden Square -- as
    they are the thing itself, and a place with a street number in front of it
    is a venue on a street rather than the street. Without that gate,
    `Dishoom Covent Garden` files under Outdoors.
    """

    key: str
    label: str
    emoji: str
    lists: tuple[str, ...] = ()
    strong: str = ""
    weak: str = ""


# Order is match order: the first category that claims a place keeps it. That
# matters where a place is on two of the owner's lists (La Cabra is both
# `Coffee` and `Baker`) and where two patterns could both fire, so the list
# reads roughly most-specific first.
#
# `Other` is not in this table. It is what a place gets when nothing here
# matches, and it is deliberately not a category you can tune -- see `classify`.
CATEGORIES: tuple[Category, ...] = (
    Category(
        "coffee", "Coffee", "☕️",
        lists=("Coffee",),
        strong=r"coffee|caff[eè]|caffe|caf[eé]\b|cafe\b|kafene|espresso|roaster|roastery|καφε",
    ),
    Category(
        "bakery", "Bakery", "🥖",
        lists=("Baker",),
        strong=r"baker|bakery|bakehouse|boulangerie|patisserie|p[aâ]tisserie|pastisseria"
               r"|pasticceria|konditorei|φουρν|ζαχαροπλαστ|viennoiserie",
    ),
    Category(
        "gelato", "Gelato", "🍦",
        lists=("Gelato",),
        strong=r"gelat|ice cream|sorbet|παγωτ|glacier\b",
    ),
    Category(
        "food", "Food", "🥙",
        lists=("Food", "Pizza"),
        strong=r"restaurant|ristorante|trattoria|osteria|taverna|tavern[ae]?\b|ταβερν|εστιατ"
               r"|ψησταρ|τσιπουρ|ουζερ|souvlaki|σουβλα|grill|bbq|barbecue|steak|churrasc"
               r"|kitchen|bistro|brasserie|diner|eatery|canteen|deli\b|delicatessen|noodle"
               r"|ramen|sushi|izakaya|yakitori|dim sum|hawker|pizzer|pizza|napoletana|burger"
               r"|taqueria|taco|kebab|shawarma|falafel|curry|dumpling|seafood|oyster|paella"
               r"|tapas|meze\b|smokehouse|rotiss|sandwich|bagel|creperie|cr[eê]pe|\bfood\b",
    ),
    Category(
        "drinks", "Drinks", "🍸",
        lists=("Bar", "Wine", "Pub"),
        strong=r"cocktail|speakeasy|taproom|tap room|brewery|brauerei|beer|bier|birra|\bpub\b"
               r"|ale house|wine|vino|enoteca|weinbar|καβα|distiller|nightclub|jazz|μπαρ"
               r"|whisky|whiskey|mezcal|bodega|cantina|\bclub\b|\bbar\b|arms$",
    ),
    Category(
        "sights", "Sights", "🏛",
        strong=r"museum|μουσει|gallery|γκαλερ|castle|καστρ|palace|παλατ|cathedral|basilica"
               r"|church|εκκλησ|μονη|monastery|temple|mosque|synagog|ruins|acropol|amphitheat"
               r"|theatre|theater|opera house|library|βιβλιοθ|monument|memorial|statue"
               r"|cemetery|cimeti|νεκροταφ|university|aquarium|planetarium|\bzoo\b|stadium"
               r"|lighthouse|φαρος|windmill|μυλος|archaeolog|αρχαιολ",
        weak=r"square|piazza|plaza|πλατει|bridge|γεφυρ|tower|πυργ|arena|historic|college",
    ),
    Category(
        "outdoors", "Outdoors", "🌊",
        strong=r"beach|plage|playa|παραλ|\bbay\b|cove|lagoon|waterfall|falls\b|\blake\b|λιμν"
               r"|mountain|\bpeak\b|summit|gorge|canyon|cave|σπηλ|hot spring|viewpoint"
               r"|lookout|overlook|\bcliff\b|dunes|forest|botanic|trail|promenade|boardwalk"
               r"|marina|harbou?r|λιμαν",
        weak=r"\bpark\b|parc\b|parque|gardens?\b|κηπ|pier\b|\bisland\b|νησ",
    ),
    Category(
        "shops", "Shops", "🛍",
        strong=r"bookshop|bookstore|βιβλιοπωλ|pharmacy|φαρμακ|apothecary|delicatessen",
        weak=r"shops?$|\bstore\b|market|mercat|mercado|αγορα|boutique|records|vintage|grocer",
    ),
    Category(
        "stay", "Stay", "🛏",
        strong=r"hotel|ξενοδοχ|hostel|\bresort\b|\bvilla\b|\bsuites?\b|guesthouse|camping"
               r"|glamping",
    ),
)

# What a place gets when nothing above matches. Sorted last everywhere and
# never hidden: it is where the guess declined, not where the places are worse.
# Two in five places land here, and most of the best restaurants are among them,
# because a good restaurant is called `Palma`, not `Palma Restaurant`.
OTHER = Category("other", "Other", "·")


class Mark(NamedTuple):
    """A list that says something about the places on it rather than where or
    what they are.

    A city list and a category list both *file* a place: they answer the two
    questions the tree is made of. A mark answers neither. `next` is the list of
    places that have not been eaten in, drunk at or walked around yet -- they
    are real places in real cities, and the only thing they are not is
    recommended, which is the one claim every other place on this page makes.

    So a marked place is held out of the tree until the button that turns its
    mark on is pressed, and drawn with the mark's glyph in place of its bullet
    once it is. Folding them in silently would be the cheaper change and the
    wrong one: it would quietly cost the collection the only thing it says.

    `lists` names the Maps lists that carry the mark, matched on the letters and
    digits of the name -- `next`, `Next` and `next 🔜` are one intention, and
    unlike a category, which is named by this taxonomy, a mark is named by
    whoever made the list.
    """

    key: str  # what a marked place carries in the JSON, and what the URL says
    label: str  # what the button that turns it on says, and what the glyph means
    emoji: str  # drawn in front of a marked place, in place of its bullet
    lists: tuple[str, ...] = ()


# Order is display order: the buttons appear left to right in this order, and a
# place carrying two marks lists them in it.
MARKS: tuple[Mark, ...] = (
    Mark(
        "unverified", "not been yet", "○",
        lists=("next",),
    ),
)

# Names the fetcher cannot be expected to work out, and the only hand-written
# geography in the project.
#
# `label` is what the tree prints. The list's own name is a private joke often
# enough -- `Ox` is Oxford and not steak, `Cope` is Copenhagen, `The dark side`
# is Cambridge -- that a stranger cannot read the tree without this, and the
# slug is also what goes in the URL, so `Aθens` costs anyone without a Greek
# keyboard the ability to type a link at all.
#
# `merge` collapses several lists into one city. London is the reason it exists:
# it is the largest place in the collection and has no list of its own, only
# five ordering scratchpads and a neighbourhood.
CITIES: dict[str, str] = {
    "Aθens": "Athens",
    "Mηlos": "Milos",
    "μParos": "Paros",
    "Anti-μParos": "Antiparos",
    "SIRifos": "Serifos",
    "Μικρές": "Small Cyclades",
    "Mykonoos": "Mykonos",
    "Beerlin": "Berlin",
    "Cope": "Copenhagen",
    "Barca": "Barcelona",
    "Roma": "Rome",
    "NYC": "New York",
    "SF": "San Francisco",
    "D.C.": "Washington",
    "Ox": "Oxford",
    "The dark side": "Cambridge",
    "Schnitzeland": "Vienna",
    "Yale": "New Haven",
    "Niagara": "Niagara Falls",
}

MERGE: dict[str, tuple[str, ...]] = {
    "London": (
        "LON (Food)",
        "LON (Coffee)",
        "LON (Drinks)",
        "LON (1st Order)",
        "LON (2nd Order)",
        "Angel-ish",
    ),
}

# Which country each city is in, as an ISO 3166-1 alpha-2 code, for the flag the
# page prints in front of it. Codes rather than the emoji itself so the table
# stays greppable and diffable -- `flag` builds the pair of regional indicators.
#
# Stated rather than inferred, which is the opposite of how the category is
# decided one screen up, and for a reason: the address is the only thing Google
# gives that names a country, and it does not name Greece. Of the 443 places on
# the sixteen Greek islands and Athens, four mention the country; Crete's thirty
# have no address at all. So an inference would be confidently wrong about the
# half of this collection it matters most for, while the truth is 38 lines long
# and never changes for a city once written. `warn_countries` checks these
# against whatever the addresses do say, so a typo here does not go quiet.
COUNTRIES: dict[str, str] = {
    "Athens": "GR",
    "Crete": "GR",
    "Mykonos": "GR",
    "Naxos": "GR",
    "Sifnos": "GR",
    "Syros": "GR",
    "Milos": "GR",
    "Paros": "GR",
    "Antiparos": "GR",
    "Ikaria": "GR",
    "Kythira": "GR",
    "Kythnos": "GR",
    "Spetses": "GR",
    "Kea": "GR",
    "Serifos": "GR",
    "Small Cyclades": "GR",
    "London": "GB",
    "Oxford": "GB",
    "Cambridge": "GB",
    "Bristol": "GB",
    "Edinburgh": "GB",
    "New York": "US",
    "San Francisco": "US",
    "Miami": "US",
    "Washington": "US",
    "New Haven": "US",
    "Hawaii": "US",
    # The falls are the border: ten places, six with a Canadian address and four
    # with an American one. The flag follows the majority rather than pretending
    # the city is in one country.
    "Niagara Falls": "CA",
    "Vancouver": "CA",
    "Dublin": "IE",
    "Paris": "FR",
    "Berlin": "DE",
    "Vienna": "AT",
    "Copenhagen": "DK",
    "Barcelona": "ES",
    "Rome": "IT",
    "Singapore": "SG",
    "Bali": "ID",
    "Dubai": "AE",
}

# Country names as Google spells them at the end of an address, and only for the
# countries above -- this is the audit of COUNTRIES, not a second way to fill it
# in, so a name that is missing here costs a check and never a flag.
COUNTRY_NAMES: dict[str, str] = {
    "United Kingdom": "GB",
    "UK": "GB",
    "United States": "US",
    "USA": "US",
    "Greece": "GR",
    "Ελλάδα": "GR",
    "Ireland": "IE",
    "France": "FR",
    "Germany": "DE",
    "Austria": "AT",
    "Denmark": "DK",
    "Spain": "ES",
    "Italy": "IT",
    "Singapore": "SG",
    "Indonesia": "ID",
    "United Arab Emirates": "AE",
    "Canada": "CA",
}

# Per-place corrections, keyed by CID, for the handful the guess gets wrong in a
# way worth fixing by hand. Empty is the honest default: a wrong guess should be
# fixed in the patterns above where it also fixes its siblings, and only pinned
# here when it is genuinely one-of-a-kind.
OVERRIDES: dict[str, str] = {}

# A list whose members are spread wider than this is describing a kind of place
# rather than a place. Nothing branches on it -- the categories above are named
# explicitly -- but it is what `warn_unclassified` uses to notice that a list
# has been added to lists.txt and not to CATEGORIES.
CATEGORY_RADIUS_KM = 200

# How far a place with no city list of its own may sit from the city it gets
# assigned to before the assignment is marked uncertain rather than trusted.
FAR_KM = 12

EARTH_KM = 6371

_STREET_NUMBER = re.compile(r"^\s*\d")


def fold(text: str) -> str:
    """Lowercase and strip accents, matching the browser's `fold` in app.js.

    Both sides have to agree or a place typed here under one spelling stops
    being findable there under another.
    """
    decomposed = unicodedata.normalize("NFD", text or "")
    stripped = "".join(c for c in decomposed if not unicodedata.combining(c))
    return stripped.lower().replace("ς", "σ")


def slug(text: str) -> str:
    """A URL-safe token for a city or category name.

    Transliterates Greek, which `fold` deliberately does not: matching and
    addressing are different jobs. The README's promise that `anoixi` will not
    find `Άνοιξη` is about *matching* and stays true. But a slug is something a
    person retypes out of an address bar, and `#/aθens` cannot be retyped on a
    Latin keyboard at all -- which today costs 107 places any reachable link.
    """
    table = str.maketrans({
        "α": "a", "β": "v", "γ": "g", "δ": "d", "ε": "e", "ζ": "z", "η": "i",
        "θ": "th", "ι": "i", "κ": "k", "λ": "l", "μ": "m", "ν": "n", "ξ": "x",
        "ο": "o", "π": "p", "ρ": "r", "σ": "s", "τ": "t", "υ": "y", "φ": "f",
        "χ": "ch", "ψ": "ps", "ω": "o",
    })
    return re.sub(r"[^a-z0-9]+", "", fold(text).translate(table))


def flag(code: str | None) -> str:
    """The flag emoji for an ISO 3166-1 alpha-2 country code.

    A flag is two regional indicator symbols, which are the letters A-Z offset
    into their own block -- there is no table to keep current and no image to
    ship. A city with no code gets an empty string and the page prints nothing,
    which is the right failure: a missing flag reads as "not said yet", and a
    wrong one reads as a claim about where a place is.
    """
    if not code or len(code) != 2 or not code.isalpha():
        return ""
    return "".join(chr(0x1F1E6 + ord(c) - ord("A")) for c in code.upper())


def haversine(a: tuple[float, float], b: tuple[float, float]) -> float:
    d_lat = math.radians(b[0] - a[0])
    d_lng = math.radians(b[1] - a[1])
    h = (
        math.sin(d_lat / 2) ** 2
        + math.cos(math.radians(a[0])) * math.cos(math.radians(b[0])) * math.sin(d_lng / 2) ** 2
    )
    return 2 * EARTH_KM * math.asin(min(1.0, math.sqrt(h)))


# ----------------------------------------------------------------- categories

_COMPILED = [
    (
        category,
        re.compile(category.strong, re.I) if category.strong else None,
        re.compile(category.weak, re.I) if category.weak else None,
    )
    for category in CATEGORIES
]

CATEGORY_LISTS = {name for category in CATEGORIES for name in category.lists}


# ---------------------------------------------------------------------- marks


def token(name: str) -> str:
    """A list name reduced to the letters and digits in it.

    The same reduction `app.js` does to turn a list name into a slug, so a name
    matched here and a name typed into the address bar agree.
    """
    return re.sub(r"[\W_]+", "", fold(name))


_MARK_BY_TOKEN = {token(name): mark.key for mark in MARKS for name in mark.lists}


def mark_of_list(name: str) -> str | None:
    """The mark a list carries, or None if it is a place or a kind of place."""
    return _MARK_BY_TOKEN.get(token(name))


def is_city_list(name: str) -> bool:
    """Whether a list is one of the places, rather than a kind of place or a mark.

    The default, and deliberately so: a list added to lists.txt and nowhere else
    becomes a city, because that is what almost every list here is.
    """
    return name not in CATEGORY_LISTS and mark_of_list(name) is None


def warn_marks(lists: list[dict]) -> None:
    """Say so when a mark names a list that was not fetched.

    This is the one table keyed on a name nothing else validates, and getting it
    wrong fails quietly in the worst way: the list files itself as a *city*, its
    places scatter into a heading named after a to-do list, and the button that
    was the point of the exercise never appears at all. `warn_unclassified`
    would also complain about the spread, but it would name the wrong fix.
    """
    seen = {token(meta["name"]) for meta in lists}
    for mark in MARKS:
        missing = [name for name in mark.lists if token(name) not in seen]
        if missing:
            print(
                f"  ! the {mark.key!r} mark names {', '.join(repr(n) for n in missing)}, "
                f"which no list in lists.txt is called. Fix the name in MARKS in "
                f"scripts/derive.py, or add the list.",
                file=sys.stderr,
            )


def classify(place: dict, list_names: set[str]) -> str:
    """Decide which category a place belongs to.

    Three passes, in descending order of how much they can be trusted: the
    owner's own filing, then the venue words that mean what they say, then the
    ones that only mean it when the address is not a street address.

    Roughly one typed place in seven is wrong, measured against the places the
    owner had already filed by hand. That is the price of a second level
    existing at all: only one place in five carries a category the owner
    assigned, so without the guess there is nothing to branch on for the other
    four -- and no level at all for whole cities like Naxos.
    """
    if place.get("cid") and place["cid"] in OVERRIDES:
        return OVERRIDES[place["cid"]]

    for category in CATEGORIES:
        if list_names.intersection(category.lists):
            return category.key

    name = fold(place["name"])
    for category, strong, _ in _COMPILED:
        if strong and strong.search(name):
            return category.key

    if _STREET_NUMBER.match(place.get("address") or ""):
        return OTHER.key
    for category, _, weak in _COMPILED:
        if weak and weak.search(name):
            return category.key

    return OTHER.key


def warn_unclassified(lists: list[dict], members: dict[str, list[dict]]) -> None:
    """Say so when a list looks like a category but is not declared as one.

    Every list not named in CATEGORIES or MARKS becomes a city, so a new
    `Museums` list added to lists.txt and nowhere else would quietly appear as a
    place, with its members scattered across the globe under one heading. A list
    whose members span the planet is not a place, and that is cheap to notice.
    """
    for meta in lists:
        if not is_city_list(meta["name"]):
            continue
        places = [p for p in members.get(meta["id"], []) if p["lat"] is not None]
        if len(places) < 3:
            continue
        centre = (
            statistics.median(p["lat"] for p in places),
            statistics.median(p["lng"] for p in places),
        )
        spread = sorted(haversine(centre, (p["lat"], p["lng"])) for p in places)
        p90 = spread[int(0.9 * (len(spread) - 1))]
        if p90 > CATEGORY_RADIUS_KM:
            print(
                f"  ! {meta['name']!r} spans {p90:.0f} km and is being treated as a place. "
                f"If it is a kind of place, add it to CATEGORIES in scripts/derive.py.",
                file=sys.stderr,
            )


# --------------------------------------------------------------------- cities


def warn_countries(cities: list[dict], places: list[dict]) -> None:
    """Hold COUNTRIES up against whatever the addresses happen to say.

    Two things go wrong with a hand-written table: a city gets added and nobody
    fills it in, and a code gets mistyped into a real country that is the wrong
    one. The first is silent on the page -- no flag, no error -- and the second
    is worse than silent, because `IE` for Barcelona looks deliberate.

    So both are checked here rather than trusted. Only a majority disagreement
    is worth printing: Niagara Falls genuinely has addresses in two countries,
    and a warning that fires on every run is one nobody reads.
    """
    said: dict[str, collections.Counter] = collections.defaultdict(collections.Counter)
    for place in places:
        address = place.get("address") or ""
        for name, code in COUNTRY_NAMES.items():
            if re.search(rf"\b{re.escape(name)}\b", address):
                said[place["city"]][code] += 1

    for city in cities:
        name = city["name"]
        if name not in COUNTRIES:
            print(
                f"  ! {name!r} has no country. Add it to COUNTRIES in scripts/derive.py "
                f"to put a flag in front of it.",
                file=sys.stderr,
            )
            continue
        votes = said.get(name)
        if not votes:
            continue
        top, count = votes.most_common(1)[0]
        if top != COUNTRIES[name] and count * 2 > sum(votes.values()):
            print(
                f"  ! {name!r} is {COUNTRIES[name]} in COUNTRIES but {count} of its "
                f"addresses say {top}.",
                file=sys.stderr,
            )


def _city_of_list(name: str) -> str:
    for city, names in MERGE.items():
        if name in names:
            return city
    return CITIES.get(name, name)


def assign_cities(lists: list[dict], places: list[dict]) -> list[dict]:
    """Give every place exactly one city, and return the cities.

    A place's own lists decide it wherever it has one. Geography does not
    overlap the way the lists do -- of the places on two different city lists,
    none disagree about which city they are in -- so the tree is a strict
    partition and needs none of the "first list that claims it" arbitration the
    flat view had to do.

    The 116 places on no city list at all, only on a `Coffee` or a `Food` -- or
    on nothing but a mark like `next` -- are placed by their nearest city
    centre. That is what makes them reachable: no geographic query finds them
    today, including 35 in Athens.
    """
    by_id = {meta["id"]: meta for meta in lists}
    members: dict[str, list[dict]] = {meta["id"]: [] for meta in lists}
    for place in places:
        for lid in place["lists"]:
            if lid in members:
                members[lid].append(place)

    warn_unclassified(lists, members)

    # Smallest list wins, so a place on both `Sifnos` and a wider list lands in
    # the more specific one.
    def city_from_lists(place: dict) -> str | None:
        owned = [
            by_id[lid] for lid in place["lists"]
            if lid in by_id and is_city_list(by_id[lid]["name"])
        ]
        if not owned:
            return None
        owned.sort(key=lambda meta: len(members[meta["id"]]))
        return _city_of_list(owned[0]["name"])

    for place in places:
        place["city"] = city_from_lists(place)

    centres: dict[str, tuple[float, float]] = {}
    for name in {p["city"] for p in places if p["city"]}:
        pts = [p for p in places if p["city"] == name and p["lat"] is not None]
        if pts:
            centres[name] = (
                statistics.median(p["lat"] for p in pts),
                statistics.median(p["lng"] for p in pts),
            )

    for place in places:
        if place["city"] or place["lat"] is None or not centres:
            continue
        nearest = min(centres, key=lambda c: haversine(centres[c], (place["lat"], place["lng"])))
        place["city"] = nearest
        if haversine(centres[nearest], (place["lat"], place["lng"])) > FAR_KM:
            # Assigned but not confidently: the page marks these rather than
            # pretending the guess is as good as a list the owner wrote.
            place["far"] = True

    # Biggest first. The order the lists happen to sit in lists.txt is the one
    # thing here that means nothing to a reader, and alphabetical buries London
    # -- 19% of the collection -- in the middle. Size descending makes the first
    # screen say what the collection actually is.
    counts = collections.Counter(p["city"] for p in places if p["city"])

    cities = []
    for name in sorted(counts, key=lambda n: (-counts[n], fold(n))):
        pts = [p for p in places if p["city"] == name]
        located = [p for p in pts if p["lat"] is not None]
        cities.append({
            "key": slug(name),
            "name": name,
            "count": len(pts),
            # Written out rather than looked up in the browser, for the same
            # reason the city is: it is a judgement, and a judgement belongs in
            # the diff.
            "flag": flag(COUNTRIES.get(name)),
            # The centre is what a future `/near <city>` sorts from, so it is
            # written out rather than recomputed in the browser.
            "lat": round(statistics.median(p["lat"] for p in located), 6) if located else None,
            "lng": round(statistics.median(p["lng"] for p in located), 6) if located else None,
        })

    warn_countries(cities, places)
    return cities


# ---------------------------------------------------------------------- entry


def derive(data: dict) -> dict:
    """Add `city`, `type` and any marks to every place, and the indexes the page reads."""
    by_id = {meta["id"]: meta for meta in data["lists"]}

    warn_marks(data["lists"])
    cities = assign_cities(data["lists"], data["places"])

    for place in data["places"]:
        names = {by_id[lid]["name"] for lid in place["lists"] if lid in by_id}
        place["type"] = classify(place, names)
        # Written only when there is one, like `far`: absent is the ordinary
        # case for all but a handful of places, and a key repeated 1600 times to
        # say `false` is 1600 lines of diff that never change.
        carried = {mark_of_list(name) for name in names}
        marks = [m.key for m in MARKS if m.key in carried]
        if marks:
            place["marks"] = marks

    used = {p["type"] for p in data["places"]}
    marked = {key for p in data["places"] for key in p.get("marks", ())}
    data["cities"] = cities
    # `lists` travels with the category so the page can resolve the slugs the
    # lists used to answer to -- `/baker` still means the bakeries -- without a
    # second copy of the taxonomy living in app.js.
    data["categories"] = [
        {"key": c.key, "name": c.label, "emoji": c.emoji, "lists": list(c.lists)}
        for c in (*CATEGORIES, OTHER)
        if c.key in used
    ]
    # Only the marks that actually claimed a place, so the page draws a button
    # for a mark that means something and no button for one that is declared and
    # empty -- a toggle that turns nothing on is worse than no toggle.
    data["marks"] = [
        {"key": m.key, "label": m.label, "emoji": m.emoji, "lists": list(m.lists)}
        for m in MARKS
        if m.key in marked
    ]

    typed = sum(1 for p in data["places"] if p["type"] != OTHER.key)
    print(
        f"  {len(cities)} cities · {len(data['categories'])} categories · "
        f"{typed}/{len(data['places'])} typed"
    )
    for mark in data["marks"]:
        held = sum(1 for p in data["places"] if mark["key"] in p.get("marks", ()))
        print(f"  {mark['emoji']} {held} {mark['label']}")
    return data

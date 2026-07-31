-- Raw events, append-only, and deliberately not aggregated at write time: what
-- a dashboard should show is a decision for later, and rolling up on the way in
-- is the one thing that cannot be undone.
--
-- Note what is absent. No IP, no cookie, no visitor id, no search text. That is
-- what keeps this side of a consent banner, and it is also why an attacker who
-- fills the table has stolen nothing -- the worst case is noise in a count.
CREATE TABLE IF NOT EXISTS events (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,

  -- Server clock, always. Client clocks are wrong when they are honest and
  -- worse when they are not, and an attacker who picks their own timestamp can
  -- backdate rows into a window you have already looked at and stopped
  -- checking. `at` being ours is what makes an attack a contiguous range you
  -- can delete in one statement.
  at      INTEGER NOT NULL,

  kind    TEXT    NOT NULL CHECK (kind IN ('view', 'search', 'open')),

  -- '/london' or '/london/coffee'. Validated against the real city and category
  -- keys before it gets here, so this column holds no string the site could not
  -- itself have produced.
  path    TEXT,

  -- For 'open', the place name -- checked against the 1651 real ones. For
  -- 'search', a result-count bucket. For 'view', null. Every value in this
  -- column comes from a closed set, which is what makes it safe to render.
  label   TEXT,

  -- Referrer host only. Full referrer URLs carry other people's query strings.
  ref     TEXT,
  country TEXT,
  agent   TEXT    NOT NULL DEFAULT 'other' CHECK (agent IN ('bot', 'mobile', 'desktop', 'other')),

  -- Reserved, and null until you decide you want daily uniques. The only
  -- honest way to fill it without storing anything identifying is a hash of
  -- IP+UA under a salt that rotates daily and is never written down, so that
  -- yesterday's hashes cannot be recomputed. Left here so that adding it later
  -- is a decision rather than a migration.
  visitor TEXT
);

CREATE INDEX IF NOT EXISTS events_at      ON events (at);
CREATE INDEX IF NOT EXISTS events_kind_at ON events (kind, at);
CREATE INDEX IF NOT EXISTS events_path    ON events (path) WHERE path IS NOT NULL;

-- One row per day per endpoint, incremented before each insert. This is the
-- backstop that makes the free tier a wall rather than a bill: past the cap the
-- Worker stops writing, so the worst an attacker buys is one ruined day, and
-- the day after starts clean without anyone waking up to fix it.
--
-- `day` is '2026-07-31' for events and 'rec:2026-07-31' for recommendations,
-- because they are different volumes with different ceilings and one filling up
-- must not stop the other. Events keep the bare date: their rows predate this
-- and a renamed key would restart the count mid-day.
CREATE TABLE IF NOT EXISTS counters (
  day TEXT PRIMARY KEY,
  n   INTEGER NOT NULL
);

-- Places other people think should be on a list. Nothing here reaches the site:
-- a recommendation becomes a place by being added in Google Maps by hand, and
-- the daily refresh finds it the way it finds everything else. So this table is
-- an inbox, not a staging area.
--
-- Note what `state` cannot be. There is no 'kept': a recommendation that has
-- been taken up is one whose CID is in data/lists.json, and the review page
-- works that out by reading the site rather than by being told. Recording it
-- here as well would be a second copy of a fact the collection already holds,
-- and two copies of a fact are two facts as soon as one of them is wrong.
--
-- It is also the one table in this repo that holds strings a stranger chose --
-- `note`, `who`, and `name` when it came out of a pasted URL's own path. There
-- is no way to make free text not be free text; what there is instead is
-- nowhere for it to go. It is never rendered into the public site, and the one
-- page that renders it at all runs under a CSP with no script source.
--
-- `url` is the exception and is deliberately not what anyone pasted: the Worker
-- parses one identifier out of the link -- a CID or a place id, both bounded
-- tokens -- and rebuilds the URL from it. So the column that gets clicked can
-- only ever hold a Google Maps link this repo's own code wrote.
CREATE TABLE IF NOT EXISTS suggestions (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,

  -- Server clock, always, for the same reason as events.at: an attacker who
  -- picks their own timestamp can backdate rows into a window you have already
  -- looked at and stopped checking.
  at      INTEGER NOT NULL,

  state   TEXT    NOT NULL DEFAULT 'new' CHECK (state IN ('new', 'passed')),

  -- When it was passed on, and null while it is still waiting. There is no
  -- column for when it was added to a list, because nothing here finds out:
  -- the place simply turns up in the collection.
  decided INTEGER,

  -- Rebuilt, never pasted. See above.
  url     TEXT    NOT NULL,

  -- The identity, when the link carried one. `cid` is what data/lists.json
  -- holds too, which is what lets a suggestion be recognised as already saved.
  cid     TEXT,
  mid     TEXT,
  lat     REAL,
  lng     REAL,

  -- Free text, all three, and bounded to 80/240/40 characters.
  name    TEXT,
  note    TEXT,
  who     TEXT,

  -- Where they were standing on the site. Checked against the same closed set
  -- of city and category keys as events.path, so this column holds no page the
  -- site does not have.
  path    TEXT,

  country TEXT,
  agent   TEXT    NOT NULL DEFAULT 'other' CHECK (agent IN ('bot', 'mobile', 'desktop', 'other'))
);

-- The review page's only query, and the only index it needs: what is waiting,
-- newest first.
CREATE INDEX IF NOT EXISTS suggestions_state ON suggestions (state, id DESC);

-- Two people recommending the same place is one decision with two reasons, so
-- the review page groups by CID. This is what makes that cheap.
CREATE INDEX IF NOT EXISTS suggestions_cid   ON suggestions (cid) WHERE cid IS NOT NULL;

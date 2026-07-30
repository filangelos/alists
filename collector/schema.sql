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

-- One row per day, incremented before each insert. This is the backstop that
-- makes the free tier a wall rather than a bill: past the cap the Worker stops
-- writing, so the worst an attacker buys is one ruined day of counts, and the
-- day after starts clean without anyone waking up to fix it.
CREATE TABLE IF NOT EXISTS counters (
  day TEXT PRIMARY KEY,
  n   INTEGER NOT NULL
);

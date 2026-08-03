/* alists -- every saved place as a tree of city then category.
 *
 * The lists are how the places are organised in Google Maps, which is not how
 * anyone else would look for them: half the names are private jokes and the
 * biggest place in the collection, London, has no list at all. So the fetcher
 * works out a city and a category for every place (scripts/derive.py) and this
 * browses that instead -- two levels, both of which read as themselves.
 *
 * It used to browse them through a prompt: one input at the bottom, a slash
 * grammar for paths, a completion menu over it. That is a fine interface for
 * whoever wrote the grammar and a wall for everyone else -- a page of saved
 * restaurants should not open by asking you to learn a command line. So the
 * same model is driven now by the things the grammar was only ever describing:
 * a trail saying where you are standing, rows you click to go deeper, a back
 * button and the browser's own back button to come out again, and a search box
 * that is nothing but a search box.
 *
 * The query itself did not change. The hash still holds `/london/coffee flat
 * white`, so every link ever shared still resolves and the address bar is
 * still the share button -- it is written by clicks now rather than by typing.
 */

(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  /* The collector, named once in index.html because count.js needs the same
     address. Empty here means a fork that has not deployed one -- in which
     case there is no recommend button at all, rather than a button that posts
     into somebody else's database. */
  const COLLECTOR = (() => {
    const meta = document.querySelector('meta[name="alists-collector"]');
    const url = meta ? (meta.getAttribute('content') || '').trim() : '';
    return url && url.indexOf('YOUR-SUBDOMAIN') === -1 ? url.replace(/\/+$/, '') : '';
  })();

  /* A backstop, not a paging scheme. The tree can only ever render the 1649
     places plus their headers, so this is unreachable in practice -- it exists
     so a bug in the expansion rule degrades to a slow page rather than a hung
     one. */
  const MAX_ROWS = 6000;

  /* The change list: everything saved in the last seven days. The file can say
     that at all only because `scripts/fetch.py` writes down the day it first
     saw each place -- Google's payload has no such date, so `added` is the day
     a place turned up in a refresh rather than the day it was starred.

     Seven days measured from `generated`, not from the visitor's clock. The
     file cannot know about anything that happened after the refresh that wrote
     it, so a page sitting on a fortnight-old blob should still show that blob's
     last week rather than quietly emptying the list to prove the clock moved.

     `from` is the first day in the window and is inclusive; empty means the
     data carries no dates at all, which is what a fork's first refresh
     produces and is why every path here is guarded on `week.count`. */
  const WEEK_DAYS = 7;
  const WEEK_EMOJI = '◷';
  const WEEK_LABEL = 'new this week';
  let week = { from: '', count: 0 };

  const isRecent = (place) => !!week.from && !!place.added && place.added >= week.from;

  let DATA = { lists: [], places: [], cities: [], categories: [], marks: [] };
  let TREE = []; // cities, each holding categories, each holding places
  let cityByKey = new Map();
  let catByKey = new Map();
  let markByKey = new Map();
  let pathTokens = new Set(); // every token that can name a city or a category
  let markTokens = new Map(); // token -> mark key, for `/unverified` and `/next`

  let view = []; // rows currently rendered, in order
  let active = -1; // index into `view`, or -1 for nothing selected

  // ------------------------------------------------------------------ text

  /* Fold accents and case so `cafe` finds `Café` and `ανοιξη` finds `Άνοιξη`.
     Greek and Latin both decompose to a base letter plus combining marks under
     NFD, so one strip covers both alphabets. It does not transliterate and is
     not meant to: `anoixi` will not find `Άνοιξη`, and typing the Greek is the
     only way to reach a Greek name. Slugs are the exception and are
     transliterated in the fetcher -- addressing and matching are different
     jobs, and a slug is something a person retypes out of an address bar.

     Final sigma folds onto the medial one: it is the same letter spelled by
     position, and `toLowerCase` applies that rule too, so `ΟΔΟΣ` lowercases to
     `οδοσ` while `Οδός` is already `οδός`. Without this the two spellings of
     one street fold apart and only one of them answers a search for it. */
  const fold = (s) =>
    (s || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/\u03c2/g, '\u03c3');

  const escapeHtml = (s) =>
    s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const tokens = (s) => fold(s).split(/[^\p{L}\p{N}]+/u).filter(Boolean);

  /* Fold `text` while keeping the way back to it: `starts[i]` and `ends[i]` are
     the bounds, in the original, of the character that produced folded position
     `i`. Latin and Greek fold one-for-one, but the rest of the world does not --
     NFD expands a Hangul syllable into three jamo and a voiced kana into a base
     plus U+3099, none of which are the combining marks `fold` strips. Slicing
     the original at an offset found in the folded string would then mark the
     wrong characters, so every offset is translated back through these. */
  function foldIndexed(text) {
    let hay = '';
    const starts = [];
    const ends = [];
    let at = 0;
    for (const char of text) {
      const folded = fold(char);
      for (let i = 0; i < folded.length; i++) {
        starts.push(at);
        ends.push(at + char.length);
      }
      hay += folded;
      at += char.length;
    }
    return { hay, starts, ends };
  }

  /* Mark every query token inside `text`, matching on the folded string and
     slicing the original, so the accented spelling survives into the page. A
     span always covers whole characters of the original -- half of a decomposed
     syllable is not something that can be marked. */
  function highlight(text, words) {
    if (!text) return '';
    if (!words.length) return escapeHtml(text);
    const { hay, starts, ends } = foldIndexed(text);
    const spans = [];
    for (const word of words) {
      let from = 0;
      for (;;) {
        const at = hay.indexOf(word, from);
        if (at === -1) break;
        spans.push([starts[at], ends[at + word.length - 1]]);
        from = at + word.length;
      }
    }
    if (!spans.length) return escapeHtml(text);
    spans.sort((a, b) => a[0] - b[0]);
    const merged = [spans[0]];
    for (const span of spans.slice(1)) {
      const last = merged[merged.length - 1];
      if (span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
      else merged.push(span);
    }
    let out = '';
    let cursor = 0;
    for (const [start, end] of merged) {
      out += escapeHtml(text.slice(cursor, start));
      out += '<mark>' + escapeHtml(text.slice(start, end)) + '</mark>';
      cursor = end;
    }
    return out + escapeHtml(text.slice(cursor));
  }

  // ----------------------------------------------------------------- state

  /* Everything the page knows: the node you are standing in, what you typed in
     the search box, whether distances are on, and which marks are folded in.
     `path` is canonical -- at most a city key and a category key, in that
     order -- so the trail, the URL and the tree all read the same two slots.

     `marks` is in here rather than beside it because it belongs in the URL: a
     link to the places worth going and a link to those plus the ones nobody has
     been to yet are two different pages, and the address bar is this page's
     only share button.

     `recommend` is in here for the same reason as `marks`, and more so: it is
     a view rather than a lens -- the form stands where the tree was -- and
     `/athens /recommend` is a link that means "recommend me somewhere in
     Athens", which a dialog could not be.

     `recent` is the change list, and is in the URL for the same reason: "the
     places saved this week" is a page worth sending somebody, and `/london
     /new` is the same sentence about one city.

     Nothing about what is *expanded* lives here. See `expanded`. */
  let state = { path: [], text: '', near: false, marks: [], recent: false, recommend: false };

  /* Twisties are a peek, not a place. They are held outside `state` and outside
     the URL, and thrown away the moment the query changes, because a shared
     link has to arrive at the same page for the sender and the receiver -- and
     "which folders happened to be open" is the one thing a URL cannot carry
     without either bloating or lying. What the tree does by default is a pure
     function of the query, exactly as before; this only records disagreements
     with it, keyed by row. */
  const expanded = new Map();

  /* A query is a path, a `near` flag and words -- and it arrives as text
     because it arrives out of the hash, where the old prompt left it. Path
     segments are matched against city and category tokens, which include every
     slug the lists used to have, so `/nyc`, `/baker` and `/aθens` all still
     resolve and every link shared before this change still works. A segment
     that names nothing becomes search text rather than being silently dropped,
     so a typo narrows to nothing visibly instead of being ignored. */
  function parseQuery(raw) {
    const path = [];
    const rest = [];
    const marks = new Set();
    let near = false;
    let recent = false;
    let recommend = false;

    for (const part of raw.trim().split(/\s+/)) {
      if (!part) continue;
      if (part.startsWith('/')) {
        for (const seg of part.split('/')) {
          if (!seg) continue;
          const key = fold(seg);
          if (key === 'near') near = true;
          // Dropped rather than kept when there is nowhere to send it, so a
          // link to a form this deploy does not have lands on the tree.
          else if (key === 'recommend') recommend = !!COLLECTOR;
          // Dropped for the same reason, and it is the same reason the button
          // is absent: a link to a week in which nothing was saved would
          // otherwise land on an empty tree with no pressed chip to explain it.
          // `/recent` is spelled out because it is the word the button is
          // about; `/new` is what the URL is written in.
          else if (key === 'new' || key === 'recent') recent = week.count > 0;
          // `/all-lists` was the old way back to the root. The trail is that
          // now, but links with it in them still have to land somewhere sane.
          else if (key === 'all-lists') continue;
          // Before the path, because a mark is named from its own token set:
          // `/unverified` and `/next` both mean the same button pressed.
          else if (markTokens.has(key)) marks.add(markTokens.get(key));
          else if (pathTokens.has(key)) path.push(key);
          else rest.push(seg);
        }
      } else {
        rest.push(part);
      }
    }
    return {
      path: canonical(path),
      text: rest.join(' '),
      near,
      recent,
      recommend,
      marks: markOrder(marks),
    };
  }

  // Kept in the order the fetcher declared them, so two links to the same view
  // spell it the same way whichever button was pressed first.
  const markOrder = (keys) => DATA.marks.map((m) => m.key).filter((k) => keys.has(k));

  const serialize = (s) =>
    [
      s.path.length ? '/' + s.path.join('/') : '',
      s.marks.length ? '/' + s.marks.join('/') : '',
      s.recent ? '/new' : '',
      s.near ? '/near' : '',
      s.recommend ? '/recommend' : '',
      s.text.trim(),
    ]
      .filter(Boolean)
      .join(' ');

  /* Resolve a path into the city and category it names. Either may be absent,
     and a category may be given without a city (`/coffee` is every coffee
     place everywhere), because the two levels are named from disjoint token
     sets and so the order they are typed in cannot be ambiguous. */
  function resolvePath(path) {
    let city = null;
    let cat = null;
    for (const token of path) {
      if (!city && cityByKey.has(token)) city = cityByKey.get(token);
      else if (!cat && catByKey.has(token)) cat = catByKey.get(token);
    }
    return { city, cat };
  }

  // Aliases resolve to the same nodes as the real slugs, so a path read out of
  // an old link is rewritten to the one the trail will show and the URL will
  // hold. `/nyc/pizza` becomes `/newyork/food` once, on arrival, rather than
  // being translated again at every place it is read.
  function canonical(path) {
    const { city, cat } = resolvePath(path);
    return [city && city.key, cat && cat.key].filter(Boolean);
  }

  /* Score a place against the words. Returns -1 for no match. Every word has to
     land somewhere, but where it lands decides the rank inside its own folder:
     a name match beats an address match.

     `_rest` deliberately no longer contains the city name -- see `prepare`. */
  function score(place, words) {
    if (!words.length) return 0;
    let total = 0;
    for (const word of words) {
      const inName = place._name.indexOf(word);
      if (inName === 0) total += 100;
      else if (inName > 0) total += place._nameWords.has(word) ? 70 : 50;
      else if (place._rest.includes(word)) total += 10;
      else return -1;
    }
    return total;
  }

  // -------------------------------------------------------------- location

  /* The origin distance is measured from. Today the toggle always means "me",
     but everything downstream reads this object rather than the browser's
     position directly, so pointing it at somewhere else -- a city the person
     names, a hotel they are staying in -- is a new branch in `resolveOrigin`
     and nothing more. Every city already carries its centre in
     data/lists.json for exactly that. */
  const origin = { state: 'idle', at: null, label: '', error: '' };

  const EARTH_KM = 6371;
  const rad = (deg) => (deg * Math.PI) / 180;

  /* Great-circle distance. Not road distance -- the point is to rank places by
     roughly how far they are, and "as the crow flies" orders a neighbourhood
     correctly while needing no network call per place. */
  function haversine(a, b) {
    const dLat = rad(b.lat - a.lat);
    const dLng = rad(b.lng - a.lng);
    const h =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  const formatKm = (km) =>
    km < 1 ? `${Math.round(km * 1000)} m` : km < 10 ? `${km.toFixed(1)} km` : `${Math.round(km)} km`;

  /* Ask for whatever `spec` names, and call `done` once it has settled.
     Location is requested only when the toggle is pressed, never on load.
     Asking an unprompted visitor where they are is the browser-permission
     equivalent of a cold call: Chrome demotes origins that do it, Safari users
     reflexively deny, and a denial is sticky -- so the one chance to ask is
     worth spending on a moment when the person has just said what they want it
     for. Nothing here throws; `origin.state` is what the UI reports. */
  function resolveOrigin(spec, done) {
    if (spec.kind === 'city') {
      const city = cityByKey.get(spec.key);
      if (city && city.lat != null) {
        origin.state = 'ready';
        origin.at = { lat: city.lat, lng: city.lng };
        origin.label = city.name;
      } else {
        origin.state = 'unavailable';
        origin.error = 'that place has no location';
      }
      done();
      return;
    }

    if (!navigator.geolocation) {
      origin.state = 'unavailable';
      origin.error = 'this browser has no location support';
      done();
      return;
    }
    origin.state = 'asking';
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        origin.state = 'ready';
        origin.at = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        origin.label = 'you';
        done();
      },
      (err) => {
        // PERMISSION_DENIED is a decision, not a fault -- say so plainly and
        // leave the results usable rather than nagging.
        origin.state = err.code === err.PERMISSION_DENIED ? 'denied' : 'unavailable';
        origin.error =
          err.code === err.PERMISSION_DENIED
            ? 'location permission denied'
            : 'could not get your location';
        done();
      },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 }
    );
  }

  const distanceTo = (place) =>
    origin.at && place.lat != null ? haversine(origin.at, place) : Infinity;

  // ----------------------------------------------------------------- lenses

  /* What the tree currently contains, once the chips have had their say. Kept
     as a pair of numbers rather than recounted at each call site because the
     header, the footer and the empty state all have to agree with the rows. */
  let shown = { places: 0, cities: 0 };
  let lensSig = null;

  /* Decide what the collection currently is: which marked places are folded
     into it, or -- when the change list is on -- only what arrived this week.

     This is not the search box wearing a different hat, and it is not done
     inside `search` for that reason: a chip changes what the collection *is*,
     so the totals a folder reports move with it. `isOpen` reads "fewer than the
     total" as "pruned by a filter, so open it and show the selection" -- and if
     the totals still counted places a button had put away, one press would
     expand every folder on the page to prove a point nobody made.

     A place is shown when every mark it carries is on. Carrying none is the
     ordinary case and is why the fast path exists at all: a category with
     nothing marked in it hands back the array it already had.

     The change list replaces that rule rather than narrowing it, and the marks
     stop applying while it is on. Nearly everything saved in a given week is
     somewhere I have not been yet -- that is what saving it means -- so a
     change list that also held those places back would answer "what arrived
     this week" with a tenth of what arrived. They keep their hollow bullet,
     which is the honest way to show them: the row still says it is a place I
     have not been to, the week still says it is new. */
  function applyLenses() {
    const sig = state.recent ? 'new' : state.marks.join(',');
    if (sig === lensSig) return;
    lensSig = sig;

    const on = new Set(state.marks);
    const visible = state.recent
      ? isRecent
      : (place) => !place.marks || place.marks.every((key) => on.has(key));
    shown = { places: 0, cities: 0 };

    for (const city of TREE) {
      let total = 0;
      for (const cat of city.cats) {
        cat.visible = state.recent || cat.marked ? cat.places.filter(visible) : cat.places;
        cat.total = cat.visible.length;
        total += cat.total;
      }
      city.total = total;
      shown.places += total;
      if (total) shown.cities += 1;
    }
  }

  // ------------------------------------------------------------------ search

  /* Walk the tree keeping only what matches, and count what survives.
     Counts are matches-beneath rather than totals: a header that contradicts
     the rows under it is worse than no header at all.

     `near` sorts rather than filters. It reorders cities by how close their
     nearest surviving place is and reorders places within their category, so
     the structure holds and the nearest thing floats to the top of it. A place
     with no coordinates sorts last instead of disappearing -- it is still a
     place you saved. */
  function search() {
    const { city: onCity, cat: onCat } = resolvePath(state.path);
    const words = state.text.trim().split(/\s+/).map(fold).filter(Boolean);
    const sorting = state.near && origin.state === 'ready';

    const cities = [];
    let matches = 0;

    for (const city of TREE) {
      if (onCity && city !== onCity) continue;
      const cats = [];
      let cityCount = 0;

      for (const cat of city.cats) {
        if (onCat && cat.key !== onCat.key) continue;
        // `visible`, not `places`: whatever the marks are currently letting
        // through. Its length is already in `cat.total`, which the spread
        // below carries into the copy `isOpen` reads.
        let places = cat.visible;
        if (words.length) {
          const hits = [];
          for (const place of places) {
            const value = score(place, words);
            if (value >= 0) hits.push({ place, value });
          }
          // Stable by construction: ties keep the curated order they arrived in.
          hits.sort((a, b) => b.value - a.value);
          places = hits.map((h) => h.place);
        }
        if (!places.length) continue;
        if (sorting) {
          places = places.slice().sort((a, b) => distanceTo(a) - distanceTo(b));
        }
        cats.push({ ...cat, places, count: places.length });
        cityCount += places.length;
      }

      if (!cityCount) continue;
      matches += cityCount;
      const near = sorting ? Math.min(...cats.map((c) => distanceTo(c.places[0]))) : 0;
      cities.push({ ...city, cats, count: cityCount, near });
    }

    if (sorting) cities.sort((a, b) => a.near - b.near);

    return { cities, matches, words, onCity, onCat };
  }

  /* What is open by default is still a pure function of the query, and the
     reasons are unchanged. A node you are standing in is open because that is
     what standing there means. A node the search pruned is open because its
     count is now a selection, and hiding a selection behind a chevron makes the
     number a claim you have to click to check. And a node holding most of what
     survived is open because otherwise searching for a city answers with the
     city's name -- one row, no places, which is not an answer.

     A twisty the person actually clicked outranks all three. */
  function isOpen(id, node, standing, total) {
    if (expanded.has(id)) return expanded.get(id);
    if (standing) return true;
    if (node.count < node.total) return true;
    return total > 0 && node.count * 2 > total;
  }

  // ---------------------------------------------------------------- render

  const mapsUrl = (place) =>
    place.cid
      ? `https://maps.google.com/?cid=${place.cid}`
      : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
          place.lat != null ? `${place.lat},${place.lng}` : place.name
        )}`;

  /* Location state belongs in the footer, next to the toggle that caused it.
     A success banner over the results would restate what a pressed toggle and
     a column of distances already say, and it would push the first result down
     every time -- so the granted case says nothing at all. Only the two states
     the distances cannot express get a line. */
  function locationHint() {
    const hint = $('gl-hint');
    // Unhidden before it is written, not after: a live region that is
    // `display: none` at the moment its text changes has already missed its
    // chance to announce, whatever it looks like afterwards.
    const say = (text, warn) => {
      hint.classList.remove('is-quiet');
      hint.textContent = text;
      hint.classList.toggle('is-warn', !!warn);
    };
    if (!state.near) {
      /* The change list says which week it means, because "this week" is the
         one thing the button cannot say precisely -- the window is anchored to
         the day the data was built, which may not be today. */
      if (state.recent) {
        // Kept short enough to survive a phone's footer, where this line is
        // ellipsised: a date cut off halfway is worse than no date at all.
        say(`${WEEK_EMOJI} saved since ${week.from}`);
        return;
      }
      /* A pressed mark buys the line off the keyboard legend, because the
         glyph it just scattered through the tree is the one thing on the page
         nothing else explains -- the button says what it turns on, not what it
         looks like. Location outranks both when it has something to report,
         and the pressed button is still saying it in the meantime. */
      if (state.marks.length) {
        say(state.marks.map((key) => {
          const mark = markByKey.get(key);
          return `${mark.emoji} ${mark.label}`;
        }).join(' · '));
        return;
      }
      // Marked quiet so a phone can drop it: it is a keyboard legend, and on a
      // narrow screen it would only crowd the count into an ellipsis. It has to
      // stay in the DOM either way -- this is the line location state announces
      // from, and a screen reader cannot read a node that was never rendered.
      hint.textContent = window.matchMedia('(hover: none)').matches
        ? 'tap a city to open it'
        : '↑↓ to move · ← to go back · ↵ opens in Maps';
      hint.classList.remove('is-warn');
      hint.classList.add('is-quiet');
      return;
    }
    switch (origin.state) {
      case 'asking':
        say('waiting for your location…');
        break;
      case 'denied':
      case 'unavailable':
        // Deliberately no retry button: re-prompting is blocked by the browser
        // once denied, so the only real fix is in site settings, and a button
        // that silently does nothing is worse than a sentence that is true.
        say(`${origin.error} — usual order; re-allow in site settings`, true);
        break;
      default:
        say(`distances from ${origin.label || 'you'}`);
    }
  }

  /* The trail is the only thing on the page that says how deep you are, so it
     also has to be the way out: every step above the current one is a button,
     the root included. */
  function renderNav(onCity, onCat) {
    const crumbs = [{ label: 'All places', path: [] }];
    if (onCity) {
      crumbs.push({ label: `${onCity.flag} ${onCity.name}`.trim(), path: [onCity.key] });
    }
    if (onCat) {
      crumbs.push({
        label: `${onCat.emoji} ${onCat.name}`,
        path: onCity ? [onCity.key, onCat.key] : [onCat.key],
      });
    }

    /* The one view the tree cannot walk to, because it is not under any city:
       a category across all of them. It used to be a line in the `/` menu; now
       it is a step sideways from the same category inside one city, which is
       where you are standing when you want it -- "the coffee here" and "the
       coffee everywhere" are one click apart in both directions. */
    const sideways = onCat && onCity ? [onCat.key] : null;

    $('gl-crumbs').innerHTML =
      crumbs
        .map((crumb, i) => {
          const sep = i ? '<span class="gl-crumb-sep" aria-hidden="true">›</span>' : '';
          const label = escapeHtml(crumb.label);
          return (
            sep +
            (i === crumbs.length - 1
              ? `<span class="gl-crumb is-current" aria-current="true">${label}</span>`
              : `<button type="button" class="gl-crumb" data-path="${escapeHtml(
                  crumb.path.join('/')
                )}">${label}</button>`)
          );
        })
        .join('') +
      (sideways
        ? `<button type="button" class="gl-crumb gl-crumb-alt" data-path="${escapeHtml(
            sideways.join('/')
          )}" title="${escapeHtml(onCat.name)} in every city">everywhere</button>`
        : '') +
      // Standing there, the same word says which of the two you got.
      (onCat && !onCity ? '<span class="gl-crumb-alt is-current">everywhere</span>' : '');

    $('gl-up').disabled = !state.path.length;
    $('gl-near').setAttribute('aria-pressed', String(state.near));
    // Absent on a deploy with no collector -- see `renderChips`.
    const suggest = $('gl-suggest');
    if (suggest) suggest.setAttribute('aria-pressed', String(state.recommend));
    // Absent in a week that saved nothing, for the same reason.
    const recent = $('gl-recent');
    if (recent) recent.setAttribute('aria-pressed', String(state.recent));
    for (const chip of $('gl-chips').querySelectorAll('[data-mark]')) {
      chip.setAttribute('aria-pressed', String(state.marks.includes(chip.dataset.mark)));
      // A mark decides nothing while the change list is on -- see
      // `applyLenses` -- and a button that is still lit and still clickable
      // while it governs nothing is a control telling a small lie.
      chip.disabled = state.recent;
    }
    $('gl-clear').hidden = !state.text;
  }

  /* One button per mark the data actually has, built here rather than written
     into index.html: a mark is a table in the fetcher, and a page that hardcoded
     its button would offer to turn on a list that had been taken away. They sit
     to the left of `near me`, which was there first and is where a thumb has
     learned to look for it. */
  function renderChips() {
    const near = $('gl-near');
    // Written into index.html rather than built here, because unlike a mark it
    // does not come from the data -- but it is taken away for the same reason a
    // mark's button is only added when its list exists: a control with nothing
    // behind it is worse than no control.
    if (!COLLECTOR) $('gl-suggest').remove();

    /* Same rule, third time: no week, no button. A blob written before places
       were dated has nothing to put behind it, and a quiet week has nothing to
       show -- and "new this week (0)" is a promise the page cannot keep. It
       goes leftmost because it is the only chip that answers a question about
       time rather than about the collection, and because the two that were
       here first should stay where a thumb has learned to find them. */
    if (week.count) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.id = 'gl-recent';
      chip.className = 'gl-chip';
      chip.setAttribute('aria-pressed', 'false');
      chip.title = `Only the ${week.count} places saved since ${week.from}`;
      chip.innerHTML =
        `<span aria-hidden="true">${WEEK_EMOJI}</span> ${escapeHtml(WEEK_LABEL)}`;
      near.parentNode.insertBefore(chip, near);
    }

    for (const mark of DATA.marks) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'gl-chip';
      chip.dataset.mark = mark.key;
      chip.setAttribute('aria-pressed', 'false');
      chip.title = `Fold in the places marked ${mark.emoji} — ${mark.label}`;
      chip.innerHTML =
        `<span aria-hidden="true">${escapeHtml(mark.emoji)}</span> ${escapeHtml(mark.label)}`;
      near.parentNode.insertBefore(chip, near);
    }
  }

  /* The id is what `aria-activedescendant` on the tree points at. Focus stays
     on the container rather than moving row to row, so without it the
     selection moves silently: a screen reader would announce nothing on
     ArrowDown and Enter would open a row it had never named. */
  const rowId = (i) => `gl-row-${i}`;

  /* The guides are the depth cue, in place of an indent you would have to
     measure, and they are the one thing here borrowed from `tree` rather than
     from the window chrome. `└` closes a run so the eye can see where a city
     ends without counting rows back to the last header.

     Whatever level is on top draws no guide at all: standing inside London
     does not mean every row should carry a stem descending from a header that
     is now in the trail instead. */
  const branch = (last) => (last ? '└─ ' : '├─ ');
  const stem = (last) => (last ? '   ' : '│  ');

  function rowHtml(i, row, guide, inner, label) {
    return (
      `<div class="gl-row gl-${row.kind}" role="treeitem" id="${rowId(i)}" data-i="${i}" ` +
      `aria-level="${row.depth + 1}" aria-label="${escapeHtml(label)}"` +
      (row.folder ? ` aria-expanded="${row.open}"` : '') +
      '>' +
      (guide ? `<span class="gl-guide" aria-hidden="true">${guide}</span>` : '') +
      (row.folder
        ? `<button type="button" class="gl-twisty" data-toggle="${i}" tabindex="-1" ` +
          `aria-label="${row.open ? 'Collapse' : 'Expand'} ${escapeHtml(row.node.name)}">` +
          `${row.open ? '▾' : '▸'}</button>`
        : '') +
      inner +
      '</div>'
    );
  }

  function syncActiveDescendant() {
    const tree = $('gl-rows');
    if (active < 0) tree.removeAttribute('aria-activedescendant');
    else tree.setAttribute('aria-activedescendant', rowId(active));
  }

  function paintActive() {
    const rows = $('gl-rows').children;
    if (active < 0 || !rows[active]) return;
    rows[active].classList.add('is-active');
    rows[active].setAttribute('aria-selected', 'true');
  }

  /* `keep` is for a re-render that is not a navigation -- a twisty, a location
     that has just arrived. Selection follows the row rather than its index,
     which shifts by however many rows the twisty just added above it, and the
     scroll stays exactly where the thumb left it. */
  function render(opts = {}) {
    // Before `search`, and the only place it is called: every path into a
    // re-render passes through here, and the chips decide what there is to
    // search before the words decide what survives it.
    applyLenses();
    const result = search();
    const { cities, matches, words, onCity, onCat } = result;
    const host = $('gl-rows');
    const empty = $('gl-empty');
    const scroll = $('gl-scroll');
    const keepId = opts.keep && view[active] ? view[active].id : null;
    const keepTop = opts.keep ? scroll.scrollTop : 0;

    renderNav(onCity, onCat);
    renderCounts();
    locationHint();

    /* The form stands where the tree was rather than over it, which is what
       makes it a view: the trail above still says which city you were in when
       you pressed the button, and that is the city the form is about. Its
       fields are only hidden, never rebuilt, so walking off to check something
       and coming back does not cost you what you had typed. */
    const form = $('gl-recommend');
    if (state.recommend) {
      host.innerHTML = '';
      host.hidden = true;
      empty.hidden = true;
      form.hidden = false;
      scroll.scrollTop = 0;
      view = [];
      active = -1;
      syncActiveDescendant();
      // Nothing was searched and nothing matched; the collection is what it
      // was. The hint line goes quiet because there is no tree to explain.
      $('gl-hint').textContent = '';
      $('gl-hint').classList.remove('is-warn');
      $('gl-status').textContent = counts();
      return;
    }
    form.hidden = true;

    if (!cities.length) {
      host.innerHTML = '';
      host.hidden = true;
      empty.hidden = false;
      /* The ways out of an empty view, in the order they undo what narrowed it.
         The change list is one of them: a city with nothing new in it is the
         one dead end here that a pressed chip alone does not obviously
         explain, and the way out should be in the sentence saying so. */
      const outs = [
        state.text ? '<button type="button" data-nav="clear">clear the search</button>' : '',
        state.recent ? '<button type="button" data-nav="all">show everything saved</button>' : '',
        state.path.length ? '<button type="button" data-nav="up">go back up</button>' : '',
      ].filter(Boolean);
      empty.innerHTML =
        'nothing saved here matches. ' +
        outs.slice(0, -1).join(', ') +
        (outs.length > 1 ? ', or ' : '') +
        (outs.length ? outs[outs.length - 1] : '');
      view = [];
      active = -1;
      syncActiveDescendant();
      status(0, words);
      return;
    }

    empty.hidden = true;
    host.hidden = false;

    // Once the trail names a level, its rows are redundant -- the whole point
    // of standing somewhere is that you stop being told where you are on every
    // line. Dropping them is also what promotes the level below to the top.
    const showCity = !onCity;
    const showCat = !onCat;
    const placeGuide = (last) =>
      (showCity && showCat ? stem(last) : '') + (showCity || showCat ? '  ' : '');

    const html = [];
    const next = [];
    const push = (row) => {
      next.push(row);
      return next.length - 1;
    };
    const showDistance = state.near && origin.state === 'ready';

    for (const city of cities) {
      if (next.length >= MAX_ROWS) break;
      let cityRow = -1;

      if (showCity) {
        const id = `city:${city.key}`;
        const row = {
          kind: 'city',
          node: city,
          id,
          depth: 0,
          parent: -1,
          folder: true,
          open: isOpen(id, city, !!onCat, matches),
        };
        cityRow = push(row);
        html.push(
          rowHtml(
            cityRow,
            row,
            '',
            `<span class="gl-flag" aria-hidden="true">${escapeHtml(city.flag)}</span>` +
              `<span class="gl-name">${highlight(city.name, words)}</span>` +
              `<span class="gl-count">${city.count}</span>`,
            `${city.name}, ${city.count} place${city.count === 1 ? '' : 's'}`
          )
        );
        if (!row.open) continue;
      }

      city.cats.forEach((cat, ci) => {
        if (next.length >= MAX_ROWS) return;
        const lastCat = ci === city.cats.length - 1;
        let catRow = cityRow;

        if (showCat) {
          const id = `cat:${city.key}:${cat.key}`;
          const row = {
            kind: 'cat',
            node: cat,
            city,
            id,
            depth: showCity ? 1 : 0,
            parent: cityRow,
            folder: true,
            open: isOpen(id, cat, !!onCity, city.count),
          };
          catRow = push(row);
          html.push(
            rowHtml(
              catRow,
              row,
              showCity ? branch(lastCat) : '',
              `<span class="gl-emoji" aria-hidden="true">${escapeHtml(cat.emoji)}</span>` +
                `<span class="gl-name">${highlight(cat.name, words)}</span>` +
                `<span class="gl-count">${cat.count}</span>`,
              `${cat.name} in ${city.name}, ${cat.count} place${cat.count === 1 ? '' : 's'}`
            )
          );
          if (!row.open) return;
        }

        const guide = placeGuide(lastCat);
        for (const place of cat.places) {
          if (next.length >= MAX_ROWS) break;
          const row = {
            kind: 'place',
            node: place,
            city,
            cat,
            id: `place:${place.cid || place.mid || place.name}`,
            depth: (showCity ? 1 : 0) + (showCat ? 1 : 0),
            parent: catRow,
            folder: false,
          };
          const i = push(row);
          const km =
            showDistance && Number.isFinite(distanceTo(place))
              ? `<span class="gl-km">${formatKm(distanceTo(place))}</span>`
              : '';
          /* The bullet is the mark. A row that is here because a button put it
             here should say so where the eye already is -- in the column every
             place has a glyph in -- rather than in a badge after the name that
             would push the addresses out of line. Hollow against filled reads
             as provisional against settled at any size, and the button that
             turned it on is carrying the same glyph as its legend. */
          const mark = place.marks ? markByKey.get(place.marks[0]) : null;
          html.push(
            rowHtml(
              i,
              row,
              guide,
              (mark
                ? `<span class="gl-bullet is-mark" aria-hidden="true" ` +
                  `title="${escapeHtml(mark.label)}">${escapeHtml(mark.emoji)}</span>`
                : '<span class="gl-bullet" aria-hidden="true">●</span>') +
                '<span class="gl-body">' +
                `<span class="gl-name">${highlight(place.name, words)}</span>` +
                (place.far ? '<span class="gl-far" title="placed by its nearest city">~</span>' : '') +
                (place.address ? `<div class="gl-meta">${highlight(place.address, words)}</div>` : '') +
                (place.note ? `<div class="gl-note">${highlight(place.note, words)}</div>` : '') +
                '</span>' +
                km,
              // Said rather than drawn for whoever is listening to the row: the
              // shape of a bullet is not something a screen reader can convey.
              `${place.name}${place.address ? ', ' + place.address : ''}` +
                (mark ? `, ${mark.label}` : '')
            )
          );
        }
      });
    }

    view = next;
    host.innerHTML = html.join('');
    const kept = keepId ? view.findIndex((row) => row.id === keepId) : -1;
    active = view.length ? Math.max(0, kept) : -1;
    paintActive();
    syncActiveDescendant();
    scroll.scrollTop = keepTop;
    status(matches, words);
  }

  /* Two different numbers, because "319 matches" is not what standing in
     London means -- nothing was matched, you walked there. A search is what
     turns the count into a claim about the words. */
  function status(total, words) {
    const el = $('gl-status');
    if (words.length) {
      el.textContent = `${total} match${total === 1 ? '' : 'es'}`;
      // The only place that knows both that these words are a search and what
      // they turned up, which is the pair worth counting. The words themselves
      // stay here: they are the one thing on this page a stranger types.
      window.glCount?.search(total);
    } else if (state.path.length) el.textContent = `${total} place${total === 1 ? '' : 's'}`;
    else el.textContent = counts();
  }

  /* What the collection currently is, which is not what is in the file: a mark
     that is off is holding places back, and a header counting rows nobody can
     see is the same lie as a folder whose number disagrees with what is inside
     it. */
  const counts = () => `${shown.places} places · ${shown.cities} cities`;

  function renderCounts() {
    $('gl-subtitle').textContent = DATA.owner ? `${DATA.owner} · ${counts()}` : counts();
  }

  function setActive(next) {
    const rows = $('gl-rows').children;
    if (!rows.length) return;
    const clamped = Math.max(0, Math.min(rows.length - 1, next));
    if (rows[active]) {
      rows[active].classList.remove('is-active');
      rows[active].removeAttribute('aria-selected');
    }
    active = clamped;
    paintActive();
    rows[active].scrollIntoView({ block: 'nearest' });
    syncActiveDescendant();
  }

  // ------------------------------------------------------------ navigation

  /* One way in and out of `state`, so that a click, a key and a back button
     cannot drift apart. `push` is what separates a move through the tree --
     which the browser's back button should undo -- from a keystroke in the
     search box, which it should not: a history entry per character would bury
     the page you arrived from under thirty of them. */
  function go(next, push) {
    state = { ...state, ...next };
    // A new query gets the openness its own shape implies, not the last one's.
    expanded.clear();
    if (state.near && origin.state === 'idle') {
      resolveOrigin({ kind: 'me' }, () => render());
    }
    render();
    syncUrl(push);
  }

  function toggle(i) {
    const row = view[i];
    if (!row || !row.folder) return;
    expanded.set(row.id, !row.open);
    render({ keep: true });
  }

  /* Going into a folder is a change of path, which is why it is the row's
     primary action: it is the same event as arriving on `#/london`, produces
     the same URL, and the trail above it grows a step you can click back. */
  function drill(row) {
    if (!row || row.kind === 'place') return false;
    const { city: onCity } = resolvePath(state.path);
    const path =
      row.kind === 'city'
        ? [row.node.key]
        : [(row.city || onCity) && (row.city || onCity).key, row.node.key].filter(Boolean);
    go({ path: canonical(path), recommend: false }, true);
    return true;
  }

  function openRow(row) {
    if (!row) return;
    if (row.kind !== 'place') {
      drill(row);
      return;
    }
    // Before the tab opens, not after: on a phone the new tab is what takes
    // the process, and a beacon queued first is the one that survives it.
    window.glCount?.open(row.node.name);
    window.open(mapsUrl(row.node), '_blank', 'noopener');
  }

  /* Up is a step, not a reset: from London's coffee it goes to London, then to
     everywhere. The search survives it, because a search is a filter you are
     carrying around rather than a place you are standing in -- the clear button
     is what puts that down. */
  function up() {
    // Out of the form is the first step out, so `←` and `Esc` mean the same
    // thing here as everywhere else: leave the thing you are in.
    if (state.recommend) {
      go({ recommend: false }, true);
      return;
    }
    if (state.path.length) go({ path: state.path.slice(0, -1) }, true);
  }

  function clearSearch() {
    if (!state.text) return;
    $('gl-search').value = '';
    go({ text: '' }, false);
  }

  function toggleNear() {
    go({ near: !state.near }, false);
  }

  /* Not a history entry, for the same reason `near me` is not one: it is a
     lens on the view rather than a move through it, and the back button owes
     you the city you came from rather than the last thing you pressed. The URL
     still learns about it -- see `serialize` -- so the link you copy is the
     page you are looking at. */
  function toggleMark(key) {
    const wanted = new Set(state.marks);
    if (!wanted.delete(key)) wanted.add(key);
    go({ marks: markOrder(wanted) }, false);
  }

  /* A lens like the other two, so no history entry either -- and it keeps the
     path, which is the point: pressing it inside London is "what is new in
     London", and the trail above still says so. The form goes away because it
     is a view rather than a lens, and the two cannot both be on screen. */
  function toggleRecent() {
    go({ recent: !state.recent, recommend: false }, false);
  }

  /* A history entry, unlike the other two chips, because this one is a move
     rather than a lens: it puts the tree away, so the back button owes you the
     tree back. */
  function toggleRecommend() {
    const on = !state.recommend;
    go({ recommend: on }, true);
    if (on) focusForm();
  }

  /* Arriving at the form puts you in the form, however you arrived -- pressing
     the chip, opening a link, or walking forward into it. That is worth doing
     for its own sake, and it is also what makes `Esc` mean "leave" here: the
     key is handled by the form, so it only reaches the form if something in it
     has the focus.

     Never on touch, where focusing a field summons a keyboard over the thing it
     is meant to be filling in. */
  function focusForm() {
    if (!window.matchMedia('(hover: none)').matches) $('gl-rec-link').focus();
  }

  // ------------------------------------------------------------ recommending

  /* The one sentence on this page written by a server, so it is set as text
     and never as markup. Everything the collector says is already a whole
     sentence -- see the `SAYS` table in collector/src/suggest.js -- because the
     thing that knows what went wrong is the thing that should say it, rather
     than a code translated back into English at this end. */
  function said(text, warn) {
    const el = $('gl-rec-said');
    el.textContent = text;
    el.classList.toggle('is-warn', !!warn);
  }

  let sending = false;

  async function recommend(event) {
    event.preventDefault();
    if (sending) return;

    const link = $('gl-rec-link');
    if (!link.value.trim()) {
      said('a Google Maps link is the one thing it needs', true);
      link.focus();
      return;
    }

    sending = true;
    $('gl-rec-send').disabled = true;
    said('sending…');

    try {
      const response = await fetch(`${COLLECTOR}/recommend`, {
        method: 'POST',
        /* `text/plain` makes this a simple request, which means no preflight:
           one round trip instead of two. The body is JSON either way and the
           Worker parses it as such -- a content type is not a claim anything
           here believes. */
        headers: { 'content-type': 'text/plain;charset=UTF-8' },
        body: JSON.stringify({
          link: link.value,
          note: $('gl-rec-note').value,
          who: $('gl-rec-who').value,
          // Where they were standing, so the queue says which city a
          // recommendation was made from. Checked against the same closed set
          // of keys at the other end.
          path: state.path.length ? '/' + state.path.join('/') : null,
        }),
      });
      const answer = await response.json();

      if (!answer || !answer.ok) {
        said((answer && answer.says) || 'that did not go through', true);
      } else {
        /* Both answers are a yes. A place that is already on a list is still
           worth having been told about -- the collector keeps it either way,
           and saying so is friendlier and more use than a refusal, because it
           is the one thing the person could not have known from this page
           without going and looking. */
        said(
          answer.state === 'already'
            ? answer.name
              ? `${answer.name} is on a list already — thank you anyway`
              : 'that one is on a list already — thank you anyway'
            : answer.name
              ? `thank you — ${answer.name} is in the queue`
              : 'thank you — it is in the queue'
        );
        link.value = '';
        $('gl-rec-note').value = '';
        // `who` survives on purpose: somebody with one place to recommend
        // usually has three, and retyping their name each time is a toll.
      }
    } catch {
      said('could not reach the collector — try again in a moment', true);
    } finally {
      sending = false;
      $('gl-rec-send').disabled = false;
    }
  }

  // ------------------------------------------------------------------ url

  /* The address bar is the share mechanism: every view is a URL, so sending
     someone the bakeries you like is copy-and-paste with no extra affordance to
     find. The shape is the one the prompt used to hold, unchanged, so a link
     from before this rewrite lands on exactly the view it named. */
  function syncUrl(push) {
    const raw = serialize(state);
    const hash = raw ? '#' + encodeURIComponent(raw) : '';
    /* Counted from here because it is the one place a click, the back button
       and the first paint all pass through -- and from *above* the early
       return, which is precisely the case where someone opened a shared link
       and the URL already says where they are. It also runs on every keystroke
       in the search box, so `count.js` is what decides that thirty of those are
       still one page. */
    window.glCount?.view(state.path);
    if (hash === window.location.hash) return;
    const url = hash || window.location.pathname;
    if (push) history.pushState(null, '', url);
    else history.replaceState(null, '', url);
  }

  const queryFromUrl = () => {
    try {
      return decodeURIComponent(window.location.hash.replace(/^#/, ''));
    } catch {
      return '';
    }
  };

  /* Arriving somewhere -- on load, on a shared link, or on the back button --
     is the same event three times over, so it has one handler. `near` asks for
     a location on every one of them: the permission belongs to whoever is
     looking at the page, not to whoever sent the link. */
  function fromUrl() {
    const raw = queryFromUrl();
    if (raw === serialize(state)) return;
    const parsed = parseQuery(raw);
    state = {
      path: parsed.path,
      text: parsed.text,
      near: parsed.near,
      marks: parsed.marks,
      recent: parsed.recent,
      recommend: parsed.recommend,
    };
    expanded.clear();
    $('gl-search').value = state.text;
    if (state.near && origin.state === 'idle') {
      resolveOrigin({ kind: 'me' }, () => render());
    }
    render();
    if (state.recommend) focusForm();
    // Rewrite an alias into the slugs the trail is showing -- `/nyc/pizza` and
    // `/newyork/food` are the same view, and the address bar should agree with
    // the page about which one you are looking at. Replaced, never pushed: this
    // is the same entry, spelled the way the page spells it.
    syncUrl(false);
  }

  // -------------------------------------------------------------- wiring

  function onTreeKeydown(event) {
    const row = view[active];
    switch (event.key) {
      case 'ArrowDown':
        setActive(active + 1);
        break;
      case 'ArrowUp':
        setActive(active - 1);
        break;
      case 'Home':
        setActive(0);
        break;
      case 'End':
        setActive(view.length - 1);
        break;
      case 'ArrowRight':
        // Open it, then walk into it -- the second press is the one that moves,
        // so a closed folder never swallows the keystroke that revealed it.
        if (row && row.folder && !row.open) toggle(active);
        else if (row && row.folder) setActive(active + 1);
        break;
      case 'ArrowLeft':
        /* Close, then climb, then leave the level entirely. Read downwards it
           is one gesture -- "out" -- and it ends where the back button does. */
        if (row && row.folder && row.open) toggle(active);
        else if (row && row.parent >= 0) setActive(row.parent);
        else up();
        break;
      case 'Enter':
        openRow(row);
        break;
      case 'Escape':
        up();
        break;
      /* Backspace is deliberately absent, though every file browser binds it to
         "up": it is also how you fix a typo, and the search box it belongs to
         is one keystroke away from the tree. Left and Escape are already the
         way out; taking Backspace as a third one would cost the correction. */
      default:
        return;
    }
    event.preventDefault();
  }

  function wire() {
    const searchEl = $('gl-search');
    const tree = $('gl-rows');

    // Typing is looking for something, which is not what the form is for -- so
    // it puts the form away. Nothing is lost: the fields are hidden rather
    // than cleared, and the chip is where it was.
    searchEl.addEventListener('input', () => go({ text: searchEl.value, recommend: false }, false));
    searchEl.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        tree.focus();
        setActive(active < 0 ? 0 : active);
      } else if (event.key === 'Enter') {
        // The first row is what the words found, so Enter on it is the fastest
        // path from a name you half-remember to the pin in Maps.
        event.preventDefault();
        openRow(view[active]);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        if (state.text) clearSearch();
        else up();
      }
    });

    $('gl-clear').addEventListener('click', () => {
      clearSearch();
      searchEl.focus();
    });

    tree.addEventListener('keydown', onTreeKeydown);
    tree.addEventListener('click', (event) => {
      const twisty = event.target.closest('[data-toggle]');
      const row = event.target.closest('.gl-row');
      if (!row) return;
      // Clicking anywhere puts the arrows back in the tree, so the pointer and
      // the keyboard never end up describing two different selections.
      tree.focus({ preventScroll: true });
      setActive(Number(row.dataset.i));
      if (twisty) toggle(Number(twisty.dataset.toggle));
      else openRow(view[active]);
    });

    $('gl-up').addEventListener('click', up);
    $('gl-near').addEventListener('click', toggleNear);

    // Absent when there is no collector to send to, so both of these are
    // guarded rather than assumed.
    const suggest = $('gl-suggest');
    if (suggest) suggest.addEventListener('click', toggleRecommend);
    const form = $('gl-recommend');
    form.addEventListener('submit', recommend);
    form.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      up();
      if (suggest) suggest.focus();
    });

    // Delegated, because these buttons are built from the data: there may be no
    // marks, one, or several, and no change list at all in a quiet week.
    $('gl-chips').addEventListener('click', (event) => {
      const chip = event.target.closest('[data-mark]');
      if (chip) toggleMark(chip.dataset.mark);
      else if (event.target.closest('#gl-recent')) toggleRecent();
    });

    $('gl-crumbs').addEventListener('click', (event) => {
      const crumb = event.target.closest('[data-path]');
      if (!crumb) return;
      const path = crumb.dataset.path ? crumb.dataset.path.split('/') : [];
      go({ path: canonical(path), recommend: false }, true);
    });

    $('gl-empty').addEventListener('click', (event) => {
      const action = event.target.closest('[data-nav]');
      if (!action) return;
      if (action.dataset.nav === 'clear') clearSearch();
      else if (action.dataset.nav === 'all') toggleRecent();
      else up();
    });

    window.addEventListener('popstate', fromUrl);
    window.addEventListener('hashchange', fromUrl);

    /* A letter belongs to the search box wherever it was typed, which is the
       one thing worth keeping from the prompt -- it is also what the tree owes
       type-ahead, and filtering 1649 places is a better answer than jumping to
       the next row starting with `p`. Guarded on modifiers so browser shortcuts
       still work, on touch so a tap on a row never summons the keyboard, and on
       `defaultPrevented` so Backspace consumed by the tree is not also a
       reason to focus the field. */
    document.addEventListener('keydown', (event) => {
      if (event.target === searchEl || event.defaultPrevented) return;
      // The form is the other place on this page where a letter means itself.
      if (event.target.closest && event.target.closest('#gl-recommend')) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === '/') {
        event.preventDefault();
        searchEl.focus();
        return;
      }
      // No preventDefault: the character itself has to land in the field, and
      // the browser routes it to whatever has focus by the time it does.
      if (event.key.length === 1 || event.key === 'Backspace') searchEl.focus();
    });

    if (!window.matchMedia('(hover: none)').matches) tree.focus();
  }

  // ------------------------------------------------------------------ boot

  /* Where the change list starts, and how many places are in it. Both are
     worked out once, on load: the window is anchored to the file rather than to
     the clock, so nothing about it moves while the page is open, and the count
     is what decides whether there is a button at all.

     Dates are `YYYY-MM-DD` and are compared as strings, which is the whole
     reason for that shape -- a lexical comparison is a chronological one, and
     no timezone gets to reinterpret a day that was already agreed in UTC. */
  function openWeek(generated, places) {
    const day = (generated || '').slice(0, 10);
    const at = Date.parse(`${day}T00:00:00Z`);
    if (!Number.isFinite(at)) return { from: '', count: 0 };
    const from = new Date(at - (WEEK_DAYS - 1) * 86400000).toISOString().slice(0, 10);
    let count = 0;
    for (const place of places) {
      if (place.added && place.added >= from) count += 1;
    }
    return { from, count };
  }

  function prepare(data) {
    // Defaulted rather than assumed: a `lists.json` written before marks
    // existed has no `marks` key, and it should still open a page -- with no
    // buttons, which is the truthful thing for it to have.
    DATA = { marks: [], ...data };
    const byCity = new Map();

    for (const place of data.places) {
      // Precomputed once at load: `score` runs over every place on every
      // keystroke, and folding a few thousand strings per character is the
      // difference between instant and visibly laggy on a phone.
      place._name = fold(place.name);
      place._nameWords = new Set(place._name.split(/[^\p{L}\p{N}]+/u).filter(Boolean));
      if (!byCity.has(place.city)) byCity.set(place.city, new Map());
      const cats = byCity.get(place.city);
      if (!cats.has(place.type)) cats.set(place.type, []);
      cats.get(place.type).push(place);
    }

    TREE = data.cities
      .filter((meta) => byCity.has(meta.name))
      .map((meta) => {
        const cats = byCity.get(meta.name);
        const city = {
          key: meta.key,
          name: meta.name,
          // Worked out in the fetcher and read back out of the blob, like the
          // category's emoji. Defaulted rather than assumed: a city added to
          // lists.txt and not to COUNTRIES in derive.py arrives without one,
          // and the page prints a name with a gap where the flag goes.
          flag: meta.flag || '',
          lat: meta.lat,
          lng: meta.lng,
          total: meta.count,
          count: meta.count,
          cats: data.categories
            .filter((c) => cats.has(c.key))
            .map((c) => ({
              key: c.key,
              name: c.name,
              emoji: c.emoji,
              places: cats.get(c.key),
              // Whether anything in here is held by a mark, so that the
              // overwhelming majority of folders -- which are not -- cost
              // nothing to fold in and out. `total` and `visible` are
              // `applyMarks`'s to fill in, and it runs before the first paint.
              marked: cats.get(c.key).some((p) => p.marks),
              visible: cats.get(c.key),
              total: cats.get(c.key).length,
              count: cats.get(c.key).length,
            })),
        };

        /* The city's own name comes out of its places' searchable text. Every
           London address contains the word "London", so before this `london`
           matched 317 places; now it matches the fifteen actually *called*
           London and the folder holds the rest. It is the README's promise
           about names outranking addresses, kept structurally rather than by a
           scoring tier that had to out-shout the address.

           Removed token by token, never as a substring: `uk` inside `Duke St`
           and `lon` inside `Colonnade` are real words in real addresses. */
        const strip = new Set([...tokens(meta.name), ...tokens(meta.key)]);
        for (const cat of city.cats) {
          for (const place of cat.places) {
            const rest = [
              place.address,
              place.note,
              ...place.lists.map((id) => data.lists.find((l) => l.id === id)?.name || ''),
            ].join(' ');
            place._rest = tokens(rest)
              .filter((t) => !strip.has(t))
              .join(' ');
          }
        }
        return city;
      });

    cityByKey = new Map(TREE.map((c) => [c.key, c]));
    catByKey = new Map(data.categories.map((c) => [c.key, c]));
    markByKey = new Map(DATA.marks.map((m) => [m.key, m]));
    markTokens = new Map(DATA.marks.map((m) => [m.key, m.key]));

    /* Everything a path segment may name. Every slug the lists used to answer
       to is folded in as an alias, so links shared before the tree existed
       still resolve: `/nyc` is New York, `/baker` is the bakeries, `/lonfood`
       widens to London. A list is a category if the taxonomy claims it and a
       city otherwise -- the same rule the fetcher used, read back out of the
       blob rather than restated here. */
    pathTokens = new Set([...cityByKey.keys(), ...catByKey.keys()]);
    const listToCat = new Map();
    for (const cat of data.categories) {
      for (const name of cat.lists || []) listToCat.set(name, cat.key);
    }
    /* A mark's own lists become aliases for the mark, keyed the same way the
       fetcher matched them -- so `/next` is the button, exactly as `/baker` is
       the bakeries. Doing it first is what stops `next` from being read as a
       *city* instead: the alias loop below would otherwise find the first place
       on the list and quietly decide that `/next` means London. */
    const listToMark = new Map();
    for (const mark of DATA.marks) {
      for (const name of mark.lists || []) {
        listToMark.set(name, mark.key);
        const alias = fold(name).replace(/[^\p{L}\p{N}]+/gu, '');
        // A level of the tree keeps its own slug: an alias is a convenience and
        // a city called `Next` is a page. The mark's key is not an alias and is
        // never given up -- it is what the URL is written in.
        if (alias && !markTokens.has(alias) && !pathTokens.has(alias)) {
          markTokens.set(alias, mark.key);
        }
      }
    }
    for (const list of data.lists) {
      const alias = fold(list.name).replace(/[^\p{L}\p{N}]+/gu, '');
      if (!alias || pathTokens.has(alias)) continue;
      if (listToMark.has(list.name) || markTokens.has(alias)) continue;
      if (listToCat.has(list.name)) {
        catByKey.set(alias, catByKey.get(listToCat.get(list.name)));
        pathTokens.add(alias);
        continue;
      }
      const sample = data.places.find((p) => p.lists.includes(list.id));
      if (!sample) continue;
      const target = TREE.find((c) => c.name === sample.city);
      if (target) {
        cityByKey.set(alias, target);
        pathTokens.add(alias);
      }
    }

    week = openWeek(data.generated, data.places);

    // The counts themselves are `renderCounts`'s, because they move with the
    // chips; here there is only the date, which does not.
    if (data.generated) {
      $('gl-stamp').textContent = `updated ${data.generated.slice(0, 10)}`;
    }
  }

  fetch('./data/lists.json', { cache: 'no-cache' })
    .then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    })
    .then((data) => {
      prepare(data);
      renderChips();
      wire();
      const parsed = parseQuery(queryFromUrl());
      state = {
        path: parsed.path,
        text: parsed.text,
        near: parsed.near,
        marks: parsed.marks,
        recent: parsed.recent,
        recommend: parsed.recommend,
      };
      $('gl-search').value = state.text;
      if (state.near) resolveOrigin({ kind: 'me' }, () => render());
      render();
      // `wire` has just given the focus to a tree that is not on screen.
      if (state.recommend) focusForm();
      // An old link may name a city by a slug the trail no longer uses; this
      // is where `/nyc/pizza` becomes `/newyork/food` in the address bar, once,
      // without adding a history entry to go back through.
      syncUrl(false);
    })
    .catch((err) => {
      $('gl-subtitle').textContent = 'could not load places';
      $('gl-rows').hidden = true;
      const empty = $('gl-empty');
      empty.hidden = false;
      empty.innerHTML =
        `data/lists.json did not load (${escapeHtml(String(err.message))}).\n` +
        'Run <code>python3 scripts/fetch.py</code> and reload.';
    });
})();

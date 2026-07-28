/* alists -- every saved place as a tree of city then category.
 *
 * The lists are how the places are organised in Google Maps, which is not how
 * anyone else would look for them: half the names are private jokes and the
 * biggest place in the collection, London, has no list at all. So the fetcher
 * works out a city and a category for every place (scripts/derive.py) and this
 * browses that instead -- two levels, both of which read as themselves.
 *
 * There is still one input and it still always filters. What changed is that
 * the slash grammar now names a path rather than a command: `/london/coffee` is
 * where you are standing, and any words after it narrow what is beneath you.
 * Typing prunes the tree; nothing is a command you had to know existed.
 */

(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  /* A backstop, not a paging scheme. The tree can only ever render the 1649
     places plus their headers, so this is unreachable in practice -- it exists
     so a bug in the expansion rule degrades to a slow page rather than a hung
     one. */
  const MAX_ROWS = 6000;

  let DATA = { lists: [], places: [], cities: [], categories: [] };
  let TREE = []; // cities, each holding categories, each holding places
  let cityByKey = new Map();
  let catByKey = new Map();
  let pathTokens = new Set(); // every token that can name a city or a category

  let view = []; // rows currently rendered, in order
  let active = -1; // index into `view`, or -1 for nothing selected
  let acItems = [];
  let acIndex = 0;

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

  // ----------------------------------------------------------------- query

  /* `near` is the only surviving command. The tree is its own index, so
     `/all-lists` has nothing left to do that clearing the prompt does not --
     it is kept only so the links already shared with it in them still land
     somewhere sensible, and it resolves to the root. */
  const COMMANDS = ['near', 'all-lists'];

  /* A query is an optional path, an optional command, and words.
     `/london/coffee flat white` is the coffee places in London matching
     `flat` and `white`. A leading slash is only ever a path or a command, so a
     place called "24/7" is still reachable as a bare word.

     Path segments are matched against city and category tokens, which include
     every slug the lists used to have -- so `/nyc`, `/baker` and `/aθens` all
     still resolve, and every link shared before this change still works. A
     segment that names nothing is treated as a word rather than silently
     dropped, so a typo narrows to nothing visibly instead of being ignored. */
  function parseQuery(raw) {
    const path = [];
    const words = [];
    let command = null;

    for (const part of raw.trim().split(/\s+/)) {
      if (!part) continue;
      if (part.startsWith('/')) {
        for (const seg of part.split('/')) {
          if (!seg) continue;
          const key = fold(seg);
          if (COMMANDS.includes(key)) command = key;
          else if (pathTokens.has(key)) path.push(key);
          else words.push(key);
        }
      } else {
        const word = fold(part);
        if (word) words.push(word);
      }
    }
    return { path, command, words };
  }

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

  /* The origin distance is measured from. Today `/near` always means "me", but
     everything downstream reads this object rather than the browser's position
     directly, so pointing it at somewhere else -- a city the person names, a
     hotel they are staying in -- is a new branch in `resolveOrigin` and nothing
     more. Every city already carries its centre in data/lists.json for exactly
     that. */
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
     Location is requested only when `/near` is typed, never on load. Asking an
     unprompted visitor where they are is the browser-permission equivalent of a
     cold call: Chrome demotes origins that do it, Safari users reflexively deny,
     and a denial is sticky -- so the one chance to ask is worth spending on a
     moment when the person has just said what they want it for. Nothing here
     throws; `origin.state` is what the UI reports. */
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

  // ------------------------------------------------------------------ search

  /* Walk the tree keeping only what matches, and count what survives.
     Counts are matches-beneath rather than totals: a header that contradicts
     the rows under it is worse than no header at all.

     `near` sorts rather than filters. It reorders cities by how close their
     nearest surviving place is and reorders places within their category, so
     the structure holds and the nearest thing floats to the top of it. A place
     with no coordinates sorts last instead of disappearing -- it is still a
     place you saved. */
  function search(raw) {
    const { path, command, words } = parseQuery(raw);
    const { city: onCity, cat: onCat } = resolvePath(path);
    const sorting = command === 'near' && origin.state === 'ready';

    const cities = [];
    let matches = 0;

    for (const city of TREE) {
      if (onCity && city !== onCity) continue;
      const cats = [];
      let cityCount = 0;

      for (const cat of city.cats) {
        if (onCat && cat.key !== onCat.key) continue;
        let places = cat.places;
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
      const near = sorting
        ? Math.min(...cats.map((c) => distanceTo(c.places[0])))
        : 0;
      cities.push({ ...city, cats, count: cityCount, near });
    }

    if (sorting) cities.sort((a, b) => a.near - b.near);

    return { cities, matches, words, command, onCity, onCat, filtering: path.length > 0 || words.length > 0 };
  }

  /* What is open is a pure function of the query -- nothing is remembered.
     The hash *is* the prompt, so any state a click could create but typing
     could not would be lost the moment the URL was shared, and "the address bar
     is the share button" would quietly stop being true.

     Three ways in. A node on the path is open because that is what standing
     there means. A node that was pruned is open because its count is now a
     selection and hiding a selection behind a chevron makes the number a claim
     you have to click to check. And a node holding most of what survived is
     open because otherwise typing a city's name answers with the city's name --
     one row, no places, which is not an answer. */
  function isOpen(node, onPath, total) {
    if (onPath) return true;
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

  const HINT = '/ to jump to a city · /near for distance';

  /* Location state belongs in the footer, next to the prompt that caused it.
     A success banner over the results would restate what `/near` in the input
     and a column of distances already say, and it would push the first result
     down every time -- so the granted case says nothing at all. Only the two
     states the distances cannot express get a line. */
  function locationHint(command) {
    const hint = $('gl-hint');
    if (command !== 'near') {
      hint.textContent = HINT;
      hint.classList.remove('is-warn');
      return;
    }
    switch (origin.state) {
      case 'asking':
        hint.textContent = 'waiting for your location…';
        hint.classList.remove('is-warn');
        break;
      case 'denied':
      case 'unavailable':
        // Deliberately no retry button: re-prompting is blocked by the browser
        // once denied, so the only real fix is in site settings, and a button
        // that silently does nothing is worse than a sentence that is true.
        hint.textContent = `${origin.error} — usual order; re-allow in site settings`;
        hint.classList.add('is-warn');
        break;
      default:
        hint.textContent = HINT;
        hint.classList.remove('is-warn');
    }
  }

  /* The id is what `aria-activedescendant` on the input points at. Focus never
     leaves the prompt, so without it the selection moves silently: a screen
     reader would announce nothing on ArrowDown and Enter would open a row it
     had never named. */
  const rowId = (i) => `gl-row-${i}`;

  /* The guides are the depth cue, in place of an indent you would have to
     measure. `└` closes a run so the eye can see where a city ends without
     counting rows back to the last header. */
  const GUIDE = { mid: '├─', end: '└─', pipe: '│ ', blank: '  ' };

  function rowHtml(i, kind, indent, inner, label) {
    return (
      `<div class="gl-row gl-${kind}${i === active ? ' is-active' : ''}" role="option" ` +
      `id="${rowId(i)}" data-i="${i}" aria-label="${escapeHtml(label)}"` +
      `${i === active ? ' aria-selected="true"' : ''}>` +
      `<span class="gl-guide" aria-hidden="true">${indent}</span>` +
      inner +
      '</div>'
    );
  }

  function syncActiveDescendant() {
    const input = $('gl-input');
    if (active < 0) input.removeAttribute('aria-activedescendant');
    else input.setAttribute('aria-activedescendant', rowId(active));
  }

  function render(raw) {
    const result = search(raw);
    const { cities, matches, words, command, onCity, onCat, filtering } = result;
    const host = $('gl-rows');
    const scroll = $('gl-scroll');

    locationHint(command);

    if (!cities.length) {
      // `presentation`, because the listbox may only contain options: the count
      // is announced from the footer, which is live where this is not.
      host.innerHTML =
        '<div class="gl-empty" role="presentation">nothing saved here matches. ' +
        '<code>Esc</code> goes back up, <code>/</code> lists the cities.</div>';
      view = [];
      active = -1;
      syncActiveDescendant();
      status(0, filtering, raw);
      return;
    }

    const html = [];
    view = [];
    const showDistance = command === 'near' && origin.state === 'ready';

    for (const city of cities) {
      if (view.length >= MAX_ROWS) break;
      const open = isOpen(city, !!onCity, matches);
      view.push({ kind: 'city', node: city });
      html.push(
        rowHtml(
          view.length - 1,
          'city',
          open ? '▾ ' : '▸ ',
          `<span class="gl-name">${highlight(city.name, words)}</span>` +
            `<span class="gl-count">${city.count}</span>`,
          `${city.name}, ${city.count} place${city.count === 1 ? '' : 's'}`
        )
      );
      if (!open) continue;

      city.cats.forEach((cat, ci) => {
        if (view.length >= MAX_ROWS) return;
        const lastCat = ci === city.cats.length - 1;
        const catOpen = isOpen(cat, !!onCat, city.count);
        view.push({ kind: 'cat', node: cat, city });
        html.push(
          rowHtml(
            view.length - 1,
            'cat',
            `${lastCat ? GUIDE.end : GUIDE.mid} ${catOpen ? '▾' : '▸'} `,
            `<span class="gl-emoji" aria-hidden="true">${escapeHtml(cat.emoji)}</span>` +
              `<span class="gl-name">${highlight(cat.name, words)}</span>` +
              `<span class="gl-count">${cat.count}</span>`,
            `${cat.name} in ${city.name}, ${cat.count} place${cat.count === 1 ? '' : 's'}`
          )
        );
        if (!catOpen) return;

        const stem = lastCat ? GUIDE.blank : GUIDE.pipe;
        for (const place of cat.places) {
          if (view.length >= MAX_ROWS) break;
          view.push({ kind: 'place', node: place });
          const km = showDistance && Number.isFinite(distanceTo(place))
            ? `<span class="gl-km">${formatKm(distanceTo(place))}</span>`
            : '';
          html.push(
            rowHtml(
              view.length - 1,
              'place',
              `${stem}    `,
              `<span class="gl-bullet" aria-hidden="true">●</span>` +
                '<span class="gl-body">' +
                `<span class="gl-name">${highlight(place.name, words)}</span>` +
                (place.far ? '<span class="gl-far" title="placed by its nearest city">~</span>' : '') +
                (place.address
                  ? `<div class="gl-meta">${highlight(place.address, words)}</div>`
                  : '') +
                (place.note ? `<div class="gl-note">${highlight(place.note, words)}</div>` : '') +
                '</span>' +
                km,
              `${place.name}${place.address ? ', ' + place.address : ''}`
            )
          );
        }
      });
    }

    host.innerHTML = html.join('');
    active = view.length ? 0 : -1;
    if (active >= 0) {
      host.querySelector('.gl-row').classList.add('is-active');
      host.querySelector('.gl-row').setAttribute('aria-selected', 'true');
    }
    syncActiveDescendant();
    scroll.scrollTop = 0;
    status(matches, filtering, raw);
  }

  // `filtering` comes from the parsed query, not the raw string: a lone `/`
  // with the menu open narrows nothing yet, and reporting it as "1649 matches"
  // would claim a filter that is not applied.
  function status(total, filtering, raw) {
    const el = $('gl-status');
    if (!filtering) {
      el.textContent = `${DATA.places.length} places · ${TREE.length} cities`;
      return;
    }
    el.textContent = `${total} match${total === 1 ? '' : 'es'}`;
  }

  function setActive(next) {
    const rows = $('gl-rows').querySelectorAll('.gl-row');
    if (!rows.length) return;
    const clamped = Math.max(0, Math.min(rows.length - 1, next));
    rows[active]?.classList.remove('is-active');
    rows[active]?.removeAttribute('aria-selected');
    active = clamped;
    rows[active].classList.add('is-active');
    rows[active].setAttribute('aria-selected', 'true');
    rows[active].scrollIntoView({ block: 'nearest' });
    syncActiveDescendant();
  }

  /* Drilling writes the path into the prompt rather than toggling a hidden
     flag, because a query is the only state this page has. Opening a city is
     therefore the same event as typing its name, and produces the same URL. */
  function drill(row) {
    if (!row) return false;
    const input = $('gl-input');
    const { command, words } = parseQuery(input.value);
    let path;
    if (row.kind === 'city') path = `/${row.node.key}`;
    else if (row.kind === 'cat') path = `/${row.city.key}/${row.node.key}`;
    else return false;
    input.value =
      [path, command ? `/${command}` : '', ...words].filter(Boolean).join(' ') + ' ';
    onInput();
    return true;
  }

  function open(row) {
    if (!row) return;
    if (row.kind !== 'place') {
      drill(row);
      return;
    }
    window.open(mapsUrl(row.node), '_blank', 'noopener');
  }

  /* Esc widens by one step rather than clearing outright: from
     `/london/coffee flat white` it drops the words, then the category, then the
     city. Clearing in one press is still there at the end of it, and widening
     is what someone who has drilled too far actually wants. */
  function widen() {
    const input = $('gl-input');
    const { path, command, words } = parseQuery(input.value);
    let next;
    if (words.length) next = path;
    else if (path.length) next = path.slice(0, -1);
    else if (command) next = [];
    else {
      input.value = '';
      onInput();
      return;
    }
    const keep = words.length ? command : next.length ? command : null;
    input.value =
      [next.length ? '/' + next.join('/') : '', keep ? `/${keep}` : '']
        .filter(Boolean)
        .join(' ') + (next.length || keep ? ' ' : '');
    onInput();
  }

  // --------------------------------------------------------- autocomplete

  /* The `/` menu is the index of everywhere you can stand. It opens on the
     token being typed, so it is reachable mid-query (`bagel /ny`), not just at
     the start of the line. Cities come first: there are thirty-eight of them
     against nine categories, and a city is what someone arriving is usually
     looking for. */
  function currentSlashToken(input) {
    const upto = input.value.slice(0, input.selectionStart ?? input.value.length);
    const match = /(?:^|\s)\/([^\s]*)$/.exec(upto);
    if (!match) return null;
    // Only the segment being typed completes, so `/london/cof` offers
    // categories rather than re-offering cities.
    const parts = match[1].split('/');
    return { typed: parts[parts.length - 1], prefix: parts.slice(0, -1) };
  }

  function closeAutocomplete() {
    $('gl-autocomplete').classList.remove('is-open');
    acItems = [];
  }

  function refreshAutocomplete() {
    const input = $('gl-input');
    const box = $('gl-autocomplete');
    const token = currentSlashToken(input);

    if (token === null) {
      closeAutocomplete();
      return;
    }

    const needle = fold(token.typed);
    const deep = token.prefix.some((p) => cityByKey.has(fold(p)));
    const entries = [];

    const plural = (n) => `${n} place${n === 1 ? '' : 's'}`;

    if (!deep) {
      for (const city of TREE) {
        entries.push({ slug: city.key, desc: `${city.name} · ${plural(city.total)}` });
      }
    }
    for (const cat of DATA.categories) {
      const where = deep ? cityByKey.get(fold(token.prefix.find((p) => cityByKey.has(fold(p))))) : null;
      const n = where
        ? (where.cats.find((c) => c.key === cat.key)?.total ?? 0)
        : DATA.places.filter((p) => p.type === cat.key).length;
      if (deep && !n) continue;
      entries.push({ slug: cat.key, desc: `${cat.emoji} ${cat.name} · ${plural(n)}` });
    }
    if (!deep) {
      entries.push({ slug: 'near', desc: 'sort by distance — asks for your location' });
    }

    acItems = entries.filter(
      (entry) => entry.slug.startsWith(needle) || fold(entry.desc).includes(needle)
    );

    if (!acItems.length) {
      box.classList.remove('is-open');
      return;
    }

    acIndex = Math.min(acIndex, acItems.length - 1);
    box.innerHTML = acItems
      .map(
        (entry, i) =>
          `<div class="bt-autocomplete-item${i === acIndex ? ' is-selected' : ''}" data-ac="${i}" role="option">` +
          `<span class="bt-autocomplete-cmd">/${escapeHtml(entry.slug)}</span>` +
          `<span class="bt-autocomplete-desc">${escapeHtml(entry.desc)}</span></div>`
      )
      .join('');
    box.classList.add('is-open');
  }

  function acceptAutocomplete(index) {
    const entry = acItems[index];
    const input = $('gl-input');
    if (!entry) return false;
    const caret = input.selectionStart ?? input.value.length;
    const before = input.value.slice(0, caret).replace(/\/[^\s/]*$/, '');
    const after = input.value.slice(caret);
    input.value = `${before}${entry.slug} ${after.replace(/^\s+/, '')}`;
    const at = before.length + entry.slug.length + 1;
    input.setSelectionRange(at, at);
    onInput();
    return true;
  }

  // ------------------------------------------------------------------ url

  /* The address bar is the share mechanism: every filter is a URL, so sending
     someone the bakeries you like is copy-and-paste with no extra affordance to
     find. replaceState, not pushState -- each keystroke is not a history entry. */
  function syncUrl(raw) {
    const hash = raw.trim() ? '#' + encodeURIComponent(raw.trim()) : '';
    if (hash !== window.location.hash) {
      history.replaceState(null, '', hash || window.location.pathname);
    }
  }

  const queryFromUrl = () => {
    try {
      return decodeURIComponent(window.location.hash.replace(/^#/, ''));
    } catch {
      return '';
    }
  };

  // -------------------------------------------------------------- wiring

  /* Show a query and honour what it asks for. Typed, arrived at on load, or
     arrived at by a hash change are the same event as far as `/near` goes: the
     permission belongs to whoever is looking at the page, not to whoever sent
     the link, so every route in has to be able to ask.

     Asked before rendering, so the first paint already says it is waiting.
     `origin.state` leaves `idle` immediately, so editing the rest of the query
     cannot re-prompt and a denial is not asked about again. */
  function applyQuery(raw) {
    if (parseQuery(raw).command === 'near' && origin.state === 'idle') {
      resolveOrigin({ kind: 'me' }, () => render($('gl-input').value));
    }
    render(raw);
  }

  function onInput() {
    const raw = $('gl-input').value;
    acIndex = 0;
    refreshAutocomplete();
    applyQuery(raw);
    syncUrl(raw);
  }

  function onKeydown(event) {
    const box = $('gl-autocomplete');
    const acOpen = box.classList.contains('is-open');
    const input = $('gl-input');

    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        if (acOpen) {
          acIndex = (acIndex + step + acItems.length) % acItems.length;
          refreshAutocomplete();
        } else {
          setActive(active + step);
        }
        return;
      }
      case 'ArrowRight':
        /* Only at the very end of the line, and never with a selection --
           anywhere else this is the caret moving through text someone is
           editing, and stealing it would make the prompt feel broken.
           ArrowLeft is deliberately never bound, for the same reason. */
        if (
          !acOpen &&
          input.selectionStart === input.value.length &&
          input.selectionStart === input.selectionEnd &&
          view[active] &&
          view[active].kind !== 'place'
        ) {
          event.preventDefault();
          drill(view[active]);
        }
        return;
      case 'Tab':
        if (acOpen) {
          event.preventDefault();
          acceptAutocomplete(acIndex);
        }
        return;
      case 'Enter':
        event.preventDefault();
        if (acOpen) acceptAutocomplete(acIndex);
        else open(view[active]);
        return;
      case 'Escape':
        event.preventDefault();
        if (acOpen) closeAutocomplete();
        else widen();
        return;
      default:
    }
  }

  function wire() {
    const input = $('gl-input');
    input.addEventListener('input', onInput);
    input.addEventListener('keydown', onKeydown);
    input.addEventListener('click', refreshAutocomplete);

    $('gl-rows').addEventListener('click', (event) => {
      const row = event.target.closest('.gl-row');
      if (!row) return;
      setActive(Number(row.dataset.i));
      open(view[active]);
    });

    $('gl-autocomplete').addEventListener('mousedown', (event) => {
      const item = event.target.closest('[data-ac]');
      if (!item) return;
      event.preventDefault(); // keep focus in the input; a blur would close the menu
      acceptAutocomplete(Number(item.dataset.ac));
    });

    window.addEventListener('hashchange', () => {
      const next = queryFromUrl();
      if (next !== input.value) {
        input.value = next;
        acIndex = 0;
        // Close rather than refresh: arriving at a query is not typing one, so
        // a link would otherwise land with the menu sitting over the very
        // results it was sent to show.
        closeAutocomplete();
        applyQuery(next);
      }
    });

    /* Any stray keystroke belongs to the filter. Guarded on modifiers so
       browser shortcuts still work, and on touch so the on-screen keyboard is
       never summoned by a tap on a row. */
    document.addEventListener('keydown', (event) => {
      if (event.target === input || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key.length === 1 || event.key === 'Backspace') input.focus();
    });

    if (!window.matchMedia('(hover: none)').matches) input.focus();
  }

  // ------------------------------------------------------------------ boot

  function prepare(data) {
    DATA = data;
    const catMeta = new Map(data.categories.map((c) => [c.key, c]));
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
    for (const list of data.lists) {
      const alias = fold(list.name).replace(/[^\p{L}\p{N}]+/gu, '');
      if (!alias || pathTokens.has(alias)) continue;
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

    const counts = `${data.places.length} places · ${TREE.length} cities`;
    $('gl-subtitle').textContent = data.owner ? `${data.owner} · ${counts}` : counts;
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
      wire();
      const initial = queryFromUrl();
      $('gl-input').value = initial;
      // No `refreshAutocomplete()` here on purpose: arriving on a shared link
      // is not typing, and the menu would open over the results the link was
      // sent to show. `applyQuery` still asks for a location if the link is a
      // `/near` one -- see there.
      applyQuery(initial);
    })
    .catch((err) => {
      $('gl-subtitle').textContent = 'could not load places';
      $('gl-rows').innerHTML =
        `<div class="gl-empty">data/lists.json did not load (${escapeHtml(String(err.message))}).\n` +
        'Run <code>python3 scripts/fetch.py</code> and reload.</div>';
    });
})();

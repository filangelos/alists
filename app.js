/* alists -- one filterable stream of every saved place.
 *
 * The lists are how the places are organised in Google Maps, not how they are
 * browsed here: a place is shown once, tagged with every list that claims it,
 * and the lists themselves are a facet you can narrow to rather than a level
 * you have to navigate through. There is one input and it always filters.
 */

(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  // A ceiling on DOM nodes, kept well clear of the actual count so the
  // unfiltered view is always complete -- truncating it would hide places with
  // no affordance to reach them. Rows cost roughly 50µs each to build, so this
  // is a backstop against a runaway, not a paging scheme; raise it rather than
  // let it start biting.
  const MAX_ROWS = 6000;

  let DATA = { lists: [], places: [] };
  let listById = new Map();
  let listSlugs = new Set(); // every list slug, for exact-beats-prefix scoping
  let view = []; // rows currently rendered, in order
  let viewKind = 'places'; // what `view` holds, so Enter knows what to open
  let active = -1; // index into `view`, or -1 for nothing selected
  let acItems = []; // open autocomplete entries
  let acIndex = 0;

  // ------------------------------------------------------------------ text

  /* Fold accents and case so `cafe` finds `Café` and `ανοιξη` finds `Άνοιξη`.
     Greek and Latin both decompose to a base letter plus combining marks under
     NFD, so one strip covers both alphabets. It does not transliterate and is
     not meant to: `anoixi` will not find `Άνοιξη`, and typing the Greek is the
     only way to reach a Greek name. */
  const fold = (s) =>
    (s || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();

  const escapeHtml = (s) =>
    s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  /* Mark every query token inside `text`, working on the folded string but
     slicing the original -- folding is length-preserving for the marks we
     strip, so an index found in one is valid in the other, and the accented
     spelling survives into the page. */
  function highlight(text, tokens) {
    if (!text) return '';
    if (!tokens.length) return escapeHtml(text);
    const hay = fold(text);
    const spans = [];
    for (const token of tokens) {
      let from = 0;
      for (;;) {
        const at = hay.indexOf(token, from);
        if (at === -1) break;
        spans.push([at, at + token.length]);
        from = at + token.length;
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

  /* Commands share the `/` namespace with the list slugs, so a command name
     must never also be a plausible list name. `all-lists` carries a hyphen,
     which `slugOf` strips from every list slug -- so no list can ever collide
     with it, whatever it gets renamed to. */
  const COMMANDS = [
    { slug: 'all-lists', desc: 'every list, opens in Google Maps' },
    { slug: 'near', desc: 'sort by distance — asks for your location' },
  ];

  /* A query is an optional command, a set of list scopes and a set of words.
     `/nyc bagel` means the NYC list AND the word bagel; the leading slash is
     only ever a command or a scope, so a place called "24/7" is still
     reachable as a bare word.

     A command is matched in full, while a scope prefix-matches: `/a` has to go
     on meaning the Aθens list rather than becoming ambiguous with `/all-lists`
     the moment a command starting with the same letter exists. */
  function parseQuery(raw) {
    const scopes = [];
    const words = [];
    let command = null;
    for (const part of raw.trim().split(/\s+/)) {
      if (!part) continue;
      if (part.startsWith('/')) {
        const slug = fold(part.slice(1));
        if (!slug) continue;
        if (COMMANDS.some((c) => c.slug === slug)) command = slug;
        else scopes.push(slug);
      } else {
        words.push(fold(part));
      }
    }
    return { command, scopes, words };
  }

  /* Keep any letter, not just a-z: stripping to ASCII turns `Aθens` into
     `aens`, a slug that names nothing and cannot be guessed. Non-Latin slugs
     are still reachable -- the menu completes them, and `/a` prefix-matches. */
  const slugOf = (list) => fold(list.name).replace(/[^\p{L}\p{N}]+/gu, '');

  /* Built once -- constructing a collator per comparison is the expensive part.
     `base` sensitivity so case and accents do not decide the order (`Aθens`
     sorts as `athens`), `numeric` so a `Top 10` would land after `Top 9`. */
  const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

  /* Score a place against the words. Returns -1 for no match. Every word has to
     land somewhere, but where it lands decides the rank: a name match beats an
     address match, so searching `london` surfaces places *called* London before
     the two hundred that merely sit in it. */
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

  function search(raw) {
    const { command, scopes, words } = parseQuery(raw);

    if (command === 'all-lists') {
      // Words still narrow, so `/all-lists ny` is a way to find a list by name
      // rather than only ever an index of all of them.
      const matched = words.length
        ? DATA.lists.filter((list) => words.every((w) => list._haystack.includes(w)))
        : DATA.lists;
      // Alphabetical, on a copy: this is an index to look a name up in, and
      // fetch order is the order they happen to sit in lists.txt, which is
      // meaningless to anyone reading the page. `DATA.lists` itself keeps that
      // order -- the place view groups by it.
      const rows = matched.slice().sort((a, b) => collator.compare(a.name, b.name));
      return { kind: 'lists', rows, ranked: false, command, scopes, words };
    }

    /* Exact beats prefix. `bar` is a prefix of `barca`, so a plain prefix rule
       would quietly answer `/bar` with 31 Barcelona places alongside the
       cocktail bars -- and the more lists there are, the more often one name
       shadows another. A scope that names a list exactly means only that list;
       prefix matching stays for the partial typing it exists for (`/b`). */
    const scoped = scopes.length
      ? DATA.places.filter((p) =>
          scopes.every((s) =>
            listSlugs.has(s) ? p._slugs.includes(s) : p._slugs.some((x) => x.startsWith(s))
          )
        )
      : DATA.places;

    let rows = scoped;
    let ranked = false;

    if (words.length) {
      const hits = [];
      for (const place of scoped) {
        const value = score(place, words);
        if (value >= 0) hits.push({ place, value });
      }
      // Stable by construction: ties keep the curated order they were fetched in.
      hits.sort((a, b) => b.value - a.value);
      rows = hits.map((h) => h.place);
      ranked = true;
    }

    /* Distance overrides relevance rather than blending with it: `/near bagel`
       asks for the closest bagel, so the words decide *what* is in the running
       and the distance decides the order. A place with no coordinates sorts
       last instead of disappearing -- it is still a place you saved. */
    if (command === 'near' && geo.origin) {
      for (const place of rows) {
        place._km = place.lat != null ? haversine(geo.origin, place) : Infinity;
      }
      rows = rows.slice().sort((a, b) => a._km - b._km);
      ranked = true;
    }

    return { kind: 'places', rows, ranked, command, scopes, words };
  }

  // -------------------------------------------------------------- location

  /* Location is requested only when `/near` is typed, never on load. Asking an
     unprompted visitor where they are is the browser-permission equivalent of a
     cold call: Chrome demotes origins that do it, Safari users reflexively deny,
     and a denial is sticky -- so the one chance to ask is worth spending on a
     moment when the person has just said what they want it for.
     `geo.state` is what the UI reports; nothing here throws. */
  const geo = { state: 'idle', origin: null, error: '' };

  const EARTH_KM = 6371;
  const rad = (deg) => (deg * Math.PI) / 180;

  /* Great-circle distance. Not road distance -- the point is to rank a list of
     places by roughly how far they are, and "as the crow flies" orders a
     neighbourhood correctly while needing no network call per place. */
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

  function requestLocation(onSettled) {
    if (!navigator.geolocation) {
      geo.state = 'unavailable';
      geo.error = 'this browser has no location support';
      onSettled();
      return;
    }
    geo.state = 'asking';
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        geo.state = 'ready';
        geo.origin = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        onSettled();
      },
      (err) => {
        // PERMISSION_DENIED is a decision, not a fault -- say so plainly and
        // leave the results usable rather than nagging.
        geo.state = err.code === err.PERMISSION_DENIED ? 'denied' : 'unavailable';
        geo.error =
          err.code === err.PERMISSION_DENIED
            ? 'location permission denied'
            : 'could not get your location';
        onSettled();
      },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 }
    );
  }

  // ---------------------------------------------------------------- render

  const mapsUrl = (place) =>
    place.cid
      ? `https://maps.google.com/?cid=${place.cid}`
      : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
          place.lat != null ? `${place.lat},${place.lng}` : place.name
        )}`;

  const HINT = '/all-lists · /near · / to scope';

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
    switch (geo.state) {
      case 'asking':
        hint.textContent = 'waiting for your location…';
        hint.classList.remove('is-warn');
        break;
      case 'denied':
      case 'unavailable':
        // Deliberately no retry button: re-prompting is blocked by the browser
        // once denied, so the only real fix is in site settings, and a button
        // that silently does nothing is worse than a sentence that is true.
        hint.textContent = `${geo.error} — usual order; re-allow in site settings`;
        hint.classList.add('is-warn');
        break;
      default:
        hint.textContent = HINT;
        hint.classList.remove('is-warn');
    }
  }

  const rowShell = (i, inner) =>
    `<div class="gl-row${i === active ? ' is-active' : ''}" role="option" data-i="${i}"` +
    `${i === active ? ' aria-selected="true"' : ''}>` +
    '<span class="gl-bullet" aria-hidden="true">●</span>' +
    inner +
    '</div>';

  function placeRow(place, i, words, showDistance) {
    const distance =
      showDistance && Number.isFinite(place._km)
        ? `<span class="gl-km">${formatKm(place._km)}</span>`
        : '';
    const tags = place.lists
      .map((id) => listById.get(id))
      .filter(Boolean)
      .map(
        (list) =>
          `<button class="gl-tag" data-scope="${escapeHtml(slugOf(list))}" ` +
          `title="${escapeHtml(list.name)}" aria-label="Only ${escapeHtml(list.name)}">` +
          `${escapeHtml(list.emoji || '#')}</button>`
      )
      .join('');

    return rowShell(
      i,
      '<span class="gl-body">' +
        `<span class="gl-name">${highlight(place.name, words)}</span>` +
        (place.address ? `<div class="gl-meta">${highlight(place.address, words)}</div>` : '') +
        (place.note ? `<div class="gl-note">${highlight(place.note, words)}</div>` : '') +
        '</span>' +
        distance +
        `<span class="gl-tags">${tags}</span>`
    );
  }

  /* A list row opens the list in Google Maps, where a place row opens the
     place -- so the chip stays the way to *narrow* to a list and this stays the
     way to hand someone the whole thing. The count sits where a place's list
     chips do, so the two row shapes line up down the right edge. */
  function listRow(list, i, words) {
    return rowShell(
      i,
      '<span class="gl-body">' +
        `<span class="gl-name">${escapeHtml(list.emoji || '')} ${highlight(list.name, words)}</span>` +
        (list.description ? `<div class="gl-meta">${highlight(list.description, words)}</div>` : '') +
        '</span>' +
        `<span class="gl-count">${list.count}</span>`
    );
  }

  function render(raw) {
    const { kind, rows, ranked, words, scopes, command } = search(raw);
    // A command is not a filter. `/all-lists` changes *what* is counted and
    // `/near` changes the order, so neither should turn "431 places" into the
    // "431 matches" of a query that narrowed nothing.
    const filtering = scopes.length > 0 || words.length > 0;
    const scroll = $('gl-scroll');
    const host = $('gl-rows');

    view = rows.slice(0, MAX_ROWS);
    viewKind = kind;
    active = view.length ? 0 : -1;

    // Never blocks the results: while the permission prompt is up, and after a
    // denial, the unsorted list is still the thing the person came for.
    locationHint(command);

    if (!rows.length) {
      host.innerHTML =
        '<div class="gl-empty">nothing matches. <code>Esc</code> to clear, <code>/</code> to pick a list.</div>';
      status(rows.length, filtering, kind);
      return;
    }

    const html = [];
    if (kind === 'lists') {
      view.forEach((list, i) => html.push(listRow(list, i, words)));
    } else {
      const showDistance = command === 'near' && geo.state === 'ready';
      let group = null;
      view.forEach((place, i) => {
        // Group headers only make sense in the curated order; once results are
        // ranked by relevance the runs are gone and a header would be a lie.
        if (!ranked && place.lists[0] !== group) {
          group = place.lists[0];
          const list = listById.get(group);
          if (list) {
            html.push(
              `<div class="gl-group"><span aria-hidden="true">${escapeHtml(list.emoji || '·')}</span>` +
                `<span class="gl-group-name">${escapeHtml(list.name)}</span>` +
                `<span class="gl-group-rule"></span><span>${runLength(i)}</span></div>`
            );
          }
        }
        html.push(placeRow(place, i, words, showDistance));
      });
    }

    host.innerHTML = html.join('');
    scroll.scrollTop = 0;
    status(rows.length, filtering, kind);
  }

  /* How many rows the header at `from` is about to sit above. Not `list.count`:
     a place saved to two lists is printed under the first that claimed it, so a
     run is already shorter than the list it names wherever the lists overlap,
     and a scope or a word narrows it further. The header has to count the rows
     beneath it or it contradicts them. */
  function runLength(from) {
    const id = view[from].lists[0];
    let n = 1;
    while (from + n < view.length && view[from + n].lists[0] === id) n++;
    return n;
  }

  // `filtering` comes from the parsed query, not the raw string: a lone `/`
  // with the list menu open narrows nothing yet, and reporting it as "431
  // matches" would claim a filter that is not applied.
  function status(total, filtering, kind) {
    const noun = kind === 'lists' ? 'list' : 'place';
    if (!filtering) {
      $('gl-status').textContent = `${total} ${noun}s`;
      return;
    }
    const shown = Math.min(total, MAX_ROWS);
    const suffix = total > MAX_ROWS ? ` of ${total}` : '';
    $('gl-status').textContent = `${shown}${suffix} match${shown === 1 ? '' : 'es'}`;
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
  }

  function open(item) {
    if (!item) return;
    // A list carries the share URL the fetcher built; a place is resolved from
    // its CID. Dispatching on `viewKind` rather than sniffing for a `url` field
    // keeps the two row types from quietly diverging if the schema grows one.
    const href = viewKind === 'lists' ? item.url : mapsUrl(item);
    if (href) window.open(href, '_blank', 'noopener');
  }

  // --------------------------------------------------------- autocomplete

  /* The `/` menu is the command and list index. It opens on the token being
     typed, so it is reachable mid-query (`bagel /ny`), not just at the start of
     the line. Commands sort first: there are one or two of them against seven
     lists, and they are the entries nobody can guess the existence of. */
  function currentSlashToken(input) {
    const upto = input.value.slice(0, input.selectionStart ?? input.value.length);
    const match = /(?:^|\s)\/([^\s]*)$/.exec(upto);
    return match ? match[1] : null;
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

    const needle = fold(token);
    const commands = COMMANDS.map((c) => ({ slug: c.slug, desc: c.desc }));
    const lists = DATA.lists.map((list) => ({
      slug: slugOf(list),
      desc:
        `${list.emoji || ''} ${list.name} · ${list.count} places` +
        (list.description ? ` · ${list.description}` : ''),
    }));

    acItems = [...commands, ...lists].filter(
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
    const before = input.value.slice(0, caret).replace(/(?:^|\s)\/[^\s]*$/, (m) =>
      m.startsWith(' ') ? ' ' : ''
    );
    const after = input.value.slice(caret);
    input.value = `${before}/${entry.slug} ${after.replace(/^\s+/, '')}`;
    const at = before.length + entry.slug.length + 2;
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
     `geo.state` leaves `idle` immediately, so editing the rest of the query
     cannot re-prompt and a denial is not asked about again. */
  function applyQuery(raw) {
    if (parseQuery(raw).command === 'near' && geo.state === 'idle') {
      requestLocation(() => render($('gl-input').value));
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
        if (acOpen) {
          closeAutocomplete();
        } else {
          $('gl-input').value = '';
          onInput();
        }
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
      const tag = event.target.closest('.gl-tag');
      if (tag) {
        input.value = `/${tag.dataset.scope} `;
        input.focus();
        onInput();
        return;
      }
      const row = event.target.closest('.gl-row');
      if (row) {
        setActive(Number(row.dataset.i));
        open(view[active]);
      }
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
        // a `/all-lists` link would otherwise land with the menu sitting over
        // the very results it was sent to show.
        closeAutocomplete();
        applyQuery(next);
      }
    });

    /* Any stray keystroke belongs to the filter. Guarded on modifiers so
       browser shortcuts still work, and on touch so the on-screen keyboard is
       never summoned by a tap on a result. */
    document.addEventListener('keydown', (event) => {
      if (event.target === input || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key.length === 1 || event.key === 'Backspace') input.focus();
    });

    if (!window.matchMedia('(hover: none)').matches) input.focus();
  }

  // ------------------------------------------------------------------ boot

  function prepare(data) {
    DATA = data;
    listById = new Map(data.lists.map((list) => [list.id, list]));
    listSlugs = new Set(data.lists.map(slugOf));
    for (const list of data.lists) {
      list._haystack = fold(`${list.name} ${list.description} ${slugOf(list)}`);
    }
    for (const place of data.places) {
      const slugs = place.lists.map((id) => {
        const list = listById.get(id);
        return list ? slugOf(list) : '';
      });
      // Precomputed once at load: `score` runs over every place on every
      // keystroke, and folding a few thousand strings per character is the
      // difference between instant and visibly laggy on a phone.
      place._name = fold(place.name);
      place._nameWords = new Set(place._name.split(/[^\p{L}\p{N}]+/u).filter(Boolean));
      place._slugs = slugs;
      place._rest = fold(
        [place.address, place.note, ...place.lists.map((id) => listById.get(id)?.name || '')].join(' ')
      );
    }

    const counts = `${data.places.length} places · ${data.lists.length} lists`;
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

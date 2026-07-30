/* Counting, kept at arm's length from the page.
 *
 * A separate file rather than a corner of app.js, because the two have
 * different failure modes and only one of them matters. This can be blocked,
 * fail to load, or answer with a 500 forever, and the tree still walks: every
 * call site in app.js goes through `window.glCount?.()`, so an absent file is
 * an absent function and nothing more. The site is still what is in the tree.
 *
 * What goes out is three shapes and no others -- a page, the fact of a search,
 * a place opened in Maps. What never goes out is what was typed. The search box
 * is the one place a stranger writes free text into this page, and the count of
 * what it found is as much as anyone needs to know about it.
 */
(function () {
  'use strict';

  // Public, and unavoidably so -- see collector/README.md for why that is the
  // premise rather than a leak. A clone of this repo that has not deployed its
  // own collector should count nothing rather than count into mine, so the
  // placeholder check below stays.
  var ENDPOINT = 'https://alists-count.filangelos.workers.dev';

  if (ENDPOINT.indexOf('YOUR-SUBDOMAIN') !== -1) return;
  if (!navigator.sendBeacon) return;

  /* Asked once, honoured for the session. Neither header is enforceable and
     most sites ignore both, which is exactly why answering them is worth the
     four lines: nothing here is worth overriding someone who has said no. */
  if (navigator.globalPrivacyControl || navigator.doNotTrack === '1') return;

  var SEARCH_IDLE = 900;
  var lastPath = null;
  var searchTimer = null;
  var searchBucket = null;

  function send(kind, path, label) {
    try {
      var body = { kind: kind };
      if (path) body.path = path;
      if (label) body.label = label;
      /* `text/plain` makes this a simple request, which means no preflight:
         one round trip instead of two, and nothing waiting on an OPTIONS that
         a click through to Maps would outrun anyway. */
      navigator.sendBeacon(
        ENDPOINT,
        new Blob([JSON.stringify(body)], { type: 'text/plain;charset=UTF-8' }),
      );
    } catch (err) {
      /* Swallowed on purpose, and this is the only catch that is. A counter
         that throws into the page it is counting has failed twice. */
    }
  }

  function flushSearch() {
    if (searchTimer) clearTimeout(searchTimer);
    if (!searchBucket) return;
    var bucket = searchBucket;
    searchTimer = null;
    searchBucket = null;
    send('search', null, bucket);
  }

  /* The last search of a visit is the one the debounce is still holding when
     the tab goes away, and `pagehide` is the only event a phone reliably
     fires -- `unload` does not run when Safari freezes a backgrounded tab. */
  window.addEventListener('pagehide', flushSearch);

  window.glCount = {
    /* Called from `syncUrl`, which is where both a click and the back button
       end up, and which also runs on every keystroke in the search box. Hence
       the comparison: a page is counted when you arrive somewhere new, not
       once per character typed while standing there. */
    view: function (path) {
      var next = path && path.length ? '/' + path.join('/') : '';
      if (next === lastPath) return;
      lastPath = next;
      send('view', next, null);
    },

    /* Called from `status`, which already knows both whether the words are a
       search and what they found. Debounced to the pause at the end of typing,
       so "prufrock" is one search rather than eight prefixes of one -- and the
       bucket, rather than the number, because a precise count of results is a
       fact about the query and enough of those describe the query. */
    search: function (total) {
      searchBucket = total === 0 ? 'none' : total <= 3 ? 'few' : total <= 20 ? 'some' : 'many';
      if (searchTimer) clearTimeout(searchTimer);
      searchTimer = setTimeout(flushSearch, SEARCH_IDLE);
    },

    /* The one thing on this page that is a destination rather than a view: the
       moment a place stops being a row and becomes somewhere you are going. */
    open: function (name) {
      // A search answered by opening one of its results is a search that
      // worked, and the pause the debounce waits for never comes -- the click
      // arrives first. Flush what it actually found rather than losing it.
      flushSearch();
      send('open', null, name);
    },
  };
})();

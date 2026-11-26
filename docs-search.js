// docs-search.js — local Unity docs search: BM25 over a downloaded
// ScriptReference snapshot (v0.21.0).
//
// Plain Node, no Electron dependency, so the smoke test can exercise
// this file directly with `node` (like context-budget.js and
// turn-ledger.js). main.js requires it through docs-engine.js for the
// docs:* IPCs; the renderer never indexes anything itself.
//
// How it works: the app downloads the official Unity offline docs zip
// (see docs-engine.js) into app data, extracts the ScriptReference
// HTML pages, and builds one inverted index per Unity version. A query
// is ranked with fielded BM25 (k1 = 1.2, b = 0.75): the body score
// plus the title score weighted 3x, so an API name in the title
// outranks a passing mention in a long body — and a query that is
// exactly one API name returns that page first. There is no live-URL
// lookup in this build: until the download exists, the docs tool
// says plainly that there is no index yet. That is a documented
// follow-up, not a silent gap.
//
// Tokenizing: Unity API names are camelCase (TransformPoint,
// Rigidbody), so the tokenizer splits camelCase boundaries AND keeps
// the whole lowercase token — a query for "transform point" and a
// query for "transformpoint" both find Transform.TransformPoint.

(function () {
  'use strict';

  var DocsSearch = {};

  DocsSearch.VERSION = '0.21.0';

  // BM25 constants (Robertson & Zaragoza defaults).
  DocsSearch.BM25_K1 = 1.2;
  DocsSearch.BM25_B = 0.75;

  // Fielded BM25: the title is scored separately from the body and
  // weighted this much, because a Unity API name in the title is
  // worth far more than a passing mention in a long body. (The
  // first version of this index repeated the title in the body
  // text; that let long bodies with many mentions outrank the exact
  // page — "rigidbody velocity" returned a physics-settings page
  // instead of Rigidbody. Fielded scoring fixed it.)
  DocsSearch.TITLE_WEIGHT = 3;

  // Index format version. The engine refuses an index built by a
  // different format instead of searching it wrong.
  DocsSearch.INDEX_FORMAT = 2;

  // How much of a page's lead text a search result carries.
  DocsSearch.LEAD_CHARS = 400;

  var STOPWORDS = {};
  ('a an the and or of to in on for with by at from as is are was were be been being ' +
   'it its this that these those there here when where which who whom what how why ' +
   'not no nor do does did can could will would should may might must shall ' +
   'you your we our they their he she his her i me my we us them him ' +
   'also then than so such if but about into over under after before between through ' +
   'per via etc').split(' ').forEach(function (w) { STOPWORDS[w] = true; });

  // Split camelCase / letter-digit boundaries, lowercase, split on
  // anything that is not a letter or digit, drop stopwords and
  // one-letter tokens. The whole lowercase token is kept alongside
  // its split parts, so "TransformPoint" indexes as
  // [transformpoint, transform, point].
  function tokenize(text) {
    if (!text) return [];
    var out = [];
    var seen = {};
    var words = String(text).split(/[^A-Za-z0-9]+/);
    for (var i = 0; i < words.length; i++) {
      var w = words[i];
      if (!w) continue;
      var lower = w.toLowerCase();
      if (lower.length >= 2 && !STOPWORDS[lower] && !seen[lower]) {
        seen[lower] = true;
        out.push(lower);
      }
      // CamelCase / letter-digit split: TransformPoint -> transform,
      // point; Rigidbody2D -> rigidbody, 2d.
      var split = w.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/([A-Za-z])([0-9])/g, '$1 $2')
        .toLowerCase().split(/[^a-z0-9]+/);
      for (var j = 0; j < split.length; j++) {
        var part = split[j];
        if (part && part.length >= 2 && !STOPWORDS[part] && !seen[part]) {
          seen[part] = true;
          out.push(part);
        }
      }
    }
    return out;
  }
  DocsSearch.tokenize = tokenize;

  var ENTITY_MAP = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

  function decodeEntities(s) {
    return String(s)
      .replace(/&#x([0-9a-fA-F]+);/g, function (_, h) { return String.fromCharCode(parseInt(h, 16)); })
      .replace(/&#([0-9]+);/g, function (_, d) { return String.fromCharCode(parseInt(d, 10)); })
      .replace(/&([a-z]+);/g, function (_, name) {
        return Object.prototype.hasOwnProperty.call(ENTITY_MAP, name) ? ENTITY_MAP[name] : '&' + name + ';';
      });
  }

  // Strip tags from an HTML fragment and collapse the whitespace.
  function textFromHtml(html) {
    return decodeEntities(String(html || '')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim());
  }
  DocsSearch.textFromHtml = textFromHtml;

  // The doc id is the canonical Unity API name: the page filename
  // without .html (Transform.TransformPoint, Rigidbody, Vector3).
  function docIdFromEntryName(name) {
    var base = String(name || '').split(/[\\/]/).pop();
    return base.replace(/\.html$/i, '');
  }
  DocsSearch.docIdFromEntryName = docIdFromEntryName;

  function isScriptReferenceEntry(name) {
    return typeof name === 'string'
      && name.indexOf('Documentation/en/ScriptReference/') === 0
      && /\.html$/i.test(name);
  }
  DocsSearch.isScriptReferenceEntry = isScriptReferenceEntry;

  // Extract the searchable text of one ScriptReference page. The
  // current docs site renders the article inside <article>; the
  // navigation tree and app shell around it are noise and are left
  // out. If the page has no <article> (an older snapshot format),
  // the whole body is used instead. The title is the doc id — the
  // filename is the canonical API name.
  function extractDocText(html, entryName) {
    var id = docIdFromEntryName(entryName);
    var source = String(html || '');
    var article = '';
    var a = source.search(/<article[\s>]/i);
    if (a >= 0) {
      var b = source.search(/<\/article>/i);
      if (b > a) article = source.slice(a, b + 10);
    }
    if (!article) {
      var body = source.search(/<body[\s>]/i);
      article = body >= 0 ? source.slice(body) : source;
    }
    // Headings carry the section names (Description, Parameters,
    // Returns, Examples).
    var headings = [];
    var hm = article.match(/<h[123][^>]*>([\s\S]*?)<\/h[123]>/gi) || [];
    for (var i = 0; i < hm.length; i++) {
      var h = textFromHtml(hm[i]);
      if (h) headings.push(h);
    }
    // The article opens with the site header (version banner,
    // language picker) before the <h1>. The searchable text starts
    // at the <h1> — otherwise every lead begins with "Manual
    // Scripting API unity.com Version: Unity 6.3 LTS …" instead of
    // the description.
    var h1 = article.search(/<h1[\s>]/i);
    var contentHtml = h1 >= 0 ? article.slice(h1) : article;
    var bodyText = textFromHtml(contentHtml);
    // The offline archive's pages carry the feedback form inside
    // the article ("Leave feedback … Switch to Manual"). It is the
    // same boilerplate on every page, so it is cut out of the text
    // — otherwise every lead is feedback-form copy instead of the
    // description. If either marker is missing the text is left
    // alone; the widget always sits near the top of the article.
    var fbStart = bodyText.indexOf('Leave feedback');
    if (fbStart >= 0 && fbStart < 1000) {
      var fbEnd = bodyText.indexOf('Switch to Manual', fbStart);
      if (fbEnd > fbStart) {
        bodyText = (bodyText.slice(0, fbStart) + bodyText.slice(fbEnd + 'Switch to Manual'.length)).replace(/\s+/g, ' ').trim();
      }
    }
    // Cap the body so one pathological page cannot bloat the index.
    if (bodyText.length > 200000) bodyText = bodyText.slice(0, 200000);
    return {
      id: id,
      title: id,
      text: bodyText,
      lead: bodyText.slice(0, DocsSearch.LEAD_CHARS),
      // Headings + body, for the body field of the index. The title
      // is indexed separately (fielded BM25), not repeated here.
      indexText: headings.join(' ') + ' ' + bodyText,
    };
  }
  DocsSearch.extractDocText = extractDocText;

  // Build the inverted index from extracted docs. The index is a
  // plain JSON object so it can be written to app data and reloaded
  // without rebuilding: docs are referenced by array position, and
  // postings map term -> {docPos: termFrequency}. Two fields are
  // indexed separately — the title (the API name) and the body
  // (headings + text) — so a title match can outrank a body mention.
  function buildIndex(docs) {
    var index = {
      version: DocsSearch.VERSION,
      format: DocsSearch.INDEX_FORMAT,
      totalDocs: docs.length,
      avgLen: 0,
      df: {},
      postings: {},
      titleAvgLen: 0,
      titleDf: {},
      titlePostings: {},
      docs: [],
    };
    var totalLen = 0;
    var totalTitleLen = 0;
    for (var d = 0; d < docs.length; d++) {
      var tokens = tokenize(docs[d].indexText || docs[d].text || '');
      totalLen += tokens.length;
      var tf = {};
      for (var i = 0; i < tokens.length; i++) {
        tf[tokens[i]] = (tf[tokens[i]] || 0) + 1;
      }
      var terms = Object.keys(tf);
      for (var j = 0; j < terms.length; j++) {
        var term = terms[j];
        index.df[term] = (index.df[term] || 0) + 1;
        if (!index.postings[term]) index.postings[term] = {};
        index.postings[term][d] = tf[term];
      }
      var titleTokens = tokenize(docs[d].title || docs[d].id);
      totalTitleLen += titleTokens.length;
      var titleTf = {};
      for (var k = 0; k < titleTokens.length; k++) {
        titleTf[titleTokens[k]] = (titleTf[titleTokens[k]] || 0) + 1;
      }
      var titleTerms = Object.keys(titleTf);
      for (var t = 0; t < titleTerms.length; t++) {
        var tterm = titleTerms[t];
        index.titleDf[tterm] = (index.titleDf[tterm] || 0) + 1;
        if (!index.titlePostings[tterm]) index.titlePostings[tterm] = {};
        index.titlePostings[tterm][d] = titleTf[tterm];
      }
      index.docs.push({
        id: docs[d].id,
        title: docs[d].title || docs[d].id,
        len: tokens.length,
        titleLen: titleTokens.length,
        lead: (docs[d].lead || (docs[d].text || '').slice(0, DocsSearch.LEAD_CHARS)),
      });
    }
    index.avgLen = docs.length ? totalLen / docs.length : 0;
    index.titleAvgLen = docs.length ? totalTitleLen / docs.length : 0;
    return index;
  }
  DocsSearch.buildIndex = buildIndex;

  function idf(totalDocs, df) {
    return Math.log(1 + (totalDocs - df + 0.5) / (df + 0.5));
  }

  function bm25Term(tf, docLen, avgLen, termIdf) {
    var denom = tf + DocsSearch.BM25_K1 * (1 - DocsSearch.BM25_B + DocsSearch.BM25_B * docLen / (avgLen || 1));
    return termIdf * (tf * (DocsSearch.BM25_K1 + 1)) / denom;
  }

  // The query stripped to bare alphanumerics, for the exact-id
  // check: "GameObject.Find" -> "gameobjectfind".
  function stripId(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  }
  DocsSearch.stripId = stripId;

  // First sentence of the lead that contains a query term, else the
  // first 200 chars of the lead. A sentence that is just the page
  // title ("Transform .TransformPoint") is skipped — it repeats the
  // title the result already shows, and the description is the
  // useful part.
  function snippetFor(lead, queryTokens, title) {
    var text = String(lead || '');
    if (!text) return '';
    var titleStripped = stripId(title || '');
    var sentences = text.split(/(?<=[.!?])\s+/);
    var isTitle = function (s) {
      return !!titleStripped && stripId(s) === titleStripped;
    };
    for (var i = 0; i < sentences.length; i++) {
      if (isTitle(sentences[i])) continue;
      var sLower = sentences[i].toLowerCase();
      for (var j = 0; j < queryTokens.length; j++) {
        if (sLower.indexOf(queryTokens[j]) >= 0) return sentences[i].slice(0, 300);
      }
    }
    // No sentence matched: fall back to the first sentence that is
    // not the title, or the head of the lead.
    for (var k = 0; k < sentences.length; k++) {
      if (sentences[k] && !isTitle(sentences[k])) return sentences[k].slice(0, 300);
    }
    return text.slice(0, 200);
  }
  DocsSearch.snippetFor = snippetFor;

  // Rank the index for a query. Fielded BM25: body score plus the
  // title score weighted by TITLE_WEIGHT. Returns at most
  // maxResults entries: {id, title, score, snippet}. An empty query
  // or an index with no matching term returns [] — never a made-up
  // page. When the query is exactly one API name (the stripped query
  // equals the stripped doc id), that page goes first: a user who
  // types "GameObject.Find" wants that page, not the best-scoring
  // mention of it.
  function search(index, query, maxResults) {
    var limit = maxResults == null ? 5 : Math.max(1, Math.min(20, maxResults | 0));
    if (!index || !index.docs || !index.docs.length) return [];
    var tokens = tokenize(query);
    if (!tokens.length) return [];
    var scores = {};
    var addField = function (postings, dfMap, avgLen, lenField, weight) {
      for (var t = 0; t < tokens.length; t++) {
        var term = tokens[t];
        var df = dfMap[term];
        if (!df) continue;
        var termPostings = postings[term] || {};
        var termIdf = idf(index.totalDocs, df);
        var docKeys = Object.keys(termPostings);
        for (var k = 0; k < docKeys.length; k++) {
          var pos = +docKeys[k];
          var tf = termPostings[docKeys[k]];
          var docLen = index.docs[pos][lenField] || 1;
          scores[pos] = (scores[pos] || 0) + weight * bm25Term(tf, docLen, avgLen, termIdf);
        }
      }
    };
    addField(index.postings || {}, index.df || {}, index.avgLen, 'len', 1);
    // An index built by the old format has no title field; the
    // body score alone still ranks, just less sharply.
    if (index.titlePostings) {
      addField(index.titlePostings, index.titleDf || {}, index.titleAvgLen, 'titleLen', DocsSearch.TITLE_WEIGHT);
    }
    var ranked = Object.keys(scores)
      .map(function (pos) { return { pos: +pos, score: scores[pos] }; })
      .sort(function (a, b) { return b.score - a.score; });
    var stripped = stripId(query);
    var exactPos = -1;
    if (stripped) {
      for (var e = 0; e < index.docs.length; e++) {
        if (stripId(index.docs[e].id) === stripped) { exactPos = e; break; }
      }
    }
    if (exactPos >= 0) {
      var at = -1;
      for (var f = 0; f < ranked.length; f++) if (ranked[f].pos === exactPos) { at = f; break; }
      if (at > 0) {
        var exact = ranked.splice(at, 1)[0];
        ranked.unshift(exact);
      } else if (at < 0) {
        ranked.unshift({ pos: exactPos, score: 0 });
      }
    }
    return ranked.slice(0, limit).map(function (r) {
      var doc = index.docs[r.pos];
      return {
        id: doc.id,
        title: doc.title,
        score: Math.round(r.score * 1000) / 1000,
        snippet: snippetFor(doc.lead, tokens, doc.title),
      };
    });
  }
  DocsSearch.search = search;

  // Unity versions look like 6000.3.9f1 or 2022.3.5f1; the offline
  // docs are filed under the major.minor pair ("6000.3", "2022.3").
  function parseUnityVersion(str) {
    var m = /^(\d+)\.(\d+)/.exec(String(str || '').trim());
    return m ? m[1] + '.' + m[2] : null;
  }
  DocsSearch.parseUnityVersion = parseUnityVersion;

  // The official offline docs archive for a Unity version.
  function docsZipUrl(unityVersion) {
    var mm = parseUnityVersion(unityVersion);
    if (!mm) return null;
    return 'https://cloudmedia-docs.unity3d.com/docscloudstorage/en/' + mm + '/UnityDocumentation.zip';
  }
  DocsSearch.docsZipUrl = docsZipUrl;

  if (typeof module !== 'undefined' && module.exports) module.exports = DocsSearch;
  if (typeof window !== 'undefined') window.DocsSearch = DocsSearch;
})();

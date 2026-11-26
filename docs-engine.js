// docs-engine.js — download, index and search the official Unity
// offline docs (v0.21.0).
//
// Plain Node, no Electron dependency (main.js passes the user-data
// path in). main.js requires it for the docs:* IPCs. The MCP server
// requires it for the docs_search tool.
//
// Where the docs live: <userData>/unity-docs/<version>/ — the zip
// (UnityDocumentation.zip, ~470 MB for 6000.3) and the built
// index.json next to it. Nothing about the docs is ever bundled in
// the repo: the snapshot is downloaded once, on first use, from
// Unity's official offline-docs archive. Until it exists, the docs
// tool says plainly "no docs index yet" and points at the download
// action.
//
// The zip is read with a minimal reader (central directory + local
// headers + zlib inflate) so the app needs no zip dependency. The
// index is built by streaming the ScriptReference entries out of the
// zip one at a time — the HTML pages are never written to disk, only
// the index is kept.

(function () {
  'use strict';

  var fs = require('fs');
  var path = require('path');
  var os = require('os');
  var https = require('https');
  var zlib = require('zlib');
  var DocsSearch = require('./docs-search');

  var DocsEngine = {};

  DocsEngine.VERSION = '0.21.0';

  // The official Unity offline docs page links this archive per
  // version; verified 2026-11-26 (HEAD: HTTP 200, 473,796,481 bytes
  // for 6000.3, 41,865 entries, 35,602 ScriptReference pages).
  DocsEngine.DOCS_ZIP_HOST = 'cloudmedia-docs.unity3d.com';

  function docsDir(userDataPath) {
    return path.join(userDataPath, 'unity-docs');
  }
  DocsEngine.docsDir = docsDir;

  function versionDir(userDataPath, version) {
    return path.join(docsDir(userDataPath), version);
  }

  function zipPathFor(userDataPath, version) {
    return path.join(versionDir(userDataPath, version), 'UnityDocumentation.zip');
  }

  function indexPathFor(userDataPath, version) {
    return path.join(versionDir(userDataPath, version), 'index.json');
  }

  // Electron's userData dir, resolved the same way Electron does
  // (app name "codefox"), for the standalone MCP server process.
  function resolveUserDataDir() {
    if (process.platform === 'win32') {
      return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'codefox');
    }
    if (process.platform === 'darwin') {
      return path.join(os.homedir(), 'Library', 'Application Support', 'codefox');
    }
    return path.join(os.homedir(), '.config', 'codefox');
  }
  DocsEngine.resolveUserDataDir = resolveUserDataDir;

  // ── Minimal ZIP reader ──────────────────────────────────────────
  //
  // Reads the end-of-central-directory record, then the central
  // directory, then individual entries through their local headers.
  // Only stored (method 0) and deflated (method 8) entries are
  // supported — that is what Unity's archive contains.

  function findEocd(buf) {
    // EOCD is at most 64 KB of comment + 22 bytes from the end.
    var start = Math.max(0, buf.length - 65557);
    for (var i = buf.length - 22; i >= start; i--) {
      if (buf.readUInt32LE(i) === 0x06054b50) return i;
    }
    return -1;
  }

  // Returns [{name, method, compressedSize, localHeaderOffset}].
  function listZipEntries(zipPath) {
    var fd = fs.openSync(zipPath, 'r');
    try {
      var stat = fs.fstatSync(fd);
      var tailLen = Math.min(stat.size, 65557);
      var tail = Buffer.alloc(tailLen);
      fs.readSync(fd, tail, 0, tailLen, stat.size - tailLen);
      var eocdOff = findEocd(tail);
      if (eocdOff < 0) throw new Error('Not a zip file (no end-of-central-directory record).');
      var cdCount = tail.readUInt16LE(eocdOff + 10);
      var cdSize = tail.readUInt32LE(eocdOff + 12);
      var cdOffset = tail.readUInt32LE(eocdOff + 16);
      var cd = Buffer.alloc(cdSize);
      fs.readSync(fd, cd, 0, cdSize, cdOffset);
      var entries = [];
      var p = 0;
      for (var i = 0; i < cdCount; i++) {
        if (cd.readUInt32LE(p) !== 0x02014b50) throw new Error('Bad central directory entry at offset ' + p + '.');
        var method = cd.readUInt16LE(p + 10);
        var compressedSize = cd.readUInt32LE(p + 20);
        var nameLen = cd.readUInt16LE(p + 28);
        var extraLen = cd.readUInt16LE(p + 30);
        var commentLen = cd.readUInt16LE(p + 32);
        var localHeaderOffset = cd.readUInt32LE(p + 42);
        var name = cd.toString('utf8', p + 46, p + 46 + nameLen);
        entries.push({ name: name, method: method, compressedSize: compressedSize, localHeaderOffset: localHeaderOffset });
        p += 46 + nameLen + extraLen + commentLen;
      }
      return entries;
    } finally {
      fs.closeSync(fd);
    }
  }
  DocsEngine.listZipEntries = listZipEntries;

  // Reads one entry's bytes (inflating when deflated).
  function readZipEntry(zipPath, entry) {
    if (entry.method !== 0 && entry.method !== 8) {
      throw new Error('Unsupported zip compression method ' + entry.method + ' for ' + entry.name + '.');
    }
    var fd = fs.openSync(zipPath, 'r');
    try {
      var lh = Buffer.alloc(30);
      fs.readSync(fd, lh, 0, 30, entry.localHeaderOffset);
      if (lh.readUInt32LE(0) !== 0x04034b50) throw new Error('Bad local header for ' + entry.name + '.');
      var nameLen = lh.readUInt16LE(26);
      var extraLen = lh.readUInt16LE(28);
      var dataStart = entry.localHeaderOffset + 30 + nameLen + extraLen;
      var compressed = Buffer.alloc(entry.compressedSize);
      fs.readSync(fd, compressed, 0, entry.compressedSize, dataStart);
      if (entry.method === 0) return compressed;
      return zlib.inflateRawSync(compressed);
    } finally {
      fs.closeSync(fd);
    }
  }
  DocsEngine.readZipEntry = readZipEntry;

  // ── Index build ─────────────────────────────────────────────────

  function buildIndexFromZip(zipPath, version) {
    var entries = listZipEntries(zipPath);
    var refEntries = entries.filter(function (e) { return DocsSearch.isScriptReferenceEntry(e.name); });
    var docs = [];
    for (var i = 0; i < refEntries.length; i++) {
      var html = readZipEntry(zipPath, refEntries[i]).toString('utf8');
      docs.push(DocsSearch.extractDocText(html, refEntries[i].name));
    }
    var index = DocsSearch.buildIndex(docs);
    index.unityVersion = version;
    index.builtAt = new Date().toISOString();
    return index;
  }
  DocsEngine.buildIndexFromZip = buildIndexFromZip;

  // ── Download ────────────────────────────────────────────────────

  var currentDownload = null; // {version, phase, downloaded, total} | null

  function downloadWithRedirects(url, destPath, onProgress) {
    return new Promise(function (resolve, reject) {
      var redirects = 0;
      function get(u) {
        var req = https.get(u, { headers: { 'User-Agent': 'CodeFox/0.21.0' } }, function (res) {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            if (++redirects > 5) { req.destroy(); reject(new Error('Too many redirects downloading the Unity docs.')); return; }
            res.resume();
            get(res.headers.location);
            return;
          }
          if (res.statusCode !== 200) {
            res.resume();
            reject(new Error('Unity docs download failed: HTTP ' + res.statusCode + '.'));
            return;
          }
          var total = parseInt(res.headers['content-length'] || '0', 10) || 0;
          var downloaded = 0;
          var out = fs.createWriteStream(destPath);
          res.on('data', function (chunk) {
            downloaded += chunk.length;
            if (currentDownload) { currentDownload.downloaded = downloaded; currentDownload.total = total; }
            if (onProgress) onProgress({ phase: 'download', downloaded: downloaded, total: total });
          });
          res.on('error', function (e) { out.destroy(); reject(e); });
          out.on('error', reject);
          out.on('finish', function () { resolve({ downloaded: downloaded, total: total }); });
          res.pipe(out);
        });
        req.on('error', reject);
        req.setTimeout(60000, function () { req.destroy(new Error('Unity docs download timed out.')); });
      }
      get(url);
    });
  }

  // Downloads the official archive for a Unity version and builds
  // the index. Returns {ok, version, pageCount, indexBytes} or
  // {ok:false, error}. Progress is reported through the module-level
  // currentDownload, which status() reads — the renderer polls it.
  async function downloadDocs(userDataPath, unityVersion, onProgress) {
    var version = DocsSearch.parseUnityVersion(unityVersion);
    if (!version) return { ok: false, error: 'Cannot work out the Unity version from "' + unityVersion + '" — expected something like 6000.3.9f1.' };
    var url = DocsSearch.docsZipUrl(version);
    var dir = versionDir(userDataPath, version);
    fs.mkdirSync(dir, { recursive: true });
    var zipPath = zipPathFor(userDataPath, version);
    currentDownload = { version: version, phase: 'download', downloaded: 0, total: 0 };
    try {
      await downloadWithRedirects(url, zipPath, onProgress);
      currentDownload.phase = 'index';
      if (onProgress) onProgress({ phase: 'index', downloaded: 0, total: 0 });
      var index = buildIndexFromZip(zipPath, version);
      var indexPath = indexPathFor(userDataPath, version);
      var json = JSON.stringify(index);
      fs.writeFileSync(indexPath, json, 'utf8');
      var done = { ok: true, version: version, pageCount: index.totalDocs, indexBytes: Buffer.byteLength(json) };
      currentDownload = null;
      return done;
    } catch (e) {
      currentDownload = null;
      return { ok: false, error: String(e && e.message || e) };
    }
  }
  DocsEngine.downloadDocs = downloadDocs;

  // ── Status / search ─────────────────────────────────────────────

  var indexCache = {}; // indexPath -> {mtimeMs, index}

  function loadIndex(indexPath) {
    var stat = fs.statSync(indexPath);
    var cached = indexCache[indexPath];
    if (cached && cached.mtimeMs === stat.mtimeMs) return cached.index;
    var index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    indexCache[indexPath] = { mtimeMs: stat.mtimeMs, index: index };
    return index;
  }

  function listIndexedVersions(userDataPath) {
    var base = docsDir(userDataPath);
    if (!fs.existsSync(base)) return [];
    return fs.readdirSync(base).filter(function (name) {
      return fs.existsSync(indexPathFor(userDataPath, name));
    });
  }

  function status(userDataPath) {
    var versions = listIndexedVersions(userDataPath);
    var latest = versions.length ? versions.sort().pop() : null;
    var info = {
      ok: true,
      indexed: !!latest,
      version: latest,
      versions: versions,
      pageCount: 0,
      indexBytes: 0,
      zipPresent: false,
      zipBytes: 0,
      docsDir: docsDir(userDataPath),
      downloading: !!currentDownload,
      downloadPhase: currentDownload ? currentDownload.phase : null,
      downloadedBytes: currentDownload ? currentDownload.downloaded : 0,
      totalBytes: currentDownload ? currentDownload.total : 0,
    };
    if (latest) {
      try {
        var stat = fs.statSync(indexPathFor(userDataPath, latest));
        info.indexBytes = stat.size;
        var index = loadIndex(indexPathFor(userDataPath, latest));
        info.pageCount = index.totalDocs || 0;
      } catch (e) { /* a half-written index reads as not indexed */ }
      try { info.zipBytes = fs.statSync(zipPathFor(userDataPath, latest)).size; info.zipPresent = true; } catch (e) {}
    }
    return info;
  }
  DocsEngine.status = status;

  // Searches the newest indexed version. Returns
  // {ok, results, version, pageCount} or {ok:false, error} — the
  // "no index yet" case is an error the caller shows plainly.
  function searchDocs(userDataPath, query, maxResults) {
    var st = status(userDataPath);
    if (!st.indexed) {
      return {
        ok: false,
        error: 'No Unity docs index yet — download it from Settings → Model → Unity docs (about 470 MB, once).',
      };
    }
    try {
      var index = loadIndex(indexPathFor(userDataPath, st.version));
      // An index built by an older format is refused, not searched
      // wrong — the download action rebuilds it.
      if (index.format !== DocsSearch.INDEX_FORMAT) {
        return { ok: false, error: 'Docs index is from an older CodeFox version — re-download it from Settings → Model → Unity docs.' };
      }
      return {
        ok: true,
        results: DocsSearch.search(index, query, maxResults),
        version: st.version,
        pageCount: index.totalDocs || 0,
      };
    } catch (e) {
      return { ok: false, error: 'Docs index could not be read: ' + String(e && e.message || e) };
    }
  }
  DocsEngine.searchDocs = searchDocs;

  if (typeof module !== 'undefined' && module.exports) module.exports = DocsEngine;
})();

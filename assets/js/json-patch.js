/* ============================================================================
 * json-patch.js — RFC 6902 JSON Patch, applied to plain JSON documents.
 *
 * Used by live-diff.js to apply the diffs returned by the official
 * StatsAPI `feed/live/diffPatch` endpoint (the same delta mechanism the
 * mlb.com Gameday client uses). Supports the full operation set:
 *   add · remove · replace · copy · move · test
 *
 * Deliberate tolerance, matched against the official endpoint's observed
 * behavior (captured 2026-11-27, adjacent timecodes 20260828_203856 →
 * 20260828_203907): an `add` to a numeric array index beyond the current
 * length appends (the endpoint emits `add` with index 3 into a 2-element
 * array), and `copy` may source any reachable pointer. Anything else that
 * fails throws, and the caller re-syncs from the full feed.
 * ==========================================================================*/
(function (global) {
  'use strict';

  function unescapeSegment(seg) {
    return String(seg).replace(/~1/g, '/').replace(/~0/g, '~');
  }

  function parsePointer(path) {
    var raw = String(path == null ? '' : path);
    if (raw === '') return [];
    if (raw.charAt(0) !== '/') throw new Error('invalid JSON pointer: ' + raw);
    return raw.slice(1).split('/').map(unescapeSegment);
  }

  function isArrayIndex(seg) { return /^(0|[1-9]\d*)$/.test(String(seg)); }

  function deepEqual(a, b) {
    if (a === b) return true;
    var aObj = a !== null && typeof a === 'object';
    var bObj = b !== null && typeof b === 'object';
    if (aObj !== bObj) return false;
    if (!aObj) return false; /* covers NaN mismatch (NaN !== NaN) */
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a)) {
      if (a.length !== b.length) return false;
      for (var i = 0; i < a.length; i += 1) if (!deepEqual(a[i], b[i])) return false;
      return true;
    }
    var aKeys = Object.keys(a);
    var bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    for (var j = 0; j < aKeys.length; j += 1) {
      var k = aKeys[j];
      if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
      if (!deepEqual(a[k], b[k])) return false;
    }
    return true;
  }

  function deepClone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  }

  /* Resolve the container + final segment for `path`. Throws when a middle
   * segment cannot be traversed (RFC 6902 §4.1). */
  function locate(doc, path) {
    var parts = parsePointer(path);
    if (parts.length === 0) return { parent: null, key: null, whole: true, parts: [] };
    var current = doc;
    for (var i = 0; i < parts.length - 1; i += 1) {
      var seg = parts[i];
      if (current === null || current === undefined) throw new Error('path not traversable at "' + seg + '" in ' + path);
      if (Array.isArray(current)) {
        if (seg === '-' || !isArrayIndex(seg)) throw new Error('expected array index at "' + seg + '" in ' + path);
        var ai = Number(seg);
        if (ai >= current.length) throw new Error('array index out of range at "' + seg + '" in ' + path);
        current = current[ai];
      } else if (typeof current === 'object') {
        if (!Object.prototype.hasOwnProperty.call(current, seg)) throw new Error('missing key "' + seg + '" in ' + path);
        current = current[seg];
      } else {
        throw new Error('path traverses a scalar at "' + seg + '" in ' + path);
      }
    }
    return { parent: current, key: parts[parts.length - 1], whole: false, parts: parts };
  }

  function getAt(doc, path) {
    var parts = parsePointer(path);
    var current = doc;
    for (var i = 0; i < parts.length; i += 1) {
      var seg = parts[i];
      if (current === null || current === undefined) throw new Error('path not traversable at "' + seg + '" in ' + path);
      if (Array.isArray(current)) {
        if (!isArrayIndex(seg)) throw new Error('expected array index at "' + seg + '" in ' + path);
        var ai = Number(seg);
        if (ai >= current.length) throw new Error('array index out of range at "' + seg + '" in ' + path);
        current = current[ai];
      } else if (typeof current === 'object') {
        if (!Object.prototype.hasOwnProperty.call(current, seg)) throw new Error('missing key "' + seg + '" in ' + path);
        current = current[seg];
      } else {
        throw new Error('path traverses a scalar at "' + seg + '" in ' + path);
      }
    }
    return current;
  }

  function addAt(loc, value) {
    var parent = loc.parent, key = loc.key;
    if (loc.whole) return value; /* replacing the whole document */
    if (Array.isArray(parent)) {
      var at;
      if (key === '-') at = parent.length;
      else {
        if (!isArrayIndex(key)) throw new Error('add to array requires numeric index or "-", got "' + key + '"');
        at = Number(key);
        /* Observed endpoint behavior: add with an index past the end appends. */
        if (at > parent.length) at = parent.length;
      }
      parent.splice(at, 0, value);
      return value;
    }
    if (parent !== null && typeof parent === 'object') {
      parent[key] = value;
      return value;
    }
    throw new Error('add target is not a container at "' + key + '"');
  }

  function removeAt(loc) {
    var parent = loc.parent, key = loc.key;
    if (loc.whole) return undefined;
    if (Array.isArray(parent)) {
      if (!isArrayIndex(key)) throw new Error('remove from array requires numeric index, got "' + key + '"');
      var ai = Number(key);
      if (ai >= parent.length) throw new Error('remove index out of range: ' + key);
      return parent.splice(ai, 1)[0];
    }
    if (parent !== null && typeof parent === 'object') {
      if (!Object.prototype.hasOwnProperty.call(parent, key)) throw new Error('remove of missing key: ' + key);
      var v = parent[key];
      delete parent[key];
      return v;
    }
    throw new Error('remove target is not a container at "' + key + '"');
  }

  function replaceAt(loc, value) {
    var parent = loc.parent, key = loc.key;
    if (loc.whole) return value;
    if (Array.isArray(parent)) {
      if (!isArrayIndex(key)) throw new Error('replace in array requires numeric index, got "' + key + '"');
      var ai = Number(key);
      if (ai >= parent.length) throw new Error('replace index out of range: ' + key);
      var prev = parent[ai];
      parent[ai] = value;
      return prev;
    }
    if (parent !== null && typeof parent === 'object') {
      if (!Object.prototype.hasOwnProperty.call(parent, key)) throw new Error('replace of missing key: ' + key);
      var prevObj = parent[key];
      parent[key] = value;
      return prevObj;
    }
    throw new Error('replace target is not a container at "' + key + '"');
  }

  /**
   * apply(doc, operations) — applies RFC 6902 ops sequentially, mutating doc.
   * Returns doc. Throws on the first invalid op; callers that need atomicity
   * should apply to a clone (live-diff.js does exactly that).
   */
  function apply(doc, operations) {
    if (!Array.isArray(operations)) throw new Error('operations must be an array');
    for (var i = 0; i < operations.length; i += 1) {
      var op = operations[i];
      if (!op || typeof op !== 'object') throw new Error('operation ' + i + ' is not an object');
      var type = String(op.op || '').toLowerCase();
      switch (type) {
        case 'add': {
          var addLoc = locate(doc, op.path);
          var addResult = addAt(addLoc, deepClone(op.value));
          if (addLoc.whole) doc = addResult;
          break;
        }
        case 'remove':
          removeAt(locate(doc, op.path));
          break;
        case 'replace': {
          var repLoc = locate(doc, op.path);
          var repResult = replaceAt(repLoc, deepClone(op.value));
          if (repLoc.whole) doc = repResult;
          break;
        }
        case 'copy': {
          if (op.from === undefined) throw new Error('copy requires "from"');
          var source = deepClone(getAt(doc, op.from));
          var copyLoc = locate(doc, op.path);
          var copyResult = addAt(copyLoc, source);
          if (copyLoc.whole) doc = copyResult;
          break;
        }
        case 'move': {
          if (op.from === undefined) throw new Error('move requires "from"');
          var moved = deepClone(getAt(doc, op.from));
          removeAt(locate(doc, op.from));
          var moveLoc = locate(doc, op.path);
          var moveResult = addAt(moveLoc, moved);
          if (moveLoc.whole) doc = moveResult;
          break;
        }
        case 'test': {
          var actual = getAt(doc, op.path);
          if (!deepEqual(actual, op.value)) throw new Error('test failed at ' + op.path);
          break;
        }
        default:
          throw new Error('unsupported op "' + op.op + '" at operation ' + i);
      }
    }
    return doc;
  }

  var api = { apply: apply, getAt: getAt, deepEqual: deepEqual, parsePointer: parsePointer };

  var root = (typeof window !== 'undefined' && window) || (typeof globalThis !== 'undefined' && globalThis) || global;
  root.JsonPatch = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
}(typeof window !== 'undefined' ? window : globalThis));

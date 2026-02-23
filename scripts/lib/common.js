// scripts/lib/common.js
const fs = require("fs");
const path = require("path");

/**
 * Atomically write JSON to disk (tmp → rename).
 */
function atomicWrite(filePath, dataObj) {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, path.basename(filePath).replace(/\.json$/, ".tmp.json"));
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(dataObj, null, 2));
  fs.renameSync(tmp, filePath);
}

/**
 * Safe JSON.parse with fallback.
 */
function safeJSON(str, fallback = {}) {
  try { return JSON.parse(String(str)); } catch { return fallback; }
}

/**
 * Unique + sorted numeric array.
 */
function uniqSortedNums(arr) {
  return [...new Set(arr.filter(Number.isFinite))].sort((a, b) => a - b);
}

/**
 * Keep the cheapest row per key.
 */
function dedupeCheapestByKey(list, keyFn) {
  const map = new Map();
  for (const row of list) {
    const k = keyFn(row);
    if (!map.has(k) || row.pricePerHourUSD < map.get(k).pricePerHourUSD) {
      map.set(k, row);
    }
  }
  return [...map.values()];
}

/**
 * Guard: skip write if output is empty/invalid.
 *
 * Supports two calling styles (backward compatible):
 *  1) warnAndSkipWriteOnEmpty("aws", rowsArray)
 *  2) warnAndSkipWriteOnEmpty(outputObject, outputPath)  // OCI style
 *
 * Returns true if caller SHOULD SKIP writing.
 */
function warnAndSkipWriteOnEmpty(arg1, arg2) {
  // Style (1): provider name + list
  if (typeof arg1 === "string") {
    const provider = arg1;
    const list = arg2;

    if (!Array.isArray(list) || list.length === 0) {
      console.warn(
        `⚠️ FAILOVER: ${provider} list is empty. Skipping write to keep last-known-good file.`
      );
      return true;
    }
    return false;
  }

  // Style (2): output object + output path (OCI fetcher)
  const outObj = arg1;
  const outPath = arg2;

  if (!outObj || typeof outObj !== "object") {
    console.warn(
      `⚠️ FAILOVER: Output object is invalid. Skipping write${outPath ? ` for ${outPath}` : ""}.`
    );
    return true;
  }

  // A lightweight sanity check: ensure it's not an empty object
  const keys = Object.keys(outObj);
  if (keys.length === 0) {
    console.warn(
      `⚠️ FAILOVER: Output object has no keys. Skipping write${outPath ? ` to ${outPath}` : ""}.`
    );
    return true;
  }

  return false;
}

function logStart(name) {
  console.log(`▶ ${name} ...`);
}
function logDone(name) {
  console.log(`✅ ${name} done`);
}

module.exports = {
  atomicWrite,
  safeJSON,
  uniqSortedNums,
  dedupeCheapestByKey,
  warnAndSkipWriteOnEmpty,
  logStart,
  logDone
};

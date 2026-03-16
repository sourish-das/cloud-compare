// scripts/gcp.linux.js
"use strict";

const fs = require("fs/promises");
const path = require("path");

const {
  buildSeriesUnitRateMaps,
  classifyGcpInstance,
  computeBaseHourlyFromUnitMaps,
  isGcpArmSeries
} = require("./lib/gcp.js");

// -------- config --------
const REGION_LIST = (process.env.GCP_REGIONS || "us-east1")
  .split(",")
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

// NEW: validation-only output path (do not touch gcp.prices.json)
const MACHINE_TYPES_FILE = process.env.GCP_MACHINE_TYPES_FILE || "data/gcp-linux-machine-types.json";
const CATALOG_FILE       = process.env.GCP_CATALOG_FILE       || "data/gcp-linux-catalog.json";
const OUTPUT_FILE        = process.env.GCP_OUTPUT_FILE        || "docs/data/gcp/gcp.linux.prices.json";

const EXCLUDE_PATTERNS = /(ultra(mem|cpu)?|hyper|extreme|-metal|-lssd)/i;

// -------- small helpers --------
async function fileExists(p) { try { await fs.access(p); return true; } catch { return false; } }
function toGiB(mb) { return typeof mb === "number" ? +(mb / 1024).toFixed(2) : undefined; }

function normalizeMachineRecords(raw) {
  if (Array.isArray(raw)) return raw;
  const out = [];
  for (const [region, arr] of Object.entries(raw || {})) {
    for (const it of arr || []) out.push({ ...it, region });
  }
  return out;
}

function uniqueByTypeInRegion(records) {
  const seen = new Set();
  const out = [];
  for (const r of records) {
    const region = (r.region || "").toLowerCase();
    const type = String(r.name || r.instance || "").toLowerCase();
    const key = `${region}|${type}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

function groupByRegion(list) {
  const map = {};
  for (const r of list) {
    const key = (r.region || "").toLowerCase();
    if (!map[key]) map[key] = [];
    map[key].push(r);
  }
  return map;
}

function seriesFromType(t) {
  const m = String(t).toLowerCase().match(/^([a-z0-9]+)-[a-z]+[a-z0-9]*-\d+$/);
  return m ? m[1] : null;
}

(async () => {
  // Load discovery & catalog
  if (!(await fileExists(MACHINE_TYPES_FILE))) {
    throw new Error(`Missing discovery file: ${MACHINE_TYPES_FILE}`);
  }
  if (!(await fileExists(CATALOG_FILE))) {
    throw new Error(`Missing Catalog SKUs file: ${CATALOG_FILE}`);
  }

  const discoveredRaw = await fs.readFile(MACHINE_TYPES_FILE, "utf-8").then(JSON.parse);
  const catalogSkus   = await fs.readFile(CATALOG_FILE, "utf-8").then(JSON.parse);

  const discovered = normalizeMachineRecords(discoveredRaw)
    .map(r => ({
      name: r.name || r.instance,
      region: (r.region || "").toLowerCase() || (r.zone ? String(r.zone).split("-").slice(0,2).join("-") : ""),
      vcpu: r.guestCpus ?? r.vcpu,
      ramGiB: r.memoryMb != null ? toGiB(r.memoryMb) : (r.ramGiB ?? r.ram)
    }))
    .filter(r =>
      r.name &&
      r.region &&
      r.vcpu &&
      r.ramGiB != null &&
      !/^custom-/i.test(r.name) &&
      EXCLUDE_PATTERNS.test(r.name) === false
    );

  const discoveredByRegion = groupByRegion(uniqueByTypeInRegion(discovered));

  // Build unit-rate maps for each region (OnDemand only)
  const unitRatesByRegion = {};
  for (const region of REGION_LIST) {
    unitRatesByRegion[region] = buildSeriesUnitRateMaps(catalogSkus, region);
  }

  const out = [];

  for (const region of REGION_LIST) {
    const unitMapForRegion = unitRatesByRegion[region] || {};
    const types = (discoveredByRegion[region] || []).sort((a,b) => a.name.localeCompare(b.name));

    for (const mt of types) {
      const series = seriesFromType(mt.name);
      if (!series) continue;

      const unitRates = unitMapForRegion[series];
      if (!unitRates || !(unitRates.core > 0) || !(unitRates.ram > 0)) continue;

      const category = classifyGcpInstance(mt.name);
      if (!category) continue;

      const arch = isGcpArmSeries(series) ? "arm" : "x86";
      const perSeriesUnitMap = { [series]: { core: unitRates.core, ram: unitRates.ram } };

      const base = computeBaseHourlyFromUnitMaps(mt.name, perSeriesUnitMap, { discoveredRamGiB: mt.ramGiB });
      if (!(base.price > 0)) continue;

      // Linux (free/open-source) only
      out.push({
        instance: mt.name,
        category,
        vcpu: mt.vcpu,
        ram: mt.ramGiB,
        pricePerHourUSD: +base.price.toFixed(6),
        region,
        os: "Linux",
        series,
        arch,
        source: "composed-validate" // explicit marker for the parallel run
      });
    }
  }

  await fs.mkdir(path.dirname(OUTPUT_FILE), { recursive: true });
  await fs.writeFile(OUTPUT_FILE, JSON.stringify(out, null

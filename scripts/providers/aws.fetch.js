// scripts/providers/aws.fetch.js
// Node 18+ (global fetch)

const path = require("path");
const {
  atomicWrite,
  dedupeCheapestByKey,
  warnAndSkipWriteOnEmpty,
  logStart,
  logDone,
  uniqSortedNums
} = require("../lib/common");

const {
  isWantedEc2Family,
  isBurstableAws,
  isAwsGravitonInstance,
  synthesizeAwsWindowsRows,
  synthesizeAwsRhelRows,
  isPlainRhel,
  filterOnlyPlainRhel
} = require("../lib/aws");

// Region + output
const REGION = process.env.AWS_REGION || "us-east-1";
const OUT = process.env.OUTPUT_PATH || path.join("docs", "data", "aws", "aws.prices.json");

/**
 * Fetch the regional EC2 public price index JSON.
 */
async function fetchAwsIndex() {
  logStart(`[AWS] EC2 PAYG ${REGION}`);
  const url = `https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonEC2/current/${REGION}/index.json`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`[AWS] Pricing HTTP ${r.status}`);
  const j = await r.json();
  logDone(`[AWS] products=${Object.keys(j.products || {}).length}`);
  return j;
}

/**
 * Pick the lowest OnDemand price dimension in USD with an hourly unit.
 * Accept both "Hrs" and "Hour" (AWS uses both).
 */
function pickHourlyUsdMin(onDemandTermsForSku) {
  if (!onDemandTermsForSku) return null;
  const termKey = Object.keys(onDemandTermsForSku)[0];
  if (!termKey) return null;
  const dims = onDemandTermsForSku[termKey]?.priceDimensions || {};
  let best = null;

  for (const dimKey of Object.keys(dims)) {
    const dim = dims[dimKey];
    const unit = String(dim?.unit || "").toLowerCase();

    // Accept units like "Hrs", "Hrs.", "Hour", "Hours"
    if (!(unit.startsWith("hrs") || unit.startsWith("hour"))) continue;

    const usd = Number(dim?.pricePerUnit?.USD);
    if (!Number.isFinite(usd) || usd <= 0) continue;
    if (best === null || usd < best) best = usd;
  }
  return best;
}

/** Normalize memory string like "16 GiB" -> 16 */
function parseGiB(memStr) {
  if (!memStr) return null;
  const n = Number(String(memStr).replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** Normalize OS label (Windows | RHEL | Linux) */
function normOs(val) {
  const s = String(val || "").toLowerCase();
  if (s.startsWith("win")) return "Windows";
  if (/\bred\s*hat\b|\brhel\b/.test(s)) return "RHEL";
  return "Linux";
}

/** Check for clean Windows license-included (no SQL, no BYOL) */
function isWindowsLicenseIncluded(attrs) {
  const os = String(attrs?.operatingSystem || "");
  if (os !== "Windows") return false;

  const lm = String(attrs?.licenseModel || "");
  if (lm && lm !== "License Included") return false;

  const pre = String(attrs?.preInstalledSw || "");
  if (pre && pre !== "NA") return false;

  return true;
}

/**
 * Learn median per‑vCPU RHEL uplift from rows that have BOTH Linux and RHEL
 * for the same (instance, region). Separate buckets for ARM and x86.
 */
function deriveRegionUplifts(rows) {
  const pairs = { arm: [], x86: [] };

  // Group by (instance, region)
  const byKey = new Map();
  for (const r of rows) {
    const k = `${r.instance}||${r.region}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(r);
  }

  for (const [, arr] of byKey) {
    const linux = arr.find(x => String(x.os).toLowerCase() === "linux");
    const rhel  = arr.find(x => String(x.os).toLowerCase() === "rhel");
    if (!linux || !rhel) continue;

    const v = Number(linux.vcpu);
    const pL = Number(linux.pricePerHourUSD);
    const pR = Number(rhel.pricePerHourUSD);
    if (!Number.isFinite(v) || v <= 0 || !Number.isFinite(pL) || !Number.isFinite(pR) || pR <= pL) continue;

    const inst = String(linux.instance || "").toLowerCase();
    const isArm = /^t4g/.test(inst) || /^c[6-9]g/.test(inst) || /^m[6-9]g/.test(inst) || /^r[6-9]g/.test(inst);
    const bucket = isArm ? "arm" : "x86";

    const uplift = (pR - pL) / v; // $/vCPU/hr
    if (uplift > 0 && uplift < 0.1) pairs[bucket].push(uplift);
  }

  const median = (arr) => {
    if (!arr.length) return null;
    const s = arr.slice().sort((a, b) => a - b);
    const i = Math.floor(s.length / 2);
    return (s.length % 2) ? s[i] : (s[i - 1] + s[i]) / 2;
  };

  return { arm: median(pairs.arm), x86: median(pairs.x86) };
}

async function main() {
  const j = await fetchAwsIndex();

  const products = j.products || {};
  const onDemandTerms = (j.terms && j.terms.OnDemand) || {};

  const rows = [];

  for (const sku in products) {
    const p = products[sku];
    if (!p || p.productFamily !== "Compute Instance") continue;

    const a = p.attributes || {};
    const inst = a.instanceType;
    if (!inst || !isWantedEc2Family(inst)) continue;

    // Exclude burstable (T-class)
    if (isBurstableAws(inst)) continue;

    // Tenancy/capacity
    if (a.tenancy !== "Shared") continue;
    if (!["Used", "Normal"].includes(a.capacitystatus)) continue;

    // OS classification
    const osRaw = String(a.operatingSystem || "");
    const isLinux = (osRaw === "Linux");
    const isWinOK = isWindowsLicenseIncluded(a);

    const isRhelOK = isPlainRhel(a, {
      productName: p.productName,
      skuName: a.instanceType || a.sku || "",
      meterName: a.usagetype || ""
    });

    if (!(isLinux || isWinOK || isRhelOK)) continue;

    // Windows cannot run on Graviton
    if (isWinOK && isAwsGravitonInstance(inst)) continue;

    const price = pickHourlyUsdMin(onDemandTerms[sku]);
    if (!(price > 0)) continue;

    const vcpu = a.vcpu ? Number(a.vcpu) : null;
    const ram = parseGiB(a.memory);

    rows.push({
      instance: inst,
      vcpu,
      ram,
      pricePerHourUSD: price,
      region: REGION,
      os: normOs(osRaw),
      source: "catalog"
    });
  }

  // --- Learn region uplift(s) from any Linux+RHEL pairs (ARM / x86)
  try {
    const learned = deriveRegionUplifts(rows);
    if (learned.arm != null || learned.x86 != null) {
      const rateMap = {};
      rateMap[REGION] = null;              // region entry not used when arch keys exist
      if (learned.arm != null) rateMap._arm = learned.arm;
      if (learned.x86 != null) rateMap._x86 = learned.x86;

      process.env.AWS_RHEL_RATE_PER_VCPU_MAP = JSON.stringify(rateMap);
      console.log(`[AWS] Learned RHEL uplift(s):`, learned);
    } else {
      console.log(`[AWS] No Linux+RHEL pairs found to learn uplift this run.`);
    }
  } catch (e) {
    console.warn(`[AWS] Failed to learn RHEL uplift:`, e?.message || e);
  }

  // Synthesize Windows rows (if missing)
  const beforeWin = rows.filter(r => r.os === "Windows").length;
  if (beforeWin === 0) {
    const added = synthesizeAwsWindowsRows(rows);
    console.log(`[AWS] Windows rows missing; synthesized ${added} rows.`);
  }

  // Synthesize RHEL rows (if missing) — will use learned rates when present
  const beforeRhel = rows.filter(r => r.os === "RHEL").length;
  if (beforeRhel === 0) {
    const added = synthesizeAwsRhelRows(rows);
    console.log(`[AWS] RHEL rows missing; synthesized ${added} rows.`);
  }

  // Remove SQL/HA/SAP variants defensively
  const hardened = filterOnlyPlainRhel(rows);

  // Deduplicate lowest price for each (instance, region, OS)
  const cheapest = dedupeCheapestByKey(
    hardened,
    r => `${r.instance}-${r.region}-${r.os}`
  );

  const countsByOs = cheapest.reduce((acc, r) => {
    acc[r.os] = (acc[r.os] || 0) + 1;
    return acc;
  }, {});

  console.log(
    `[AWS] collected=${rows.length}, hardened=${hardened.length}, cheapest=${cheapest.length}, byOS=`,
    countsByOs
  );

  if (warnAndSkipWriteOnEmpty("AWS", cheapest)) return;

  const meta = {
    os: ["Linux", "RHEL", "Windows"],
    vcpu: uniqSortedNums(cheapest.map(x => x.vcpu)),
    ram: uniqSortedNums(cheapest.map(x => x.ram))
  };

  const storage = {
    region: REGION,
    ssd_per_gb_month: 0.08,
    hdd_st1_per_gb_month: 0.045
  };

  const out = { meta, compute: cheapest, storage };
  atomicWrite(OUT, out);
  console.log(`✅ Wrote ${OUT}`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});

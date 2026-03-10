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
  // NEW strict helpers from lib/aws.js
  isPlainRhel,
  filterOnlyPlainRhel
} = require("../lib/aws");

// Region + output
const REGION = process.env.AWS_REGION || "us-east-1";
const OUT = process.env.OUTPUT_PATH || path.join("docs", "data", "aws", "aws.prices.json");

/**
 * Fetch the regional EC2 public price index JSON.
 * https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonEC2/current/<REGION>/index.json
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
 * (A few SKUs expose >1 dimension; choose the cheapest defensively.)
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
    if (!unit.startsWith("hrs")) continue;
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

/** Normalize OS label for rows (Windows | RHEL | Linux) with strict word boundaries */
function normOs(val) {
  const s = String(val || "").toLowerCase();
  if (s.startsWith("win")) return "Windows";
  if (/\bred\s*hat\b|\brhel\b/.test(s)) return "RHEL";
  return "Linux";
}

/** True if this product is a clean Windows Server license-included VM (no SQL, no BYOL) */
function isWindowsLicenseIncluded(attrs) {
  const os = String(attrs?.operatingSystem || "");
  if (os !== "Windows") return false;

  // Exclude BYOL; prefer "License Included" only
  const lm = String(attrs?.licenseModel || "");
  if (lm && lm !== "License Included") return false;

  // Exclude any SQL preinstalled variants; we want plain Windows Server
  const pre = String(attrs?.preInstalledSw || "");
  if (pre && pre !== "NA") return false;

  return true;
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

    // ❗ Exclude burstable T-class at source for enterprise consistency
    if (isBurstableAws(inst)) continue;

    // Capacity and tenancy filters
    if (a.tenancy !== "Shared") continue;
    if (!["Used", "Normal"].includes(a.capacitystatus)) continue;

    // OS filters (Linux, Windows, RHEL-plain only)
    const osRaw   = String(a.operatingSystem || "");
    const isLinux = (osRaw === "Linux");
    const isWinOK = isWindowsLicenseIncluded(a);
    const isRhelOK = isPlainRhel(a, {
      productName: p.productName,
      skuName: a.instanceType || a.sku || "",
      meterName: a.usagetype || ""
    });

    if (!(isLinux || isWinOK || isRhelOK)) continue;

    // Exclude Graviton shapes for Windows (no public Windows AMIs on Graviton)
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

  // (Optional) Synthesize Windows if missing
  const beforeWin = rows.filter(r => r.os === "Windows").length;
  if (beforeWin === 0) {
    const added = synthesizeAwsWindowsRows(rows);
    console.log(`[AWS] Windows rows were absent; synthesized ${added} from Linux via uplift.`);
  }

  // (Optional) Synthesize RHEL (plain) if missing
  const beforeRhel = rows.filter(r => r.os === "RHEL").length;
  if (beforeRhel === 0) {
    const added = synthesizeAwsRhelRows(rows);
    console.log(`[AWS] RHEL rows were absent; synthesized ${added} from Linux via uplift.`);
  }

  // Final safety: remove any RHEL rows that look like SQL/SAP/HA variants
  const hardened = filterOnlyPlainRhel(rows);

  // Keep the cheapest per (instance, region, OS)
  const cheapest = dedupeCheapestByKey(
    hardened,
    r => `${r.instance}-${r.region}-${r.os}`
  );

  const countsByOs = cheapest.reduce((acc, r) => {
    acc[r.os] = (acc[r.os] || 0) + 1; return acc;
  }, {});
  console.log(`[AWS] collected=${rows.length}, hardened=${hardened.length}, cheapest=${cheapest.length}, byOS=`, countsByOs);

  if (warnAndSkipWriteOnEmpty("AWS", cheapest)) return;

  const meta = {
    os: ["Linux", "RHEL", "Windows"],
    vcpu: uniqSortedNums(cheapest.map(x => x.vcpu)),
    ram:  uniqSortedNums(cheapest.map(x => x.ram))
  };

  // Storage placeholders (you model EBS in UI; these are baseline list prices)
  const storage = {
    region: REGION,
    ssd_per_gb_month: 0.08,     // gp3 (ballpark)
    hdd_st1_per_gb_month: 0.045 // st1 (ballpark)
  };

  const out = { meta, compute: cheapest, storage };
  atomicWrite(OUT, out);
  console.log(`✅ Wrote ${OUT}`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});

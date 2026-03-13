// scripts/providers/azure.fetch.rhel.test.js
// Node 18+ (global fetch) — Isolated test fetcher for Azure RHEL SKUs

const fs = require("fs");
const path = require("path");
const {
  atomicWrite,
  dedupeCheapestByKey,
  warnAndSkipWriteOnEmpty,
  logStart,
  logDone,
  uniqSortedNums
} = require("../lib/common");

// IMPORTANT: use the shim that adds granular paid-Linux flags
const {
  // Classifiers & helpers (inherited from main + overridden getRetailOsInfo)
  getRetailOsInfo,
  isWindowsRetailEligible,           // unused in RHEL-only path, kept for parity
  isLinuxRetailEligible,             // unused here, we filter specific paid Linux variant
  extractRetailHourlyUSD,
  normalizeAzureInstanceName,
  isAzureArmInstance,
  isBurstableAzure,

  // Enrichment + categorization + naming (same as prod)
  getResourceSkusMap,
  categorizeByInstanceName,
  widenAzureSeries,
  azureDisplayNameFromNormalized,
  azureSeriesFromNormalized,
  azureSeriesNameFromNormalized
} = require("../lib/azure_rhel_test");

// Write to an isolated test path
const OUT = process.env.OUTPUT_PATH || path.join("docs", "data", "azure", "_test", "azure.rhel.prices.json");
const REGION = process.env.AZURE_REGION || "eastus";
const LINUX_VARIANT = String(process.env.AZURE_LINUX_VARIANT || "rhel").toLowerCase();

/* ---------------- fetch with retry ---------------- */
async function fetchWithRetry(url, retries = 6) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": "cloud-compare/azure-rhel-test (+https://github.com/sourish-das/cloud-compare)"
        }
      });
      if (res.ok) return res.json();
      console.warn(`[Azure:RHEL-TEST] Retail HTTP ${res.status} on attempt ${i + 1}/${retries}`);
    } catch (err) {
      console.warn(`[Azure:RHEL-TEST] Retail error on attempt ${i + 1}/${retries} → ${err.message}`);
    }
    const delay = Math.min(1000 * Math.pow(2, i), 10000); // 1s, 2s, 4s, 8s, 10s cap
    await new Promise(res => setTimeout(res, delay));
  }
  throw new Error(`[Azure:RHEL-TEST] Retail failed after ${retries} retries → ${url}`);
}

/* ---------------- retail pages ---------------- */
async function fetchRetailPrices() {
  logStart(`[Azure:RHEL-TEST] Retail (PAYG) ${REGION}`);

  const base =
    `https://prices.azure.com/api/retail/prices` +
    `?$filter=serviceName eq 'Virtual Machines' and armRegionName eq '${REGION}' and type eq 'Consumption'`;

  const items = [];
  let next = base, pages = 0, MAX = 200;

  while (next && pages < MAX) {
    const j = await fetchWithRetry(next);
    items.push(...(j.Items || []));
    next = j.NextPageLink || null;
    pages++;
    if (pages % 5 === 0) {
      console.log(`[Azure:RHEL-TEST] paged=${pages}, accumulated=${items.length}`);
    }
  }

  logDone(`[Azure:RHEL-TEST] Retail count=${items.length}`);
  return items;
}

/* ---------------- MAIN ---------------- */
async function main() {
  const retail = await fetchRetailPrices();

  const rows = [];
  for (const it of retail) {
    // Require PRIMARY meters (prevent secondary meters from winning)
    if (it?.isPrimaryMeterRegion !== true) continue;

    // Exclude discounted/alt offers by text (defense-in-depth)
    const blob = [
      it.productName, it.skuName, it.meterName, it.armSkuName, it.retailPriceType
    ].filter(Boolean).join(" ").toLowerCase();

    if (/\bpromo\b/.test(blob)) continue;
    if (/dev\s*\/?\s*test|devtest|msdn/i.test(blob)) continue;
    if (/spot|low\s*priority/i.test(blob)) continue;
    if (/reservation|reserved/i.test(blob)) continue;
    if (/savings\s*plan/i.test(blob)) continue;
    if (/\bahb\b|hybrid\s*benefit/i.test(blob)) continue;

    // Hourly price only
    const price = extractRetailHourlyUSD(it);
    if (!(price > 0)) continue;

    // Use full name, do NOT split (prevents collapsing D2s v5 -> D2s)
    const instRaw = it.armSkuName || it.skuName || "";
    if (!instRaw) continue;

    const instance = normalizeAzureInstanceName(instRaw);
    if (!instance) continue;
    if (!widenAzureSeries(instance)) continue;

    // Exclude burstable at source (B-series)
    if (isBurstableAzure(instance)) continue;

    // OS eligibility (RHEL-only in this test)
    const osInfo = getRetailOsInfo(it);
    if (osInfo.os !== "Linux") continue;

    // Variant filtering (default: RHEL)
    if (LINUX_VARIANT === "rhel") {
      if (!osInfo.isRhel) continue;
    } else if (LINUX_VARIANT === "sles") {
      if (!osInfo.isSles) continue;
    } else if (LINUX_VARIANT === "ubuntu-pro") {
      if (!osInfo.isUbuntuPro) continue;
    } else if (LINUX_VARIANT === "oracle") {
      if (!osInfo.isOracleLinux) continue;
    } else {
      // Explicitly skip free Linux in this test
      continue;
    }

    rows.push({
      instance,
      displayInstance: azureDisplayNameFromNormalized(instance),
      series:         azureSeriesFromNormalized(instance),
      seriesName:     azureSeriesNameFromNormalized(instance),

      pricePerHourUSD: price,
      region: REGION,
      os: "Linux",
      linuxVariant: LINUX_VARIANT,
      source: "retail"
    });
  }

  // Deduplicate by (instance, region, os) — safe here since this file has only paid Linux
  const cheapest = dedupeCheapestByKey(rows, r => `${r.instance}-${r.region}-${r.os}`);
  const countsByOs = cheapest.reduce((a, r) => (a[r.os] = (a[r.os] || 0) + 1, a), {});
  console.log(`[Azure:RHEL-TEST] collected=${rows.length}, cheapest=${cheapest.length}, byOS=`, countsByOs);
  if (warnAndSkipWriteOnEmpty("Azure:RHEL-TEST", cheapest)) return;

  // Enrich with ResourceSkus if available (uses same ARM token + cross-walk)
  const subscriptionId = process.env.AZURE_SUBSCRIPTION_ID;
  const armToken = process.env.ARM_TOKEN;

  const skuMap =
    subscriptionId && armToken
      ? await getResourceSkusMap({ subscriptionId, region: REGION, armToken })
      : new Map();

  for (const vm of cheapest) {
    const spec = skuMap.get(String(vm.instance).toLowerCase());
    vm.vcpu = (spec?.vcpu ?? null);
    vm.ram  = (spec?.ram  ?? null);
    vm.category = categorizeByInstanceName(vm.instance);
  }

  const meta = {
    os: ["Linux"],              // rows are Linux (paid variant)
    linuxVariant: LINUX_VARIANT,
    vcpu: uniqSortedNums(cheapest.map(x => x.vcpu)),
    ram:  uniqSortedNums(cheapest.map(x => x.ram))
  };

  // Safety: ensure directory exists (workflow already makes it; keep robust)
  try { fs.mkdirSync(path.dirname(OUT), { recursive: true }); } catch {}

  const out = { meta, compute: cheapest /*, storage: undefined */ };
  atomicWrite(OUT, out);
  console.log(`✅ Wrote ${OUT}`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
``

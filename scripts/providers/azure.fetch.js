// scripts/providers/azure.fetch.js
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
  // Robust helpers
  getRetailOsInfo,
  isWindowsRetailEligible,
  isLinuxRetailEligible,
  extractRetailHourlyUSD,
  normalizeAzureInstanceName,
  isAzureArmInstance,
  isBurstableAzure,

  // Existing helpers
  getResourceSkusMap,
  categorizeByInstanceName,
  widenAzureSeries,

  // NEW: UI naming helpers
  azureDisplayNameFromNormalized,
  azureSeriesFromNormalized,
  azureSeriesNameFromNormalized
} = require("../lib/azure");

// Write to docs/data by default (workflow can override)
const OUT = process.env.OUTPUT_PATH || path.join("docs", "data", "azure", "azure.prices.json");
const REGION = process.env.AZURE_REGION || "eastus";

/* ---------------- fetch with retry ---------------- */
async function fetchWithRetry(url, retries = 6) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return res.json();
      console.warn(`[Azure] Retail HTTP ${res.status} on attempt ${i + 1}/${retries}`);
    } catch (err) {
      console.warn(`[Azure] Retail error on attempt ${i + 1}/${retries} → ${err.message}`);
    }
    await new Promise(res => setTimeout(res, 1500 * Math.pow(2, i)));
  }
  throw new Error(`[Azure] Retail failed after ${retries} retries → ${url}`);
}

/* ---------------- retail pages ---------------- */
async function fetchRetailPrices() {
  logStart(`[Azure] Retail (PAYG) ${REGION}`);

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
  }

  logDone(`[Azure] Retail count=${items.length}`);
  return items;
}

/* ---------------- MAIN ---------------- */
async function main() {
  const retail = await fetchRetailPrices();

  const rows = [];
  for (const it of retail) {
    // Require PRIMARY meters (prevent secondary meters from winning)
    if (it?.isPrimaryMeterRegion !== true) continue; // <-- IMPORTANT

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

    // OS eligibility
    const { os } = getRetailOsInfo(it);
    if (os === "Linux") {
      if (!isLinuxRetailEligible(it)) continue;       // free Linux only
    } else if (os === "Windows") {
      if (!isWindowsRetailEligible(it)) continue;     // license-included, no SQL/DevTest/BYOL/preinstalled
      if (isAzureArmInstance(instance)) continue;     // block ARM (Bpsv2 / Dpsv5 / Dpldsv5 / Epsv5)
    } else {
      continue;
    }

    rows.push({
      instance,
      // NEW: UI-friendly fields
      displayInstance: azureDisplayNameFromNormalized(instance),
      series: azureSeriesFromNormalized(instance),
      seriesName: azureSeriesNameFromNormalized(instance),

      pricePerHourUSD: price,
      region: REGION,
      os,
      source: "retail"
    });
  }

  // Deduplicate by (instance, region, os)
  const cheapest = dedupeCheapestByKey(rows, r => `${r.instance}-${r.region}-${r.os}`);
  const countsByOs = cheapest.reduce((a, r) => (a[r.os] = (a[r.os] || 0) + 1, a), {});
  console.log(`[Azure] collected=${rows.length}, cheapest=${cheapest.length}, byOS=`, countsByOs);
  if (warnAndSkipWriteOnEmpty("Azure", cheapest)) return;

  // Enrich with ResourceSkus if available
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
    os: ["Linux", "Windows"],
    vcpu: uniqSortedNums(cheapest.map(x => x.vcpu)),
    ram:  uniqSortedNums(cheapest.map(x => x.ram))
  };

  // Storage (monthly) — UI converts to hourly
  const storage = {
    region: REGION,
    ssd_monthly: { 128: 9.6, 256: 19.2 },
    hdd_monthly: { 128: 5.888, 256: 11.328 }
  };

  const out = { meta, compute: cheapest, storage };
  atomicWrite(OUT, out);
  console.log(`✅ Wrote ${OUT}`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});

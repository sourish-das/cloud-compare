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
  // New robust helpers
  getRetailOsInfo,
  isWindowsRetailEligible,
  isLinuxRetailEligible,
  extractRetailHourlyUSD,
  normalizeAzureInstanceName,
  isAzureArmInstance,

  // Existing helpers
  getResourceSkusMap,
  categorizeByInstanceName,
  widenAzureSeries
} = require("../lib/azure");

// Output → prefer workflow override, else docs/data (consistent with other providers)
const OUT =
  process.env.OUTPUT_PATH || path.join("docs", "data", "azure", "azure.prices.json");
const REGION = process.env.AZURE_REGION || "eastus";

/* ------------------------------------------------------------------
   🔥 Resilient fetch with retry + backoff
   Handles Azure Retail API 429, 500, 503, network drops, bad pages.
--------------------------------------------------------------------*/
async function fetchWithRetry(url, retries = 6) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        return res.json();
      }
      console.warn(
        `[Azure] Retail HTTP ${res.status} on attempt ${i + 1}/${retries}`
      );
    } catch (err) {
      console.warn(
        `[Azure] Retail error on attempt ${i + 1}/${retries} → ${err.message}`
      );
    }
    // Exponential backoff: 1.5s, 3s, 6s, 12s, 24s...
    await new Promise(res => setTimeout(res, 1500 * Math.pow(2, i)));
  }
  throw new Error(`[Azure] Retail failed after ${retries} retries → ${url}`);
}

/* ------------------------------------------------------------------
   🔥 Retail price fetcher with retry for each page
--------------------------------------------------------------------*/
async function fetchRetailPrices() {
  logStart(`[Azure] Retail (PAYG) ${REGION}`);

  // VM consumption prices for the region
  const base =
    `https://prices.azure.com/api/retail/prices` +
    `?$filter=serviceName eq 'Virtual Machines' and armRegionName eq '${REGION}' and type eq 'Consumption'`;

  const items = [];
  let next = base, pages = 0, MAX = 200;

  while (next && pages < MAX) {
    const j = await fetchWithRetry(next);   // retry wrapper
    items.push(...(j.Items || []));
    next = j.NextPageLink || null;
    pages++;
  }

  logDone(`[Azure] Retail count=${items.length}`);
  return items;
}

/* ------------------------------------------------------------------
   🔥 MAIN
--------------------------------------------------------------------*/
async function main() {
  // 1) Retail prices with retry
  const retail = await fetchRetailPrices();

  // 2) Normalize + strict filtering to standard PAYG
  const rows = [];
  for (const it of retail) {

    // --- Filter out promo/reservation/spot/savings/AHB etc. up front (textual + meta)
    // NOTE: We still rely on isWindowsRetailEligible/isLinuxRetailEligible below for final OS filtering.
    const blob = [
      it.productName, it.skuName, it.meterName, it.armSkuName, it.retailPriceType
    ].filter(Boolean).join(" ").toLowerCase();

    // Common exclusions for pay-as-you-go comparison:
    if (/\bpromo\b/.test(blob)) continue;
    if (/dev\s*\/?\s*test|devtest|msdn/i.test(blob)) continue;
    if (/spot|low\s*priority/i.test(blob)) continue;
    if (/reservation|reserved/i.test(blob)) continue;
    if (/savings\s*plan/i.test(blob)) continue;
    if (/\bahb\b|hybrid\s*benefit/i.test(blob)) continue;

    // --- Must be hourly price
    const price = extractRetailHourlyUSD(it);
    if (!(price > 0)) continue;

    // --- Instance extraction/normalization
    const instRaw = it.armSkuName || (it.skuName ? it.skuName.split(" ")[0] : "");
    if (!instRaw) continue;
    const instance = normalizeAzureInstanceName(instRaw);
    if (!instance) continue;
    if (!widenAzureSeries(instance)) continue;

    // --- OS classification (and special flags)
    const { os } = getRetailOsInfo(it);

    // Final OS acceptance:
    if (os === "Linux") {
      if (!isLinuxRetailEligible(it)) continue;       // exclude paid Linux & Dev/Test
    } else if (os === "Windows") {
      if (!isWindowsRetailEligible(it)) continue;     // exclude SQL/DevTest
      if (isAzureArmInstance(instance)) continue;     // block ARM for Windows
    } else {
      continue; // unknown OS
    }

    rows.push({
      instance,
      pricePerHourUSD: price,
      region: REGION,
      os,
      source: "retail"
    });
  }

  // Keep the cheapest per (instance, region, OS)
  const cheapest = dedupeCheapestByKey(rows, r => `${r.instance}-${r.region}-${r.os}`);
  const countsByOs = cheapest.reduce((a, r) => (a[r.os] = (a[r.os] || 0) + 1, a), {});
  console.log(`[Azure] collected=${rows.length}, cheapest=${cheapest.length}, byOS=`, countsByOs);
  if (warnAndSkipWriteOnEmpty("Azure", cheapest)) return;

  // 3) Optionally enrich with ResourceSkus (vcpu/ram)
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

  // 4) Meta + storage
  const meta = {
    os: ["Linux", "Windows"],
    vcpu: uniqSortedNums(cheapest.map(x => x.vcpu)),
    ram:  uniqSortedNums(cheapest.map(x => x.ram))
  };

  const storage = {
    region: REGION,
    // Example static mappings; swap for a Retail API-based disk fetcher if desired
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

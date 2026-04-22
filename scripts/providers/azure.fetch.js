// scripts/providers/azure.fetch.js
// Fetch Azure retail VM prices and enrich with vCPU/RAM + architecture (PAYG only)
// Output: docs/data/azure/azure.prices.json

const fs = require('fs');
const path = require('path');
const https = require('https');

const {
  isWindowsRetailEligible,
  isLinuxRetailEligible,
  extractRetailHourlyUSD,
  isAzureArmInstance,
  isBurstableAzure,
  normalizeAzureInstanceName,
  fullInstanceFromRetail,
  isPrimaryOnDemandRetailItem,
  getResourceSkusMap,
  azureDisplayNameFromNormalized,
  azureSeriesFromNormalized,
  azureSeriesNameFromNormalized,
  synthesizeAzureRhelRows,
  widenAzureSeries,
} = require('../lib/azure');

const REGION = process.env.AZURE_REGION || 'eastus';
const SUBSCRIPTION_ID = process.env.AZURE_SUBSCRIPTION_ID || '';
const ARM_TOKEN = process.env.ARM_TOKEN || '';
const OUTPUT_PATH = process.env.OUTPUT_PATH || path.join('docs','data','azure','azure.prices.json');

function fetchJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(encodeURI(url), { headers }, (res) => {
      let data = '';
      res.on('data', (d) => (data += d));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
  });
}

// ---------- Retail fetch (PAYG only) with ARM-friendly tokens ----------
async function fetchRetailPrices(region) {
  const base = 'https://prices.azure.com/api/retail/prices';
  let next = `${base}?$filter=` +
    `serviceName eq 'Virtual Machines' and type eq 'Consumption' ` +
    `and (armRegionName eq '${region}' or armRegionName eq '' or armRegionName eq null) ` +
    `and ( ` +
    `  contains(productName,'Virtual Machines') ` +
    `  or contains(tolower(productName),'v5') ` +
    `  or contains(tolower(productName),'asv5') ` +
    `  or contains(tolower(productName),'dplds') ` +
    `  or contains(tolower(skuName),'v5') ` +
    `  or contains(tolower(meterName),'v5') ` +
    `)`;

  const rows = [];
  let pages = 0; const MAXP = 120;
  while (next && pages < MAXP) {
    const j = await fetchJson(next);
    for (const it of (j.Items || [])) {
      // Keep only primary on‑demand VM meters
      if (!isPrimaryOnDemandRetailItem(it)) continue;

      // Hourly price only
      const price = extractRetailHourlyUSD(it);
      if (price == null) continue;

      // Defensive text guards — prevent discounted/alt meters from slipping in
      const blob = [it.productName, it.skuName, it.meterName, it.armSkuName, it.retailPriceType]
        .filter(Boolean).join(' ').toLowerCase();
      if (/\bpromo\b/.test(blob)) continue;                    // promotional
      if (/(dev\s*\/?\s*test|devtest|msdn)/i.test(blob)) continue; // Dev/Test
      if (/(spot|low\s*priority)/i.test(blob)) continue;        // Spot/Low priority
      if (/(reservation|reserved)/i.test(blob)) continue;        // Reservations
      if (/savings\s*plan/i.test(blob)) continue;               // Savings plan
      if (/(\bahb\b|hybrid\s*benefit)/i.test(blob)) continue;  // Azure Hybrid Benefit

      // Instance name: prefer armSkuName; never split
      const instanceRaw = fullInstanceFromRetail(it);
      if (!instanceRaw) continue;
      const instance = normalizeAzureInstanceName(instanceRaw);
      if (!instance) continue;
      if (!widenAzureSeries(instance)) continue;
      if (isBurstableAzure(instance)) continue; // exclude B-series

      // OS eligibility
      const okLinux = isLinuxRetailEligible(it);     // free Linux only
      const okWindows = isWindowsRetailEligible(it); // Windows license-included only
      if (!(okLinux || okWindows)) continue;
      const os = okWindows ? 'Windows' : 'Linux';

      rows.push({
        instance,
        pricePerHourUSD: price,
        region,
        os,
        source: 'retail'
      });
    }
    next = j.NextPageLink || null;
    pages++;
  }
  return rows;
}

function inferArchitecture(name, capsArch) {
  // capsArch like 'Arm64' | 'x64' from ResourceSkus capabilities
  if (typeof capsArch === 'string') {
    const s = capsArch.toLowerCase();
    if (s.includes('arm')) return 'arm';
  }
  return isAzureArmInstance(name) ? 'arm' : 'x86';
}

async function enrichWithSkus(rows) {
  if (!SUBSCRIPTION_ID || !ARM_TOKEN) {
    console.warn('[Azure] Missing SUBSCRIPTION_ID/ARM_TOKEN. vCPU/RAM/arch may be null.');
    return rows.map(r => ({ ...r, architecture: inferArchitecture(r.instance) }));
  }
  const skuMap = await getResourceSkusMap({ subscriptionId: SUBSCRIPTION_ID, region: REGION, armToken: ARM_TOKEN });
  return rows.map(r => {
    const caps = skuMap.get(String(r.instance).toLowerCase()) || null;
    const vcpu = caps?.vcpu ?? null;
    const ram = caps?.ram ?? null;
    const arch = inferArchitecture(r.instance, caps?.CpuArchitecture || caps?.cpuArchitecture);
    return {
      ...r,
      vcpu,
      ram,
      architecture: arch,
      displayInstance: azureDisplayNameFromNormalized(r.instance),
      series: azureSeriesFromNormalized(r.instance),
      seriesName: azureSeriesNameFromNormalized(r.instance),
      category: null // filled later
    };
  });
}

function categorize(row) {
  const inst = String(row.instance || '');
  const lead = inst.startsWith('standard_') ? inst[9] : inst[0];
  if (lead === 'e') return 'memory';
  if (lead === 'f') return 'compute';
  if (lead === 'd') return 'general';
  return 'other';
}

function dedupeBy(keys) {
  return (arr) => {
    const out = [];
    const seen = new Set();
    for (const x of arr) {
      const k = keys.map(k => String(x[k] ?? '')).join('|');
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(x);
    }
    return out;
  };
}

async function main() {
  const baseRows = await fetchRetailPrices(REGION);
  let enriched = await enrichWithSkus(baseRows);

  // Fill category + architecture fallback (for missing caps)
  enriched = enriched.map(r => ({
    ...r,
    category: r.category || categorize(r),
    architecture: r.architecture || inferArchitecture(r.instance)
  }));

  // Synthesize RHEL rows from Linux base (uses azure.js per‑vCPU uplift buckets)
  const added = synthesizeAzureRhelRows(enriched);
  if (added > 0) console.log(`[Azure] RHEL synthesized rows: ${added}`);

  // Stable sort then dedupe by (instance, os, region)
  enriched.sort((a, b) => (a.instance.localeCompare(b.instance) || a.os.localeCompare(b.os)));
  const dedupe = dedupeBy(['instance', 'os', 'region']);
  const finalRows = dedupe(enriched);

  const payload = {
    meta: {
      os: ['Linux', 'RHEL', 'Windows'],
      vcpu: Array.from(new Set(finalRows.map(r => r.vcpu).filter(x => x != null))).sort((a, b) => a - b),
      ram: Array.from(new Set(finalRows.map(r => r.ram).filter(x => x != null))).sort((a, b) => a - b),
    },
    compute: finalRows
  };

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(payload, null, 2));
  console.log(`[Azure] Wrote ${finalRows.length} rows -> ${OUTPUT_PATH}`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});

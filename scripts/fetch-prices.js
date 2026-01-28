// scripts/fetch-prices.js (CommonJS)
// Purpose: Build a compact prices.json with correct AWS On-Demand hourly rates
// and Azure Retail prices for your site (no creds, no backend).

const fetch = require("node-fetch");
const fs = require("fs");

/* ========================
   CONFIG (tune as needed)
   ======================== */

// Primary regions to include
const AWS_REGION = "us-east-1";    // You can switch to "ap-south-1" later
const AZURE_REGION = "eastus";     // Or "centralindia" / "southindia"

// Optional: whitelist popular, general-purpose/compute families to reduce file size
// const AWS_FAMILY_WHITELIST = /^(t3|t3a|t4g|m5|m6g|c5|c6g)/i;
// const MAX_PER_FAMILY = 8;

/* ==============================
   Helpers for AWS price parsing
   ============================== */

// Returns true if a product's attributes look like standard On-Demand, Linux, shared tenancy, used capacity
function isLinuxSharedUsed(attrs) {
  const os   = String(attrs.operatingSystem || "").toLowerCase();
  const ten  = String(attrs.tenancy || "").toLowerCase();
  const pre  = String(attrs.preInstalledSw || "").toLowerCase();
  const cap  = String(attrs.capacitystatus || "").toLowerCase();
  return os === "linux" && ten === "shared" && pre === "na" && cap === "used";
}

// From a single SKU's OnDemand term set, pick the correct *hourly* instance price
function pickHourlyUsd(onDemandTerms) {
  if (!onDemandTerms) return null;

  for (const term of Object.values(onDemandTerms)) {
    for (const dim of Object.values(term.priceDimensions || {})) {
      const unit = String(dim.unit || "").toLowerCase();   // should be "hrs"
      const begin = dim.beginRange;
      const end   = dim.endRange;
      const usd   = Number(dim?.pricePerUnit?.USD);
      const desc  = String(dim.description || "").toLowerCase();

      // Must be instance-hours
      const isHourly = unit === "hrs" && begin === "0" && end === "Inf";
      // Exclude RI/Dedicated/Upfront/Host related dimensions
      const looksReservedOrHost = /reserved instance|upfront fee|dedicated host/i.test(desc);

      if (isHourly && !looksReservedOrHost && !Number.isNaN(usd)) {
        return usd;
      }
    }
  }
  return null;
}

/* ===========================
   AWS: Fetch & parse (Bulk)
   =========================== */
async function fetchAws(region = "us-east-1") {
  const url = `https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonEC2/current/${region}/index.json`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`AWS pricing (${region}) HTTP ${resp.status}`);
  const data = await resp.json();

  let rows = [];

  for (const sku in data.products) {
    const prod = data.products[sku];
    if (prod.productFamily !== "Compute Instance") continue;

    const attrs = prod.attributes || {};
    const instance = attrs.instanceType;
    if (!instance) continue;

    // Only standard On-Demand Linux, shared tenancy, used capacity
    if (!isLinuxSharedUsed(attrs)) continue;

    // OPTIONAL: filter out unwanted families to reduce size
    // if (!AWS_FAMILY_WHITELIST.test(instance)) continue;

    // Extract vCPU and RAM (GiB)
    const vcpu = Number(attrs.vcpu || 0);
    const ram  = Number(String(attrs.memory || "0 GB").split(" ")[0]);

    // Pull the correct hourly pricePerUnit.USD
    const onDemandTerms = data.terms?.OnDemand?.[sku];
    const price = pickHourlyUsd(onDemandTerms);
    if (price == null || price === 0) continue;

    rows.push({
      instance,
      vcpu,
      ram,
      pricePerHourUSD: price,
      region
    });
  }

  // OPTIONAL: cap per family to keep file smaller
  /*
  const grouped = {};
  for (const row of rows) {
    const fam = row.instance.split(".")[0]; // e.g., m5.large -> m5
    grouped[fam] = grouped[fam] || [];
    grouped[fam].push(row);
  }
  rows = Object.values(grouped)
    .flatMap(list => list
      .sort((a, b) =>
        (a.vcpu - b.vcpu) ||
        (a.ram - b.ram)  ||
        (a.pricePerHourUSD - b.pricePerHourUSD)
      )
      .slice(0, MAX_PER_FAMILY)
    );
  */

  return rows;
}

/* ====================================
   Azure Retail Prices API (public)
   ==================================== */
async function fetchAzure(region = "eastus") {
  // NOTE: '&' not '&amp;' in Node.js (the earlier HTML entity causes a bad URL)
  const url = `https://prices.azure.com/api/retail/prices?$filter=serviceName eq 'Virtual Machines' and armRegionName eq '${region}' and priceType eq 'Consumption'&$top=200`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Azure pricing (${region}) HTTP ${resp.status}`);
  const data = await resp.json();

  // Keep the row minimal; vCPU/RAM are inferred in the client script
  return (data.Items || []).map(x => ({
    instance: x.armSkuName || x.skuName || x.meterName || "Unknown",
    pricePerHourUSD: x.unitPrice ?? x.retailPrice ?? null,
    region,
    vcpu: null,
    ram: null
  }));
}

/* ===========================
   Build combined prices.json
   =========================== */
(async () => {
  try {
    const aws   = await fetchAws(AWS_REGION);
    const azure = await fetchAzure(AZURE_REGION);

    const output = {
      meta: {
        os: ["Linux", "Windows"],
        vcpu: [1, 2, 4, 8, 16],
        ram:  [1, 2, 4, 8, 16, 32]
      },
      aws,
      azure
    };

    fs.writeFileSync("data/prices.json", JSON.stringify(output, null, 2));
    console.log(`✅ data/prices.json updated. AWS: ${aws.length} | Azure: ${azure.length}`);
  } catch (e) {
    console.error("❌ Failed to update prices:", e);
    process.exit(1);
  }
})();

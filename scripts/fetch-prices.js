// scripts/fetch-prices.js (CommonJS)
const fetch = require("node-fetch");
const fs = require("fs");

// Fetch AWS EC2 pricing (Bulk Offer File - public)
async function fetchAws(region = "us-east-1") {
  const url = `https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonEC2/current/${region}/index.json`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`AWS pricing (${region}) HTTP ${resp.status}`);
  const data = await resp.json();

  const result = [];

  for (const sku in data.products) {
    const prod = data.products[sku];
    if (prod.productFamily !== "Compute Instance") continue;

    const attrs = prod.attributes || {};
    const instance = attrs.instanceType;
    const vcpu = Number(attrs.vcpu || 0);
    const ram  = Number(String(attrs.memory || "0 GB").split(" ")[0]);

    const onDemand = data.terms?.OnDemand?.[sku];
    if (!onDemand) continue;

    let price = null;
    for (const term of Object.values(onDemand)) {
      for (const dim of Object.values(term.priceDimensions || {})) {
        const usd = Number(dim?.pricePerUnit?.USD);
        if (!isNaN(usd)) price = usd;
      }
    }

    result.push({
      instance,
      vcpu,
      ram,
      pricePerHourUSD: price,
      region
    });
  }

  return result;
}

// Fetch Azure Retail Prices API (public)
async function fetchAzure(region = "eastus") {
  const url = `https://prices.azure.com/api/retail/prices?$filter=serviceName eq 'Virtual Machines' and armRegionName eq '${region}'&$top=200`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Azure pricing (${region}) HTTP ${resp.status}`);
  const data = await resp.json();

  return (data.Items || []).map(x => ({
    instance: x.armSkuName || x.skuName || x.meterName || "Unknown",
    pricePerHourUSD: x.unitPrice ?? x.retailPrice ?? null,
    region,
    vcpu: null,
    ram: null
  }));
}

(async () => {
  try {
    const aws   = await fetchAws("us-east-1"); // change region if needed
    const azure = await fetchAzure("eastus");  // change region if needed

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
    console.log("✅ data/prices.json updated.");
  } catch (e) {
    console.error("❌ Failed to update prices:", e);
    process.exit(1);
  }
})();

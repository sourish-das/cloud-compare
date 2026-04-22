const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const REGION = process.env.AZURE_REGION || 'East US';
const OUTPUT_PATH = process.env.OUTPUT_PATH || 'docs/data/azure/azure.calculator.prices.json';

const OS_TYPES = [
  { os: 'Linux', type: 'Ubuntu', osLabel: 'Linux' },
  { os: 'Linux', type: 'Red Hat Enterprise Linux', osLabel: 'RHEL' },
  { os: 'Windows', type: '(OS Only)', osLabel: 'Windows' }
];

// Series/family mapping for category (optional, can be removed for all series)
function getCategory(series) {
  const s = String(series).toUpperCase();
  if (s.startsWith('D')) return 'general';
  if (s.startsWith('E')) return 'memory';
  if (s.startsWith('F')) return 'compute';
  return null;
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto('https://azure.microsoft.com/en-us/pricing/calculator/', { waitUntil: 'domcontentloaded' });

  // Check if estimator is open; if not, click "Add to estimate" for Virtual Machines
  if (!(await page.$('select[name="region"]'))) {
    // Click the "Virtual Machines" card
    await page.click('text="Virtual Machines"');
    // Click the "Add to estimate" button
    await page.click('button:has-text("Add to estimate")');
    await page.waitForSelector('select[name="region"]', { timeout: 20000 });
  }

  let allRows = [];

  for (const { os, type, osLabel } of OS_TYPES) {
    // Set region
    await page.selectOption('select[name="region"]', { label: REGION });
    // Set OS
    await page.selectOption('select[name="operatingSystem"]', { label: os });
    // Set Type
    await page.selectOption('select[name="type"]', { label: type });
    // Set Tier
    await page.selectOption('select[name="tier"]', { label: 'Standard' });

    // Wait for VM size dropdown to populate
    await page.waitForSelector('select[name="size"]', { timeout: 10000 });

    // Get all VM sizes
    const vmOptions = await page.$$eval('select[name="size"] option', opts =>
      opts.map(o => ({
        value: o.value,
        text: o.textContent.trim()
      }))
    );

    for (const vm of vmOptions) {
      if (!vm.value || vm.value === 'none') continue;

      // Series/family extraction
      const seriesMatch = vm.text.match(/^([A-Z]+)[0-9]/i);
      const series = seriesMatch ? seriesMatch[1] : '';
      const category = getCategory(series);
      // If you want all series, comment out the next line:
      // if (!category) continue; // Only D, E, F series

      // Select VM size
      await page.selectOption('select[name="size"]', vm.value);

      // Wait for price and specs to update
      await page.waitForTimeout(500);

      // Extract price, vCPU, RAM
      let pricePerHourUSD = null, vcpu = null, ram = null;
      try {
        const priceText = await page.$eval('.price', el => el.textContent.trim());
        pricePerHourUSD = parseFloat(priceText.replace(/[^0-9.]/g, '')) || null;
      } catch { /* ignore missing price */ }

      try {
        const specsText = await page.$eval('.specs', el => el.textContent.trim());
        const vcpuMatch = specsText.match(/(\d+)\s*vCPU/i);
        const ramMatch = specsText.match(/(\d+)\s*GB RAM/i);
        vcpu = vcpuMatch ? parseInt(vcpuMatch[1], 10) : null;
        ram = ramMatch ? parseInt(ramMatch[1], 10) : null;
      } catch { /* ignore missing specs */ }

      // Architecture detection (simple heuristic)
      const architecture = /arm|ampere/i.test(vm.text) ? 'arm' : 'x86';

      const instance = vm.value.toLowerCase().replace(/\s+/g, '_');
      const displayInstance = vm.text;
      const seriesName = series + '-series';

      allRows.push({
        instance,
        pricePerHourUSD,
        region: REGION.toLowerCase().replace(/\s+/g, ''),
        os: osLabel,
        source: 'retail',
        vcpu,
        ram,
        architecture,
        displayInstance,
        series,
        seriesName,
        category // can be null if not D/E/F
      });
    }
  }

  await browser.close();

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify({ compute: allRows }, null, 2));
  console.log(`[Azure Calculator] Wrote ${allRows.length} rows -> ${OUTPUT_PATH}`);
})();

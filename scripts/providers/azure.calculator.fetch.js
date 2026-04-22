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

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto('https://azure.microsoft.com/en-us/pricing/calculator/', { waitUntil: 'domcontentloaded' });

  // Wait for the product grid to load
  await page.waitForSelector('button:has-text("Add to estimate")', { timeout: 20000 });

  // Check if estimator is open (region dropdown present)
  let estimatorOpen = await page.$('select[name="region"]');
  if (!estimatorOpen) {
    // Find all "Add to estimate" buttons
    const addButtons = await page.$$('button:has-text("Add to estimate")');
    let clicked = false;
    for (const btn of addButtons) {
      // Check if the button is inside the Virtual Machines card
      const parent = await btn.evaluateHandle(node => node.closest('div'));
      const parentText = await parent.evaluate(node => node.textContent);
      if (parentText && parentText.includes('Virtual Machines')) {
        await btn.click();
        clicked = true;
        break;
      }
    }
    if (!clicked) {
      throw new Error('Could not find "Add to estimate" button for Virtual Machines');
    }
    await page.waitForSelector('select[name="region"]', { timeout: 20000 });
  }

  // If estimator is minimized, expand it
  const expandBtn = await page.$('button[aria-label*="Expand Virtual Machines"]');
  if (expandBtn) {
    await expandBtn.click();
    await page.waitForSelector('select[name="region"]', { timeout: 10000 });
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
      const seriesMatch = vm.text.match(/^([A-Z]+)[0-9]/i);
      const series = seriesMatch ? seriesMatch[1] : '';
      const seriesName = series ? series + '-series' : 'other-series';

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
        category: 'other'
      });
    }
  }

  await browser.close();

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify({ compute: allRows }, null, 2));
  console.log(`[Azure Calculator] Wrote ${allRows.length} rows -> ${OUTPUT_PATH}`);
})();

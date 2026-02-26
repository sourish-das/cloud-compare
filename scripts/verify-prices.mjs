// scripts/verify-prices.mjs
import fs from 'node:fs';

const DATA_PATH = './docs/data/prices.json';  // adjust if yours differs
const HOURS = 730;

function load() {
  const j = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  if (!j) throw new Error('Cannot read prices.json');
  return j;
}

function approxEqual(a, b, pct = 0.02) { // within 2%
  if (a == null || b == null) return false;
  const diff = Math.abs(a - b);
  return diff <= Math.max(pct * Math.max(a, b), 0.0001);
}

function assert(cond, msg) {
  if (!cond) throw new Error(`❌ ${msg}`);
  console.log('✅', msg);
}

function pickGcp(rows, inst, region, os) {
  return rows.find(r =>
    r.instance?.toLowerCase() === inst.toLowerCase() &&
    r.region?.toLowerCase() === region.toLowerCase() &&
    String(r.os || '').toLowerCase() === os.toLowerCase()
  );
}

function pickAws(rows, inst, region, os) {
  return rows.find(r =>
    r.instance?.toLowerCase() === inst.toLowerCase() &&
    r.region?.toLowerCase() === region.toLowerCase() &&
    String(r.os || '').toLowerCase() === os.toLowerCase()
  );
}

function verifyOCI(oci, { vcpu = 2, ram = 4 }) {
  console.log('\n=== OCI checks ===');
  const linux = oci?.linux;
  const windows = oci?.windows;
  assert(linux && typeof linux === 'object', 'OCI.linux block present');
  assert(windows && typeof windows === 'object', 'OCI.windows block present');
  assert(Number.isFinite(windows.license_per_vcpu_hour), 'OCI.windows.license_per_vcpu_hour present');

  const amd = (linux.amd || [])[0];
  const intel = (linux.intel || [])[0];
  assert(amd || intel, 'OCI has at least one x86 entry (amd or intel)');

  const entry = amd || intel;
  assert(Number.isFinite(entry.ocpu_per_hour), 'OCI entry has ocpu_per_hour');
  assert(Number.isFinite(entry.ram_gb_per_hour), 'OCI entry has ram_gb_per_hour');

  // Compute Windows vs Linux for a sample using the formula
  const ocpu = vcpu / 2; // x86 mapping in our matcher
  const baseLinux = ocpu * entry.ocpu_per_hour + ram * entry.ram_gb_per_hour;
  const win = baseLinux + vcpu * windows.license_per_vcpu_hour;

  assert(win > baseLinux, 'OCI Windows hourly > Linux hourly for same shape');
  console.log(`ℹ️  Linux ≈ $${baseLinux.toFixed(4)}/hr  Windows ≈ $${win.toFixed(4)}/hr  (sample)`);
}

function verifyGCP(gcp, { region = 'us-central1' }) {
  console.log('\n=== GCP checks ===');
  assert(Array.isArray(gcp), 'GCP array present');

  // Use e2-standard-2 as canonical general-purpose example (2 vCPU / 8 GiB)
  const linux = pickGcp(gcp, 'e2-standard-2', region, 'linux');
  const win   = pickGcp(gcp, 'e2-standard-2', region, 'windows');

  assert(linux, `GCP Linux row exists for e2-standard-2 @ ${region}`);
  assert(win,   `GCP Windows row exists for e2-standard-2 @ ${region}`);
  assert(Number.isFinite(linux.pricePerHourUSD), 'GCP Linux pricePerHourUSD finite');
  assert(Number.isFinite(win.pricePerHourUSD),   'GCP Windows pricePerHourUSD finite');
  assert(win.pricePerHourUSD > linux.pricePerHourUSD, 'GCP Windows > Linux for same machine');

  // (Optional) If you export windows_per_vcpu somewhere in your build, you could validate the delta ≈ vcpu * premium.
  console.log(`ℹ️  GCP Linux $${linux.pricePerHourUSD.toFixed(4)}, Windows $${win.pricePerHourUSD.toFixed(4)} (e2-standard-2 @ ${region})`);
}

function verifyAWS(aws, { region = 'us-east-1' }) {
  console.log('\n=== AWS checks ===');
  assert(Array.isArray(aws), 'AWS array present');

  // Use t3.medium as canonical example (2 vCPU / 4 GiB)
  const linux = pickAws(aws, 't3.medium', region, 'linux');
  const win   = pickAws(aws, 't3.medium', region, 'windows');

  assert(linux, `AWS Linux row exists for t3.medium @ ${region}`);
  assert(win,   `AWS Windows row exists for t3.medium @ ${region}`);
  assert(Number.isFinite(linux.pricePerHourUSD), 'AWS Linux pricePerHourUSD finite');
  assert(Number.isFinite(win.pricePerHourUSD),   'AWS Windows pricePerHourUSD finite');
  assert(win.pricePerHourUSD > linux.pricePerHourUSD, 'AWS Windows > Linux for same instance');

  console.log(`ℹ️  AWS Linux $${linux.pricePerHourUSD.toFixed(4)}, Windows $${win.pricePerHourUSD.toFixed(4)} (t3.medium @ ${region})`);
}

(function main() {
  const data = load();

  if (data.oci)  verifyOCI(data.oci, { vcpu: 2, ram: 4 });
  if (data.gcp)  verifyGCP(data.gcp, { region: 'us-central1' });
  if (data.aws)  verifyAWS(data.aws, { region: 'us-east-1' });

  console.log('\n✅ Verification completed for OCI, GCP, AWS.\n');
})();

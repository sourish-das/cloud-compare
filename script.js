
const WORKER_BASE = "https://<your-worker>.workers.dev"; // <-- replace

document.addEventListener("DOMContentLoaded", init);

async function init() {
  try {
    // 1) Load dynamic options from /meta
    const metaResp = await fetch(`${WORKER_BASE}/meta`, { method: "GET" });
    const { meta } = await metaResp.json();

    // 2) Populate selects
    fillSelect("region", meta.regions.map(x => ({ value: x.value, text: x.label })));
    fillSelect("os",     meta.os.map(x => ({ value: x.value, text: x.value })));
    fillSelect("cpu",    meta.vcpu.map(v => ({ value: v, text: v })));
    fillSelect("ram",    meta.ram.map(v => ({ value: v, text: v })));

    // 3) (optional) set sensible defaults
    setSelectValue("region", "ap-south-1");
    setSelectValue("os", "Linux");
    setSelectValue("cpu", "2");
    setSelectValue("ram", "4");
  } catch (e) {
    console.error("Failed to load meta:", e);
    alert("Could not load options from the API. Check your Worker URL/CORS.");
  }
}

function fillSelect(id, items) {
  const sel = document.getElementById(id);
  sel.innerHTML = "";
  for (const it of items) {
    const opt = document.createElement("option");
    opt.value = it.value;
    opt.textContent = it.text;
    sel.appendChild(opt);
  }
}
function setSelectValue(id, value) {
  const sel = document.getElementById(id);
  const opt = Array.from(sel.options).find(o => o.value == value);
  if (opt) sel.value = value;
}

async function compare() {
  const region = document.getElementById("region").value;
  const os     = document.getElementById("os").value;
  const vcpu   = document.getElementById("cpu").value;
  const ram    = document.getElementById("ram").value;

  // Show a quick loading state
  document.getElementById("awsInstance").innerText = "Instance: loading...";
  document.getElementById("azInstance").innerText  = "VM Size: loading...";
  document.getElementById("awsPrice").innerText    = "Price/hr: -";
  document.getElementById("azPrice").innerText     = "Price/hr: -";

  try {
    const url = `${WORKER_BASE}/?region=${encodeURIComponent(region)}&os=${encodeURIComponent(os)}&vcpu=${encodeURIComponent(vcpu)}&ram=${encodeURIComponent(ram)}`;
    const resp = await fetch(url);
    const { data } = await resp.json();

    // AWS
    if (!data.aws.error) {
      document.getElementById("awsInstance").innerText = `Instance: ${data.aws.instance}`;
      document.getElementById("awsCpu").innerText      = `vCPU: ${data.aws.vcpu}`;
      document.getElementById("awsRam").innerText      = `RAM: ${data.aws.ram} GB`;
      document.getElementById("awsPrice").innerText    = `Price/hr: $${data.aws.pricePerHourUSD} (≈ $${data.aws.monthlyUSD}/mo)`;
    } else {
      document.getElementById("awsInstance").innerText = `Instance: (error) ${data.aws.error}`;
    }

    // Azure
    if (!data.azure.error) {
      document.getElementById("azInstance").innerText = `VM Size: ${data.azure.instance}`;
      document.getElementById("azCpu").innerText      = `vCPU: ${data.azure.vcpu}`;
      document.getElementById("azRam").innerText      = `RAM: ${data.azure.ram} GB`;
      document.getElementById("azPrice").innerText    = `Price/hr: $${data.azure.pricePerHourUSD} (≈ $${data.azure.monthlyUSD}/mo)`;
    } else {
      document.getElementById("azInstance").innerText = `VM Size: (error) ${data.azure.error}`;
    }

  } catch (e) {
    console.error(e);
    alert("Could not reach the comparison API.");
  }
}

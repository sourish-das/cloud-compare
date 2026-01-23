
const API_BASE = "https://cloud-compare.sourishdas0.workers.dev";

const FALLBACK_META = {
  os:   [{ value: "Linux" }, { value: "Windows" }],
  vcpu: [1, 2, 4, 8, 16],
  ram:  [1, 2, 4, 8, 16, 32]
};

document.addEventListener("DOMContentLoaded", async () => {
  try {
    const r = await fetch(`${API_BASE}/meta`, { mode: "cors" });
    const j = r.ok ? await r.json() : { meta: FALLBACK_META };
    const meta = j.meta || FALLBACK_META;
    fillSelect("os",   meta.os.map(x => ({ value: x.value, text: x.value })));
    fillSelect("cpu",  meta.vcpu.map(v => ({ value: v, text: v })));
    fillSelect("ram",  meta.ram.map(v => ({ value: v, text: v })));
  } catch {
    fillSelect("os",   FALLBACK_META.os.map(x => ({ value: x.value, text: x.value })));
    fillSelect("cpu",  FALLBACK_META.vcpu.map(v => ({ value: v, text: v })));
    fillSelect("ram",  FALLBACK_META.ram.map(v => ({ value: v, text: v })));
  }
  setSelectValue("os", "Linux");
  setSelectValue("cpu", "2");
  setSelectValue("ram", "4");
});

function fillSelect(id, items) {
  const el = document.getElementById(id);
  el.innerHTML = "";
  for (const it of items) {
    const opt = document.createElement("option");
    opt.value = it.value;
    opt.textContent = it.text;
    el.appendChild(opt);
  }
}
function setSelectValue(id, value) {
  const el = document.getElementById(id);
  const match = Array.from(el.options).find(o => o.value == value);
  if (match) el.value = value;
}
function fmt(n)      { return (n == null || isNaN(n)) ? "-" : `$${Number(n).toFixed(4)}`; }
function monthly(ph) { return (ph == null || isNaN(ph)) ? null : ph * 730; }

function setStatus(msg, level="info") {
  const el = document.getElementById("status");
  el.textContent = msg;
  el.style.color = (level === "error") ? "var(--err)" :
                   (level === "warn")  ? "var(--warn)" : "var(--muted)";
}

async function compare() {
  const btn = document.getElementById("compareBtn");
  btn.disabled = true;
  setStatus("Fetching live prices…");

  const os   = document.getElementById("os").value;
  const vcpu = Number(document.getElementById("cpu").value);
  const ram  = Number(document.getElementById("ram").value);

  const url = `${API_BASE}/?os=${encodeURIComponent(os)}&vcpu=${vcpu}&ram=${ram}`;
  try {
    resetCards();

    const r = await fetch(url, { mode: "cors" });
    if (!r.ok) throw new Error(`API ${r.status}`);
    const j = await r.json();

    // AWS
    if (j.data?.aws?.error) {
      document.getElementById("awsInstance").innerText = `Error: ${j.data.aws.error}`;
    } else {
      const a = j.data.aws;
      document.getElementById("awsInstance").innerText = `Instance: ${a.instance} (${j.regionsUsed.aws})`;
      document.getElementById("awsCpu").innerText      = `vCPU: ${a.vcpu}`;
      document.getElementById("awsRam").innerText      = `RAM: ${a.ram} GB`;
      document.getElementById("awsPrice").innerText    = `Price/hr: ${fmt(a.pricePerHourUSD)}`;
      document.getElementById("awsMonthly").innerText  = `≈ Monthly: ${fmt(monthly(a.pricePerHourUSD))}`;
    }

    // Azure
    if (j.data?.azure?.error) {
      document.getElementById("azInstance").innerText = `Error: ${j.data.azure.error}`;
    } else {
      const z = j.data.azure;
      document.getElementById("azInstance").innerText = `VM Size: ${z.instance} (${j.regionsUsed.azure})`;
      document.getElementById("azCpu").innerText      = `vCPU: ${z.vcpu}`;
      document.getElementById("azRam").innerText      = `RAM: ${z.ram} GB`;
      document.getElementById("azPrice").innerText    = `Price/hr: ${fmt(z.pricePerHourUSD)}`;
      document.getElementById("azMonthly").innerText  = `≈ Monthly: ${fmt(monthly(z.pricePerHourUSD))}`;
    }

    setStatus("Live comparison complete ✓");
  } catch (err) {
    console.error(err);
    setStatus(`Error: ${err.message}`, "error");
    alert("Unable to get prices. Please try again.");
  } finally {
    btn.disabled = false;
  }
}

function resetCards() {
  document.getElementById("awsInstance").innerText = "Instance: …";
  document.getElementById("awsCpu").innerText      = "vCPU: …";
  document.getElementById("awsRam").innerText      = "RAM: …";
  document.getElementById("awsPrice").innerText    = "Price/hr: -";
  document.getElementById("awsMonthly").innerText  = "≈ Monthly: -";
  document.getElementById("azInstance").innerText  = "VM Size: …";
  document.getElementById("azCpu").innerText       = "vCPU: …";
  document.getElementById("azRam").innerText       = "RAM: …";
  document.getElementById("azPrice").innerText     = "Price/hr: -";
  document.getElementById("azMonthly").innerText   = "≈ Monthly: -";
}

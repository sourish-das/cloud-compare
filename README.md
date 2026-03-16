
# Cloud Price Compare (AWS • Azure • GCP • OCI)

**Cloud Price Compare** is a lightweight, client‑side web app that lets you compare on‑demand VM prices across the four major cloud providers—**AWS**, **Microsoft Azure**, **Google Cloud**, and **Oracle Cloud Infrastructure (OCI)**—side‑by‑side. It’s designed for fast, apples‑to‑apples checks without logins or servers. The site is published from the `/docs` folder via GitHub Pages and the price data is auto‑refreshed by GitHub Actions.

> Live site (GitHub Pages): enable Pages for this repo and point it to the `/docs` folder. The UI files are under `docs/index.html`, `docs/script.js`, and `docs/style.css`.

---

## ✨ Features
- **Side‑by‑side VM price comparison** for AWS, Azure, GCP, and OCI.  
- **Client‑only UI** (pure HTML/CSS/JS) – easy to host on GitHub Pages.  
- **Automated daily price refresh** using GitHub Actions – updates JSON under `docs/data/`.  
- **Clean UI with export to PDF** of the results grid (optional feature in `docs/script.js`).  
- **Provider‑aware instance naming** and series labels to keep comparisons clear.

> Repository layout and the `/docs` app shell are visible in the repo’s tree. The Actions tab shows periodic runs that auto‑update prices and deploy Pages. citeturn1search4turn1search6

---

## 🗂️ Repository Structure
```
cloud-compare/
├── .github/workflows/       # GitHub Actions to fetch & refresh prices (per provider and all)
├── docs/                    # Live site (GitHub Pages)
│   ├── data/                # Auto‑generated pricing JSON snapshots (AWS/Azure/GCP/OCI)
│   ├── ui/                  # UI helpers and matchers
│   ├── index.html           # App page (filters + results)
│   ├── script.js            # Client logic (compare, recommend, export)
│   └── style.css            # Styles
├── scripts/                 # Provider fetchers / helpers used by workflows
├── README.md                # (this file)
└── ...
```
> The `docs` folder shows updated files (e.g., `script.js`, `style.css`, `data/`) and recent commits from the auto‑update workflow. citeturn1search4

---

## 🚀 Quick Start (Local)
1. **Clone**
   ```bash
   git clone https://github.com/sourish-das/cloud-compare.git
   cd cloud-compare
   ```
2. **Open the app**
   - Double‑click `docs/index.html`, or
   - Serve locally (for stricter browser settings):
     ```bash
     # Python 3
     cd docs && python -m http.server 8080
     # then open http://localhost:8080
     ```
3. **Compare**
   - Pick **OS**, **vCPU**, **RAM**, **Storage**, and **Region(s)**, then click **Compare**.
   - Use **Export** (if enabled) to generate a PDF of just the results grid.

> The UI and behavior are implemented in `docs/index.html` + `docs/script.js`. citeturn1search4

---

## 🌐 Deploy on GitHub Pages
1. In **Settings → Pages**, set **Source** to **Deploy from a branch**, folder **/docs**.  
2. The **Pages** workflow will publish your site on every push to `main`.  
3. Price update workflows will refresh `docs/data/` and trigger a Pages deploy.

> You can confirm recent Pages deploys and price refresh runs in the repo’s **Actions** tab. citeturn1search6

---

## 🔄 Data Refresh & Workflows
- Dedicated **GitHub Actions** fetch pricing for each provider and an **All‑in‑one** update job.  
- Generated price files are written under `docs/data/` for the app to consume at runtime.  
- Commits are stamped by the workflow bot on successful runs.

> The `docs` tree and Actions history indicate frequent auto‑update commits like “Auto-update ALL cloud prices (AWS/Azure/GCP/OCI)”. citeturn1search4

---

## 🧠 How It Works (High Level)
1. **Fetch**: Actions call provider APIs/CSV endpoints (via scripts under `/scripts`) and normalize outputs.  
2. **Publish**: Normalized JSON lands in `docs/data/` and gets served by GitHub Pages.  
3. **Compare**: The browser reads JSON, filters by your inputs, maps nearest equivalents across providers, and renders a side‑by‑side grid.

> The presence of provider‑scoped workflows and regularly updated `docs/data/` files reflects this pipeline. citeturn1search4turn1search6

---

## 📌 Scope & Assumptions
- **On‑demand** prices only (no Spot/Preemptible or Reserved/Commit discounts) to keep comparisons simple.  
- Focus is on **compute (VM)** list prices; storage & network may be out of scope or simplified.  
- Regional alignment attempts to pick comparable regions per provider.

> Comparable tools and public references typically limit to on‑demand for fair side‑by‑side checks. See examples like VMCompare / CloudPricer for methodology inspiration. citeturn1search8turn1search9

---

## 🛣️ Roadmap Ideas
- Add **explicit OS uplifts** (e.g., Windows & RHEL SKUs) per vCPU tier where applicable.  
- Expand **storage** and **egress** cost modeling.  
- Add **equivalent instance mapping** explanations per match.  
- Improve **validation** against official calculators per provider.

> Market comparisons and community posts show demand for richer cost dimensions and transparent mapping. citeturn1search10

---

## 🧪 Validating Prices
For spot‑checks, compare values against official calculators / price pages from each provider.
- AWS Pricing: https://aws.amazon.com/ec2/pricing/on-demand/  
- Azure Pricing: https://azure.microsoft.com/pricing/details/virtual-machines/  
- GCP Pricing: https://cloud.google.com/compute/pricing  
- OCI Pricing: https://www.oracle.com/cloud/compute/pricing/

> Use these as authoritative references when verifying instance/hour rates you see in the grid. (External authoritative sources; link out only.)

---

## 🧩 Contributing
1. Open an issue describing the change.  
2. For provider fetchers, keep outputs **normalized** and **schema‑stable** under `docs/data/`.  
3. For UI, maintain **accessibility**, **responsive layout**, and **zero‑dependency** approach.

---

## 📄 License
MIT (add your preferred license if different).

---

## 🙌 Acknowledgements
- Inspired by public cloud price comparison tools and community write‑ups.  
- Thanks to contributors and reviewers.

---

> _Generated on 2026-03-16T08:28:32.988774Z_

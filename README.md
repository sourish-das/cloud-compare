
# Cloud Price Compare (AWS • Azure • GCP • OCI)

Cloud Price Compare is a lightweight, browser‑based tool that helps you compare on‑demand VM pricing from AWS, Microsoft Azure, Google Cloud, and Oracle Cloud (OCI) in a single view.
Everything runs client‑side, and the UI is served directly from the `/docs` folder using GitHub Pages. Pricing data is refreshed automatically through GitHub Actions.

---
## ✨ Features
- Side‑by‑side VM price comparison across all four major cloud providers
- Pure client-side implementation (HTML/CSS/JS)
- Automated price refresh powered by GitHub Actions
- PDF export of the comparison grid
- Clear provider‑specific instance naming

---
## 📁 Repository Structure
```
cloud-compare/
├── .github/workflows/       # Workflows fetching and updating pricing
├── docs/                    # GitHub Pages site
│   ├── data/                # Auto-generated pricing JSON files
│   ├── ui/                  # UI helpers and matchers
│   ├── index.html           # Main interface
│   ├── script.js            # Core logic for comparison
│   └── style.css            # Stylesheet
├── scripts/                 # Fetch scripts for each cloud provider
└── README.md
```

---
## 🌐 Deployment (GitHub Pages)
1. Go to **Settings → Pages**
2. Set **Source** to **Deploy from a branch** and select the `/docs` folder
3. The site will be published automatically based on the configured workflow
4. Updated pricing files in `docs/data/` are included in each published build

---
## 🔄 How the Pricing Pipeline Works
- Scheduled workflows call provider pricing APIs or catalog files
- Provider fetch scripts normalize data into consistent JSON
- Updated files are placed into `docs/data/`
- GitHub Pages serves `/docs`, so the UI always loads the latest pricing

---
## 🧪 Validating Prices
Verify values directly using official pricing pages:
- AWS: https://aws.amazon.com/ec2/pricing/on-demand/
- Azure: https://azure.microsoft.com/pricing/details/virtual-machines/
- GCP: https://cloud.google.com/compute/pricing
- OCI: https://www.oracle.com/cloud/compute/pricing/

---
## 🙌 Acknowledgements
Thanks to the cloud community and various public references that inspired this project.
This tool aims to keep comparisons simple, fast, and transparent.


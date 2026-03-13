// scripts/lib/azure_rhel_test.js
// Thin wrapper for testing paid-Linux detection (RHEL/SLES/Ubuntu Pro/Oracle Linux)
// without touching the main azure.js

const base = require("./azure");

/**
 * Extend getRetailOsInfo with granular paid-Linux flags.
 * Keeps Windows/Linux determination + guards from base.
 */
function getRetailOsInfoExt({ productName = "", skuName = "", meterName = "" } = {}) {
  const s = `${productName} ${skuName} ${meterName}`.toLowerCase();

  // Start from base classifier
  const info = base.getRetailOsInfo({ productName, skuName, meterName });

  // Add granular paid-Linux flags
  const isRhel        = /(rhel|red\s*hat)/.test(s);
  const isSles        = /(suse|sles)/.test(s);
  const isUbuntuPro   = /ubuntu\s*pro/.test(s);
  const isOracleLinux = /oracle\s*linux/.test(s);
  const isPaidLinux   = isRhel || isSles || isUbuntuPro || isOracleLinux;

  return {
    ...info,
    isPaidLinux,
    isRhel,
    isSles,
    isUbuntuPro,
    isOracleLinux
  };
}

module.exports = {
  ...base,
  // Override only this one
  getRetailOsInfo: getRetailOsInfoExt
};

// config.js — IRS limits, federal tax brackets, and pure tax helpers.
// All figures are TAX YEAR 2026. Update annually; see PLAN.md "Config provenance".
// Sources: IRS 2026 limit notice + Tax Foundation 2026 brackets.

// --- IRS contribution limits (2026) ------------------------------------
const IRS_LIMITS = {
  taxYear: 2026,

  // 401(k)/403(b)/457(b) employee elective deferral
  k401_employee: 24500,
  k401_catchup_50: 8000,        // standard catch-up, age 50+
  k401_catchup_60_63: 11250,    // SECURE 2.0 higher catch-up, ages 60–63 (replaces the 50+ figure)
  k401_total_415c: 72000,       // §415(c) combined employee+employer annual additions

  // IRA — combined across Traditional + Roth
  ira_combined: 7500,
  ira_catchup_50: 1100,         // age 50+

  // HSA — by coverage tier  (⚠️ verify against IRS Rev. Proc. for 2026)
  hsa_self: 4400,
  hsa_family: 8750,
  hsa_catchup_55: 1000,         // age 55+

  // SECURE 2.0: from 2026, catch-up must be Roth if prior-year wages with the
  // plan sponsor exceeded this threshold.
  roth_catchup_wage_threshold: 150000,
};

// --- Federal income tax brackets (2026) --------------------------------
// Each entry: marginal `rate` applies to taxable income up to `upTo`.
const FEDERAL_BRACKETS = {
  single: [
    { rate: 0.10, upTo: 12400 },
    { rate: 0.12, upTo: 50400 },
    { rate: 0.22, upTo: 105700 },
    { rate: 0.24, upTo: 201775 },
    { rate: 0.32, upTo: 256225 },
    { rate: 0.35, upTo: 640600 },
    { rate: 0.37, upTo: Infinity },
  ],
  mfj: [
    { rate: 0.10, upTo: 24800 },
    { rate: 0.12, upTo: 100800 },
    { rate: 0.22, upTo: 211400 },
    { rate: 0.24, upTo: 403550 },
    { rate: 0.32, upTo: 512450 },
    { rate: 0.35, upTo: 768700 },
    { rate: 0.37, upTo: Infinity },
  ],
};

const STANDARD_DEDUCTION = { single: 16100, mfj: 32200 };

// Long-term capital-gains rate — simplified single rate for v1.
const CAP_GAINS_RATE_DEFAULT = 0.15;

// Early-withdrawal penalty (pre-59½), and RMD start age (config constant).
const EARLY_WITHDRAWAL_PENALTY = 0.10;
const RMD_START_AGE = 73; // 75 for those born 1960+; refine in Phase 4.

// --- v2: healthcare & ACA -----------------------------------------------

// Medicare baseline (age 65+) — Part B + Part D + Medigap, per person, per year.
// Hard-coded per the v2 spec; rough 2026 all-in estimate.
const MEDICARE_BASELINE_ANNUAL = 6500;

// Federal Poverty Line (2026 estimate, 48 contiguous states): base for a
// 1-person household plus a per-additional-person increment. Used by the ACA
// subsidy approximation. (HHS publishes these annually; refresh each year.)
const FPL_2026 = { base: 15650, perPerson: 5500 };

// National-average benchmark (second-lowest-cost Silver) premium for a pre-65
// adult — a coarse single figure scaled by household size in the estimator.
const ACA_BENCHMARK_PREMIUM_PER_ADULT = 7200; // ~$600/mo/adult, annual

// Coarse regional cost multiplier keyed by the first digit of the ZIP. We have
// no per-ZIP benchmark (SLCSP) data offline, so this only nudges the national
// average up/down by region. Documented as an estimate, not a quote.
const ACA_ZIP_REGION_FACTOR = {
  '0': 1.10, // Northeast
  '1': 1.10,
  '2': 1.00, // Mid-Atlantic / Southeast
  '3': 0.95,
  '4': 0.95, // Midwest
  '5': 0.95,
  '6': 0.95,
  '7': 0.95, // South-central
  '8': 1.05, // Mountain
  '9': 1.10, // West Coast
};

// ACA "applicable percentage" sliding scale — the share of income a household is
// expected to contribute toward the benchmark plan, by % of the Federal Poverty
// Line. Statutory (pre-IRA) scale; the enhanced 2021–2025 subsidies lapse, so we
// use the original sliding scale capped at 400% FPL (the "subsidy cliff").
//   [fplRatioUpTo, expectedContributionPct]
const ACA_APPLICABLE_PCT = [
  [1.33, 0.0210],
  [1.50, 0.0410],
  [2.00, 0.0640],
  [2.50, 0.0820],
  [3.00, 0.0960],
  [4.00, 0.0960],
];

// --- v2.6: master location / cost-of-living lookup ----------------------
// v1, offline-only: coarse regional estimate keyed by the ZIP's first digit
// (same precedent as ACA_ZIP_REGION_FACTOR above — no per-ZIP BEA RPP table
// shipped yet, ~300KB+ and out of scope for this pass). rpp_all/rpp_rent are
// approximate BEA-style Regional Price Parities (100 = US average). Good
// enough to scale spend-tier category budgets and default property-tax/state-
// tax assumptions; never blocks the calculator when empty/unrecognized
// (national average is the fallback).
const LOCATION_REGION = {
  '0': { region: 'Northeast', rpp_all: 115, rpp_rent: 130, propertyTaxRate: 0.018, stateIncomeTaxRate: 0.05 },
  '1': { region: 'Northeast', rpp_all: 112, rpp_rent: 125, propertyTaxRate: 0.017, stateIncomeTaxRate: 0.05 },
  '2': { region: 'Mid-Atlantic / Southeast', rpp_all: 100, rpp_rent: 100, propertyTaxRate: 0.012, stateIncomeTaxRate: 0.045 },
  '3': { region: 'Southeast', rpp_all: 92, rpp_rent: 85, propertyTaxRate: 0.009, stateIncomeTaxRate: 0.03 },
  '4': { region: 'Midwest', rpp_all: 90, rpp_rent: 82, propertyTaxRate: 0.013, stateIncomeTaxRate: 0.04 },
  '5': { region: 'Midwest', rpp_all: 89, rpp_rent: 80, propertyTaxRate: 0.014, stateIncomeTaxRate: 0.045 },
  '6': { region: 'South-central', rpp_all: 91, rpp_rent: 82, propertyTaxRate: 0.011, stateIncomeTaxRate: 0.02 },
  '7': { region: 'South-central', rpp_all: 95, rpp_rent: 88, propertyTaxRate: 0.016, stateIncomeTaxRate: 0.0 },
  '8': { region: 'Mountain', rpp_all: 98, rpp_rent: 95, propertyTaxRate: 0.007, stateIncomeTaxRate: 0.025 },
  '9': { region: 'West Coast', rpp_all: 120, rpp_rent: 140, propertyTaxRate: 0.008, stateIncomeTaxRate: 0.07 },
};
const LOCATION_NATIONAL_AVG = { region: 'US average', rpp_all: 100, rpp_rent: 100, propertyTaxRate: 0.011, stateIncomeTaxRate: 0.04 };
// A handful of named ZIPs for a friendlier "City, ST" readout — falls back to
// the generic region label above when the ZIP isn't in this small sample set.
const LOCATION_ZIP_NAMES = {
  '75068': 'Little Elm, TX', '94016': 'San Francisco, CA', '10001': 'New York, NY',
  '60601': 'Chicago, IL', '78701': 'Austin, TX', '98101': 'Seattle, WA',
  '33101': 'Miami, FL', '80202': 'Denver, CO', '02108': 'Boston, MA', '85001': 'Phoenix, AZ',
};
function lookupLocation(zip) {
  const z = String(zip || '').replace(/\D/g, '').slice(0, 5);
  if (z.length < 5) return Object.assign({ zip: '', city: '', matched: false }, LOCATION_NATIONAL_AVG);
  const region = LOCATION_REGION[z[0]] || LOCATION_NATIONAL_AVG;
  const city = LOCATION_ZIP_NAMES[z] || `${region.region} region`;
  return Object.assign({ zip: z, city, matched: true }, region);
}

// --- v2: global numeric sanitizer ---------------------------------------

// Strict utility: strip every character that is not a digit. "$1,200" -> "1200".
// Returns a string (caller parses). Intended for currency / whole-number fields.
function sanitizeDigits(v) {
  return String(v == null ? '' : v).replace(/[^0-9]/g, '');
}

// --- Pure tax helpers --------------------------------------------------

// Total federal tax on a given taxable income using marginal brackets.
function taxOnIncome(taxableIncome, brackets) {
  if (taxableIncome <= 0) return 0;
  let tax = 0, lower = 0;
  for (const b of brackets) {
    const slice = Math.min(taxableIncome, b.upTo) - lower;
    if (slice > 0) tax += slice * b.rate;
    lower = b.upTo;
    if (taxableIncome <= b.upTo) break;
  }
  return tax;
}

// Marginal rate at a given taxable income.
function marginalRate(taxableIncome, brackets) {
  for (const b of brackets) {
    if (taxableIncome <= b.upTo) return b.rate;
  }
  return brackets[brackets.length - 1].rate;
}

// Effective (average) tax rate at a given taxable income.
function effectiveRate(taxableIncome, brackets) {
  if (taxableIncome <= 0) return 0;
  return taxOnIncome(taxableIncome, brackets) / taxableIncome;
}

// 401(k) catch-up amount for a given age (0 if under 50).
function catchUp401k(age) {
  if (age >= 60 && age <= 63) return IRS_LIMITS.k401_catchup_60_63;
  if (age >= 50) return IRS_LIMITS.k401_catchup_50;
  return 0;
}

// IRA catch-up amount for a given age.
function catchUpIRA(age) {
  return age >= 50 ? IRS_LIMITS.ira_catchup_50 : 0;
}

// HSA catch-up amount for a given age.
function catchUpHSA(age) {
  return age >= 55 ? IRS_LIMITS.hsa_catchup_55 : 0;
}

if (typeof window !== 'undefined') {
  Object.assign(window, {
    IRS_LIMITS, FEDERAL_BRACKETS, STANDARD_DEDUCTION, CAP_GAINS_RATE_DEFAULT,
    EARLY_WITHDRAWAL_PENALTY, RMD_START_AGE,
    MEDICARE_BASELINE_ANNUAL, FPL_2026, ACA_BENCHMARK_PREMIUM_PER_ADULT,
    ACA_ZIP_REGION_FACTOR, ACA_APPLICABLE_PCT,
    LOCATION_REGION, LOCATION_NATIONAL_AVG, LOCATION_ZIP_NAMES, lookupLocation,
    taxOnIncome, marginalRate, effectiveRate, catchUp401k, catchUpIRA, catchUpHSA,
    sanitizeDigits,
  });
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    IRS_LIMITS, FEDERAL_BRACKETS, STANDARD_DEDUCTION, CAP_GAINS_RATE_DEFAULT,
    EARLY_WITHDRAWAL_PENALTY, RMD_START_AGE,
    MEDICARE_BASELINE_ANNUAL, FPL_2026, ACA_BENCHMARK_PREMIUM_PER_ADULT,
    ACA_ZIP_REGION_FACTOR, ACA_APPLICABLE_PCT,
    LOCATION_REGION, LOCATION_NATIONAL_AVG, LOCATION_ZIP_NAMES, lookupLocation,
    taxOnIncome, marginalRate, effectiveRate, catchUp401k, catchUpIRA, catchUpHSA,
    sanitizeDigits,
  };
}

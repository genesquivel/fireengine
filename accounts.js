// accounts.js — Phase 1 account model + projection engine. Pure functions.
//
// Two-level model:
//   AccountGroup  (a real-world account, e.g. "Fidelity 401k")
//     └─ SubAccount[]  (one per tax treatment held within it)
//
// A SubAccount carries its own balance, contribution schedule (base + per-year
// overrides), tax treatment, and optional return override. Everything here is
// serializable plain data + pure functions, so it persists and unit-tests cleanly.

const TAX_TREATMENTS = ['pretax', 'roth', 'aftertax', 'taxable'];

// Money-source categories the user picks from. Each maps to an underlying tax
// `treatment` plus two flags used by contribution-limit validation:
//   deferral  — counts toward the annual employee elective-deferral limit
//   addition  — counts toward the §415(c) total-annual-additions limit
// Rollovers and in-plan conversions aren't contributions, so neither applies.
const SUBACCOUNT_CATEGORIES = {
  pretax:          { label: 'Pre-Tax',                 treatment: 'pretax',   source: 'employee', deferral: true,  addition: true },
  roth:            { label: 'Roth',                    treatment: 'roth',     source: 'employee', deferral: true,  addition: true },
  match:           { label: 'Employer Match',          treatment: 'pretax',   source: 'employer', deferral: false, addition: true },
  rollover:        { label: 'Rollover',                treatment: 'pretax',   source: 'employee', deferral: false, addition: false },
  roth_rollover:   { label: 'Roth Rollover',           treatment: 'roth',     source: 'employee', deferral: false, addition: false },
  roth_conversion: { label: 'Roth In-Plan Conversion', treatment: 'roth',     source: 'employee', deferral: false, addition: false },
  aftertax:        { label: 'After-Tax (non-Roth)',    treatment: 'aftertax', source: 'employee', deferral: false, addition: true },
  taxable:         { label: 'Taxable',                 treatment: 'taxable',  source: 'employee', deferral: false, addition: false },
  total:           { label: 'Total (no split)',        treatment: 'pretax',   source: 'mixed',    deferral: false, addition: false },
};

// Canonical category for a bare tax treatment (used when migrating old data).
function inferCategory(treatment) {
  if (treatment === 'roth') return 'roth';
  if (treatment === 'aftertax') return 'aftertax';
  if (treatment === 'taxable') return 'taxable';
  return 'pretax';
}

// --- Factories (stable shapes; ids for UI keying) ----------------------
let _idCounter = 0;
function _id(prefix) { return `${prefix}_${Date.now().toString(36)}_${_idCounter++}`; }

function makeSubAccount(opts = {}) {
  const category = opts.category && SUBACCOUNT_CATEGORIES[opts.category]
    ? opts.category
    : inferCategory(opts.taxTreatment);
  const info = SUBACCOUNT_CATEGORIES[category];
  return {
    id: opts.id || _id('sub'),
    label: opts.label || '',
    category,
    taxTreatment: info.treatment,   // derived — engine projects/taxes on this
    source: info.source,            // 'employee' | 'employer' | 'mixed'
    deferral: info.deferral,
    addition: info.addition,
    balance: opts.balance || 0,
    basis: opts.basis == null ? null : opts.basis,   // cost basis (taxable / after-tax)
    baseContribution: opts.baseContribution || 0,     // annual
    overrides: opts.overrides ? { ...opts.overrides } : {}, // { [year]: amount }
    expectedReturn: opts.expectedReturn == null ? null : opts.expectedReturn, // %, optional
  };
}

function makeGroup(opts = {}) {
  return {
    id: opts.id || _id('grp'),
    name: opts.name || 'Account',
    type: opts.type || 'other', // '401k'|'403b'|'457b'|'tsp'|'ira'|'hsa'|'brokerage'|'other'
    owner: opts.owner || 'you',  // 'you' | 'partner' | 'joint' — for per-person limits
    expectedReturn: opts.expectedReturn == null ? null : opts.expectedReturn,
    employerMatch: opts.employerMatch || null, // { rate, capPctOfSalary }
    // Public-sector flags: agency/employer matching (TSP/403(b)) and the 457(b)
    // perk of penalty-free withdrawals once you separate from service.
    agencyMatch: opts.agencyMatch || false,
    penaltyFreeSeparation: opts.penaltyFreeSeparation || false,
    subAccounts: (opts.subAccounts || []).map(makeSubAccount),
  };
}

// --- Contribution schedule --------------------------------------------
// Effective contribution for a calendar year: override if present, else base.
function getContribution(subAccount, year) {
  const o = subAccount.overrides;
  if (o && Object.prototype.hasOwnProperty.call(o, year) && o[year] != null) return o[year];
  return subAccount.baseContribution || 0;
}

// Set a single year's override (returns a new overrides map; pure).
function setOverride(subAccount, year, amount) {
  return { ...subAccount.overrides, [year]: amount };
}

// "Apply to all": change the base; optionally wipe per-year overrides.
function applyBaseToAll(subAccount, newBase, keepOverrides) {
  return {
    ...subAccount,
    baseContribution: newBase,
    overrides: keepOverrides ? { ...subAccount.overrides } : {},
  };
}

// --- Returns ----------------------------------------------------------
// Resolution order: sub-account → group → global default.
function effectiveReturn(subAccount, group, globalReturnPct) {
  if (subAccount.expectedReturn != null) return subAccount.expectedReturn;
  if (group && group.expectedReturn != null) return group.expectedReturn;
  return globalReturnPct;
}

// --- Projection -------------------------------------------------------
// Project one sub-account from `startYear` for `years`. Growth compounds
// monthly; that year's scheduled contribution is added at year-end.
// Returns { final, finalBasis, series: [{ year, balance, basis }] }.
// `basis` = contributed principal (cost basis). It grows only by contributions,
// NOT by investment return — this is what's accessible penalty-free from a Roth
// before 59½ (earnings stay locked). Starts at subAccount.basis, or the current
// balance if basis is unknown (assume the existing balance is all principal).
function projectSubAccount(subAccount, group, globalReturnPct, startYear, years) {
  const ret = effectiveReturn(subAccount, group, globalReturnPct);
  const r = ret / 100 / 12;
  let balance = subAccount.balance || 0;
  let basis = subAccount.basis == null ? (subAccount.balance || 0) : subAccount.basis;
  const series = [{ year: startYear, balance, basis }];
  for (let y = 0; y < years; y++) {
    const yearContribution = getContribution(subAccount, startYear + y);
    for (let m = 0; m < 12; m++) balance *= 1 + r;
    balance += yearContribution; // contribute at year-end (compounds next year)
    basis += yearContribution;   // basis rises by contributions only — never compounds
    series.push({ year: startYear + y + 1, balance, basis });
  }
  return { final: balance, finalBasis: basis, series };
}

// Project a whole group: sum of its sub-accounts, plus per-treatment composition
// of both total balance and accessible basis.
function projectGroup(group, globalReturnPct, startYear, years) {
  const byTreatment = { pretax: 0, roth: 0, aftertax: 0, taxable: 0 };
  const byTreatmentBasis = { pretax: 0, roth: 0, aftertax: 0, taxable: 0 };
  let total = 0;
  const subResults = group.subAccounts.map((sub) => {
    const res = projectSubAccount(sub, group, globalReturnPct, startYear, years);
    byTreatment[sub.taxTreatment] += res.final;
    byTreatmentBasis[sub.taxTreatment] += res.finalBasis;
    total += res.final;
    return { id: sub.id, treatment: sub.taxTreatment, final: res.final, finalBasis: res.finalBasis, series: res.series };
  });
  return { type: group.type, total, byTreatment, byTreatmentBasis, subResults };
}

// Project a whole portfolio (array of groups).
function projectPortfolio(groups, globalReturnPct, startYear, years) {
  const byTreatment = { pretax: 0, roth: 0, aftertax: 0, taxable: 0 };
  const byTreatmentBasis = { pretax: 0, roth: 0, aftertax: 0, taxable: 0 };
  let total = 0;
  const groupResults = groups.map((g) => {
    const res = projectGroup(g, globalReturnPct, startYear, years);
    total += res.total;
    for (const k of TAX_TREATMENTS) { byTreatment[k] += res.byTreatment[k]; byTreatmentBasis[k] += res.byTreatmentBasis[k]; }
    return { id: g.id, name: g.name, ...res };
  });
  return { total, byTreatment, byTreatmentBasis, groupResults };
}

// --- Current totals (no projection) -----------------------------------
function groupBalance(group) {
  return group.subAccounts.reduce((s, a) => s + (a.balance || 0), 0);
}
function groupContribution(group, year) {
  return group.subAccounts.reduce((s, a) => s + getContribution(a, year), 0);
}

// Ordinary income tax on an amount. If `filingStatus` ('single'|'mfj') is given,
// use the progressive federal brackets minus the standard deduction (dynamic);
// otherwise fall back to a flat `ordinaryRate`. Pure.
function ordinaryTaxOnWithdrawal(amount, params = {}) {
  if (amount <= 0) return 0;
  if (params.filingStatus && typeof FEDERAL_BRACKETS !== 'undefined' && FEDERAL_BRACKETS[params.filingStatus]) {
    const ded = (STANDARD_DEDUCTION && STANDARD_DEDUCTION[params.filingStatus]) || 0;
    const taxable = Math.max(0, amount - ded);
    return taxOnIncome(taxable, FEDERAL_BRACKETS[params.filingStatus]);
  }
  return amount * (params.ordinaryRate || 0);
}

// --- After-tax (spendable) value --------------------------------------
// Convert a pre-tax-of-withdrawal balance into spendable dollars given its
// treatment. params: { ordinaryRate | filingStatus, capGainsRate, basis }.
//   pretax    → fully taxed as ordinary income (progressive if filingStatus set)
//   roth      → tax-free
//   aftertax  → contributions (basis) tax-free; earnings taxed as ordinary
//   taxable   → only gains taxed at capital-gains rate
function afterTaxValue(balance, treatment, params = {}) {
  const capGains = params.capGainsRate == null ? CAP_GAINS_RATE_DEFAULT : params.capGainsRate;
  const basis = params.basis == null ? 0 : params.basis;
  switch (treatment) {
    case 'roth': return balance;
    case 'pretax': return balance - ordinaryTaxOnWithdrawal(balance, params);
    case 'aftertax': {
      const earnings = Math.max(0, balance - basis);
      return basis + earnings - ordinaryTaxOnWithdrawal(earnings, params);
    }
    case 'taxable':
    default: {
      const gains = Math.max(0, balance - basis);
      return balance - gains * capGains;
    }
  }
}

// --- Group-level contribution validation (warn, don't block) ----------
// Recalculated per year (age & limits change). Returns { warnings, totals }.
//   ctx: { age, coverage: 'self'|'family', limits = IRS_LIMITS }
function validateGroupYear(group, year, ctx = {}) {
  const limits = ctx.limits || (typeof IRS_LIMITS !== 'undefined' ? IRS_LIMITS : null);
  const age = ctx.age || 0;
  const warnings = []; // hard limit exceeded
  const hints = [];    // soft, educational (e.g. mega-backdoor splitting)

  // Limits are PER PERSON. Employee elective deferrals (Pre-Tax + Roth) vs. the
  // deferral limit; total annual additions (deferrals + match + after-tax) vs.
  // §415(c). Rollovers / conversions / "Total" count toward neither.
  const deferral = group.subAccounts
    .filter((a) => a.deferral)
    .reduce((s, a) => s + getContribution(a, year), 0);
  const additions = group.subAccounts
    .filter((a) => a.addition)
    .reduce((s, a) => s + getContribution(a, year), 0);

  if (!limits) return { warnings, hints, totals: { deferral, additions } };

  // Employer-sponsored deferral plans share the §415(c) framework: 401(k),
  // 403(b), and the federal TSP all let employee deferrals + employer/agency
  // match + after-tax push total additions up to §415(c).
  const PLAN_NAME = { '401k': '401(k)', '403b': '403(b)', 'tsp': 'TSP', '457b': '457(b)' };
  if (['401k', '403b', 'tsp'].includes(group.type)) {
    const name = PLAN_NAME[group.type];
    // §415(c) total-additions is the real per-person ceiling — this is what
    // enables the mega-backdoor Roth (after-tax + in-plan conversion) to push
    // contributions well above the elective-deferral limit.
    if (additions > limits.k401_total_415c) {
      warnings.push(`Total ${name} additions ${money(additions)} exceed the ${year} §415(c) limit of ${money(limits.k401_total_415c)} per person.`);
    }
    // Elective-deferral sub-limit is a soft hint: a lump entered as Pre-Tax/Roth
    // that exceeds it is usually match + after-tax (mega backdoor) lumped in.
    const deferralCap = limits.k401_employee + catchUp401k(age);
    const hasMegaSources = group.subAccounts.some((a) => ['match', 'aftertax', 'roth_conversion'].includes(a.category));
    if (deferral > deferralCap && !hasMegaSources) {
      hints.push(`Pure pre-tax/Roth deferrals cap at ${money(deferralCap)}/person. If this ${money(deferral)} includes employer match or after-tax (mega-backdoor Roth) dollars, split it into those sources — total additions are allowed up to ${money(limits.k401_total_415c)}.`);
    }
    // Agency/employer matching: TSP automatically contributes 1% and matches up
    // to 4% more (5% total). If matching is enabled but no Match source models it,
    // remind the user to add one so it's captured in the additions.
    if ((group.type === 'tsp' || group.type === '403b') && group.agencyMatch &&
        !group.subAccounts.some((a) => a.category === 'match')) {
      hints.push(`${name} agency/employer matching is on, but no "Employer Match" source is modeled${group.type === 'tsp' ? ' — TSP agencies add up to 5% (1% automatic + 4% matched)' : ''}. Add a Match source so it counts toward your §415(c) additions.`);
    }
  } else if (group.type === '457b') {
    // Governmental 457(b): its OWN elective-deferral limit (mirrors the 401(k)
    // figure with the same age catch-ups), separate from §415(c). Employee +
    // employer dollars share this single limit.
    const cap = limits.k401_employee + catchUp401k(age);
    if (additions > cap) {
      warnings.push(`457(b) contributions ${money(additions)} exceed the ${year} elective-deferral limit of ${money(cap)} per person.`);
    }
  } else if (group.type === 'ira') {
    const cap = limits.ira_combined + catchUpIRA(age);
    if (deferral > cap) {
      warnings.push(`IRA contributions ${money(deferral)} exceed the combined Traditional+Roth ${year} limit of ${money(cap)} per person.`);
    }
  } else if (group.type === 'hsa') {
    const base = ctx.coverage === 'family' ? limits.hsa_family : limits.hsa_self;
    const cap = base + catchUpHSA(age);
    if (deferral > cap) {
      warnings.push(`HSA contributions ${money(deferral)} exceed the ${year} ${ctx.coverage === 'family' ? 'family' : 'self-only'} limit of ${money(cap)}.`);
    }
  }
  // Catch-up visibility (C.2): if the owner is 50+, surface the extra room their
  // age unlocks for this account type — including the SECURE 2.0 60–63 boost.
  const deferralPlans = ['401k', '403b', 'tsp', '457b'];
  if (age >= 50 && [...deferralPlans, 'ira', 'hsa'].includes(group.type)) {
    let cu = 0, base = 0, kind = '';
    if (deferralPlans.includes(group.type)) { cu = catchUp401k(age); base = limits.k401_employee; kind = `${PLAN_NAME[group.type] || group.type} deferral`; }
    else if (group.type === 'ira') { cu = catchUpIRA(age); base = limits.ira_combined; kind = 'IRA'; }
    else { cu = catchUpHSA(age); base = (ctx.coverage === 'family' ? limits.hsa_family : limits.hsa_self); kind = 'HSA'; }
    if (cu > 0) {
      const boost = (age >= 60 && age <= 63 && deferralPlans.includes(group.type)) ? ' (SECURE 2.0 ages 60–63 boost)' : '';
      hints.push(`At age ${age}, catch-up adds ${money(cu)} to your ${kind} limit${boost} — up to ${money(base + cu)}/person this year.`);
    }
  }
  return { warnings, hints, totals: { deferral, additions } };
}

function money(n) { return '$' + Math.round(n).toLocaleString('en-US'); }

// --- Migration --------------------------------------------------------
// Wrap a legacy single balance + contribution as a one-sub-account group.
function migrateLegacy(balance, annualContribution, opts = {}) {
  return makeGroup({
    name: opts.name || 'Retirement savings',
    type: opts.type || '401k',
    expectedReturn: opts.expectedReturn == null ? null : opts.expectedReturn,
    subAccounts: [makeSubAccount({
      taxTreatment: 'pretax',
      balance: balance || 0,
      baseContribution: annualContribution || 0,
    })],
  });
}

const AccountsAPI = {
  TAX_TREATMENTS, SUBACCOUNT_CATEGORIES, inferCategory,
  makeSubAccount, makeGroup,
  getContribution, setOverride, applyBaseToAll,
  effectiveReturn,
  projectSubAccount, projectGroup, projectPortfolio,
  groupBalance, groupContribution,
  afterTaxValue, ordinaryTaxOnWithdrawal,
  validateGroupYear,
  migrateLegacy,
};

if (typeof window !== 'undefined') Object.assign(window, AccountsAPI);
if (typeof module !== 'undefined' && module.exports) module.exports = AccountsAPI;

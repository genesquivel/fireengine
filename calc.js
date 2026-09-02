// calc.js — Retirement forecasting math. Pure functions, no DOM.
// Every projection is deterministic and auditable: same inputs -> same outputs.

// The "classic" Coast FIRE convention assumes you keep working an ordinary
// career to a traditional retirement age and merely stop *contributing* once
// growth alone will reach the target by then. This app also computes Coast
// against the user's OWN (often early) retirement age — so we surface both:
// "coast to <your age>" and this classic "coast to 65". See milestones.coast.
const CLASSIC_COAST_AGE = 65;

// --- Core compounding ---------------------------------------------------

// Future value of a starting balance plus a constant annual contribution.
// Growth compounds monthly; the full annual contribution is added at the end
// of each 12-month block. Returns the nominal balance at the end.
function projectBalance(startBalance, annualContribution, annualReturnPct, years) {
  const months = Math.max(0, Math.round(years * 12));
  const r = annualReturnPct / 100 / 12; // monthly growth rate
  let balance = startBalance;
  for (let m = 1; m <= months; m++) {
    balance = balance * (1 + r);
    if (m % 12 === 0) balance += annualContribution; // contribute at year end
  }
  return balance;
}

// Like projectBalance, but any income stream active in a given pre-retirement
// year is added to that year's contribution — so surplus cash flow from streams
// (e.g. side/rental income earned before retiring) compounds into the savings
// pool alongside regular contributions. The accumulation loop only spans ages
// startAge..(startAge+years-1), so only pre-retirement stream years count here.
function projectBalanceWithStreams(startBalance, annualContribution, annualReturnPct, years, startAge, streams) {
  if (!streams || streams.length === 0) return projectBalance(startBalance, annualContribution, annualReturnPct, years);
  const r = annualReturnPct / 100 / 12;
  let balance = startBalance;
  for (let y = 0; y < years; y++) {
    const age = startAge + y;
    let contribution = annualContribution;
    for (const st of streams) {
      const end = st.endAge == null ? Infinity : st.endAge;
      if (age >= st.startAge && age <= end) contribution += (st.annualAmount || 0);
    }
    for (let m = 0; m < 12; m++) balance *= 1 + r;
    balance += contribution; // contribute (incl. stream surplus) at year end
  }
  return balance;
}

// Sustainable annual income from a portfolio at a given withdrawal rate.
function sustainableAnnualIncome(balance, withdrawalRatePct) {
  return balance * (withdrawalRatePct / 100);
}

// --- v2: spending phases (Go-Go / Slow-Go / No-Go) ----------------------

// Normalize a phases array to numeric {annualSpend, years}, dropping empties.
function phaseSchedule(phases) {
  return (phases || [])
    .map((p) => ({ annualSpend: +p.annualSpend || 0, years: Math.max(0, Math.round(+p.years || 0)) }))
    .filter((p) => p.years > 0);
}

// Base annual spend for a given retirement-year offset (0 = first year). Walks
// the phase durations in order and HOLDS the last phase's level past its end.
// Returns null when no phases are defined (caller falls back to a flat spend).
function spendForPhaseYear(phases, yearOffset) {
  const sched = phaseSchedule(phases);
  if (sched.length === 0) return null;
  let acc = 0;
  for (const p of sched) {
    if (yearOffset < acc + p.years) return p.annualSpend;
    acc += p.years;
  }
  return sched[sched.length - 1].annualSpend;
}

// Duration-weighted average spend across all phases — the single headline figure
// used for FIRE-number math when phases drive desired income.
function blendedDesiredIncome(phases) {
  const sched = phaseSchedule(phases);
  if (sched.length === 0) return 0;
  const totalYears = sched.reduce((s, p) => s + p.years, 0);
  const weighted = sched.reduce((s, p) => s + p.annualSpend * p.years, 0);
  return totalYears > 0 ? weighted / totalYears : 0;
}

// --- v2: lifecycle expenses --------------------------------------------

// Per-year lifecycle expense breakdown (in TODAY's dollars; caller scales by the
// inflation factor `f`). Home maintenance is 1% of home value; property tax is
// either the entered figure or a 1.2% national-average (one primary residence).
// Vehicles, support, and kids/529 are each a LIST of items (one entry per
// vehicle/recipient/child) so a household can model more than one of each:
//   lifecycle: { homeValue, propertyTax, useNatAvgTax,
//                vehicles: [{freq, cost, startAge}],          // each on its own replacement cadence
//                support:  [{annualAmount, startAge}],         // summed across all recipients
//                kids529:  [{annualAmount, years, startAge}],  // each active while yearOffset < years
//                custom:   [{annualAmount, years, startAge}] } // flexible annual costs
function lifecycleAnnual(lifecycle, yearOffset, f = 1, currentAge = null) {
  const lc = lifecycle || {};
  const homeValue = +lc.homeValue || 0;
  const homeMaint = homeValue * 0.01;
  const propertyTax = lc.useNatAvgTax ? homeValue * 0.012 : (+lc.propertyTax || 0);
  const support = (lc.support || []).reduce((s, item) => {
    const startAge = item.startAge || 0;
    const years = +item.years || 0;
    const isActive = (!currentAge || currentAge >= startAge) && (years === 0 || yearOffset < years);
    return s + (isActive ? (+item.annualAmount || 0) : 0);
  }, 0);
  const kids529 = (lc.kids529 || []).reduce((s, item) => {
    const startAge = item.startAge || 0;
    const isActive = (!currentAge || currentAge >= startAge) && yearOffset < (+item.years || 0);
    return s + (isActive ? (+item.annualAmount || 0) : 0);
  }, 0);
  const custom = (lc.custom || []).reduce((s, item) => {
    const startAge = item.startAge || 0;
    const isActive = (!currentAge || currentAge >= startAge) && yearOffset < (+item.years || 0);
    return s + (isActive ? (+item.annualAmount || 0) : 0);
  }, 0);
  const vehicle = (lc.vehicles || []).reduce((s, v) => {
    const freq = Math.round(+v.freq || 0);
    const startAge = v.startAge || 0;
    const isActive = !currentAge || currentAge >= startAge;
    return s + ((isActive && freq > 0 && yearOffset > 0 && yearOffset % freq === 0) ? (+v.cost || 0) : 0);
  }, 0);
  const recurring = homeMaint + propertyTax + support + kids529 + custom;
  return {
    homeMaint: homeMaint * f, propertyTax: propertyTax * f, support: support * f,
    kids529: kids529 * f, custom: custom * f, vehicle: vehicle * f,
    recurring: recurring * f, total: (recurring + vehicle) * f,
  };
}

// --- v2: Social Security actuarial + taxation ---------------------------

// Annual SS benefit for a chosen claiming age given the monthly PIA at FRA.
// Early reduction: 5/9 of 1%/mo for the first 36 months early, 5/12 of 1%/mo
// beyond (→ −30% at 62 vs FRA 67). Delayed credit: 2/3 of 1%/mo (→ +24% at 70).
function ssBenefitAtClaim(monthlyPIA, claimAge, fra = 67) {
  const pia = (monthlyPIA || 0) * 12;
  if (pia <= 0) return 0;
  const age = Math.max(62, Math.min(70, claimAge));
  const monthsDiff = Math.round((age - fra) * 12);
  let factor = 1;
  if (monthsDiff < 0) {
    const early = -monthsDiff;
    const first = Math.min(early, 36);
    const beyond = Math.max(0, early - 36);
    factor = 1 - (first * (5 / 9) / 100) - (beyond * (5 / 12) / 100);
  } else if (monthsDiff > 0) {
    factor = 1 + monthsDiff * (2 / 3) / 100;
  }
  return pia * Math.max(0, factor);
}

// Taxable portion of SS benefits (v2 simplification per spec): if combined income
// (other income + ½ of SS) exceeds $34k single / $44k joint, 85% of the benefit
// is taxable; otherwise $0.
function ssTaxablePortion(otherIncome, ssAnnual, filingStatus = 'single') {
  if (ssAnnual <= 0) return 0;
  const combined = (otherIncome || 0) + 0.5 * ssAnnual;
  const threshold = filingStatus === 'mfj' ? 44000 : 34000;
  return combined > threshold ? 0.85 * ssAnnual : 0;
}

// --- v2: ACA subsidy approximation -------------------------------------

// Expected income-contribution % toward the benchmark plan, by % of FPL.
function acaApplicablePct(fplRatio) {
  if (fplRatio <= 0) return 0;
  const scale = (typeof ACA_APPLICABLE_PCT !== 'undefined') ? ACA_APPLICABLE_PCT
    : [[1.33, 0.021], [1.5, 0.041], [2, 0.064], [2.5, 0.082], [3, 0.096], [4, 0.096]];
  for (const [upTo, pct] of scale) if (fplRatio <= upTo) return pct;
  return scale[scale.length - 1][1];
}

// Estimated pre-65 ACA marketplace cost AFTER premium subsidies. Approximation:
// no per-ZIP benchmark (SLCSP) data offline, so we scale a national-average
// benchmark by household size and a coarse regional factor, then subtract the
// FPL/MAGI-based subsidy. Above 400% FPL there is no subsidy (the "cliff").
// Returns { benchmark, fplRatio, expectedContribution, subsidy, netPremium, cliff }.
function acaSubsidy(opts = {}) {
  const { householdSize = 1, magi = 0, zip = '' } = opts;
  const perAdult = (typeof ACA_BENCHMARK_PREMIUM_PER_ADULT !== 'undefined') ? ACA_BENCHMARK_PREMIUM_PER_ADULT : 7200;
  const fplBase = (typeof FPL_2026 !== 'undefined') ? FPL_2026.base : 15650;
  const fplPer = (typeof FPL_2026 !== 'undefined') ? FPL_2026.perPerson : 5500;
  const regionMap = (typeof ACA_ZIP_REGION_FACTOR !== 'undefined') ? ACA_ZIP_REGION_FACTOR : {};
  const size = Math.max(1, Math.round(householdSize));
  const adults = Math.min(size, 2);
  const kids = Math.max(0, size - 2);
  const region = regionMap[String(zip).trim().charAt(0)] || 1.0;
  const benchmark = (perAdult * adults + 0.6 * perAdult * kids) * region;
  const fpl = fplBase + fplPer * (size - 1);
  const fplRatio = fpl > 0 ? Math.max(0, magi) / fpl : Infinity;
  if (fplRatio > 4.0) {
    return { benchmark, fplRatio, expectedContribution: benchmark, subsidy: 0, netPremium: benchmark, cliff: true };
  }
  const expectedContribution = Math.max(0, magi) * acaApplicablePct(fplRatio);
  const subsidy = Math.max(0, benchmark - expectedContribution);
  const netPremium = Math.max(0, benchmark - subsidy);
  return { benchmark, fplRatio, expectedContribution, subsidy, netPremium, cliff: false };
}

// --- v2: inflation display helper --------------------------------------

// Convert a nominal future value into today's purchasing power.
function toTodaysDollars(value, yearsFromNow, inflationPct) {
  const infl = (inflationPct || 0) / 100;
  return value / Math.pow(1 + infl, Math.max(0, yearsFromNow));
}

// Years a portfolio lasts when drawing `annualDraw` (today's dollars),
// growing at `annualReturnPct` and eroding at `annualInflationPct`.
// Returns Infinity if the portfolio never depletes within 100 years.
function yearsOfRunway(balance, annualDraw, annualReturnPct, annualInflationPct) {
  if (annualDraw <= 0) return Infinity;
  const r = annualReturnPct / 100;
  const infl = annualInflationPct / 100;
  let bal = balance;
  let draw = annualDraw;
  for (let y = 0; y < 100; y++) {
    bal = bal * (1 + r) - draw;
    if (bal <= 0) return y + 1;
    draw = draw * (1 + infl); // next year's spending rises with inflation
  }
  return Infinity;
}

// Pure age-aware drawdown simulation. Each retirement year the portfolio grows,
// then a NET draw is removed. The net draw is the inflation-adjusted spend, PLUS
// a pre-65 healthcare premium (C.3), MINUS active income streams (C.4) and Social
// Security (counted only from ssStartAge). Everything scales by inflation so the
// model stays in consistent (nominal) dollars.
//   opts: { startBalance, startAge, annualSpend, returnPct, inflationPct,
//           horizonYears=60, healthcareAnnual=0, healthcareUntilAge=65,
//           incomeStreams=[{annualAmount,startAge,endAge}], socialSecurityAnnual=0,
//           ssStartAge=67, mortgage={annualPayment,payoffAge}|null,
//           earlyPenaltyRate=0, penaltyUntilAge=59.5, penaltyExemptBalance=0 }
// A mortgage (or any debt) is a FIXED nominal expense added to the draw every
// year BEFORE its payoff age, then dropped entirely once paid off — a "step-down"
// in required spending. Unlike other flows it does NOT scale with inflation
// (the payment is contractually fixed).
// Early-withdrawal penalty (off by default): before penaltyUntilAge (59½), draws
// that exceed the penalty-free pool (penaltyExemptBalance — taxable, basis, and
// 457(b)-on-separation balances) incur earlyPenaltyRate (e.g. 10%), grossed up
// out of the portfolio like the tax. The exempt pool is consumed as it's used.
// Returns { runway, depletionAge, series:[{age,balance,spend,healthcare,streams,ss,mortgage,netDraw,tax,penalty}] }
function simulateDrawdown(opts) {
  const {
    startBalance, startAge, annualSpend, returnPct, inflationPct,
    horizonYears = 60, healthcareAnnual = 0, healthcareUntilAge = 65,
    incomeStreams = [], socialSecurityAnnual = 0, ssStartAge = 67,
    filingStatus = 'single', mortgage = null,
    earlyPenaltyRate = 0, penaltyUntilAge = 59.5, penaltyExemptBalance = 0,
    // v2 additions (all default to prior behavior):
    phases = null,            // [{annualSpend, years}] — overrides flat annualSpend
    medicareAnnual = 0,       // per-person Medicare baseline applied from age 65
    persons = 1,              // household size for the Medicare baseline
    lifecycle = null,         // {homeValue, propertyTax, vehicle…, support, kids529…}
    events = [],              // [{type:'correction'|'oneTime'|'geo', age, dropPct|amount|multiplier}]
  } = opts;
  const r = returnPct / 100, infl = inflationPct / 100;
  // Tax gross-up: the portfolio must cover the net draw AND the income tax on it.
  // v2: the taxable base also includes the taxable portion of Social Security.
  const taxOn = (amount) => (typeof ordinaryTaxOnWithdrawal === 'function'
    ? ordinaryTaxOnWithdrawal(amount, { filingStatus })
    : 0);
  let balance = startBalance;
  let exemptRemaining = penaltyExemptBalance; // penalty-free pool, consumed over early years
  const series = [];
  for (let i = 0; i < horizonYears; i++) {
    const age = startAge + i;
    const f = Math.pow(1 + infl, i); // inflation factor — scales every cash flow
    // Geo-arbitrage spend multiplier: product of every move whose age has arrived.
    let geoMult = 1;
    for (const ev of events) if (ev.type === 'geo' && ev.age <= age) geoMult *= (ev.multiplier || 1);
    const baseSpend = (phases ? spendForPhaseYear(phases, i) : null);
    const spend = (baseSpend == null ? annualSpend : baseSpend) * f * geoMult;
    // Pre-65: ACA/manual premium. 65+: Medicare baseline × persons.
    const healthcare = age < healthcareUntilAge ? healthcareAnnual * f : medicareAnnual * persons * f;
    const lc = lifecycle ? lifecycleAnnual(lifecycle, i, f, age) : null;
    const lcRecurring = lc ? lc.recurring : 0;
    const lcVehicle = lc ? lc.vehicle : 0;
    const lcKids529 = lc ? lc.kids529 : 0;
    const lcCustom = lc ? lc.custom : 0;
    const streams = incomeStreams.reduce((s, st) =>
      s + (age >= st.startAge && age <= (st.endAge == null ? Infinity : st.endAge) ? (st.annualAmount || 0) * f : 0), 0);
    const ss = age >= ssStartAge ? socialSecurityAnnual * f : 0;
    // Fixed-nominal mortgage payment until payoff, then it disappears.
    const mort = (mortgage && age < mortgage.payoffAge) ? (mortgage.annualPayment || 0) : 0;
    // One-time events this year: +amount = expense, −amount = windfall.
    let oneTime = 0;
    for (const ev of events) if (ev.type === 'oneTime' && Math.round(ev.age) === age) oneTime += (ev.amount || 0);
    const netDraw = Math.max(0, spend + healthcare + lcRecurring + lcVehicle + mort + oneTime - streams - ss);
    const taxableSS = ssTaxablePortion(netDraw, ss, filingStatus);
    const computedTax = taxOn(netDraw + taxableSS);
    // Early-withdrawal penalty on the portion of an early draw not covered by
    // penalty-free funds (457(b)-on-separation, taxable, Roth/after-tax basis).
    let penalty = 0;
    if (earlyPenaltyRate > 0 && age < penaltyUntilAge && netDraw > 0) {
      const exemptUsed = Math.min(netDraw, exemptRemaining);
      penalty = (netDraw - exemptUsed) * earlyPenaltyRate;
      exemptRemaining -= exemptUsed;
    }
    // Grow with base return, then apply market correction and recovery boost.
    let returnRate = r;
    // Check if we're in a recovery window after a correction
    for (const ev of events) {
      if (ev.type === 'correction' && ev.age < age && age <= ev.age + (ev.recoveryDuration || 0)) {
        // We're in the recovery window after a correction
        const boost = (ev.recoveryBoost || 0) / 100;
        returnRate += boost;
      }
    }
    let grown = balance * (1 + returnRate);
    // Apply market corrections that happen this year
    for (const ev of events) if (ev.type === 'correction' && Math.round(ev.age) === age) grown *= (1 - (ev.dropPct || 0));
    balance = grown - (netDraw + computedTax + penalty);
    series.push({ age: age + 1, balance, spend, healthcare, lifecycle: lcRecurring, kids529: lcKids529, custom: lcCustom, vehicle: lcVehicle, streams, ss, mortgage: mort, oneTime, netDraw, tax: computedTax, penalty });
    if (balance <= 0) return { runway: i + 1, depletionAge: age + 1, series };
  }
  return { runway: Infinity, depletionAge: null, series };
}

// Year-by-year balance trajectory. Growth compounds monthly; the annual
// contribution lands at each year end. Returns one point per year (incl.
// the starting point) as { age, balance }.
function projectSeries(startBalance, annualContribution, annualReturnPct, years, startAge) {
  const r = annualReturnPct / 100 / 12;
  const points = [{ age: startAge, balance: startBalance }];
  let balance = startBalance;
  const months = Math.round(years * 12);
  for (let m = 1; m <= months; m++) {
    balance = balance * (1 + r);
    if (m % 12 === 0) {
      balance += annualContribution;
      points.push({ age: startAge + m / 12, balance });
    }
  }
  return points;
}

// Accumulation trajectory with Scenario-Playground events applied. Like
// projectBalanceWithStreams but returns a per-year {age, balance} series and
// applies pre-retirement events at year-end: a market correction multiplies the
// balance by (1−dropPct); a one-time expense/windfall adjusts it (+amount =
// expense, −amount = windfall). Income-shift events are passed in via `streams`.
function projectSeriesWithEvents(startBalance, annualContribution, annualReturnPct, years, startAge, streams, events) {
  const r = annualReturnPct / 100 / 12;
  const evs = events || [];
  const points = [{ age: startAge, balance: startBalance }];
  let balance = startBalance;
  for (let y = 0; y < years; y++) {
    const age = startAge + y;
    let contribution = annualContribution;
    for (const st of (streams || [])) {
      const end = st.endAge == null ? Infinity : st.endAge;
      if (age >= st.startAge && age <= end) contribution += (st.annualAmount || 0);
    }
    // Check if we're in a recovery window after a correction
    let monthlyRate = r;
    for (const ev of evs) {
      if (ev.type === 'correction' && ev.age < age && age <= ev.age + (ev.recoveryDuration || 0)) {
        // We're in the recovery window
        const boost = (ev.recoveryBoost || 0) / 100 / 12;
        monthlyRate += boost;
      }
    }
    for (let m = 0; m < 12; m++) balance *= 1 + monthlyRate;
    balance += contribution;
    const yearEndAge = startAge + y + 1;
    for (const ev of evs) {
      if (ev.type === 'correction' && Math.round(ev.age) === yearEndAge) balance *= (1 - (ev.dropPct || 0));
      if (ev.type === 'oneTime' && Math.round(ev.age) === yearEndAge) balance -= (ev.amount || 0);
    }
    if (balance < 0) balance = 0;
    points.push({ age: yearEndAge, balance });
  }
  return points;
}

// --- Scenario banding ---------------------------------------------------

// Build the three-scenario assumption set from base inputs.
// Optimistic: higher return, lower inflation. Pessimistic: lower return,
// higher inflation. Guardrail: pessimistic inflation never exceeds
// pessimistic return.
function buildScenarios(baseReturn, baseInflation, returnBand, inflationBand) {
  const pessReturn = baseReturn - returnBand;
  let pessInflation = baseInflation + inflationBand;
  if (pessInflation > pessReturn) pessInflation = pessReturn; // guardrail
  return {
    pessimistic: { return: pessReturn, inflation: pessInflation },
    base: { return: baseReturn, inflation: baseInflation },
    optimistic: {
      return: baseReturn + returnBand,
      inflation: Math.max(0, baseInflation - inflationBand),
    },
  };
}

// --- FIRE milestones ----------------------------------------------------

// FIRE number = annual spend / withdrawal rate (the 25x rule when wr = 4%).
function fireNumber(annualSpend, withdrawalRatePct) {
  return annualSpend / (withdrawalRatePct / 100);
}

// Real (inflation-adjusted) return = (1 + nominal) / (1 + inflation) - 1.
// Coast FIRE compares a balance against a FIRE target expressed in TODAY'S
// dollars, so it must compound/discount with the REAL return — using the
// nominal return would overstate how far a balance coasts once inflation
// erodes the target's purchasing power. Percent in, percent out.
function realReturn(nominalReturnPct, inflationPct) {
  return ((1 + nominalReturnPct / 100) / (1 + inflationPct / 100) - 1) * 100;
}

// Coast FIRE is an age/growth test: will the CURRENT balance, with zero
// further contributions, compound to the full FIRE number by retirement?
// Returns { reached, ageReached } where ageReached is when current savings
// would coast across the target (may be after retirement age = not reached).
// NOTE: pass a REAL return here whenever targetFireNumber is in today's
// dollars (see realReturn) — forecast() does exactly that.
function coastFire(currentBalance, currentAge, retirementAge, annualReturnPct, targetFireNumber) {
  const r = annualReturnPct / 100;
  if (currentBalance <= 0 || targetFireNumber <= 0) return { reached: false, ageReached: null };
  let bal = currentBalance;
  for (let age = currentAge; age <= retirementAge; age++) {
    if (bal >= targetFireNumber) return { reached: true, ageReached: age };
    bal = bal * (1 + r);
  }
  if (bal >= targetFireNumber) return { reached: true, ageReached: retirementAge };
  return { reached: false, ageReached: null };
}

// The future age at which Coast FIRE is ACHIEVED: the earliest age where the
// balance (still receiving contributions up to that age) is large enough that,
// growing with ZERO further contributions, it would reach the full FIRE target
// by retirement. Returns that age (= currentAge if already coasting), or null
// if the plan never reaches it before retirement.
// NOTE: pass a REAL return here whenever targetFireNumber is in today's
// dollars (see realReturn) — contributions are then treated as today's dollars.
function ageCoastFireReached(startBalance, annualContribution, currentAge, retirementAge, annualReturnPct, targetFireNumber) {
  if (targetFireNumber <= 0) return null;
  const totalYears = retirementAge - currentAge;
  for (let y = 0; y <= totalYears; y++) {
    const balAtAge = projectBalance(startBalance, annualContribution, annualReturnPct, y);
    const coastedToRetirement = projectBalance(balAtAge, 0, annualReturnPct, totalYears - y);
    if (coastedToRetirement >= targetFireNumber) return currentAge + y;
  }
  return null;
}

// Coast FIRE number "today": the balance you'd need RIGHT NOW so that, with
// ZERO further contributions, real growth alone reaches the today's-dollar
// FIRE target by the retirement age. Discount the target at the real return.
// (currentAge param lets callers reuse it for any "required at age A" value.)
function coastNumberToday(targetFireNumber, currentAge, retirementAge, realReturnPct) {
  const years = Math.max(0, retirementAge - currentAge);
  return targetFireNumber / Math.pow(1 + realReturnPct / 100, years);
}

// Build the "Your Coast FIRE path" rows. For each age: the projected invested
// balance (contributions through that age) versus the required coast balance
// at that age — both in today's dollars — plus whether coast is reached.
// realReturnPct must be the REAL return so both sides share today's dollars.
function coastPath(startBalance, annualContribution, currentAge, retirementAge, realReturnPct, targetFireNumber, ages) {
  return ages.map((age) => {
    const y = Math.max(0, age - currentAge);
    const projected = projectBalance(startBalance, annualContribution, realReturnPct, y);
    const required = coastNumberToday(targetFireNumber, age, retirementAge, realReturnPct);
    return { age, projected, required, reached: projected >= required };
  });
}

// Given a projected nominal balance at retirement, the age at which the
// growing portfolio first crosses a target FIRE number. Used to label the
// projected age each milestone is hit.
function ageMilestoneHit(startBalance, annualContribution, annualReturnPct, startAge, targetFireNumber, maxYears) {
  const r = annualReturnPct / 100 / 12;
  let balance = startBalance;
  const months = Math.round(maxYears * 12);
  for (let m = 0; m <= months; m++) {
    if (balance >= targetFireNumber) return startAge + m / 12;
    balance = balance * (1 + r);
    if (m > 0 && m % 12 === 0) balance += annualContribution; // contribute at year end
  }
  return null; // not reached within horizon
}

// Years for a Barista-FIRE portfolio to coast up to Full FIRE while the retiree
// withdraws exactly the safe withdrawal rate each year. Each year the portfolio
// earns its return and the SWR amount is withdrawn, so the remaining excess
// return (return − withdrawal rate) compounds. Returns the number of years to
// reach the Full FIRE target, or null if it never grows (return ≤ SWR) or takes
// longer than 50 years.
function yearsFromBaristaToFull(baristaBalance, desiredIncome, withdrawalRate, annualReturnPct) {
  const w = withdrawalRate / 100;
  const r = annualReturnPct / 100;
  const fullFire = w > 0 ? desiredIncome / w : Infinity;
  if (baristaBalance >= fullFire) return 0;
  if (r - w <= 0) return null; // withdrawals consume all the returns — never grows
  let balance = baristaBalance;
  for (let y = 1; y <= 50; y++) {
    balance = balance * (1 + r - w); // earn return, withdraw SWR, remainder compounds
    if (balance >= fullFire) return y;
  }
  return null;
}

// --- Recommendations (how to reach an unmet milestone) ------------------

// Smallest annual contribution that lands the portfolio at >= target by
// retirement. Binary search over projectBalance (monotonic in contribution).
function requiredAnnualContribution(startBalance, annualReturnPct, years, target) {
  if (projectBalance(startBalance, 0, annualReturnPct, years) >= target) return 0;
  let lo = 0, hi = target; // contributing the full target/yr always overshoots
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (projectBalance(startBalance, mid, annualReturnPct, years) >= target) hi = mid;
    else lo = mid;
  }
  return hi;
}

// Years needed (from today) to reach target at the current contribution.
// Returns null if unreachable within 80 years.
function yearsToReach(startBalance, annualContribution, annualReturnPct, target) {
  const r = annualReturnPct / 100 / 12;
  let balance = startBalance;
  for (let m = 1; m <= 80 * 12; m++) {
    balance = balance * (1 + r);
    if (m % 12 === 0) {
      balance += annualContribution;
      if (balance >= target) return m / 12;
    }
  }
  return null;
}

// Build an actionable recommendation for an unmet, target-based milestone.
function recommendation(startBalance, annualContribution, annualReturnPct, years, target) {
  const needed = requiredAnnualContribution(startBalance, annualReturnPct, years, target);
  const extraAnnual = Math.max(0, needed - annualContribution);
  const yrs = yearsToReach(startBalance, annualContribution, annualReturnPct, target);
  const extraYears = yrs == null ? null : Math.max(0, yrs - years);
  return { extraAnnual, extraYears };
}

// --- Top-level forecast -------------------------------------------------

// Consolidate the income streams the DRAWDOWN should see: the user's streams,
// plus a Barista part-time stream (retirement→Medicare/SS) and a FERS/CSRS
// pension stream from its eligibility age. Pure; reused by forecast + playground.
function buildActiveStreams(inputs, retirementAge) {
  const { incomeStreams = [], baristaPartTimeIncome = 0, ssStartAge = 67, pension = null } = inputs;
  const activeStreams = [...incomeStreams];
  if (baristaPartTimeIncome > 0) {
    activeStreams.push({
      label: 'Barista Input Income',
      annualAmount: baristaPartTimeIncome,
      startAge: retirementAge,
      endAge: Math.min(65, ssStartAge), // run until Medicare or SS starts
    });
  }
  if (pension && pension.high3 > 0 && pension.serviceYears > 0) {
    const annual = projectPension(pension.high3, pension.serviceYears, pension.startAge, pension.isFERS);
    if (annual > 0) {
      activeStreams.push({
        label: 'Government pension', annualAmount: annual,
        startAge: pension.startAge, endAge: null, // lifetime annuity
      });
    }
  }
  return activeStreams;
}

// Inputs is a normalized household object (see app.js buildInputs).
// Returns the full forecast for base/optimistic/pessimistic plus milestones.
function forecast(inputs) {
  const {
    householdBalance, householdAnnual, yearsToRetirement,
    desiredAnnualIncome, leanAnnualSpend, fatAnnualSpend, baristaPartTimeIncome,
    socialSecurityAnnual, withdrawalRate, retirementYears,
    baseReturn, baseInflation, returnBand, inflationBand,
    youngestAge,
    incomeStreams = [], healthcareAnnual = 0, ssStartAge = 67,
    filingStatus = 'single', mortgage = null,
    pension = null, earlyPenaltyRate = 0, penaltyExemptBalance = 0,
    phases = null, medicareAnnual = 0, persons = 1, lifecycle = null,
  } = inputs;

  const retirementAge = youngestAge + yearsToRetirement;
  const scenarios = buildScenarios(baseReturn, baseInflation, returnBand, inflationBand);
  const activeStreams = buildActiveStreams(inputs, retirementAge);
  // The drawdown horizon is the user's "years in retirement" input, not an
  // arbitrary fixed window — falls back to simulateDrawdown's own default (60).
  const horizonYears = retirementYears > 0 ? retirementYears : 60;

  const projectScenario = (s) => {
    // Pre-retirement income streams compound into the savings pool alongside contributions.
    const balance = projectBalanceWithStreams(householdBalance, householdAnnual, s.return, yearsToRetirement, youngestAge, incomeStreams);
    const portfolioIncome = sustainableAnnualIncome(balance, withdrawalRate);
    // Social Security isn't available the day you retire if you retire before
    // ssStartAge — someone FIRE-ing at 40 has a 20+ year bridge before SS
    // starts. The per-year drawdown below already models this correctly
    // (simulateDrawdown only adds SS from ssStartAge onward); this headline
    // total/gap must agree with that, not naively assume SS from year one.
    const ssAvailableAtRetirement = retirementAge >= ssStartAge ? socialSecurityAnnual : 0;
    const totalIncome = portfolioIncome + ssAvailableAtRetirement;
    const gap = totalIncome - desiredAnnualIncome;
    // Runway via the age-aware drawdown engine: pre-65 healthcare adds to the
    // draw, income streams (incl. Barista) + Social Security reduce it, and
    // ordinary income tax on the draw is grossed up out of the portfolio.
    const draw = simulateDrawdown({
      startBalance: balance, startAge: retirementAge, annualSpend: desiredAnnualIncome,
      returnPct: s.return, inflationPct: s.inflation, horizonYears,
      healthcareAnnual, incomeStreams: activeStreams, socialSecurityAnnual, ssStartAge, filingStatus,
      mortgage, // Debt Destroyer step-down expense (null = no modeled debt)
      earlyPenaltyRate, penaltyExemptBalance, // pre-59½ penalty (457(b)-on-separation aware)
      phases, medicareAnnual, persons, lifecycle, // v2: phases, Medicare baseline, lifecycle costs
    });
    return { assumptions: s, balance, portfolioIncome, totalIncome, gap, runway: draw.runway, drawdown: draw };
  };

  const base = projectScenario(scenarios.base);
  const optimistic = projectScenario(scenarios.optimistic);
  const pessimistic = projectScenario(scenarios.pessimistic);

  // FIRE numbers (all 25x-style, scaled to the chosen withdrawal rate).
  // Targets are PORTFOLIO-only: they don't subtract Social Security, which
  // doesn't start until ~62–67. (Baking in SS at an early retirement age
  // understates the target — and could collapse Barista to $0.) SS is treated
  // as a later supplement, surfaced separately in the gap banner.
  const fullFire = fireNumber(desiredAnnualIncome, withdrawalRate);
  const leanFire = fireNumber(leanAnnualSpend, withdrawalRate);
  const fatFire = fireNumber(fatAnnualSpend, withdrawalRate);
  const baristaFire = fireNumber(Math.max(0, desiredAnnualIncome - baristaPartTimeIncome), withdrawalRate);

  // Coast FIRE works in today's dollars (fullFire is a today's-dollar target),
  // so every coast projection/discount below uses the REAL return, never the
  // nominal one. With zero inflation real == nominal, so legacy behavior holds.
  const coastReturn = realReturn(scenarios.base.return, scenarios.base.inflation);

  const milestones = {
    lean: {
      target: leanFire,
      ageHit: ageMilestoneHit(householdBalance, householdAnnual, scenarios.base.return, youngestAge, leanFire, yearsToRetirement),
      reachedByRetirement: base.balance >= leanFire,
    },
    coast: Object.assign(
      coastFire(householdBalance, youngestAge, retirementAge, coastReturn, fullFire),
      {
        coastAge: ageCoastFireReached(householdBalance, householdAnnual, youngestAge, retirementAge, coastReturn, fullFire),
        targetRetirementAge: retirementAge,
        // Today's-dollar figures the Coast FIRE UI reads directly.
        coastReturn,
        currentBalance: householdBalance,
        numberToday: coastNumberToday(fullFire, youngestAge, retirementAge, coastReturn),
        // "If you stopped contributing today": current balance coasted to
        // retirement on real growth alone (today's dollars).
        noContribBalanceAtRetirement: projectBalance(householdBalance, 0, coastReturn, Math.max(0, retirementAge - youngestAge)),
        // "Classic" Coast FIRE: coast to a traditional retirement age (65)
        // instead of the user's own (often early) age. With a longer runway
        // this needs less in hand today, so it's typically hit EARLIER than
        // the coast-to-<your age> figure — restoring the intuitive ordering.
        // Clamp to at least the plan's own retirement age so it never sits
        // before the moment the household actually stops working.
        classic: (function () {
          const classicAge = Math.max(CLASSIC_COAST_AGE, retirementAge);
          return Object.assign(
            coastFire(householdBalance, youngestAge, classicAge, coastReturn, fullFire),
            {
              coastAge: ageCoastFireReached(householdBalance, householdAnnual, youngestAge, classicAge, coastReturn, fullFire),
              targetRetirementAge: classicAge,
            }
          );
        })(),
      }
    ),
    barista: {
      target: baristaFire,
      ageHit: ageMilestoneHit(householdBalance, householdAnnual, scenarios.base.return, youngestAge, baristaFire, yearsToRetirement),
      reachedByRetirement: base.balance >= baristaFire,
      // Minimum part-time income needed so portfolio income + work covers spending.
      minIncome: Math.max(0, desiredAnnualIncome - base.balance * (withdrawalRate / 100)),
    },
    fat: {
      target: fatFire,
      ageHit: ageMilestoneHit(householdBalance, householdAnnual, scenarios.base.return, youngestAge, fatFire, yearsToRetirement),
      reachedByRetirement: base.balance >= fatFire,
    },
    full: { target: fullFire, ageHit: ageMilestoneHit(householdBalance, householdAnnual, scenarios.base.return, youngestAge, fullFire, yearsToRetirement), reachedByRetirement: base.balance >= fullFire },
  };

  // Attach a "how to get there" recommendation to each unmet target milestone.
  for (const key of ['lean', 'barista', 'fat', 'full']) {
    const ms = milestones[key];
    if (!ms.reachedByRetirement) {
      ms.recommendation = recommendation(
        householdBalance, householdAnnual, scenarios.base.return, yearsToRetirement, ms.target
      );
    }
  }

  const series = {
    base: projectSeries(householdBalance, householdAnnual, scenarios.base.return, yearsToRetirement, youngestAge),
    optimistic: projectSeries(householdBalance, householdAnnual, scenarios.optimistic.return, yearsToRetirement, youngestAge),
    pessimistic: projectSeries(householdBalance, householdAnnual, scenarios.pessimistic.return, yearsToRetirement, youngestAge),
  };

  return { scenarios, base, optimistic, pessimistic, milestones, fullFire, series };
}

// --- v2: Scenario Playground orchestration ------------------------------

// A single unified accumulation→drawdown trajectory (one {age, balance} point
// per year) under the BASE assumptions, with Scenario-Playground events applied
// across both legs. Income-shift events are folded in as income streams (pre-
// retirement they boost contributions; in retirement they offset the draw).
// Pass events=[] for the baseline plan and the user's events for the impacted
// plan. Returns { series, balanceAtRetirement, retirementAge, runway, depletionAge }.
function forecastWithEvents(inputs, events = []) {
  const {
    householdBalance, householdAnnual, yearsToRetirement, desiredAnnualIncome,
    withdrawalRate, baseReturn, baseInflation, returnBand, inflationBand, youngestAge,
    incomeStreams = [], healthcareAnnual = 0, socialSecurityAnnual = 0, ssStartAge = 67,
    filingStatus = 'single', mortgage = null, earlyPenaltyRate = 0, penaltyExemptBalance = 0,
    phases = null, medicareAnnual = 0, persons = 1, lifecycle = null, retirementYears,
  } = inputs;

  const retirementAge = youngestAge + yearsToRetirement;
  const s = buildScenarios(baseReturn, baseInflation, returnBand, inflationBand).base;
  const horizonYears = retirementYears > 0 ? retirementYears : 60;

  // Income-shift events → streams active over their window (separate from the
  // correction/oneTime/geo events the drawdown engine consumes directly).
  const shiftStreams = events
    .filter((ev) => ev.type === 'incomeShift')
    .map((ev) => ({ label: 'Income shift', annualAmount: ev.newSalary || 0, startAge: ev.startAge, endAge: ev.endAge == null ? null : ev.endAge }));
  const accStreams = [...incomeStreams, ...shiftStreams];
  const drawEvents = events.filter((ev) => ev.type === 'correction' || ev.type === 'oneTime' || ev.type === 'geo');

  // Accumulation leg (events applied year-by-year).
  const accSeries = projectSeriesWithEvents(householdBalance, householdAnnual, s.return, yearsToRetirement, youngestAge, accStreams, events);
  const balanceAtRetirement = accSeries.length ? accSeries[accSeries.length - 1].balance : householdBalance;

  // Drawdown leg from that balance.
  const activeStreams = [...buildActiveStreams(inputs, retirementAge), ...shiftStreams];
  const draw = simulateDrawdown({
    startBalance: balanceAtRetirement, startAge: retirementAge, annualSpend: desiredAnnualIncome,
    returnPct: s.return, inflationPct: s.inflation, horizonYears,
    healthcareAnnual, incomeStreams: activeStreams, socialSecurityAnnual, ssStartAge, filingStatus,
    mortgage, earlyPenaltyRate, penaltyExemptBalance,
    phases, medicareAnnual, persons, lifecycle, events: drawEvents,
  });

  // Stitch the two legs into one age→balance series (drop the duplicate join year).
  const series = accSeries.map((p) => ({ age: p.age, balance: p.balance }))
    .concat(draw.series.map((p) => ({ age: p.age, balance: p.balance })));
  return { series, balanceAtRetirement, retirementAge, runway: draw.runway, depletionAge: draw.depletionAge };
}

// --- Government pension (FERS / CSRS) -----------------------------------

// Annual defined-benefit annuity for a public-sector (federal) pension.
//   high3        — average of the highest 3 consecutive years of salary
//   serviceYears — creditable years of service
//   age          — age at which the annuity is claimed (affects the FERS bonus)
//   isFERS       — true = FERS, false = CSRS (the older, richer system)
// FERS: 1.0% × high-3 × years, bumped to 1.1% when retiring at 62+ with 20+ years.
// CSRS (simplified): 1.5% for the first 5 years + 1.75% for the next 5 + 2.0% for
// every year beyond 10. Pure.
function projectPension(high3, serviceYears, age, isFERS = true) {
  if (high3 <= 0 || serviceYears <= 0) return 0;
  if (isFERS) {
    const multiplier = (age >= 62 && serviceYears >= 20) ? 0.011 : 0.010;
    return high3 * multiplier * serviceYears;
  }
  const y1 = Math.min(serviceYears, 5);
  const y2 = Math.min(Math.max(serviceYears - 5, 0), 5);
  const y3 = Math.max(serviceYears - 10, 0);
  const pct = y1 * 0.015 + y2 * 0.0175 + y3 * 0.02;
  return high3 * pct;
}

// --- Debt / amortization (Debt Destroyer) -------------------------------

// The fixed monthly payment that fully amortizes `balance` over `termMonths`
// at `annualRatePct` (standard mortgage formula). r=0 → straight-line payoff.
function standardPayment(balance, annualRatePct, termMonths) {
  if (termMonths <= 0 || balance <= 0) return 0;
  const r = annualRatePct / 100 / 12;
  if (r === 0) return balance / termMonths;
  return (balance * r) / (1 - Math.pow(1 + r, -termMonths));
}

// Advance a {year, month:1..12} calendar marker by `n` whole months.
function addMonths(start, n) {
  const total = (start.month - 1) + n;
  return { year: start.year + Math.floor(total / 12), month: (total % 12) + 1 };
}

// Month-by-month amortization. Each month: accrue interest on the balance, apply
// the regular payment (interest first, remainder to principal), then add any
// recurring extra principal and any dated lump sum that falls in this calendar
// month. The loop runs until the balance hits $0 (or maxMonths as a guard).
//   opts: { balance, annualRatePct, monthlyPayment, extraMonthly=0,
//           lumpSums=[{amount, year, month}], startDate={year,month}, maxMonths=1200 }
// lumpSums are matched to the calendar month offset from startDate; dates before
// startDate are ignored. Returns
//   { months, payoffYear, payoffMonth, totalInterest, totalPaid, finalBalance, schedule:[{monthIndex,year,month,balance,interest,principal}] }
function calculateMortgage(opts) {
  const {
    balance, annualRatePct, monthlyPayment,
    extraMonthly = 0, lumpSums = [], startDate = null, maxMonths = 1200,
  } = opts;
  const now = new Date();
  const start = startDate || { year: now.getFullYear(), month: now.getMonth() + 1 };
  const r = annualRatePct / 100 / 12;

  // Index lump sums by their whole-month offset from the start date.
  const lumpByOffset = {};
  for (const l of lumpSums) {
    if (!l || !(l.amount > 0) || !l.year || !l.month) continue;
    const off = (l.year - start.year) * 12 + (l.month - start.month);
    if (off < 0) continue; // a date in the past — ignore
    lumpByOffset[off] = (lumpByOffset[off] || 0) + l.amount;
  }

  let bal = balance;
  let totalInterest = 0, totalPaid = 0;
  const schedule = [{ monthIndex: 0, year: start.year, month: start.month, balance: bal, interest: 0, principal: 0 }];
  let m = 0;
  while (bal > 0 && m < maxMonths) {
    const interest = bal * r;
    const lump = lumpByOffset[m] || 0; // period index m → calendar month start+m
    let principal = (monthlyPayment - interest) + extraMonthly + lump;
    if (principal <= 0) { // payment doesn't cover interest — no progress, bail to guard
      totalInterest += interest;
      totalPaid += monthlyPayment + extraMonthly + lump;
      bal += interest - (monthlyPayment + extraMonthly + lump);
      m++;
      schedule.push({ monthIndex: m, ...addMonths(start, m), balance: bal, interest, principal: 0 });
      continue;
    }
    let payment = monthlyPayment + extraMonthly + lump;
    if (principal >= bal) { principal = bal; payment = bal + interest; } // final (partial) month
    bal -= principal;
    if (bal < 0.005) bal = 0;
    totalInterest += interest;
    totalPaid += payment;
    m++;
    schedule.push({ monthIndex: m, ...addMonths(start, m), balance: bal, interest, principal });
  }
  const end = addMonths(start, m);
  return { months: m, payoffYear: end.year, payoffMonth: end.month, totalInterest, totalPaid, finalBalance: bal, schedule };
}

// Export for both browser and any test harness.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    CLASSIC_COAST_AGE,
    projectBalance, projectBalanceWithStreams, sustainableAnnualIncome, yearsOfRunway, buildScenarios,
    fireNumber, coastFire, ageCoastFireReached, ageMilestoneHit, forecast, projectSeries,
    requiredAnnualContribution, yearsToReach, recommendation, simulateDrawdown,
    yearsFromBaristaToFull, standardPayment, calculateMortgage, projectPension,
    // v2 additions
    phaseSchedule, spendForPhaseYear, blendedDesiredIncome, lifecycleAnnual,
    ssBenefitAtClaim, ssTaxablePortion, acaApplicablePct, acaSubsidy, toTodaysDollars,
    projectSeriesWithEvents, buildActiveStreams, forecastWithEvents,
  };
}

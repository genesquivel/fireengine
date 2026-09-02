// tests.js — unit tests for the Phase 1 engine (config.js + accounts.js).
// Runs in the browser via tests.html (no Node toolchain in this project).

(function () {
  const results = [];
  let pass = 0, fail = 0;

  function approx(a, b, tol = 0.5) { return Math.abs(a - b) <= tol; }
  function ok(name, cond, detail) {
    results.push({ name, cond: !!cond, detail: detail || '' });
    cond ? pass++ : fail++;
  }
  function eqApprox(name, got, want, tol) {
    ok(name, approx(got, want, tol), `got ${got}, want ${want}`);
  }

  // ---- config: taxOnIncome ----
  // Single, $50,000 taxable: 10% of 12,400 + 12% of (50,000-12,400)
  eqApprox('taxOnIncome single $50k', taxOnIncome(50000, FEDERAL_BRACKETS.single), 1240 + 0.12 * 37600, 0.01);
  ok('marginalRate single $50k = 12%', marginalRate(50000, FEDERAL_BRACKETS.single) === 0.12);
  ok('taxOnIncome zero = 0', taxOnIncome(0, FEDERAL_BRACKETS.single) === 0);
  // MFJ top of 10% bracket exactly
  eqApprox('taxOnIncome MFJ $24,800', taxOnIncome(24800, FEDERAL_BRACKETS.mfj), 2480, 0.01);

  // ---- config: catch-up by age ----
  ok('catchUp401k age 45 = 0', catchUp401k(45) === 0);
  ok('catchUp401k age 52 = 8000', catchUp401k(52) === 8000);
  ok('catchUp401k age 61 = 11250', catchUp401k(61) === 11250);
  ok('catchUp401k age 64 = 8000', catchUp401k(64) === 8000);
  ok('catchUpIRA age 50 = 1100', catchUpIRA(50) === 1100);

  // ---- accounts: getContribution overrides ----
  const sub = makeSubAccount({ baseContribution: 10000, overrides: { 2028: 15000 } });
  ok('getContribution base year', getContribution(sub, 2026) === 10000);
  ok('getContribution override year', getContribution(sub, 2028) === 15000);
  const sub0 = makeSubAccount({ baseContribution: 5000, overrides: { 2030: 0 } });
  ok('getContribution override of 0 honored', getContribution(sub0, 2030) === 0);

  // ---- accounts: projection (deterministic) ----
  // $1,000, no contributions, 12% annual (monthly), 1 year => 1000*(1.01)^12
  const p1 = projectSubAccount(makeSubAccount({ balance: 1000, baseContribution: 0 }), null, 12, 2026, 1);
  eqApprox('project growth-only 1yr', p1.final, 1000 * Math.pow(1.01, 12), 0.01);
  // $0 start, $1,200/yr, 0% return, 1 year => 1,200
  const p2 = projectSubAccount(makeSubAccount({ balance: 0, baseContribution: 1200 }), null, 0, 2026, 1);
  eqApprox('project contribution-only 1yr', p2.final, 1200, 0.001);
  // series length = years + 1
  ok('project series length', p2.series.length === 2);

  // ---- accounts: basis tracking (Roth basis vs earnings) ----
  // $10k Roth basis + $5k/yr contributions, 10% growth, 5 years.
  // Basis grows ONLY by contributions (no compounding): 10k + 5*5k = 35k.
  const pb = projectSubAccount(makeSubAccount({ taxTreatment: 'roth', balance: 10000, basis: 10000, baseContribution: 5000 }), null, 10, 2026, 5);
  eqApprox('basis grows by contributions only', pb.finalBasis, 35000, 0.001);
  ok('balance exceeds basis (earnings accrue)', pb.final > pb.finalBasis);
  ok('series carries basis', pb.series[pb.series.length - 1].basis === pb.finalBasis);
  // basis defaults to current balance when null
  const pbn = projectSubAccount(makeSubAccount({ taxTreatment: 'roth', balance: 8000, baseContribution: 0 }), null, 10, 2026, 3);
  eqApprox('basis defaults to balance when null', pbn.finalBasis, 8000, 0.001);
  // group/portfolio expose byTreatmentBasis
  const grpB = makeGroup({ type: 'ira', subAccounts: [{ taxTreatment: 'roth', balance: 20000, basis: 20000, baseContribution: 6000 }] });
  const gB = projectGroup(grpB, 7, 2026, 4);
  eqApprox('group byTreatmentBasis.roth = 20k + 4*6k', gB.byTreatmentBasis.roth, 44000, 0.001);
  ok('group basis < balance', gB.byTreatmentBasis.roth < gB.byTreatment.roth);
  const portB = projectPortfolio([grpB], 7, 2026, 4);
  eqApprox('portfolio byTreatmentBasis.roth', portB.byTreatmentBasis.roth, 44000, 0.001);

  // ---- accounts: effectiveReturn resolution ----
  const grp = makeGroup({ expectedReturn: 6, subAccounts: [{ baseContribution: 0 }] });
  ok('return falls back to group', effectiveReturn(grp.subAccounts[0], grp, 7) === 6);
  const subR = makeSubAccount({ expectedReturn: 9 });
  ok('return prefers sub-account', effectiveReturn(subR, grp, 7) === 9);
  ok('return falls back to global', effectiveReturn(makeSubAccount({}), makeGroup({}), 7) === 7);

  // ---- accounts: afterTaxValue per treatment ----
  ok('afterTax roth = balance', afterTaxValue(100000, 'roth') === 100000);
  eqApprox('afterTax pretax @22%', afterTaxValue(100000, 'pretax', { ordinaryRate: 0.22 }), 78000, 0.01);
  eqApprox('afterTax taxable basis 60k @15%', afterTaxValue(100000, 'taxable', { basis: 60000, capGainsRate: 0.15 }), 100000 - 40000 * 0.15, 0.01);
  eqApprox('afterTax aftertax basis 60k earnings@22%', afterTaxValue(100000, 'aftertax', { basis: 60000, ordinaryRate: 0.22 }), 60000 + 40000 * 0.78, 0.01);

  // ---- C.3 + C.4: drawdown with healthcare gap & income streams ----
  const baseDraw = simulateDrawdown({ startBalance: 1000000, startAge: 50, annualSpend: 60000, returnPct: 5, inflationPct: 0 });
  // Healthcare gap (age<65) should SHORTEN runway vs. no healthcare.
  const withHealth = simulateDrawdown({ startBalance: 1000000, startAge: 50, annualSpend: 60000, returnPct: 5, inflationPct: 0, healthcareAnnual: 15000 });
  ok('healthcare gap shortens runway', withHealth.runway < baseDraw.runway, `${withHealth.runway} vs ${baseDraw.runway}`);
  // An income stream covering all spend during early years should LENGTHEN runway.
  const withStream = simulateDrawdown({ startBalance: 1000000, startAge: 50, annualSpend: 60000, returnPct: 5, inflationPct: 0, incomeStreams: [{ annualAmount: 60000, startAge: 50, endAge: 60 }] });
  ok('income stream lengthens runway', withStream.runway > baseDraw.runway, `${withStream.runway} vs ${baseDraw.runway}`);
  // Social Security from 67 reduces net draw later.
  const withSS = simulateDrawdown({ startBalance: 1000000, startAge: 50, annualSpend: 60000, returnPct: 5, inflationPct: 0, socialSecurityAnnual: 30000, ssStartAge: 67 });
  ok('Social Security lengthens runway', withSS.runway > baseDraw.runway);
  // Healthcare only applies before 65: a year-66 retiree pays none.
  const lateRetiree = simulateDrawdown({ startBalance: 500000, startAge: 66, annualSpend: 40000, returnPct: 5, inflationPct: 0, healthcareAnnual: 15000 });
  ok('no healthcare gap at 66', lateRetiree.series[0].healthcare === 0);

  // ---- Tax gross-up in the drawdown ----
  // A draw above the standard deduction incurs tax that's pulled from the portfolio.
  const taxed = simulateDrawdown({ startBalance: 1000000, startAge: 50, annualSpend: 60000, returnPct: 5, inflationPct: 0, filingStatus: 'single' });
  ok('drawdown reports a positive tax on the net draw', taxed.series[0].tax > 0, String(taxed.series[0].tax));
  ok('tax gross-up withdraws more than the net draw', taxed.series[0].tax === ordinaryTaxOnWithdrawal(60000, { filingStatus: 'single' }));
  // MFJ (wider brackets + bigger standard deduction) owes less tax than single → longer runway.
  const single = simulateDrawdown({ startBalance: 1000000, startAge: 50, annualSpend: 90000, returnPct: 5, inflationPct: 0, filingStatus: 'single' });
  const mfj = simulateDrawdown({ startBalance: 1000000, startAge: 50, annualSpend: 90000, returnPct: 5, inflationPct: 0, filingStatus: 'mfj' });
  ok('MFJ owes less tax than single', mfj.series[0].tax < single.series[0].tax, `${mfj.series[0].tax} vs ${single.series[0].tax}`);
  ok('lower tax → longer (or equal) runway', mfj.runway >= single.runway);

  // ---- Pre-retirement income streams compound into savings ----
  const noStream = projectBalanceWithStreams(100000, 20000, 7, 14, 36, []);
  const withPreStream = projectBalanceWithStreams(100000, 20000, 7, 14, 36, [{ annualAmount: 10000, startAge: 36, endAge: 49 }]);
  ok('projectBalanceWithStreams: empty = plain projectBalance', noStream === projectBalance(100000, 20000, 7, 14));
  ok('pre-retirement stream boosts the savings pool', withPreStream > noStream, `${Math.round(withPreStream)} vs ${Math.round(noStream)}`);
  // A stream that only starts AT retirement (e.g. Barista) adds nothing to pre-retirement savings.
  const postOnly = projectBalanceWithStreams(100000, 20000, 7, 14, 36, [{ annualAmount: 30000, startAge: 50, endAge: 65 }]);
  ok('post-retirement stream does not change accumulation', postOnly === noStream);

  // ---- Barista income consolidated into the drawdown (forecast level) ----
  const baristaInputs = { householdBalance: 800000, householdAnnual: 0, yearsToRetirement: 0, desiredAnnualIncome: 100000, leanAnnualSpend: 40000, fatAnnualSpend: 150000, baristaPartTimeIncome: 40000, socialSecurityAnnual: 0, withdrawalRate: 4, retirementYears: 40, baseReturn: 5, baseInflation: 0, returnBand: 2, inflationBand: 1, youngestAge: 50, incomeStreams: [], healthcareAnnual: 0, ssStartAge: 67, filingStatus: 'single' };
  const fBarista = forecast(baristaInputs);
  const noBarista = forecast(Object.assign({}, baristaInputs, { baristaPartTimeIncome: 0 }));
  ok('Barista part-time income lengthens runway via the drawdown', fBarista.base.runway > noBarista.base.runway, `${fBarista.base.runway} vs ${noBarista.base.runway}`);

  // ---- Coast FIRE achieved age ----
  // fullFire = 100k/.04 = 2.5M. Already-coasting balance returns currentAge.
  // $2.5M now at 36, retire 65 → already coasts (no contrib needed) → age 36.
  ok('coastAge: already coasting = currentAge', ageCoastFireReached(2500000, 0, 36, 65, 7, 2500000) === 36);
  // Small balance + contributions: hits coast at some future age before retirement.
  const ca = ageCoastFireReached(100000, 30000, 36, 65, 7, 2500000);
  ok('coastAge: future age between now and retirement', ca != null && ca > 36 && ca <= 65, String(ca));
  // Monotonic-ish: coasting later (lower contributions) hits coast later.
  const caLow = ageCoastFireReached(100000, 10000, 36, 65, 7, 2500000);
  ok('coastAge: lower contributions → later (or null)', caLow == null || caLow >= ca, `${caLow} vs ${ca}`);
  // Never reaches → null.
  ok('coastAge: unreachable = null', ageCoastFireReached(1000, 0, 36, 65, 7, 2500000) === null);

  // ---- Coast: own-age vs classic (65) readouts (forecast level) ----
  // Early retirement (age 50): coast.classic targets 65 and, with the longer
  // runway, is reached earlier-or-equal than coast-to-50.
  const coastInputs = { householdBalance: 300000, householdAnnual: 40000, yearsToRetirement: 14, desiredAnnualIncome: 120000, leanAnnualSpend: 45000, fatAnnualSpend: 150000, baristaPartTimeIncome: 0, socialSecurityAnnual: 0, withdrawalRate: 4, retirementYears: 40, baseReturn: 7, baseInflation: 0, returnBand: 2, inflationBand: 1, youngestAge: 36, incomeStreams: [], healthcareAnnual: 0, ssStartAge: 67, filingStatus: 'mfj' };
  const fCoast = forecast(coastInputs);
  ok('coast has a classic (65) sub-readout', fCoast.milestones.coast.classic != null);
  ok('coast.targetRetirementAge = own retirement age (50)', fCoast.milestones.coast.targetRetirementAge === 50, String(fCoast.milestones.coast.targetRetirementAge));
  ok('coast.classic.targetRetirementAge = 65', fCoast.milestones.coast.classic.targetRetirementAge === 65, String(fCoast.milestones.coast.classic.targetRetirementAge));
  const ownCA = fCoast.milestones.coast.coastAge, clCA = fCoast.milestones.coast.classic.coastAge;
  ok('classic coast (to 65) reached earlier-or-equal than coast-to-50', ownCA == null || (clCA != null && clCA <= ownCA), `classic ${clCA} vs own ${ownCA}`);
  // Retiring at/after 65 collapses the two: classic clamps to the plan's own age.
  const fLate = forecast(Object.assign({}, coastInputs, { yearsToRetirement: 31 })); // retire at 67
  ok('coast.classic clamps to retirement age when ≥ 65', fLate.milestones.coast.classic.targetRetirementAge === 67, String(fLate.milestones.coast.classic.targetRetirementAge));

  // ---- Barista → Full FIRE coast time ----
  // Already at/above Full FIRE → 0 years.
  ok('baristaToFull: already full = 0', yearsFromBaristaToFull(2500000, 100000, 4, 7) === 0);
  // 7% return, 4% SWR → 3% net growth. Full FIRE = 100k/.04 = 2.5M.
  // From $1.5M: 1.5M*1.03^y >= 2.5M → y = ln(2.5/1.5)/ln(1.03) ≈ 17.3 → 18 years.
  ok('baristaToFull: coasts in ~18 yrs', yearsFromBaristaToFull(1500000, 100000, 4, 7) === 18, String(yearsFromBaristaToFull(1500000, 100000, 4, 7)));
  // Return ≤ SWR → never grows → null.
  ok('baristaToFull: return<=SWR is null', yearsFromBaristaToFull(1000000, 100000, 4, 4) === null);
  // Too far below → > 50 years → null.
  ok('baristaToFull: >50yrs is null', yearsFromBaristaToFull(100000, 100000, 4, 5) === null);

  // ---- C.1: dynamic tax bracket drawdown ----
  // MFJ $100k pre-tax withdrawal: taxable = 100k - 32.2k std ded = 67.8k.
  // tax = 10% of 24.8k + 12% of (67.8k-24.8k) = 2480 + 5160 = 7640.
  eqApprox('bracket tax MFJ $100k', ordinaryTaxOnWithdrawal(100000, { filingStatus: 'mfj' }), 7640, 0.01);
  eqApprox('afterTax pretax via brackets (MFJ)', afterTaxValue(100000, 'pretax', { filingStatus: 'mfj' }), 92360, 0.01);
  // Below the standard deduction → no tax.
  ok('bracket tax below std deduction = 0', ordinaryTaxOnWithdrawal(20000, { filingStatus: 'mfj' }) === 0);
  // Flat-rate fallback still works when no filingStatus given.
  eqApprox('flat-rate fallback', afterTaxValue(100000, 'pretax', { ordinaryRate: 0.22 }), 78000, 0.01);

  // ---- accounts: group totals ----
  const split = makeGroup({
    type: '401k',
    subAccounts: [
      { taxTreatment: 'pretax', balance: 50000, baseContribution: 12000 },
      { taxTreatment: 'roth', balance: 50000, baseContribution: 8000 },
    ],
  });
  ok('groupBalance sums subs', groupBalance(split) === 100000);
  ok('groupContribution sums subs', groupContribution(split, 2026) === 20000);

  // ---- accounts: validation warns over the limit ----
  const over = makeGroup({
    type: '401k',
    subAccounts: [
      { taxTreatment: 'pretax', baseContribution: 20000 },
      { taxTreatment: 'roth', baseContribution: 10000 },
    ],
  });
  const vOver = validateGroupYear(over, 2026, { age: 40 });
  ok('deferral over limit -> hint, not hard warning', vOver.warnings.length === 0 && vOver.hints.length >= 1, `w:${vOver.warnings.length} h:${vOver.hints.length}`);
  const vOk = validateGroupYear(over, 2026, { age: 61 }); // cap 24,500+11,250 = 35,750 > 30,000
  ok('within deferral limit at 61 -> no warning + no split hint', vOk.warnings.length === 0 && !vOk.hints.some((h) => h.includes('split it into those sources')), vOk.hints.join(' | '));
  // C.2: catch-up visibility hint fires for 50+ owners
  ok('catch-up hint at age 61 (SECURE 2.0)', vOk.hints.some((h) => h.includes('catch-up') && h.includes('60–63')), vOk.hints.join(' | '));
  ok('no catch-up hint under 50', validateGroupYear(over, 2026, { age: 45 }).hints.every((h) => !h.includes('catch-up')));

  // Mega-backdoor Roth: $65k lumped as Pre-Tax is under §415(c) -> no hard warning, just a split hint
  const mega = makeGroup({ type: '401k', subAccounts: [{ category: 'pretax', baseContribution: 65000 }] });
  const vMega = validateGroupYear(mega, 2026, { age: 36 });
  ok('mega-backdoor $65k: no hard warning', vMega.warnings.length === 0, vMega.warnings.join(' | '));
  ok('mega-backdoor $65k: gives split hint', vMega.hints.length >= 1);
  // Properly split: deferral 24,500 + after-tax 40,500 = 65,000 additions -> totally clean
  const split401 = makeGroup({ type: '401k', subAccounts: [
    { category: 'pretax', baseContribution: 24500 },
    { category: 'aftertax', baseContribution: 40500 },
  ] });
  const vSplit = validateGroupYear(split401, 2026, { age: 36 });
  ok('split mega-backdoor: no warning, no hint', vSplit.warnings.length === 0 && vSplit.hints.length === 0, `w:${vSplit.warnings.length} h:${vSplit.hints.length}`);
  // §415(c) ceiling still enforced
  const tooMuch = makeGroup({ type: '401k', subAccounts: [{ category: 'aftertax', baseContribution: 80000 }] });
  ok('§415(c) exceeded -> hard warning', validateGroupYear(tooMuch, 2026, { age: 36 }).warnings.length >= 1);
  // Employer match (category) excluded from the employee deferral limit
  const withMatch = makeGroup({
    type: '401k',
    subAccounts: [
      { category: 'pretax', baseContribution: 23000 },
      { category: 'match', baseContribution: 9000 },
    ],
  });
  ok('employer match excluded from deferral limit', validateGroupYear(withMatch, 2026, { age: 40 }).warnings.length === 0);

  // Category model: derived treatment/source/flags
  const matchSub = makeSubAccount({ category: 'match' });
  ok('match -> pretax treatment', matchSub.taxTreatment === 'pretax');
  ok('match -> employer source', matchSub.source === 'employer');
  ok('match -> not a deferral', matchSub.deferral === false);
  const rollSub = makeSubAccount({ category: 'rollover' });
  ok('rollover -> not deferral, not addition', rollSub.deferral === false && rollSub.addition === false);
  const rothConv = makeSubAccount({ category: 'roth_conversion' });
  ok('roth conversion -> roth treatment', rothConv.taxTreatment === 'roth');
  // A big rollover does NOT trigger a contribution-limit warning
  const rolloverGroup = makeGroup({ type: '401k', subAccounts: [{ category: 'rollover', baseContribution: 0, balance: 500000 }] });
  ok('rollover balance does not warn', validateGroupYear(rolloverGroup, 2026, { age: 40 }).warnings.length === 0);
  // Legacy data (bare taxTreatment) still infers a category
  ok('legacy pretax infers category', makeSubAccount({ taxTreatment: 'pretax' }).category === 'pretax');

  // ---- accounts: migration ----
  const mig = migrateLegacy(140000, 26400);
  ok('migrate -> one sub-account', mig.subAccounts.length === 1);
  ok('migrate -> pretax treatment', mig.subAccounts[0].taxTreatment === 'pretax');
  ok('migrate -> balance preserved', mig.subAccounts[0].balance === 140000);
  ok('migrate -> contribution preserved', getContribution(mig.subAccounts[0], 2026) === 26400);

  // ---- portfolio projection: composition adds up ----
  const port = projectPortfolio([split], 6, 2026, 10);
  eqApprox('portfolio total = sum of treatments',
    port.total, port.byTreatment.pretax + port.byTreatment.roth + port.byTreatment.aftertax + port.byTreatment.taxable, 0.01);

  // ---- Debt Destroyer: standardPayment + calculateMortgage ----
  // $300k @6% over 30y → ~$1,798.65/mo, ~$347,514 total interest, 360 months.
  const pmt = standardPayment(300000, 6, 360);
  eqApprox('standardPayment 300k/6%/30y', pmt, 1798.65, 1);
  const mBase = calculateMortgage({ balance: 300000, annualRatePct: 6, monthlyPayment: pmt });
  ok('mortgage pays off in ~360 months', mBase.months >= 358 && mBase.months <= 360, String(mBase.months));
  eqApprox('mortgage total interest ~347.5k', mBase.totalInterest, 347514, 3000);
  // Extra monthly principal shortens the payoff and cuts interest.
  const mExtra = calculateMortgage({ balance: 300000, annualRatePct: 6, monthlyPayment: pmt, extraMonthly: 300 });
  ok('extra principal shortens payoff', mExtra.months < mBase.months, `${mExtra.months} vs ${mBase.months}`);
  ok('extra principal saves interest', mExtra.totalInterest < mBase.totalInterest, `${Math.round(mExtra.totalInterest)} vs ${Math.round(mBase.totalInterest)}`);
  // A dated lump sum (only when it matches a calendar month) further shortens it.
  const mLump = calculateMortgage({ balance: 300000, annualRatePct: 6, monthlyPayment: pmt, startDate: { year: 2026, month: 1 }, lumpSums: [{ amount: 50000, year: 2027, month: 6 }] });
  ok('dated lump sum shortens payoff', mLump.months < mBase.months, `${mLump.months} vs ${mBase.months}`);
  // A lump sum dated before the start date is ignored.
  const mPast = calculateMortgage({ balance: 300000, annualRatePct: 6, monthlyPayment: pmt, startDate: { year: 2026, month: 1 }, lumpSums: [{ amount: 50000, year: 2020, month: 1 }] });
  ok('past-dated lump sum is ignored', mPast.months === mBase.months, `${mPast.months} vs ${mBase.months}`);
  // 0% interest → straight-line: balance / payment months, no interest.
  const mZero = calculateMortgage({ balance: 12000, annualRatePct: 0, monthlyPayment: 1000 });
  ok('0% interest pays off in 12 months', mZero.months === 12, String(mZero.months));
  ok('0% interest accrues no interest', mZero.totalInterest === 0, String(mZero.totalInterest));

  // ---- Mortgage step-down expense in the drawdown ----
  const noMort = simulateDrawdown({ startBalance: 1000000, startAge: 50, annualSpend: 60000, returnPct: 5, inflationPct: 0 });
  const withMort = simulateDrawdown({ startBalance: 1000000, startAge: 50, annualSpend: 60000, returnPct: 5, inflationPct: 0, mortgage: { annualPayment: 24000, payoffAge: 60 } });
  ok('mortgage expense shortens runway', withMort.runway < noMort.runway, `${withMort.runway} vs ${noMort.runway}`);
  ok('mortgage applies before payoff, drops after (step-down)', withMort.series[0].mortgage === 24000 && withMort.series[10].mortgage === 0,
    `y0:${withMort.series[0].mortgage} y10:${withMort.series[10].mortgage}`);

  // ---- Government pension (FERS / CSRS) ----
  // FERS: 1.0% × high-3 × years; 1.1% at 62+ with 20+ years.
  ok('FERS 100k/20yr/age55 = 1.0% → 20k', projectPension(100000, 20, 55, true) === 20000, String(projectPension(100000, 20, 55, true)));
  ok('FERS 100k/20yr/age62 = 1.1% → 22k', projectPension(100000, 20, 62, true) === 22000, String(projectPension(100000, 20, 62, true)));
  ok('FERS 100k/19yr/age62 = 1.0% (under 20yr) → 19k', projectPension(100000, 19, 62, true) === 19000, String(projectPension(100000, 19, 62, true)));
  // CSRS simplified: 5×1.5% + 5×1.75% + 10×2.0% = 36.25% of high-3.
  eqApprox('CSRS 100k/20yr = 36.25% → 36,250', projectPension(100000, 20, 60, false), 36250, 0.01);
  ok('pension zero inputs → 0', projectPension(0, 20, 62, true) === 0 && projectPension(100000, 0, 62, true) === 0);

  // ---- Pension integrated into forecast() as a stream ----
  const pensionInputs = { householdBalance: 500000, householdAnnual: 0, yearsToRetirement: 0, desiredAnnualIncome: 60000, leanAnnualSpend: 40000, fatAnnualSpend: 150000, baristaPartTimeIncome: 0, socialSecurityAnnual: 0, withdrawalRate: 4, retirementYears: 40, baseReturn: 5, baseInflation: 0, returnBand: 2, inflationBand: 1, youngestAge: 62, incomeStreams: [], healthcareAnnual: 0, ssStartAge: 67, filingStatus: 'single', pension: { high3: 100000, serviceYears: 20, startAge: 62, isFERS: true } };
  const fPension = forecast(pensionInputs);
  const fNoPension = forecast(Object.assign({}, pensionInputs, { pension: null }));
  ok('FERS pension lengthens runway via forecast stream', fPension.base.runway > fNoPension.base.runway, `${fPension.base.runway} vs ${fNoPension.base.runway}`);

  // ---- validateGroupYear: TSP / 403(b) / 457(b) ----
  // TSP $65k as pre-tax: under §415(c) → no hard warning, just a split hint (like 401k).
  const tspMega = makeGroup({ type: 'tsp', subAccounts: [{ category: 'pretax', baseContribution: 65000 }] });
  const vTsp = validateGroupYear(tspMega, 2026, { age: 36 });
  ok('TSP $65k pre-tax: no hard warning', vTsp.warnings.length === 0, vTsp.warnings.join(' | '));
  ok('TSP $65k: gives split hint', vTsp.hints.length >= 1);
  // 403(b) honors §415(c) ceiling.
  const b403over = makeGroup({ type: '403b', subAccounts: [{ category: 'aftertax', baseContribution: 80000 }] });
  ok('403(b) over §415(c) → warning', validateGroupYear(b403over, 2026, { age: 36 }).warnings.length >= 1);
  // 457(b) has its OWN elective-deferral limit (no §415(c)); over it → warning.
  const g457 = makeGroup({ type: '457b', subAccounts: [{ category: 'pretax', baseContribution: 30000 }] });
  ok('457(b) over deferral limit → warning', validateGroupYear(g457, 2026, { age: 36 }).warnings.length >= 1);
  // TSP deferral-eligible with match excluded from the employee limit (no warning).
  const tspOk = makeGroup({ type: 'tsp', subAccounts: [{ category: 'pretax', baseContribution: 20000 }, { category: 'match', baseContribution: 5000 }] });
  ok('TSP within limits (match excluded from deferral): no warning', validateGroupYear(tspOk, 2026, { age: 40 }).warnings.length === 0);
  // Agency matching toggle on but no Match source modeled → hint.
  const tspNoMatch = makeGroup({ type: 'tsp', agencyMatch: true, subAccounts: [{ category: 'pretax', baseContribution: 10000 }] });
  ok('TSP agency match on without Match source → hint', validateGroupYear(tspNoMatch, 2026, { age: 36 }).hints.some((h) => h.includes('matching is on')), validateGroupYear(tspNoMatch, 2026, { age: 36 }).hints.join(' | '));

  // ---- Early-withdrawal penalty (457(b)-on-separation aware) ----
  const noPen = simulateDrawdown({ startBalance: 1000000, startAge: 50, annualSpend: 60000, returnPct: 5, inflationPct: 0 });
  const withPen = simulateDrawdown({ startBalance: 1000000, startAge: 50, annualSpend: 60000, returnPct: 5, inflationPct: 0, earlyPenaltyRate: 0.10, penaltyExemptBalance: 0 });
  ok('penalty off by default (no field)', noPen.series[0].penalty === 0);
  ok('early-withdrawal penalty shortens runway', withPen.runway < noPen.runway, `${withPen.runway} vs ${noPen.runway}`);
  ok('early draw with no exempt pool incurs a penalty', withPen.series[0].penalty > 0, String(withPen.series[0].penalty));
  // A penalty-free pool (e.g. a 457(b)-on-separation balance) mitigates it.
  const withExempt = simulateDrawdown({ startBalance: 1000000, startAge: 50, annualSpend: 60000, returnPct: 5, inflationPct: 0, earlyPenaltyRate: 0.10, penaltyExemptBalance: 500000 });
  ok('exempt pool mitigates the penalty', withExempt.runway >= withPen.runway && withExempt.runway <= noPen.runway, `${withExempt.runway} (pen ${withPen.runway}, none ${noPen.runway})`);
  // No penalty once you're 59½+.
  const lateRet = simulateDrawdown({ startBalance: 1000000, startAge: 60, annualSpend: 60000, returnPct: 5, inflationPct: 0, earlyPenaltyRate: 0.10 });
  ok('no early penalty at 60+', lateRet.series[0].penalty === 0);

  // ======================================================================
  // v2: onboarding sanitizer, phases, SS PIA, ACA, lifecycle, events
  // ======================================================================

  // ---- sanitizeDigits ----
  ok('sanitizeDigits strips $ and commas', sanitizeDigits('$1,200') === '1200');
  ok('sanitizeDigits strips letters/decimals', sanitizeDigits('ab12.3c') === '123');
  ok('sanitizeDigits of blank', sanitizeDigits('') === '');

  // ---- spending phases ----
  const phs = [{ annualSpend: 100000, years: 5 }, { annualSpend: 50000, years: 5 }, { annualSpend: 0, years: 0 }];
  ok('phaseSchedule drops empty phases', phaseSchedule(phs).length === 2);
  ok('spendForPhaseYear in phase 1', spendForPhaseYear(phs, 0) === 100000);
  ok('spendForPhaseYear in phase 2', spendForPhaseYear(phs, 5) === 50000);
  ok('spendForPhaseYear holds last phase', spendForPhaseYear(phs, 20) === 50000);
  ok('spendForPhaseYear null when no phases', spendForPhaseYear([], 0) === null);
  eqApprox('blendedDesiredIncome weighted avg', blendedDesiredIncome(phs), 75000, 0.01);

  // ---- Social Security PIA actuarial ----
  eqApprox('SS at FRA 67 = PIA×12', ssBenefitAtClaim(2500, 67), 30000, 0.01);
  eqApprox('SS at 62 is −30%', ssBenefitAtClaim(2500, 62), 30000 * 0.70, 1);
  eqApprox('SS at 70 is +24%', ssBenefitAtClaim(2500, 70), 30000 * 1.24, 1);
  ok('SS zero PIA → 0', ssBenefitAtClaim(0, 67) === 0);

  // ---- Social Security taxation ----
  ok('SS taxable 0 below threshold', ssTaxablePortion(0, 10000, 'single') === 0);
  eqApprox('SS 85% taxable above single threshold', ssTaxablePortion(50000, 30000, 'single'), 0.85 * 30000, 0.01);
  ok('SS MFJ higher threshold not crossed', ssTaxablePortion(30000, 18000, 'mfj') === 0);

  // ---- ACA subsidy approximation ----
  const aca1 = acaSubsidy({ householdSize: 2, magi: 40000, zip: '' });
  ok('ACA subsidy reduces net premium', aca1.netPremium < aca1.benchmark, `${aca1.netPremium} vs ${aca1.benchmark}`);
  ok('ACA net premium ≥ 0', aca1.netPremium >= 0);
  const acaCliff = acaSubsidy({ householdSize: 2, magi: 200000, zip: '' });
  ok('ACA cliff above 400% FPL → no subsidy', acaCliff.cliff === true && acaCliff.subsidy === 0);

  // ---- lifecycle expenses ----
  eqApprox('home maintenance = 1% of value', lifecycleAnnual({ homeValue: 500000 }, 0, 1).homeMaint, 5000, 0.01);
  eqApprox('property tax national avg = 1.2%', lifecycleAnnual({ homeValue: 500000, useNatAvgTax: true }, 0, 1).propertyTax, 6000, 0.01);
  ok('vehicle replaces on the frequency year', lifecycleAnnual({ vehicles: [{ freq: 5, cost: 30000 }] }, 5, 1).vehicle === 30000);
  ok('vehicle off in a non-frequency year', lifecycleAnnual({ vehicles: [{ freq: 5, cost: 30000 }] }, 3, 1).vehicle === 0);
  // multiple vehicles on independent cadences both contribute in their own years
  const twoVehicles = { vehicles: [{ freq: 5, cost: 30000 }, { freq: 8, cost: 50000 }] };
  ok('two vehicles: only the matching one fires at year 5', lifecycleAnnual(twoVehicles, 5, 1).vehicle === 30000);
  ok('two vehicles: only the matching one fires at year 8', lifecycleAnnual(twoVehicles, 8, 1).vehicle === 50000);
  ok('two vehicles: both can land on the same year (LCM)', lifecycleAnnual(twoVehicles, 40, 1).vehicle === 80000);
  // multiple support recipients sum
  const support2 = { support: [{ annualAmount: 5000 }, { annualAmount: 8000 }] };
  ok('multiple support recipients sum', lifecycleAnnual(support2, 0, 1).support === 13000);
  // multiple kids with different durations
  const kids2 = { kids529: [{ annualAmount: 10000, years: 5 }, { annualAmount: 6000, years: 15 }] };
  eqApprox('both kids active in an early year', lifecycleAnnual(kids2, 2, 1).kids529, 16000, 0.01);
  eqApprox('only the longer-duration kid active later', lifecycleAnnual(kids2, 10, 1).kids529, 6000, 0.01);
  ok('neither kid active past both durations', lifecycleAnnual(kids2, 20, 1).kids529 === 0);
  const custom2 = { custom: [{ annualAmount: 12000, years: 3 }, { annualAmount: 5000, years: 8 }] };
  eqApprox('custom expenses active by duration', lifecycleAnnual(custom2, 2, 1).custom, 17000, 0.01);
  eqApprox('custom expenses expire by duration', lifecycleAnnual(custom2, 5, 1).custom, 5000, 0.01);

  // ---- inflation deflation helper ----
  eqApprox('toTodaysDollars deflates by inflation', toTodaysDollars(110, 1, 10), 100, 0.01);
  ok('toTodaysDollars at year 0 = identity', toTodaysDollars(100, 0, 10) === 100);

  // ---- simulateDrawdown: phases, Medicare, events ----
  const dPhases = simulateDrawdown({ startBalance: 5000000, startAge: 50, annualSpend: 0, returnPct: 0, inflationPct: 0, phases: [{ annualSpend: 100000, years: 5 }, { annualSpend: 50000, years: 5 }] });
  ok('drawdown phase-1 spend', dPhases.series[0].spend === 100000);
  ok('drawdown phase-2 spend', dPhases.series[5].spend === 50000);
  const dMed = simulateDrawdown({ startBalance: 5000000, startAge: 64, annualSpend: 40000, returnPct: 0, inflationPct: 0, healthcareAnnual: 10000, medicareAnnual: 6500, persons: 2 });
  ok('pre-65 healthcare uses ACA/manual', dMed.series[0].healthcare === 10000);
  ok('65+ healthcare switches to Medicare×persons', dMed.series[1].healthcare === 13000);
  const dCorr = simulateDrawdown({ startBalance: 1000, startAge: 50, annualSpend: 0, returnPct: 0, inflationPct: 0, events: [{ type: 'correction', age: 51, dropPct: 0.5 }] });
  eqApprox('market-correction event halves balance that year', dCorr.series[1].balance, 500, 0.01);
  const dOne = simulateDrawdown({ startBalance: 100000, startAge: 50, annualSpend: 0, returnPct: 0, inflationPct: 0, events: [{ type: 'oneTime', age: 50, amount: 10000 }] });
  eqApprox('one-time expense event draws from balance', dOne.series[0].balance, 90000, 0.01);
  const dGeo = simulateDrawdown({ startBalance: 5000000, startAge: 50, annualSpend: 50000, returnPct: 0, inflationPct: 0, events: [{ type: 'geo', age: 50, multiplier: 0.5 }] });
  ok('geo-arbitrage multiplies spend', dGeo.series[0].spend === 25000);

  // ---- forecastWithEvents: baseline vs impacted ----
  const evInputs = { householdBalance: 500000, householdAnnual: 10000, yearsToRetirement: 10, desiredAnnualIncome: 40000, leanAnnualSpend: 30000, fatAnnualSpend: 100000, baristaPartTimeIncome: 0, socialSecurityAnnual: 0, withdrawalRate: 4, retirementYears: 40, baseReturn: 5, baseInflation: 0, returnBand: 2, inflationBand: 1, youngestAge: 40, incomeStreams: [], healthcareAnnual: 0, ssStartAge: 67, filingStatus: 'single' };
  const baseEv = forecastWithEvents(evInputs, []);
  const impEv = forecastWithEvents(evInputs, [{ type: 'correction', age: 45, dropPct: 0.3 }]);
  const endOf = (r) => r.series[r.series.length - 1].balance;
  ok('forecastWithEvents builds a full-life series', baseEv.series.length > evInputs.yearsToRetirement);
  ok('a market correction lowers the impacted ending balance', endOf(impEv) < endOf(baseEv), `${endOf(impEv)} vs ${endOf(baseEv)}`);

  // ---- retirementYears -> horizonYears wiring (bug fix) ----
  // The drawdown horizon must follow the user's "years in retirement" input,
  // not always run a fixed 60 years regardless of it.
  const shortHorizon = Object.assign({}, evInputs, { retirementYears: 10 });
  const longHorizon = Object.assign({}, evInputs, { retirementYears: 50 });
  const shortEv = forecastWithEvents(shortHorizon, []);
  const longEv = forecastWithEvents(longHorizon, []);
  const accPoints = shortHorizon.yearsToRetirement + 1; // accumulation leg length is unaffected
  ok('short retirementYears caps the drawdown horizon', shortEv.series.length === accPoints + 10, `${shortEv.series.length} vs expected ${accPoints + 10}`);
  ok('longer retirementYears yields a longer series', longEv.series.length > shortEv.series.length, `${longEv.series.length} vs ${shortEv.series.length}`);
  const fcShort = forecast(Object.assign({}, evInputs, { retirementYears: 10, fatAnnualSpend: 100000, leanAnnualSpend: 30000 }));
  ok('forecast() also respects retirementYears for the drawdown', fcShort.base.drawdown.series.length <= 10);

  // ---- render ----
  const summary = { pass, fail, total: pass + fail };
  window.__TEST_RESULTS__ = { summary, results };
  console.log(`TESTS: ${pass}/${pass + fail} passed`, summary);

  const root = document.getElementById('test-output');
  if (root) {
    root.innerHTML =
      `<div class="summary ${fail === 0 ? 'allpass' : 'somefail'}">${pass} / ${pass + fail} passed${fail ? ` · ${fail} FAILED` : ' ✓'}</div>` +
      results.map((r) =>
        `<div class="t ${r.cond ? 'p' : 'f'}"><span>${r.cond ? '✓' : '✗'}</span> ${r.name}${r.cond ? '' : ` — <em>${r.detail}</em>`}</div>`
      ).join('');
  }
})();

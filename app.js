// app.js — wires the DOM to calc.js. Recomputes on every input/slider change.

const $ = (id) => document.getElementById(id);
const parseMoney = (v) => parseFloat(String(v == null ? '' : v).replace(/[$,\s]/g, '')) || 0;
const num = (id) => parseMoney($(id).value);

const fmt$ = (n) => {
  if (!isFinite(n)) return '∞';
  return '$' + Math.round(n).toLocaleString('en-US');
};
const fmt$k = (n) => {
  if (!isFinite(n)) return '∞';
  const abs = Math.abs(n);
  if (abs >= 1e6) {
    // Up to 3 decimals, trimming trailing zeros: 1.125M, 3.5M, 2M.
    return '$' + parseFloat((n / 1e6).toFixed(3)) + 'M';
  }
  if (abs >= 1000) return '$' + (n / 1000).toFixed(0) + 'k';
  return fmt$(n);
};
const fmtYears = (n) => (isFinite(n) ? n.toFixed(0) : '∞');
const fmtAge = (a) => (a == null ? '—' : a.toFixed(a % 1 ? 1 : 0));
const fmtInput = (n) => Math.round(parseMoney(n)).toLocaleString('en-US');
const moneyAttr = (n) => escAttr(fmtInput(n));

// v2: global inflation display mode — 'nominal' (engine default) | 'today'.
let inflMode = 'nominal';
// Deflate a single nominal value into today's dollars when the toggle is on.
function deflate(value, yearsFromNow, inflPct) {
  return (inflMode === 'today' && typeof toTodaysDollars === 'function')
    ? toTodaysDollars(value, yearsFromNow, inflPct) : value;
}
// Deflate a {age, balance} series relative to its first age.
function deflateSeries(series, inflPct) {
  if (inflMode !== 'today' || !series.length) return series;
  const startAge = series[0].age;
  return series.map((p) => Object.assign({}, p, { balance: deflate(p.balance, p.age - startAge, inflPct) }));
}

// Gather all inputs into the normalized shape calc.forecast() expects.
// Household / ages / Social Security for the tab currently on screen. The Goal
// Builder keeps its OWN independent household (goalAgeA/goalRetA/goalSsA…); every
// other tab uses the Forecast household. Reading from the active tab here makes
// buildInputs() a single source of truth, so renderers no longer have to patch the
// values afterward (the old, drift-prone approach). Same shape either way.
// v2.6: Goal Builder is the single source of truth for household/age/SS on
// EVERY tab now (not just its own) — Forecast's ageA/retA/ssA/household
// fields are read-only mirrors kept in sync by syncForecastHouseholdFromGoal()
// below, so the two tabs can never silently diverge.
function activeHouseholdInputs() {
  if ($('goalHousehold')) return getGoalBuilderHouseholdInputs();
  const isCouple = $('household').value === 'couple';
  return {
    isCouple,
    ageA: num('ageA'), retA: num('retA'), ssA: num('ssA'),
    ageB: isCouple ? num('ageB') : 0,
    retB: isCouple ? num('retB') : 0,
    ssB: isCouple ? num('ssB') : 0,
  };
}
// Mirrors Goal Builder's household/age/SS fields onto the Forecast tab's
// (now read-only) fields, so every other bit of code that still reads
// ageA/retA/ssA/household directly (account-owner age, milestone clock,
// onboarding wizard prefill) keeps working unchanged.
function syncForecastHouseholdFromGoal() {
  if (!$('goalHousehold') || !$('household')) return;
  const isCouple = $('goalHousehold').value === 'couple';
  $('household').value = isCouple ? 'couple' : 'single';
  $('ageA').value = $('goalAgeA').value;
  $('retA').value = $('goalRetA').value;
  $('ssA').value = $('goalSsA').value;
  if (isCouple) {
    $('ageB').value = $('goalAgeB').value;
    $('retB').value = $('goalRetB').value;
    $('ssB').value = $('goalSsB').value;
  }
  toggleCouple();
}

// Lean/Fat FIRE spend mirror Goal Builder's Lean ($45k) / Fat ($120k) tier
// pills, COL-adjusted for the master ZIP — same read-only-mirror pattern as
// household/age/SS above, so editing them only happens in one place.
function syncLeanFatFromGoal() {
  if (!$('lean') || !$('fat') || typeof colAdjustedCategories !== 'function') return;
  const sumCats = (cats) => Object.values(cats).reduce((s, v) => s + v, 0);
  $('lean').value = fmtInput(sumCats(colAdjustedCategories(SPEND_TIER_BASE.lean)));
  $('fat').value = fmtInput(sumCats(colAdjustedCategories(SPEND_TIER_BASE.fat)));
}

// Forecast's "Pre-65 health insurance" is now a read-only mirror of Goal
// Builder's own manual fallback field (used when no ACA MAGI is set) — same
// pattern as household/age/SS/Lean/Fat above.
function syncHealthcareFromGoal() {
  if (!$('healthcare') || !$('goalHealthcareManual')) return;
  $('healthcare').value = $('goalHealthcareManual').value;
}

function buildInputs() {
  const { isCouple, ageA, retA, ssA, ageB, retB, ssB } = activeHouseholdInputs();

  // Sliders (levers applied on top of base inputs).
  const baseReturn = num('returnRate');
  const withdrawalRate = num('withdrawalRate');
  const extra = num('extraContribution');
  // "Shift retirement age" lives only on the Forecast tab's What-if panel — it has no
  // Goal Builder equivalent and isn't shown there. Without this guard it silently
  // shifted Goal Builder's horizon away from the goalRetA/goalRetB the user actually
  // typed (e.g. "retiring at 50" next to "horizon: age 45" with no explanation).
  // Goal Builder's own household is meant to be fully independent — see ssA/ssB above
  // — so this lever simply doesn't apply there. It still applies everywhere else
  // (Forecast, Scenario Playground, Debt, Strategy) which share the Forecast household.
  const ageShift = activeTab === 'goal' ? 0 : num('ageShift');

  // Savings and contributions are entered once for the whole household.
  const householdBalance = num('bal');
  const householdAnnual = num('con') + extra;
  const socialSecurityAnnual = ssA + (isCouple ? ssB : 0);

  // Project to the FIRST retirement — when the household stops full-time work
  // and begins drawing down. (Years until each person's own retirement; the
  // soonest wins.) The what-if age lever shifts the dates.
  const retAdj = (r) => r + ageShift;
  const yearsA = retAdj(retA) - ageA;
  const yearsB = isCouple ? retAdj(retB) - ageB : Infinity;
  const yearsToRetirement = Math.max(0, Math.min(yearsA, yearsB));
  // Milestone clock = the current age of whoever retires first.
  const firstRetiree = yearsB < yearsA ? 'B' : 'A';
  const youngestAge = firstRetiree === 'B' ? ageB : ageA;

  // Debt Destroyer → a fixed-nominal "step-down" expense in the drawdown: the
  // mortgage payment is part of required spending until it's paid off, then
  // drops out. payoffAge is measured on the first-retiree's age clock.
  const debt = computeDebt();
  const mortgage = debt.active
    ? { annualPayment: debt.d.effectivePayment * 12, payoffAge: youngestAge + debt.accel.months / 12 }
    : null;

  // Government (FERS/CSRS) pension — forecast() runs projectPension and injects a
  // lifetime stream from the eligibility age. Null/zero when not entered.
  const pensionHigh3 = num('pensionHigh3');
  const pensionYears = num('pensionYears');
  const pension = (pensionHigh3 > 0 && pensionYears > 0)
    ? { high3: pensionHigh3, serviceYears: pensionYears, startAge: num('pensionStartAge') || 62, isFERS: $('pensionSystem').value !== 'csrs' }
    : null;

  // Early-withdrawal penalty modeling, only when retiring before 59½: pre-tax
  // draws normally incur 10%, but genuinely penalty-free sources are exempt —
  // taxable, Roth/after-tax basis, AND 457(b) balances flagged penalty-free on
  // separation. A flagged 457(b) enlarges this pool → less penalty → more runway.
  const retAge = youngestAge + yearsToRetirement;
  const pen = earlyPenaltyContext(retAge, yearsToRetirement, baseReturn);

  // --- v2: spending phases (Goal Builder). They drive the drawdown's per-year
  // spending CURVE (e.g. front-loaded Go-Go spend tapering down) whenever any are
  // defined. They do NOT auto-overwrite "Desired household income" — use the
  // "Pull from Goal Builder" buttons to copy the blended figure in deliberately.
  const phases = goalPhases();
  const phasesOn = phases.length > 0;
  const desiredAnnualIncome = num('desired');

  // --- v2: healthcare. ACA estimate (Goal Builder) feeds pre-65 cost when a MAGI
  // is set; otherwise the manual fallback is Goal Builder's own field — NOT
  // Forecast's #healthcare, which is now just a read-only mirror of it (see
  // syncHealthcareFromGoal()). Read the source directly rather than trusting
  // the mirror to have synced first.
  const aca = goalAca();
  const healthcareAnnual = (aca && aca.magiOn) ? Math.round(aca.netPremium) : num($('goalHealthcareManual') ? 'goalHealthcareManual' : 'healthcare');
  const medicareAnnual = (typeof MEDICARE_BASELINE_ANNUAL === 'number') ? MEDICARE_BASELINE_ANNUAL : 6500;
  const persons = isCouple ? 2 : 1;

  // --- v2: lifecycle expenses (null = none, preserves default drawdown behavior).
  const lifecycle = goalLifecycle();

  // Social Security: claim-early, worst-case assumption — starts at 62, same
  // figure Goal Builder already hardcodes (GOAL_SS_CLAIM_AGE). The PIA model
  // (separate PIA $ + claiming-age sliders overriding this) was removed —
  // one fewer thing to configure, consistent across both tabs.
  const ssAnnual = socialSecurityAnnual;
  const ssStart = 62;

  return {
    isCouple,
    householdBalance,
    householdAnnual,
    socialSecurityAnnual: ssAnnual,
    withdrawalRate,
    baseReturn,
    baseInflation: num('inflation'),
    returnBand: num('returnBand'),
    inflationBand: num('inflationBand'),
    desiredAnnualIncome,
    leanAnnualSpend: num('lean'),
    fatAnnualSpend: num('fat'),
    baristaPartTimeIncome: 0,
    retirementYears: num('retYears'),
    youngestAge,
    yearsToRetirement,
    firstRetiree, // 'A' | 'B' — whose retirement drives the horizon
    // Phase 2 drawdown inputs:
    healthcareAnnual,
    ssStartAge: ssStart,
    incomeStreams: incomeStreams.map((s) => ({ label: s.label, annualAmount: s.annualAmount, startAge: s.startAge, endAge: s.endAge })),
    // Filing status for tax gross-up: a couple files jointly (MFJ).
    filingStatus: isCouple ? 'mfj' : 'single',
    mortgage, // Debt Destroyer step-down expense (null = no modeled debt)
    pension,  // Government pension → projectPension stream in forecast()
    earlyPenaltyRate: pen.rate,
    penaltyExemptBalance: pen.exempt,
    // v2: Goal Builder
    phases: phasesOn ? phases : null,
    medicareAnnual, persons, lifecycle,
  };
}

// --- v2: Goal Builder input readers -------------------------------------

// Spending phases, read from the dynamic spendingPhases[] list (see CRUD below).
function goalPhases() {
  return spendingPhases
    .map((p) => ({ name: p.name, annualSpend: p.annualSpend, years: p.years }))
    .filter((p) => p.years > 0);
}

// ACA subsidy estimate from Goal Builder inputs. magiOn flags whether the user
// has engaged it (a MAGI is set) — when true, it feeds the pre-65 healthcare cost.
function goalAca() {
  if (typeof acaSubsidy !== 'function' || !$('acaMagi')) return null;
  const magi = num('acaMagi');
  const res = acaSubsidy({
    householdSize: num('acaHousehold') || 1,
    magi,
    zip: userLocation.zip || '', // single master ZIP (Goal Builder), not a separate Healthcare ZIP field
  });
  return Object.assign({ magiOn: magi > 0 }, res);
}
// Healthcare household size defaults from the Goal Builder Household selector
// (fixes Household=Single / Healthcare household=2 silently diverging) — only
// when the user hasn't touched it themselves.
let acaHouseholdEdited = false;
function syncAcaHouseholdFromGoal() {
  if (acaHouseholdEdited || !$('acaHousehold') || !$('goalHousehold')) return;
  $('acaHousehold').value = $('goalHousehold').value === 'couple' ? 2 : 1;
}

// Home is a single-value section (not a dynamic list like vehicles/support/
// kids/custom), but should behave the same way to a user: hidden behind
// "+ Add home" until clicked, not two boxes sitting open by default with
// nothing in them. revealHomeSection() shows it (called on click, or on
// boot/restore when a saved scenario already has a non-zero value).
function revealHomeSection() {
  if ($('homeSection')) $('homeSection').classList.remove('hidden');
  if ($('homeEmpty')) $('homeEmpty').classList.add('hidden');
  if ($('addHomeBtn')) $('addHomeBtn').classList.add('hidden');
  if ($('removeHomeBtn')) $('removeHomeBtn').classList.remove('hidden');
}
// The "×" counterpart to revealHomeSection() — clears the values (back to the
// same zeroed default a fresh page has) and collapses back to the empty
// state, same as removing the only row from a vehicle/support/kid list.
function removeHomeSection() {
  if ($('homeValue')) $('homeValue').value = '0';
  if ($('propertyTax')) $('propertyTax').value = '0';
  if ($('propertyTaxNatAvg')) $('propertyTaxNatAvg').checked = false;
  if ($('homeSection')) $('homeSection').classList.add('hidden');
  if ($('homeEmpty')) $('homeEmpty').classList.remove('hidden');
  if ($('addHomeBtn')) $('addHomeBtn').classList.remove('hidden');
  if ($('removeHomeBtn')) $('removeHomeBtn').classList.add('hidden');
  recompute(); refreshActiveTab(); saveState();
}
function syncHomeSectionVisibility() {
  if (num('homeValue') > 0 || num('propertyTax') > 0) revealHomeSection();
}

// Lifecycle expense bundle, or null when nothing is entered (keeps the drawdown
// on its default no-lifecycle path). Vehicles/support/kids-529 read from their
// own dynamic lists (see CRUD below); home value/property tax stay single-value
// (one primary residence).
function goalLifecycle() {
  if (!$('homeValue')) return null;
  const lc = {
    homeValue: num('homeValue'),
    propertyTax: num('propertyTax'),
    useNatAvgTax: !!($('propertyTaxNatAvg') && $('propertyTaxNatAvg').checked),
    // `label` rides along for display only — the engine (lifecycleAnnual) ignores it.
    vehicles: vehicleItems.filter((v) => v.cost > 0 && v.freq > 0).map((v) => ({ freq: v.freq, cost: v.cost, label: v.label })),
    support: supportItems.filter((s) => s.annualAmount > 0).map((s) => ({ annualAmount: s.annualAmount, label: s.label })),
    kids529: kids529Items.filter((k) => k.annualAmount > 0 && k.years > 0).map((k) => ({ annualAmount: k.annualAmount, years: k.years, label: k.label })),
    custom: customExpenseItems.filter((x) => x.annualAmount > 0 && x.years > 0).map((x) => ({ annualAmount: x.annualAmount, years: x.years, label: x.label })),
  };
  const any = lc.homeValue || lc.propertyTax || lc.vehicles.length || lc.support.length || lc.kids529.length || lc.custom.length;
  return any ? lc : null;
}

// ======================================================================
// v2.6: master location (single ZIP, drives COL / ACA / property-tax / state
// tax everywhere). Lives in plain module state — this app has no
// React/Zustand store, so `location` plays that role; every reader (ACA,
// property tax default, spend-tier category budgets, Forecast) pulls from it.
// ======================================================================
let userLocation = Object.assign({ zip: '', city: '', matched: false }, (typeof LOCATION_NATIONAL_AVG !== 'undefined' ? LOCATION_NATIONAL_AVG : {}));
function refreshLocation() {
  const zipEl = $('goalZip');
  if (!zipEl || typeof lookupLocation !== 'function') return;
  const prevZip = userLocation.zip;
  userLocation = lookupLocation(zipEl.value);
  if ($('goalZipResult')) {
    $('goalZipResult').innerHTML = userLocation.matched
      ? `<strong>${userLocation.city}</strong> — COL ${userLocation.rpp_all}% US avg`
      : `Using US national averages (COL 100%) — enter a ZIP to refine.`;
  }
  // Make the ZIP → spend connection explicit, right where the categories it
  // scales actually live — otherwise the COL adjustment happens invisibly and
  // there's nothing on screen tying the two together.
  if ($('colConnectionNote')) {
    $('colConnectionNote').innerHTML = userLocation.matched
      ? `📍 Categories below are scaled for <strong>${userLocation.city}</strong> (COL ${userLocation.rpp_all}% of US avg) — change the ZIP above to rescale.`
      : `📍 Categories below use US national averages — enter a ZIP above to scale them to your area.`;
  }
  if ($('locationFromGoal')) {
    // Click handled by the single delegated [data-jump-tab] listener (see
    // wiring section) — no per-render listener needed here.
    $('locationFromGoal').innerHTML = (userLocation.matched
      ? `Using ${userLocation.zip} · ${userLocation.city} from Your Target`
      : `Using US national averages from Your Target (no ZIP entered)`) +
      ` · <a href="#" class="edit-in-goal-link" data-jump-tab="goal">change</a>`;
  }
  if (userLocation.zip !== prevZip) {
    // A changed master ZIP immediately rescales every Auto-state category
    // (applySpendTier only ever touches non-edited categories) and leaves
    // anything the user has explicitly Edited untouched.
    applySpendTier(activeSpendTier || 'base', { keepEdited: true });
    const editedCount = Object.values(spendCategoryEdited).filter(Boolean).length;
    if ($('locationChangeBanner')) {
      $('locationChangeBanner').innerHTML = (editedCount && prevZip)
        ? `Location updated: <strong>${userLocation.city}</strong>. ${editedCount} edited field${editedCount > 1 ? 's' : ''} kept. ` +
          `<button type="button" class="btn-link" id="locApplyAllBtn">Apply new COL to all</button> ` +
          `<button type="button" class="btn-link" id="locKeepEditsBtn">Keep my edits</button>`
        : '';
      const applyBtn = $('locApplyAllBtn');
      if (applyBtn) applyBtn.addEventListener('click', () => {
        Object.keys(spendCategoryEdited).forEach((k) => { spendCategoryEdited[k] = false; });
        applySpendTier(activeSpendTier || 'base', { keepEdited: false });
        $('locationChangeBanner').innerHTML = '';
      });
      const keepBtn = $('locKeepEditsBtn');
      if (keepBtn) keepBtn.addEventListener('click', () => { $('locationChangeBanner').innerHTML = ''; });
    }
  }
}

// --- v2.6: spend-tier presets + COL-adjusted category budgets ----------
const SPEND_TIER_BASE = { lean: 45000, base: 65000, comfort: 85000, fat: 120000 };
// Base-tier ($65k) category split. Other tiers scale proportionally; healthcare
// stays flat across tiers (it's driven by ACA/Medicare modeling, not lifestyle).
const SPEND_BASE_CATEGORIES = { housing: 18000, food: 8500, transportation: 9750, healthcare: 8500, travel: 6000, other: 14250 };
const SPEND_CATEGORY_LABELS = { housing: 'Housing', food: 'Food', transportation: 'Transportation', healthcare: 'Healthcare', travel: 'Travel', other: 'Other' };
// Natural-language noun phrase for sentences like "a typical ___" — most
// categories read fine lowercased ("a typical housing budget"), but "Other"
// doesn't ("a typical other budget" is nonsense); needs its own phrase.
const SPEND_CATEGORY_PHRASE = { housing: 'housing', food: 'food', transportation: 'transportation', healthcare: 'healthcare', travel: 'travel', other: 'miscellaneous expenses' };
let spendCategories = Object.assign({}, SPEND_BASE_CATEGORIES);
let spendCategoryEdited = { housing: false, food: false, transportation: false, travel: false, other: false }; // healthcare excluded — modeled separately
let activeSpendTier = 'base';
let lifecycleSuggestionsShown = false;

// COL-adjusted category budget for a given national base amount, before any
// user edits. Housing uses RPP_rent (housing-specific); everything else but
// healthcare (kept flat — it's modeled via ACA/Medicare, not COL) uses RPP_all.
function colAdjustedCategories(tierBase) {
  const scale = tierBase / SPEND_TIER_BASE.base;
  const rppAll = (userLocation.rpp_all || 100) / 100;
  const rppRent = (userLocation.rpp_rent || 100) / 100;
  const out = {};
  Object.keys(SPEND_BASE_CATEGORIES).forEach((k) => {
    const national = SPEND_BASE_CATEGORIES[k] * scale;
    if (k === 'healthcare') out[k] = Math.round(national); // flat, no COL scaling
    else if (k === 'housing') out[k] = Math.round(national * rppRent);
    else out[k] = Math.round(national * rppAll);
  });
  return out;
}
function spendCategoriesTotal() { return Object.values(spendCategories).reduce((s, v) => s + v, 0); }

// Clicking a tier pill fills every category that hasn't been hand-edited.
function applySpendTier(tier, opts = {}) {
  const base = SPEND_TIER_BASE[tier]; if (!base) return;
  const adjusted = colAdjustedCategories(base);
  activeSpendTier = tier;
  Object.keys(adjusted).forEach((k) => {
    if (opts.keepEdited !== false && spendCategoryEdited[k]) return; // editing a category locks it out of re-fill, no lock icon — just respected
    spendCategories[k] = adjusted[k];
  });
  syncFirstPhaseFromCategories();
  maybeShowLifecycleSuggestions();
  renderSpendCategories();
}
function editSpendCategory(key, value) {
  spendCategories[key] = Math.max(0, parseMoney(value));
  spendCategoryEdited[key] = true;
  activeSpendTier = null; // any edit away from a preset → "Custom" state, no pill selected
  syncFirstPhaseFromCategories();
  // Deliberately no renderSpendCategories() call here — this runs on every
  // keystroke/drag-tick. Rebuilding the list here would destroy the very
  // input/slider the user has focus or mouse-capture on (the bug this whole
  // guard exists to prevent). The container's 'change' listener does the
  // full rebuild once the interaction actually finishes.
}
function resetSpendCategoriesToBase() {
  Object.keys(spendCategoryEdited).forEach((k) => { spendCategoryEdited[k] = false; });
  applySpendTier('base', { keepEdited: false });
}
// The category budget IS the first spending phase's annual amount — keeps the
// existing phases engine (drawdown curve) as the single source of truth; we
// don't fork a second spend model.
function syncFirstPhaseFromCategories() {
  if (!spendingPhases.length) spendingPhases.push(makePhase({ name: 'Retirement spending', years: phaseDefaults()[0].years }));
  spendingPhases[0].annualSpend = spendCategoriesTotal();
  renderPhases();
}
// Compact 2-row-per-category layout (~58px/row): row 1 = label + Suggested
// chip (Auto only); row 2 = text input + info-tip (the app's standard hover/
// focus tooltip bubble — a bare title= attribute is invisible on touch/
// keyboard and easy to mistake for a dead button) + an inline ↺ reset when
// Edited. One shared source footnote replaces the old per-row helper text.
function renderSpendCategories() {
  const el = $('spendCategoriesContainer');
  if (!el) return;
  // This is called on every keystroke (the document-level 'input' listener
  // triggers recompute()+refreshActiveTab() for ALL inputs app-wide) and it
  // replaces the whole list via innerHTML — which would otherwise destroy and
  // recreate the very input the user is typing into, dropping focus after
  // every single character. Preserve focus + cursor position across the
  // rebuild.
  const active = document.activeElement;
  const hadFocus = active && el.contains(active) && active.id;
  const selStart = hadFocus && typeof active.selectionStart === 'number' ? active.selectionStart : null;
  const selEnd = hadFocus && typeof active.selectionEnd === 'number' ? active.selectionEnd : null;
  const keys = Object.keys(SPEND_CATEGORY_LABELS);
  el.innerHTML = keys.map((k, i) => {
    const edited = !!spendCategoryEdited[k];
    const auto = !edited;
    const v = spendCategories[k] || 0;
    const resetTo = colAdjustedCategories(SPEND_TIER_BASE[activeSpendTier || 'base'])[k] || v;
    // Plain language, not the underlying data-source jargon (BLS/BEA RPP)
    // that a typical user has no reason to know. Auto and Edited get
    // DIFFERENT wording — once a user types their own number, it's no longer
    // "a typical regional budget", it's their own figure. Describing an
    // edited value as if it were still the suggestion would misattribute the
    // user's own input back to us.
    const colPhrase = userLocation.matched
      ? (userLocation.rpp_all > 100 ? `${userLocation.rpp_all - 100}% above` : userLocation.rpp_all < 100 ? `${100 - userLocation.rpp_all}% below` : 'about equal to')
      : null;
    const sourceTitle = auto
      ? `${fmt$(v)}/yr — typically budgeted for ${SPEND_CATEGORY_PHRASE[k]}` +
        (colPhrase ? `, adjusted for ${userLocation.city} (${colPhrase} the US average cost of living)` : ' (US average)')
      : `Your own number — the suggested amount for ${SPEND_CATEGORY_PHRASE[k]} was ${fmt$(resetTo)}/yr.`;
    const row = `<div class="field cat-field ${auto ? 'auto-value' : 'edited-value'}">
      <div class="cat-row-1">
        <label for="cat_${k}">${SPEND_CATEGORY_LABELS[k]}</label>
        ${auto ? '<span class="suggested-chip">✨ Suggested</span>' : ''}
      </div>
      <div class="cat-input-row">
        <input type="text" inputmode="decimal" id="cat_${k}" data-cat="${k}" value="${fmtInput(v)}" aria-describedby="cat_${k}_help">
        ${!auto ? `<button type="button" class="reset-inline reset-cat-btn" data-cat="${k}" title="Reset to ${fmt$(resetTo)}" aria-label="Reset ${SPEND_CATEGORY_LABELS[k]} to ${fmt$(resetTo)}">↺</button>` : ''}
        <span class="info-tip" id="cat_${k}_help" tabindex="0">ⓘ<span class="info-tip-bubble">${escAttr(sourceTitle)}</span></span>
      </div>
    </div>`;
    const isLast = i === keys.length - 1;
    return row + (isLast
      ? `<div class="cat-source-footer">These are typical US household budgets, scaled to your area's cost of living · <a href="#" id="catSourceDetailsLink">how?</a></div>
         <p class="cat-source-footer hidden" id="catSourceDetails">Housing is scaled using local rent costs specifically; Food, Transportation, Travel, and Other use your area's overall cost of living. Healthcare isn't scaled here — it's estimated separately based on your age and health coverage (ACA before 65, Medicare after).</p>`
      : '');
  }).join('');
  const total = spendCategoriesTotal();
  const stateEl = $('spendTierState');
  if (stateEl) {
    stateEl.textContent = activeSpendTier ? '' : `Custom ${fmt$k(total)} — `;
    if (!activeSpendTier) {
      stateEl.innerHTML = `Custom ${fmt$k(total)} — <button type="button" class="btn-link" id="resetAllTiersBtn">Reset all to Base</button>`;
    }
  }
  document.querySelectorAll('#spendTierPills .tier-pill').forEach((p) => p.classList.toggle('active', p.dataset.tier === activeSpendTier));
  if ($('resetAllTiersBtn')) $('resetAllTiersBtn').addEventListener('click', () => { resetSpendCategoriesToBase(); recompute(); refreshActiveTab(); saveState(); });
  document.querySelectorAll('.reset-cat-btn').forEach((b) => b.addEventListener('click', (e) => {
    const k = e.target.dataset.cat;
    spendCategoryEdited[k] = false;
    spendCategories[k] = colAdjustedCategories(SPEND_TIER_BASE[activeSpendTier || 'base'])[k];
    syncFirstPhaseFromCategories(); renderSpendCategories(); recompute(); refreshActiveTab(); saveState();
  }));
  if ($('catSourceDetailsLink')) $('catSourceDetailsLink').addEventListener('click', (e) => {
    e.preventDefault();
    $('catSourceDetails').classList.toggle('hidden');
  });
  if (hadFocus) {
    const restored = document.getElementById(active.id);
    if (restored) {
      restored.focus();
      if (selStart != null && typeof restored.setSelectionRange === 'function') {
        try { restored.setSelectionRange(selStart, selEnd); } catch (e) { /* range inputs don't support selection */ }
      }
    }
  }
}
function wireSpendTiers() {
  if ($('spendTierPills')) $('spendTierPills').addEventListener('click', (e) => {
    const btn = e.target.closest('.tier-pill'); if (!btn) return;
    applySpendTier(btn.dataset.tier);
    recompute(); refreshActiveTab(); saveState();
  });
  const cont = $('spendCategoriesContainer');
  if (cont) {
    cont.addEventListener('input', (e) => {
      if (!e.target.dataset.cat) return;
      editSpendCategory(e.target.dataset.cat, e.target.value);
      recompute(); refreshActiveTab(); saveState();
    });
    // 'change' fires once when a drag/edit actually finishes (slider release,
    // or text blur with a changed value) — safe point to do the full rebuild
    // that 'input' skips above, so the Auto/Edited tint, chip, and reset link
    // catch up without ever interrupting an in-progress drag or keystroke.
    cont.addEventListener('change', (e) => {
      if (!e.target.dataset.cat) return;
      renderSpendCategories();
    });
  }
}
// #12 — first time a tier pill is picked, surface (not auto-add) the two most
// common forgotten lifecycle costs as one-click "Add" chips.
function maybeShowLifecycleSuggestions() {
  if (lifecycleSuggestionsShown) return;
  lifecycleSuggestionsShown = true;
  const el = $('lifecycleSuggestions');
  if (!el) return;
  el.innerHTML = `
    <button type="button" class="btn-link lc-suggest-chip" id="suggestVehicleBtn">+ Add vehicle replacement — $35k every 8 years</button>
    <button type="button" class="btn-link lc-suggest-chip" id="suggestHomeBtn">+ Add home maintenance — 1%/yr</button>`;
  if ($('suggestVehicleBtn')) $('suggestVehicleBtn').addEventListener('click', () => {
    vehicleItems.push(makeVehicle({ label: 'Car', cost: 35000, freq: 8 }));
    onVehiclesChanged();
    el.innerHTML = '';
  });
  if ($('suggestHomeBtn')) $('suggestHomeBtn').addEventListener('click', () => {
    if ($('lifecycleAccordion')) $('lifecycleAccordion').open = true;
    if ($('homeValue')) { $('homeValue').focus(); $('homeValue').scrollIntoView({ block: 'center' }); }
    el.innerHTML = '';
  });
}

// --- v2: Goal Builder dynamic lists (phases / vehicles / support / kids-529 / custom) --
// Each mirrors the income-streams CRUD pattern: makeX/xRowHTML/renderX/xById/
// onXChanged/addX/removeX/wireX/initX, persisted as its own array under __key.

let spendingPhases = [];
let _phaseId = 0;
// Start simple: one flat phase covering the whole retirement. Seeding three life-
// stage phases up front overwhelms users new to the concept — they can split this
// into Go-Go / Slow-Go / No-Go stages via "+ Add phase" whenever they're ready.
//
// Duration is derived from the retirement age so it plans through a longevity age
// (~95) rather than a fixed 30 yrs: a FIRE plan (retire ~50) gets the 40-45 yr
// horizon it actually needs, while a traditional age-65 retirement still lands on
// the classic ~30 yrs. (A fixed 30 silently under-plans early retirees by a
// decade-plus.) Users can always edit the duration.
const PHASE_PLANNING_AGE = 95;
function phaseDefaults() {
  // Read the Goal Builder retire-at, falling back to the Forecast field (or 65)
  // when that field isn't in the DOM yet.
  const retAge = ($('goalRetA') ? num('goalRetA') : num('retA')) || 65;
  const years = Math.max(10, Math.round(PHASE_PLANNING_AGE - retAge));
  return [
    { name: 'Retirement spending', annualSpend: 80000, years,
      info: `Your overall yearly retirement budget, planned through age ${PHASE_PLANNING_AGE}. Spending often changes with age — add more phases (e.g. an active "Go-Go" decade, then slower years) to model that.` },
  ];
}
function makePhase(o = {}) {
  return { id: o.id || `ph_${Date.now().toString(36)}_${_phaseId++}`,
    name: o.name || 'New phase', annualSpend: o.annualSpend || 0, years: o.years || 0, info: o.info || '' };
}
function phaseRowHTML(p) {
  return `<div class="phase-input" data-pid="${p.id}">
    <div class="phase-name">
      <input class="phase-label" data-pid="${p.id}" value="${escAttr(p.name)}" placeholder="Phase name" aria-label="Phase name">
      ${p.info ? `<span class="phase-info">${infoTip(p.info)}</span>` : ''}
      <button type="button" class="x remove-phase-btn" data-pid="${p.id}" title="Remove">×</button>
    </div>
    <div class="row">
      <div class="field"><label>Annual spend ($)</label><input class="phase-spend" type="text" inputmode="decimal" data-pid="${p.id}" value="${moneyAttr(p.annualSpend)}" data-money></div>
      <div class="field"><label>Duration (years)</label><input class="phase-years" type="number" min="0" max="70" step="1" data-pid="${p.id}" value="${p.years}"></div>
    </div>
  </div>`;
}
function renderPhases() {
  const c = $('phasesContainer');
  if (!c) return;
  c.innerHTML = spendingPhases.map(phaseRowHTML).join('') ||
    `<div class="streams-empty">No spending phases yet — add one to shape your retirement income need.</div>`;
}
function phaseById(id) { return spendingPhases.find((p) => p.id === id); }
function onPhasesChanged() { renderPhases(); recompute(); refreshActiveTab(); saveState(); }
function addPhase() { spendingPhases.push(makePhase({ name: `Phase ${spendingPhases.length + 1}`, annualSpend: 60000, years: 5 })); onPhasesChanged(); }
function removePhase(id) { spendingPhases = spendingPhases.filter((p) => p.id !== id); onPhasesChanged(); }
function wirePhases() {
  const c = $('phasesContainer');
  if (!c) return;
  c.addEventListener('input', (e) => {
    const p = phaseById(e.target.dataset.pid); if (!p) return;
    const t = e.target;
    if (t.classList.contains('phase-label')) p.name = t.value;
    else if (t.classList.contains('phase-spend')) p.annualSpend = parseMoney(t.value);
    else if (t.classList.contains('phase-years')) p.years = parseFloat(t.value) || 0;
    else return;
    recompute(); refreshActiveTab(); saveState();
    e.stopPropagation();
  });
  c.addEventListener('click', (e) => {
    if (e.target.classList.contains('remove-phase-btn')) removePhase(e.target.dataset.pid);
  });
}
// The pre-v2.2 seed was three life-stage phases. We now start with one. A user
// who still has the OLD default saved (untouched) should migrate to the new single
// default — but anyone who actually edited their phases keeps them.
const LEGACY_PHASE_DEFAULTS = [
  { name: 'Go-Go', annualSpend: 90000, years: 10 },
  { name: 'Slow-Go', annualSpend: 70000, years: 10 },
  { name: 'No-Go', annualSpend: 55000, years: 10 },
];
function isLegacyDefaultPhases(saved) {
  if (!Array.isArray(saved) || saved.length !== LEGACY_PHASE_DEFAULTS.length) return false;
  return saved.every((p, i) => p && p.name === LEGACY_PHASE_DEFAULTS[i].name
    && +p.annualSpend === LEGACY_PHASE_DEFAULTS[i].annualSpend
    && +p.years === LEGACY_PHASE_DEFAULTS[i].years);
}

function initPhases(saved) {
  if (isLegacyDefaultPhases(saved)) saved = null; // untouched old default → new single default
  spendingPhases = Array.isArray(saved) && saved.length ? saved.map(makePhase) : phaseDefaults().map(makePhase);
  renderPhases();
}

let vehicleItems = [];
let _vehicleId = 0;
function makeVehicle(o = {}) {
  return { id: o.id || `veh_${Date.now().toString(36)}_${_vehicleId++}`,
    label: o.label || 'Car', freq: o.freq || 8, cost: o.cost || 0, startAge: o.startAge || 0 };
}
function vehicleRowHTML(v) {
  return `<div class="stream-row vehicle-row" data-vid="${v.id}">
    <input class="veh-label" data-vid="${v.id}" value="${escAttr(v.label)}" placeholder="Label" aria-label="Label">
    <input class="veh-freq" type="number" min="0" max="30" step="1" data-vid="${v.id}" value="${v.freq}" aria-label="Every (yrs)" title="Every (yrs)">
    <input class="veh-cost" type="text" inputmode="decimal" data-vid="${v.id}" value="${moneyAttr(v.cost)}" aria-label="Cost ($)" title="Cost ($)" data-money>
    <input class="veh-start-age" type="number" min="0" max="120" step="1" data-vid="${v.id}" value="${v.startAge || ''}" placeholder="Start at age (optional)" aria-label="Start at age" title="Start at age (optional)">
    <button type="button" class="x remove-veh-btn" data-vid="${v.id}" title="Remove">×</button>
  </div>`;
}
function renderVehicles() {
  const c = $('vehiclesContainer');
  if (!c) return;
  c.innerHTML = vehicleItems.length
    ? `<div class="stream-row vehicle-row stream-head"><span>Label</span><span>Every (yrs)</span><span>Cost ($)</span><span>Start at age</span><span></span></div>` +
      vehicleItems.map(vehicleRowHTML).join('')
    : `<div class="streams-empty">No vehicles yet — add one to model replacement costs.</div>`;
}
function vehicleById(id) { return vehicleItems.find((v) => v.id === id); }
function onVehiclesChanged() { renderVehicles(); recompute(); refreshActiveTab(); saveState(); }
function addVehicle() { vehicleItems.push(makeVehicle()); onVehiclesChanged(); }
function removeVehicle(id) { vehicleItems = vehicleItems.filter((v) => v.id !== id); onVehiclesChanged(); }
function wireVehicles() {
  const c = $('vehiclesContainer');
  if (!c) return;
  c.addEventListener('input', (e) => {
    const v = vehicleById(e.target.dataset.vid); if (!v) return;
    const t = e.target;
    if (t.classList.contains('veh-label')) v.label = t.value;
    else if (t.classList.contains('veh-freq')) v.freq = parseFloat(t.value) || 0;
    else if (t.classList.contains('veh-cost')) v.cost = parseMoney(t.value);
    else if (t.classList.contains('veh-start-age')) v.startAge = parseFloat(t.value) || 0;
    else return;
    recompute(); refreshActiveTab(); saveState();
    e.stopPropagation();
  });
  c.addEventListener('click', (e) => {
    if (e.target.classList.contains('remove-veh-btn')) removeVehicle(e.target.dataset.vid);
  });
}
function initVehicles(saved) {
  if (Array.isArray(saved)) vehicleItems = saved.map(makeVehicle);
  renderVehicles();
}

let supportItems = [];
let _supportId = 0;
function makeSupport(o = {}) {
  return { id: o.id || `sup_${Date.now().toString(36)}_${_supportId++}`,
    label: o.label || 'Parent', annualAmount: o.annualAmount || 10000, years: o.years || 0, startAge: o.startAge || 0 };
}
function supportRowHTML(s) {
  return `<div class="stream-row support-row" data-spid="${s.id}">
    <input class="sup-label" data-spid="${s.id}" value="${escAttr(s.label)}" placeholder="Label" aria-label="Label">
    <input class="sup-amt" type="text" inputmode="decimal" data-spid="${s.id}" value="${moneyAttr(s.annualAmount)}" aria-label="$/yr" title="$/yr" data-money>
    <input class="sup-years" type="number" min="0" max="60" step="1" data-spid="${s.id}" value="${s.years || ''}" placeholder="Years (optional)" aria-label="Years" title="Years (optional)">
    <input class="sup-start-age" type="number" min="0" max="120" step="1" data-spid="${s.id}" value="${s.startAge || ''}" placeholder="Start at age (optional)" aria-label="Start at age" title="Start at age (optional)">
    <button type="button" class="x remove-sup-btn" data-spid="${s.id}" title="Remove">×</button>
  </div>`;
}
function renderSupport() {
  const c = $('supportContainer');
  if (!c) return;
  c.innerHTML = supportItems.length
    ? `<div class="stream-row support-row stream-head"><span>Label</span><span>$/yr</span><span>Years</span><span>Start at age</span><span></span></div>` +
      supportItems.map(supportRowHTML).join('')
    : `<div class="streams-empty">No support recipients yet — add one to budget for family support.</div>`;
}
function supportById(id) { return supportItems.find((s) => s.id === id); }
function onSupportChanged() { renderSupport(); recompute(); refreshActiveTab(); saveState(); }
function addSupport() { supportItems.push(makeSupport()); onSupportChanged(); }
function removeSupport(id) { supportItems = supportItems.filter((s) => s.id !== id); onSupportChanged(); }
function wireSupport() {
  const c = $('supportContainer');
  if (!c) return;
  c.addEventListener('input', (e) => {
    const s = supportById(e.target.dataset.spid); if (!s) return;
    const t = e.target;
    if (t.classList.contains('sup-label')) s.label = t.value;
    else if (t.classList.contains('sup-amt')) s.annualAmount = parseMoney(t.value);
    else if (t.classList.contains('sup-years')) s.years = parseFloat(t.value) || 0;
    else if (t.classList.contains('sup-start-age')) s.startAge = parseFloat(t.value) || 0;
    else return;
    recompute(); refreshActiveTab(); saveState();
    e.stopPropagation();
  });
  c.addEventListener('click', (e) => {
    if (e.target.classList.contains('remove-sup-btn')) removeSupport(e.target.dataset.spid);
  });
}
function initSupport(saved) {
  if (Array.isArray(saved)) supportItems = saved.map(makeSupport);
  renderSupport();
}

let kids529Items = [];
let _kid529Id = 0;
function makeKid529(o = {}) {
  return { id: o.id || `k529_${Date.now().toString(36)}_${_kid529Id++}`,
    label: o.label || 'Child', annualAmount: o.annualAmount || 10000, years: o.years || 10, startAge: o.startAge || 0 };
}
function kid529RowHTML(k) {
  return `<div class="stream-row kid529-row" data-kid="${k.id}">
    <input class="kid-label" data-kid="${k.id}" value="${escAttr(k.label)}" placeholder="Label" aria-label="Label">
    <input class="kid-amt" type="text" inputmode="decimal" data-kid="${k.id}" value="${moneyAttr(k.annualAmount)}" aria-label="$/yr" title="$/yr" data-money>
    <input class="kid-years" type="number" min="0" max="30" step="1" data-kid="${k.id}" value="${k.years}" aria-label="Years" title="Years">
    <input class="kid-start-age" type="number" min="0" max="120" step="1" data-kid="${k.id}" value="${k.startAge || ''}" placeholder="Start at age (optional)" aria-label="Start at age" title="Start at age (optional)">
    <button type="button" class="x remove-kid-btn" data-kid="${k.id}" title="Remove">×</button>
  </div>`;
}
function renderKids529() {
  const c = $('kids529Container');
  if (!c) return;
  c.innerHTML = kids529Items.length
    ? `<div class="stream-row kid529-row stream-head"><span>Label</span><span>$/yr</span><span>Years</span><span>Start at age</span><span></span></div>` +
      kids529Items.map(kid529RowHTML).join('')
    : `<div class="streams-empty">No kids/529 entries yet — add one per child to budget for education.</div>`;
}
function kid529ById(id) { return kids529Items.find((k) => k.id === id); }
function onKids529Changed() { renderKids529(); recompute(); refreshActiveTab(); saveState(); }
function addKid529() { kids529Items.push(makeKid529()); onKids529Changed(); }
function removeKid529(id) { kids529Items = kids529Items.filter((k) => k.id !== id); onKids529Changed(); }
function wireKids529() {
  const c = $('kids529Container');
  if (!c) return;
  c.addEventListener('input', (e) => {
    const k = kid529ById(e.target.dataset.kid); if (!k) return;
    const t = e.target;
    if (t.classList.contains('kid-label')) k.label = t.value;
    else if (t.classList.contains('kid-amt')) k.annualAmount = parseMoney(t.value);
    else if (t.classList.contains('kid-years')) k.years = parseFloat(t.value) || 0;
    else if (t.classList.contains('kid-start-age')) k.startAge = parseFloat(t.value) || 0;
    else return;
    recompute(); refreshActiveTab(); saveState();
    e.stopPropagation();
  });
  c.addEventListener('click', (e) => {
    if (e.target.classList.contains('remove-kid-btn')) removeKid529(e.target.dataset.kid);
  });
}
function initKids529(saved) {
  if (Array.isArray(saved)) kids529Items = saved.map(makeKid529);
  renderKids529();
}

let customExpenseItems = [];
let _customExpenseId = 0;
function makeCustomExpense(o = {}) {
  return { id: o.id || `cust_${Date.now().toString(36)}_${_customExpenseId++}`,
    label: o.label || 'Custom', annualAmount: o.annualAmount || 5000, years: o.years || 10, startAge: o.startAge || 0 };
}
function customExpenseRowHTML(x) {
  return `<div class="stream-row custom-expense-row" data-cid="${x.id}">
    <input class="cust-label" data-cid="${x.id}" value="${escAttr(x.label)}" placeholder="Label" aria-label="Label">
    <input class="cust-amt" type="text" inputmode="decimal" data-cid="${x.id}" value="${moneyAttr(x.annualAmount)}" aria-label="$/yr" title="$/yr" data-money>
    <input class="cust-years" type="number" min="0" max="60" step="1" data-cid="${x.id}" value="${x.years}" aria-label="Years" title="Years">
    <input class="cust-start-age" type="number" min="0" max="120" step="1" data-cid="${x.id}" value="${x.startAge || ''}" placeholder="Start at age (optional)" aria-label="Start at age" title="Start at age (optional)">
    <button type="button" class="x remove-custom-expense-btn" data-cid="${x.id}" title="Remove">×</button>
  </div>`;
}
function renderCustomExpenses() {
  const c = $('customExpensesContainer');
  if (!c) return;
  c.innerHTML = customExpenseItems.length
    ? `<div class="stream-row custom-expense-row stream-head"><span>Label</span><span>$/yr</span><span>Years</span><span>Start at age</span><span></span></div>` +
      customExpenseItems.map(customExpenseRowHTML).join('')
    : `<div class="streams-empty">No custom expenses yet — add travel, care, dues, or anything else you want modeled.</div>`;
}
function customExpenseById(id) { return customExpenseItems.find((x) => x.id === id); }
function onCustomExpensesChanged() { renderCustomExpenses(); recompute(); refreshActiveTab(); saveState(); }
function addCustomExpense() { customExpenseItems.push(makeCustomExpense()); onCustomExpensesChanged(); }
function removeCustomExpense(id) { customExpenseItems = customExpenseItems.filter((x) => x.id !== id); onCustomExpensesChanged(); }
function wireCustomExpenses() {
  const c = $('customExpensesContainer');
  if (!c) return;
  c.addEventListener('input', (e) => {
    const x = customExpenseById(e.target.dataset.cid); if (!x) return;
    const t = e.target;
    if (t.classList.contains('cust-label')) x.label = t.value;
    else if (t.classList.contains('cust-amt')) x.annualAmount = parseMoney(t.value);
    else if (t.classList.contains('cust-years')) x.years = parseFloat(t.value) || 0;
    else if (t.classList.contains('cust-start-age')) x.startAge = parseFloat(t.value) || 0;
    else return;
    recompute(); refreshActiveTab(); saveState();
    e.stopPropagation();
  });
  c.addEventListener('click', (e) => {
    if (e.target.classList.contains('remove-custom-expense-btn')) removeCustomExpense(e.target.dataset.cid);
  });
}
function initCustomExpenses(saved) {
  if (Array.isArray(saved)) customExpenseItems = saved.map(makeCustomExpense);
  renderCustomExpenses();
}

// Inline confirmation next to a "Pull from Goal Builder" button — independent of
// flashStatus, which only writes into the Forecast tab's (often-hidden) status pill.
function showPullConfirm(btn, msg) {
  const el = btn && btn.parentElement && btn.parentElement.querySelector('.pull-confirm');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el.__pullTimer);
  el.__pullTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

function syncGoalDesiredInput() {
  const field = $('goalDesiredIncome');
  if (!field || document.activeElement === field) return;
  field.value = fmtInput(num('desired'));
}

function applyGoalDesiredInput({ format = false } = {}) {
  const field = $('goalDesiredIncome');
  if (!field) return;
  $('desired').value = parseMoney(field.value);
  if (format) formatMoneyInput(field);
  recompute(); refreshActiveTab(); saveState();
}

function formatMoneyInput(input) {
  if (!input || !input.matches || !input.matches('input[data-money]')) return;
  if (document.activeElement === input) return;
  input.value = fmtInput(input.value);
}

function formatMoneyInputs(root = document) {
  root.querySelectorAll('input[data-money]').forEach(formatMoneyInput);
}

// One-time, explicit copy of the Goal Builder's phase-blended income into the
// shared "Desired household income" field. Deliberately NOT automatic — the
// phases drive the drawdown's spending curve, but the headline desired-income
// figure only changes when the user clicks "Pull from Goal Builder".
function pullDesiredFromGoalBuilder(btn) {
  const phases = goalPhases();
  if (!phases.length) { showPullConfirm(btn, 'No spending phases entered in Your Target yet'); return; }
  const blended = Math.round(blendedDesiredIncome(phases));
  $('desired').value = blended;
  syncGoalDesiredInput();
  recompute(); refreshActiveTab(); saveState();
  showPullConfirm(btn, `Pulled ${fmt$(blended)}/yr ✓`);
}

// Pre-59½ early-withdrawal penalty context. Off (rate 0) when retiring at/after
// 59½. The exempt pool is the projected total of genuinely penalty-free money:
// taxable + after-tax basis + Roth IRA basis + 457(b) balances flagged
// penalty-free upon separation.
function earlyPenaltyContext(retAge, years, ret) {
  if (retAge >= 59.5 || typeof projectPortfolio !== 'function' || !accountGroups.length) {
    return { rate: 0, exempt: 0 };
  }
  const port = projectPortfolio(accountGroups, ret, CURRENT_YEAR, years);
  const taxable = port.byTreatment.taxable;
  const afterTaxBasis = port.byTreatmentBasis.aftertax;
  const rothIRABasis = port.groupResults
    .filter((g) => g.type === 'ira')
    .reduce((s, g) => s + g.byTreatmentBasis.roth, 0);
  const sep457 = port.groupResults
    .filter((g) => g.type === '457b' && (findGroup(g.id) || {}).penaltyFreeSeparation)
    .reduce((s, g) => s + g.total, 0);
  const exempt = taxable + afterTaxBasis + rothIRABasis + sep457;
  const rate = (typeof EARLY_WITHDRAWAL_PENALTY === 'number') ? EARLY_WITHDRAWAL_PENALTY : 0.10;
  return { rate, exempt };
}

function renderGap(base, inputs) {
  const banner = $('gapBanner');
  const surplus = base.gap >= 0;
  // Being short isn't a failure — it's a starting point. Use an encouraging amber
  // "on your way" tone (not alarm-red) and frame the gap as progress + a target to
  // close, never a verdict that the user has done something wrong.
  banner.className = 'gap-banner ' + (surplus ? 'good' : 'warn');
  // Social Security isn't available the day you retire if you retire before
  // ssStartAge (62) — someone FIRE-ing at 40 has a 20+ year bridge before SS
  // starts. base.totalIncome/base.gap already reflect this (see forecast() in
  // calc.js); this just mirrors the same $0-during-the-bridge figure in the
  // banner text instead of always showing the full SS amount.
  const retAge = inputs.youngestAge + inputs.yearsToRetirement;
  const ssCounted = retAge >= inputs.ssStartAge ? inputs.socialSecurityAnnual : 0;
  const bridgeNote = ssCounted === 0 && inputs.socialSecurityAnnual > 0
    ? ` Social Security (${fmt$(inputs.socialSecurityAnnual)}/yr) isn't counted here — it doesn't start until age ${inputs.ssStartAge}, ${Math.round(inputs.ssStartAge - retAge)} years after this retirement age.`
    : '';
  const totalIncomeLine = ssCounted > 0
    ? `Total income = portfolio income + Social Security (${fmt$(base.portfolioIncome)} + ${fmt$(ssCounted)}) = ${fmt$(base.totalIncome)}/yr.`
    : inputs.socialSecurityAnnual > 0
      ? `Total income = portfolio income only = ${fmt$(base.totalIncome)}/yr. Social Security (${fmt$(inputs.socialSecurityAnnual)}/yr) isn't included — it doesn't start until age ${inputs.ssStartAge}, after this retirement age.`
      : `Total income = portfolio income only = ${fmt$(base.totalIncome)}/yr (no Social Security entered).`;
  const calc = `Portfolio income = projected balance × withdrawal rate (${fmt$k(base.balance)} × ${num('withdrawalRate').toFixed(1)}%) = ${fmt$(base.portfolioIncome)}/yr.\n` +
    `${totalIncomeLine}\n` +
    `Gap = total income − desired income (${fmt$(base.totalIncome)} − ${fmt$(inputs.desiredAnnualIncome)}) = ${surplus ? '+' : '−'}${fmt$(Math.abs(base.gap))}/yr.\n` +
    `Runway = years until the base-scenario drawdown depletes the portfolio (or ∞ if it never does).`;
  // Only surface the "(incl. … Social Security)" parenthetical when SS is
  // actually counted — otherwise it reads "(incl. $0 Social Security)" right
  // before the bridge note that explains why, which is confusing.
  const inclSs = ssCounted > 0 ? ` (incl. ${fmt$(ssCounted)} Social Security)` : '';
  if (surplus) {
    banner.innerHTML = `<strong>You're on track ✓</strong> ${infoTip(calc)}
      <span class="big">+${fmt$(base.gap)}/yr to spare</span>
      Your plan projects ${fmt$(base.totalIncome)}/yr against your ${fmt$(inputs.desiredAnnualIncome)}/yr goal${inclSs}. Portfolio runway: ${fmtYears(base.runway)} yrs.${bridgeNote}`;
  } else {
    const pct = inputs.desiredAnnualIncome > 0
      ? Math.max(0, Math.round((base.totalIncome / inputs.desiredAnnualIncome) * 100)) : 0;
    banner.innerHTML = `<strong>You're on your way.</strong> ${infoTip(calc)}
      <span class="big">${fmt$(Math.abs(base.gap))}/yr to go</span>
      Your plan already covers ${fmt$(base.totalIncome)}/yr of your ${fmt$(inputs.desiredAnnualIncome)}/yr goal${inclSs} — about <strong>${pct}%</strong> of the way there.
      Nudge the levers above to close the rest: save a bit more, work a little longer, or fine-tune spending.${bridgeNote}`;
  }
}

// v2 safety: warn when the projected Full-FIRE age is later than the target
// retirement age (or never reached). Returns the warning HTML, or '' if fine.
function fireAgeWarningHTML(f, inputs) {
  const retAge = inputs.youngestAge + inputs.yearsToRetirement;
  const hit = f.milestones.full.ageHit;
  if (hit != null && hit <= retAge + 1e-6) return '';
  const tail = hit != null
    ? `At your current plan, your portfolio fully covers your goal around <strong>age ${fmtAge(hit)}</strong> — a few years past your target of <strong>${Math.round(retAge)}</strong>.`
    : `You're not quite at full coverage for retiring at <strong>age ${Math.round(retAge)}</strong> within the plan horizon yet.`;
  return `💡 <strong>Almost there:</strong> ${tail} Each lever above closes the gap — saving a bit more, working a little longer, or fine-tuning spending.`;
}

// v2.1: a persistent, plain-language readout of the inputs driving every
// calculation on screen, so you can sanity-check the math at a glance without
// scrolling back to the inputs panel. Updated on every recompute.
function renderAssumptionsBar(inputs) {
  const ids = ['assumptionsBarForecast', 'assumptionsBarGoal', 'assumptionsBarScenario'];
  if (!ids.some((id) => $(id))) return;
  const retAgeA = inputs.youngestAge + inputs.yearsToRetirement; // first-retiree clock

  // Display the ACTIVE tab's household (matches what buildInputs computed above),
  // so the shown ages and the derived horizon always agree.
  const hh = activeHouseholdInputs();
  const who = inputs.isCouple
    ? `You're <strong>${hh.ageA}</strong> (retiring at <strong>${hh.retA}</strong>), your partner is <strong>${hh.ageB}</strong> (retiring at <strong>${hh.retB}</strong>)`
    : `You're <strong>${hh.ageA}</strong> this year, retiring at <strong>${hh.retA}</strong>`;
  // On Goal Builder, "Desired income" must show what's ACTUALLY driving the
  // cards below — the phase-blended spend (== the category budget total,
  // since the tier/category UI writes into phase 0) — not the separate
  // Forecast-tab "desired" field. Showing the stale Forecast figure here was
  // exactly the kind of cross-tab disconnect this pass is meant to remove.
  const phases = goalPhases();
  const onGoalWithPhases = activeTab === 'goal' && phases.length > 0;
  const incomeLabel = onGoalWithPhases ? 'Annual spend' : 'Desired income';
  const incomeValue = onGoalWithPhases ? Math.round(blendedDesiredIncome(phases)) : inputs.desiredAnnualIncome;
  const html = `${who} (current year <strong>${CURRENT_YEAR}</strong>) · ` +
    `First retirement drives the horizon: age <strong>${retAgeA.toFixed(0)}</strong> · ` +
    `Base return <strong>${inputs.baseReturn.toFixed(1)}%</strong> ±${num('returnBand').toFixed(1)} · ` +
    `Inflation <strong>${inputs.baseInflation.toFixed(1)}%</strong> ±${num('inflationBand').toFixed(1)} · ` +
    `Withdrawal rate <strong>${num('withdrawalRate').toFixed(1)}%</strong> · ` +
    `${incomeLabel} <strong>${fmt$(incomeValue)}/yr</strong> ${inflMode === 'today' ? '(figures shown in today\'s $)' : '(figures shown in future nominal $)'}`;
  ids.forEach((id) => { if ($(id)) $(id).innerHTML = html; });
}

// Forecast-only achievability warning. Deliberately NOT shown in Goal Builder:
// that tab is for defining how much you need, not judging whether you're short —
// the "are you on track" verdict lives on the Forecast tab.
function renderFireWarning(f, inputs) {
  const html = fireAgeWarningHTML(f, inputs);
  const el = $('fireWarning');
  if (!el) return;
  el.className = 'gap-banner ' + (html ? 'warn' : 'hidden');
  el.innerHTML = html;
}

function renderBalances(f) {
  const order = [
    ['Pessimistic', f.pessimistic, ''],
    ['Base', f.base, 'base'],
    ['Optimistic', f.optimistic, ''],
  ];
  // Balances are at retirement; deflate by base inflation over the years to it.
  const sb = f.series.base;
  const yearsToRet = sb.length ? sb[sb.length - 1].age - sb[0].age : 0;
  const inflPct = f.scenarios.base.inflation;
  // Full FIRE target (what you NEED). Each card compares its projected balance
  // (what you'll HAVE) against it. Compared on the SAME nominal basis the FIRE
  // Milestones panel uses (balance vs target), so the cushion/short verdict never
  // contradicts "Full FIRE reached" — even in Today's-Dollars display mode.
  const target = f.milestones.full.target;
  $('balanceCards').innerHTML = order.map(([name, s, cls]) => {
    const calc = `Balance compounds monthly from your accounts' starting balance + contributions, at ${s.assumptions.return.toFixed(1)}% return for ${yearsToRet.toFixed(1)} years (to your retirement age).\n` +
      `Income = balance × withdrawal rate (${fmt$k(s.balance)} × ${num('withdrawalRate').toFixed(1)}%) = ${fmt$(s.portfolioIncome)}/yr.` +
      (inflMode === 'today' ? `\nDeflated to today's $ using ${inflPct.toFixed(1)}% inflation over ${yearsToRet.toFixed(1)} yrs.` : '');
    let cushionLine = '';
    if (target > 0) {
      const cushion = s.balance - target;
      const surplus = cushion >= 0;
      cushionLine = `<div class="csub cushion ${surplus ? 'is-surplus' : 'is-shortfall'}">` +
        `→ ${fmt$k(Math.abs(cushion))} ${surplus ? 'cushion' : 'short'} vs Full FIRE</div>`;
    }
    return `
    <div class="card ${cls}">
      <div class="ctitle">${name} ${infoTip(calc)}</div>
      <div class="cval">${fmt$k(deflate(s.balance, yearsToRet, inflPct))}</div>
      <div class="csub">${s.assumptions.return.toFixed(1)}% return · ${s.assumptions.inflation.toFixed(1)}% infl.</div>
      <div class="csub">${fmt$(deflate(s.portfolioIncome, yearsToRet, inflPct))}/yr from portfolio</div>
      ${cushionLine}
    </div>`;
  }).join('');
  $('incomeLine').textContent = inflMode === 'today'
    ? `Shown in today's dollars. Sustainable income is portfolio-only at your withdrawal rate; the gap banner adds Social Security.`
    : `Sustainable income shown is portfolio-only at your withdrawal rate; the gap banner adds Social Security.`;
}

// Distinct colors for milestone markers (independent of the base-line accent).
const MS_COLORS = { lean: '#1a7f37', coast: '#0891b2', barista: '#d97706', full: '#4b3fe4', fat: '#7c3aed' };

// Linear interpolation of base-series balance at a given age.
function balanceAtAge(series, age) {
  if (age <= series[0].age) return series[0].balance;
  const last = series[series.length - 1];
  if (age >= last.age) return last.balance;
  for (let i = 1; i < series.length; i++) {
    if (age <= series[i].age) {
      const a = series[i - 1], b = series[i];
      const t = (age - a.age) / (b.age - a.age);
      return a.balance + t * (b.balance - a.balance);
    }
  }
  return last.balance;
}

// Hover interaction: a tooltip + guide line/dot reading off the projected
// balance (and range) at the age under the cursor.
function wireChartHover(chartEl, ctx) {
  const { base, opt, pess, xMin, xMax, yMax, MT, plotH } = ctx;
  const svg = chartEl.querySelector('svg');
  const overlay = svg.querySelector('.chart-hover-rect');
  const hline = svg.querySelector('.chart-hover-line');
  const hdot = svg.querySelector('.chart-hover-dot');

  let tip = chartEl.querySelector('.chart-tip');
  if (!tip) { tip = document.createElement('div'); tip.className = 'chart-tip'; chartEl.appendChild(tip); }

  const X = (age) => ctx.ML + ((age - xMin) / Math.max(1e-9, xMax - xMin)) * ctx.plotW;
  const Y = (bal) => MT + (1 - bal / yMax) * plotH;

  overlay.addEventListener('mousemove', (e) => {
    const pr = overlay.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientX - pr.left) / pr.width));
    const i = Math.round(frac * (base.length - 1)); // base is one point per year
    const p = base[i];
    const lineX = X(p.age), dotY = Y(p.balance);

    hline.setAttribute('x1', lineX); hline.setAttribute('x2', lineX); hline.style.display = '';
    hdot.setAttribute('cx', lineX); hdot.setAttribute('cy', dotY); hdot.style.display = '';

    const cr = chartEl.getBoundingClientRect();
    const dotPxX = pr.left + ((p.age - xMin) / Math.max(1e-9, xMax - xMin)) * pr.width - cr.left;
    const dotPxY = pr.top + (1 - p.balance / yMax) * pr.height - cr.top;
    tip.innerHTML = `<strong>Age ${Math.round(p.age)}</strong> · ${fmt$k(p.balance)}<span class="r">range ${fmt$k(pess[i].balance)} – ${fmt$k(opt[i].balance)}</span>`;
    tip.style.display = 'block';
    tip.style.left = `${dotPxX}px`;
    tip.style.top = `${dotPxY}px`;
  });
  overlay.addEventListener('mouseleave', () => {
    hline.style.display = 'none'; hdot.style.display = 'none'; tip.style.display = 'none';
  });
}

// Accumulation (f.series.X, growth only, ends exactly at retirement) used to
// be the WHOLE chart — it never showed the drawdown/spending phase at all,
// so the chart stopped cold at retirement instead of running through to a
// longevity age. Chains it with f.X.drawdown.series (already computed for
// the gap banner/runway/audit) into one continuous lifecycle curve. Ages
// line up exactly: accumulation's last point is retAge, drawdown's first
// point is retAge+1 (see projectSeries/simulateDrawdown in calc.js) — no
// overlap, no gap.
function fullLifecycleSeries(scenarioResult, accSeries) {
  const drawPts = scenarioResult.drawdown.series.map((p) => ({ age: p.age, balance: Math.max(0, p.balance) }));
  return accSeries.concat(drawPts);
}
// Pessimistic typically depletes (and its series stops) earlier than
// base/optimistic, which keep going to the full "Years in retirement"
// horizon (or forever, if return > spend). wireChartHover/the tooltip index
// base[i]/opt[i]/pess[i] by the SAME i, so pad the shorter ones with $0
// points (truthfully: depleted = $0) rather than leaving them short, which
// would throw reading .balance of undefined once the cursor passes where a
// shorter series ends.
function padToLength(series, targetLength) {
  if (series.length >= targetLength) return series;
  const last = series[series.length - 1];
  const padded = series.slice();
  for (let age = last.age + 1; padded.length < targetLength; age++) padded.push({ age, balance: 0 });
  return padded;
}

function renderChart(f) {
  const W = 800, H = 360, ML = 60, MR = 16, MT = 16, MB = 30;
  const plotW = W - ML - MR, plotH = H - MT - MB;
  const inflPct = f.scenarios.base.inflation;
  let base = fullLifecycleSeries(f.base, f.series.base);
  let opt = fullLifecycleSeries(f.optimistic, f.series.optimistic);
  let pess = fullLifecycleSeries(f.pessimistic, f.series.pessimistic);
  const longest = Math.max(base.length, opt.length, pess.length);
  base = deflateSeries(padToLength(base, longest), inflPct);
  opt = deflateSeries(padToLength(opt, longest), inflPct);
  pess = deflateSeries(padToLength(pess, longest), inflPct);

  const xMin = base[0].age, xMax = base[base.length - 1].age;
  const yMax = Math.max(1, ...opt.map((p) => p.balance), ...base.map((p) => p.balance)) * 1.05;
  const xspan = Math.max(1e-9, xMax - xMin);

  const X = (age) => ML + ((age - xMin) / xspan) * plotW;
  const Y = (bal) => MT + (1 - bal / yMax) * plotH;

  const path = (pts) => pts.map((p, i) => `${i ? 'L' : 'M'}${X(p.age).toFixed(1)},${Y(p.balance).toFixed(1)}`).join(' ');

  // Shaded assumption band: pessimistic out, optimistic back.
  const bandPath = path(pess) + ' ' +
    [...opt].reverse().map((p) => `L${X(p.age).toFixed(1)},${Y(p.balance).toFixed(1)}`).join(' ') + ' Z';

  // Gridlines + y-axis ticks (dollar amounts).
  let grid = '', yticks = '';
  for (let i = 0; i <= 4; i++) {
    const val = (yMax / 4) * i, yy = Y(val);
    grid += `<line class="chart-grid" x1="${ML}" y1="${yy.toFixed(1)}" x2="${W - MR}" y2="${yy.toFixed(1)}"/>`;
    yticks += `<text class="chart-tick" x="${ML - 6}" y="${(yy + 3).toFixed(1)}" text-anchor="end">${fmt$k(val)}</text>`;
  }
  // x-axis ticks (ages), roughly every 5 years.
  let xticks = '';
  const step = Math.max(1, Math.round((xMax - xMin) / 6 / 5) * 5);
  for (let age = Math.ceil(xMin); age <= xMax; age += step) {
    xticks += `<text class="chart-tick" x="${X(age).toFixed(1)}" y="${H - 8}" text-anchor="middle">${age}</text>`;
  }

  // Milestone markers — only those actually reached get a dot on the curve.
  const markers = [];
  const add = (key, label, age) => {
    if (age == null || age < xMin || age > xMax) return;
    markers.push({ key, label, age, bal: balanceAtAge(base, age) });
  };
  add('lean', 'Lean', f.milestones.lean.reachedByRetirement ? f.milestones.lean.ageHit : null);
  add('coast', 'Coast', f.milestones.coast.coastAge);
  add('full', 'Full', f.milestones.full.reachedByRetirement ? f.milestones.full.ageHit : null);
  add('fat', 'Fat', f.milestones.fat.reachedByRetirement ? f.milestones.fat.ageHit : null);

  let msMarks = '';
  markers.forEach((m, i) => {
    const x = X(m.age), y = Y(m.bal), c = MS_COLORS[m.key];
    // Stagger labels vertically a touch to reduce overlap when ages are close.
    const dy = (i % 2 === 0) ? -10 : -22;
    msMarks += `<line class="ms-line" x1="${x.toFixed(1)}" y1="${MT}" x2="${x.toFixed(1)}" y2="${(plotH + MT).toFixed(1)}" stroke="${c}"/>`;
    msMarks += `<circle class="ms-dot" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="5" fill="${c}"/>`;
    msMarks += `<text class="ms-label" x="${x.toFixed(1)}" y="${(y + dy).toFixed(1)}" text-anchor="middle" fill="${c}">${m.label} · ${m.age.toFixed(0)}</text>`;
  });

  $('chart').innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Savings growth over time with FIRE milestones">
    ${grid}
    <line class="chart-axis" x1="${ML}" y1="${MT}" x2="${ML}" y2="${MT + plotH}"/>
    <line class="chart-axis" x1="${ML}" y1="${MT + plotH}" x2="${W - MR}" y2="${MT + plotH}"/>
    <path class="chart-band" d="${bandPath}"/>
    <path class="chart-line" d="${path(base)}"/>
    ${msMarks}
    ${yticks}${xticks}
    <line class="chart-hover-line" x1="0" y1="${MT}" x2="0" y2="${MT + plotH}" style="display:none"/>
    <circle class="chart-hover-dot" r="5" style="display:none"/>
    <rect class="chart-hover-rect" x="${ML}" y="${MT}" width="${plotW}" height="${plotH}" fill="transparent"/>
  </svg>`;

  wireChartHover($('chart'), { base, opt, pess, xMin, xMax, yMax, ML, MR, MT, plotW, plotH, W });

  // Legend.
  const legend = [
    `<span class="lg"><span class="swatch" style="background:var(--accent)"></span>Base projection</span>`,
    `<span class="lg"><span class="swatch" style="background:var(--accent);opacity:.25"></span>Optimistic–pessimistic range</span>`,
    ...markers.map((m) => `<span class="lg"><span class="swatch" style="background:${MS_COLORS[m.key]}"></span>${m.label} FIRE (age ${m.age.toFixed(0)})</span>`),
  ];
  $('chartLegend').innerHTML = legend.join('');
}

// Barista FIRE window: with the user's part-time income, you could downshift
// when the portfolio first reaches the Barista target (barista.ageHit) and keep
// the part-time work until the portfolio fully covers spending (full.ageHit),
// after which it takes over entirely.
function baristaWindowHTML(barista, full, income) {
  if (income <= 0) {
    return `<div class="fmin">No part-time income entered — Barista FIRE equals Full FIRE. Add a Barista part-time income above to model downshifting sooner.</div>`;
  }
  if (barista.ageHit == null) {
    return barista.minIncome > 0
      ? `<div class="fmin">At retirement you'd still need <strong>${fmt$(barista.minIncome)}/yr</strong> of part-time income to cover the gap.</div>`
      : '';
  }
  const fullAge = full.ageHit != null ? fmtAge(full.ageHit) : null;
  return fullAge
    ? `<div class="fmin">With your <strong>${fmt$(income)}/yr</strong> part-time income, you could downshift at <strong>age ${fmtAge(barista.ageHit)}</strong> and keep it until <strong>age ${fullAge}</strong>, when your portfolio takes over entirely.</div>`
    : `<div class="fmin">With your <strong>${fmt$(income)}/yr</strong> part-time income, you could downshift at <strong>age ${fmtAge(barista.ageHit)}</strong> — keep it until your portfolio fully covers your spending.</div>`;
}

function renderFire(m) {
  // Barista FIRE removed from this grid (and the chart marker below) so the
  // milestones shown here line up with Goal Builder's tier pills (Lean/Base/
  // Fat — Comfort was removed there for the same reason). Barista itself is
  // unchanged everywhere else (Path to Independence still uses it) — this is
  // just the milestones-grid/chart presentation.
  const items = [
    ['Lean FIRE', m.lean, 'Frugal spending covered (25× lean spend).'],
    ['Coast FIRE', m.coast, `Once you hit Coast, current savings compound to your Full FIRE number with no further contributions. Shown two ways: to your own retirement age (${m.coast.targetRetirementAge}) and to the classic age ${m.coast.classic.targetRetirementAge}.`],
    ['Full FIRE', m.full, 'Your portfolio alone fully covers your target lifestyle.'],
    ['Fat FIRE', m.fat, 'Elevated/luxury lifestyle fully funded.'],
  ];

  $('fireGrid').innerHTML = items.map(([name, ms, desc]) => {
    let hit, status, extra = '';
    if (name === 'Coast FIRE') {
      hit = ms.reached;
      // Two readouts: coast to the user's OWN retirement age, and the classic
      // coast to 65. The classic figure usually lands earlier (longer runway).
      const line = (label, targetAge, coastAge, reached, reachedAge) => {
        if (reached) {
          return `<strong>Coast to ${targetAge}:</strong> reached — you could stop contributing now (coasts to goal by ${fmtAge(reachedAge)})`;
        }
        if (coastAge != null) {
          return `<strong>Coast to ${targetAge}:</strong> hit around age <strong>${fmtAge(coastAge)}</strong>, then contributions optional`;
        }
        return `<strong>Coast to ${targetAge}:</strong> not yet on this plan — keep contributing and it comes into range`;
      };
      const own = line(`your age ${ms.targetRetirementAge}`, ms.targetRetirementAge, ms.coastAge, ms.reached, ms.ageReached);
      const cl = ms.classic;
      const classic = line(`65 (classic)`, cl.targetRetirementAge, cl.coastAge, cl.reached, cl.ageReached);
      // When the plan's own retirement age is already ≥ 65 the two collapse to
      // the same thing — show one line rather than a confusing duplicate.
      status = (ms.targetRetirementAge >= cl.targetRetirementAge)
        ? own
        : `${own}<br>${classic}`;
    } else {
      hit = ms.reachedByRetirement;
      status = ms.ageHit != null
        ? `Reached around age ${fmtAge(ms.ageHit)}`
        : (hit ? 'Reached by retirement' : 'Not yet on this plan — see how to close it below');
    }
    const wr = num('withdrawalRate');
    let calc;
    if (name === 'Coast FIRE') {
      calc = `Tests whether your CURRENT balance, with zero further contributions, would compound (at the base return) to the Full FIRE target by a given age.\n"Coast to ${ms.targetRetirementAge}" uses your own retirement age; "Coast to 65" uses the traditional age. A longer runway (to 65) needs less in hand today, so it's usually reached earlier.`;
    } else if (ms.target) {
      const impliedSpend = ms.target * (wr / 100);
      calc = `Target = annual spend ÷ withdrawal rate (${fmt$(impliedSpend)} ÷ ${wr.toFixed(1)}%) = ${fmt$k(ms.target)}.\n` +
        `"Reached around age X" = the first age the BASE-scenario balance crosses this target.`;
    } else {
      calc = 'No target set for this milestone yet.';
    }
    return `<div class="fire ${hit ? 'hit' : ''}">
      <div class="dot"></div>
      <div>
        <div class="fname">${name} ${infoTip(calc)}</div>
        <div class="fdesc">${desc}</div>
        <div class="fstatus">${status}${ms.target ? ` · target ${fmt$k(ms.target)}` : ''}</div>
        ${extra}
        ${recommendationHTML(ms.recommendation)}
      </div>
    </div>`;
  }).join('');
}

// Year-by-year projection table (item 3): age, balance, assumption range, and
// the year each FIRE milestone is first crossed.
function renderProjectionTable(f) {
  const base = f.series.base, opt = f.series.optimistic, pess = f.series.pessimistic;
  const ms = f.milestones;
  const targets = [
    ['Lean', ms.lean.target], ['Barista', ms.barista.target],
    ['Full', ms.full.target], ['Fat', ms.fat.target],
  ].filter(([, t]) => t > 0);
  // Milestone crossings compare NOMINAL balances vs nominal targets; the displayed
  // figures may be deflated to today's dollars when the toggle is on.
  const inflPct = f.scenarios.base.inflation;
  const startAge = base.length ? base[0].age : 0;
  const flagged = {};
  const rows = base.map((p, i) => {
    const hits = [];
    targets.forEach(([name, t]) => { if (!flagged[name] && p.balance >= t) { flagged[name] = true; hits.push(name); } });
    const yrs = p.age - startAge;
    return `<tr class="${hits.length ? 'ms-hit-row' : ''}">
      <td>${Math.round(p.age)}</td>
      <td>${fmt$k(deflate(pess[i].balance, yrs, inflPct))} – ${fmt$k(deflate(opt[i].balance, yrs, inflPct))}</td>
      <td><strong>${fmt$k(deflate(p.balance, yrs, inflPct))}</strong></td>
      <td>${hits.map((h) => `🎯 ${h} FIRE`).join(' ')}</td>
    </tr>`;
  }).join('');
  $('projectionTable').innerHTML = `<table class="proj-table">
    <tr><th>Age</th><th>Range (pess–opt)</th><th>Base balance</th><th>Milestone</th></tr>${rows}</table>`;
}

// Plain-language "how to get there" line for an unmet milestone.
function recommendationHTML(rec) {
  if (!rec) return '';
  const parts = [];
  if (rec.extraAnnual > 0) parts.push(`add <strong>${fmt$(rec.extraAnnual)}/yr</strong> in contributions`);
  if (rec.extraYears != null && rec.extraYears > 0) parts.push(`work <strong>${rec.extraYears.toFixed(0)} more years</strong>`);
  if (parts.length === 0) return '';
  return `<div class="frec">To reach it: ${parts.join(', or ')}.</div>`;
}

function renderAudit(f, inputs) {
  const s = f.scenarios;
  // "Household annual contribution" = accounts total + the What-if "Extra
  // annual contribution" slider — easy to forget the slider is nonzero and
  // be surprised the audited number is bigger than what's in the account
  // rows. Spell out the two parts instead of just the combined figure.
  const acctContribution = accountsTotals().contribution;
  const extraContribution = num('extraContribution');
  const contribCalc = extraContribution > 0
    ? `${fmt$(acctContribution)} from your account rows + ${fmt$(extraContribution)} from the "Extra annual contribution" what-if slider above = ${fmt$(inputs.householdAnnual)}/yr.`
    : `${fmt$(acctContribution)} from your account rows (the "Extra annual contribution" what-if slider is $0).`;
  $('auditBody').innerHTML = `
    <table>
      <tr><th>Input</th><th>Value</th></tr>
      <tr><td>Household balance (shared pool)</td><td>${fmt$(inputs.householdBalance)}</td></tr>
      <tr><td>Household annual contribution ${infoTip(contribCalc)}</td><td>${fmt$(inputs.householdAnnual)}</td></tr>
      <tr><td>Years to retirement (to first retirement)</td><td>${inputs.yearsToRetirement.toFixed(0)}</td></tr>
      <tr><td>Withdrawal rate</td><td>${inputs.withdrawalRate.toFixed(1)}%</td></tr>
      <tr><td>Social Security (household)</td><td>${fmt$(inputs.socialSecurityAnnual)}/yr</td></tr>
    </table>
    <table style="margin-top:14px">
      <tr><th>Scenario</th><th>Return</th><th>Inflation</th><th>Balance</th><th>Runway</th></tr>
      <tr><td>Pessimistic</td><td>${s.pessimistic.return.toFixed(1)}%</td><td>${s.pessimistic.inflation.toFixed(1)}%</td><td>${fmt$(f.pessimistic.balance)}</td><td>${fmtYears(f.pessimistic.runway)} yrs</td></tr>
      <tr><td>Base</td><td>${s.base.return.toFixed(1)}%</td><td>${s.base.inflation.toFixed(1)}%</td><td>${fmt$(f.base.balance)}</td><td>${fmtYears(f.base.runway)} yrs</td></tr>
      <tr><td>Optimistic</td><td>${s.optimistic.return.toFixed(1)}%</td><td>${s.optimistic.inflation.toFixed(1)}%</td><td>${fmt$(f.optimistic.balance)}</td><td>${fmtYears(f.optimistic.runway)} yrs</td></tr>
    </table>
    <p style="color:var(--muted);font-size:12px;margin-top:10px">
      Deterministic compounding (monthly), single shared portfolio. Pessimistic pairs low return with high inflation;
      guardrail prevents pessimistic inflation from exceeding its return. This is a range of assumptions, not probabilities —
      it does not model sequence-of-returns risk (a v2 Monte Carlo upgrade).
    </p>
    <p style="color:var(--warn);font-size:12px;margin-top:8px;background:rgba(182,121,31,.08);border:1px solid rgba(182,121,31,.3);border-radius:6px;padding:6px 8px">
      <strong>Runway is conservative on taxes.</strong> The drawdown taxes the <em>entire</em> annual draw as ordinary income
      (${(inputs.filingStatus === 'mfj' ? 'married filing jointly' : 'single')} brackets). In reality, money pulled from taxable
      basis and Roth comes out at little or no tax, so your real runway is likely <em>longer</em> than shown. A future
      upgrade will source each year's draw across taxable → pre-tax → Roth buckets and tax each accordingly.
    </p>${inputs.earlyPenaltyRate > 0 ? `
    <p style="color:var(--muted);font-size:12px;margin-top:8px;background:rgba(var(--accent-rgb),.06);border:1px solid rgba(var(--accent-rgb),.25);border-radius:6px;padding:6px 8px">
      <strong>Retiring before 59½ — early-withdrawal penalty modeled.</strong> Draws before 59½ beyond your
      penalty-free pool of <strong>${fmt$(inputs.penaltyExemptBalance)}</strong> (taxable, Roth/after-tax basis, and any
      457(b) flagged penalty-free on separation) incur a ${(inputs.earlyPenaltyRate * 100).toFixed(0)}% penalty.
      Flagging a 457(b) as penalty-free-on-separation enlarges this pool and extends your runway.
    </p>` : ''}`;
}

// --- Spending strategy tab ---------------------------------------------
// Recommendations tailored to the user's earliest retirement age, based on
// established decumulation research (see footnote links in the rendered tab).
// Phase-based roadmap: 4 life-stage cards (Early Bridge → Penalty-Free Era →
// Social Security & Medicare → RMDs). Phases entirely before the user's
// retirement age are skipped, and advice strings adapt to the projected
// balances (handles $0 taxable / $0 Roth basis / retiring after 59½).
function renderPhaseRoadmap(d) {
  const start = Math.round(d.startAge);
  const ssAge = d.ssStartAge || 67;
  const taxable = d.taxable || 0, rothBasisIRA = d.rothBasisIRA || 0, rothBasis401k = d.rothBasis401k || 0, pretax = d.pretax || 0;
  const buffer = taxable + rothBasisIRA;
  const out = [];

  // Phase 1 — Early Bridge (retire → 59½). Only if retiring before 59½.
  if (start < 60) {
    let body = buffer > 0
      ? `Live off your accessible money first — <strong>${fmt$k(taxable)} taxable</strong>${rothBasisIRA > 0 ? ` plus <strong>${fmt$k(rothBasisIRA)} Roth IRA basis</strong>` : ''} (~${fmt$k(buffer)}).`
      : `You have little directly-accessible money projected here, so this bridge is the tight spot — build up taxable/Roth IRA savings before you retire.`;
    if (rothBasis401k > 0) body += ` Roll your <strong>${fmt$k(rothBasis401k)} Roth 401(k)</strong> into a Roth IRA to unlock its basis.`;
    if (pretax > 0) body += ` Run a <strong>Roth conversion ladder</strong> on your ${fmt$k(pretax)} pre-tax — each tranche is withdrawable penalty-free after a 5-year wait.`;
    body += ` Keep taxable income low to maximize ACA health-insurance subsidies.`;
    out.push({ title: 'Early Bridge', range: `Age ${start}–59½`, body });
  }

  // Phase 2 — Penalty-Free Era (59½ → Medicare 65). Only if retiring before 65.
  if (start < 65) {
    out.push({ title: 'Penalty-Free Era', range: `Age ${Math.max(60, start)}–65`,
      body: `Your 401(k)/IRA unlocks at 59½ — draw from any account with no penalty. Medicare hasn't started yet, so keep income (MAGI) managed for affordable ACA coverage, and do Roth conversions in low-tax years to smooth future taxes.` });
  }

  // Phase 3 — Social Security & Medicare (65 → 73). Only if retiring before 73.
  if (start < 73) {
    out.push({ title: 'Social Security & Medicare', range: `Age ${Math.max(65, start)}–73`,
      body: `Medicare takes over health coverage at 65${ssAge <= 73 ? `, and Social Security can begin around ${ssAge}` : ''} — both cut how much you draw from the portfolio. Keep converting pre-tax to Roth before required withdrawals begin.` });
  }

  // Phase 4 — RMDs (73+). Always relevant.
  out.push({ title: 'Required Withdrawals (RMDs)', range: 'Age 73+',
    body: pretax > 0
      ? `At 73, the IRS forces minimum withdrawals from your <strong>${fmt$k(pretax)} pre-tax</strong> accounts, taxed as income. The Roth conversions you did earlier shrink these RMDs and the tax spike they cause.`
      : `At 73, the IRS requires minimum withdrawals from pre-tax accounts — but with little pre-tax left, your RMDs (and their taxes) stay small.` });

  const cards = out.map((p, i) => `
    <div class="phase-card">
      <div class="phase-card-num">${i + 1}</div>
      <div class="phase-card-body">
        <div class="phase-card-head"><span class="phase-card-title">${p.title}</span><span class="phase-card-range">${p.range}</span></div>
        <p>${p.body}</p>
      </div>
    </div>`).join('');

  return `<div class="strat-section">
    <h3>🗺️ Your phase-based roadmap</h3>
    <p class="sub">Retirement unfolds in distinct phases as accounts unlock and benefits kick in. Here's the plan for each, from your retirement at ${start} onward.</p>
    <div class="phase-stack">${cards}</div>
  </div>`;
}

// Execution summary: a compact strip of the key ages that change how you draw
// income, from retirement onward (the year-by-year table is gone).
function strategyTimeline(inputs, startAge) {
  const start = Math.round(startAge);
  const ssAge = inputs.ssStartAge || 67;
  const steps = [
    { age: start, icon: '🏁', label: 'Retire', note: 'Begin drawing down' },
    { age: 60, icon: '🔓', label: '59½', note: 'Accounts penalty-free' },
    { age: 65, icon: '🏥', label: 'Medicare', note: 'Health coverage' },
    { age: ssAge, icon: '💵', label: 'Social Security', note: 'Benefits can start' },
    { age: 73, icon: '📉', label: 'RMDs', note: 'Required withdrawals' },
  ].filter((s) => s.age >= start).sort((a, b) => a.age - b.age);
  const items = steps.map((s) => `
    <div class="exec-step">
      <div class="exec-icon">${s.icon}</div>
      <div class="exec-age">Age ${Math.round(s.age)}</div>
      <div class="exec-label">${s.label}</div>
      <div class="exec-note">${s.note}</div>
    </div>`).join('');
  return `<div class="strat-section">
    <h3>⏱️ Execution summary</h3>
    <p class="sub">The key ages that change how you draw income, from retirement onward.</p>
    <div class="exec-timeline">${items}</div>
  </div>`;
}

function renderStrategy() {
  const inputs = buildInputs();
  const f = forecast(inputs);
  const isCouple = inputs.isCouple;
  // First person to stop working (earliest retirement age, incl. the what-if shift).
  const startAge = Math.min(num('retA') + num('ageShift'), isCouple ? num('retB') + num('ageShift') : Infinity);
  const bridgeYears = Math.max(0, 59.5 - startAge);
  const early = startAge < 59.5;

  // Real numbers from the forecast + tax-treatment composition at retirement.
  const projected = f.base.balance;                       // projected portfolio at retirement
  const desired = inputs.desiredAnnualIncome;
  const wr = inputs.withdrawalRate;
  const proj = projectPortfolio(accountGroups, inputs.baseReturn, CURRENT_YEAR, inputs.yearsToRetirement);
  const bt = proj.byTreatment;
  const basisBt = proj.byTreatmentBasis;
  // Roth basis accessibility depends on the ACCOUNT, not just the treatment:
  //  • Roth IRA basis  → withdrawable anytime, penalty-free.
  //  • Roth 401(k) basis → NOT directly accessible before 59½; must first be
  //    rolled into a Roth IRA (then the basis becomes accessible).
  const rothBasisIRA = proj.groupResults.filter((g) => g.type === 'ira').reduce((s, g) => s + g.byTreatmentBasis.roth, 0);
  const rothBasis401k = proj.groupResults.filter((g) => g.type === '401k').reduce((s, g) => s + g.byTreatmentBasis.roth, 0);
  // Directly penalty-free before 59½: taxable + after-tax basis + Roth IRA basis.
  const accessibleEarly = bt.taxable + bt.aftertax + rothBasisIRA;
  const lockedPretax = bt.pretax;
  const lockedRothEarnings = Math.max(0, bt.roth - basisBt.roth); // Roth growth, locked until 59½
  const bridgeNeed = desired * bridgeYears;
  const bridgeCoverPct = bridgeNeed > 0 ? Math.min(100, Math.round(accessibleEarly / bridgeNeed * 100)) : 100;
  const startWithdrawal = projected * (wr / 100);

  $('stratIntro').innerHTML = early
    ? `Your plan reaches FIRE around <strong>age ${startAge.toFixed(0)}</strong> with a projected
       <strong>${fmt$k(projected)}</strong> portfolio — about <strong>${bridgeYears.toFixed(0)} years before 59½</strong>,
       when you can tap pre-tax 401(k)/IRA money without the 10% penalty. Bridging those years at your
       ${fmt$(desired)}/yr target needs roughly <strong>${fmt$k(bridgeNeed)}</strong>; your projected
       <strong>${fmt$k(accessibleEarly)}</strong> in taxable + Roth IRA basis covers about
       <strong>${bridgeCoverPct}%</strong> of it${rothBasis401k > 0 ? ` (plus <strong>${fmt$k(rothBasis401k)}</strong> of Roth 401(k) basis reachable after a rollover)` : ''}, with <strong>${fmt$k(lockedPretax)}</strong> locked in pre-tax.`
    : `Your plan reaches FIRE around <strong>age ${startAge.toFixed(0)}</strong> (at or past 59½) with a projected
       <strong>${fmt$k(projected)}</strong> portfolio — so you can draw from any account without the early-withdrawal
       penalty. At your ${wr.toFixed(1)}% rate that's about <strong>${fmt$(startWithdrawal)}/yr</strong> to start.`;

  const card = (title, tag, body, pro, con) => `
    <div class="strat-card${tag === 'best' ? ' rec' : ''}">
      <h4>${title}${tag ? `<span class="tag ${tag}">${tag === 'best' ? 'Recommended' : 'Early-retiree'}</span>` : ''}</h4>
      <p>${body}</p>
      ${pro ? `<div class="pro">✓ ${pro}</div>` : ''}
      ${con ? `<div class="con">✗ ${con}</div>` : ''}
    </div>`;

  // 1. Bridging to 59½ (only if retiring early).
  const shortfall = Math.max(0, bridgeNeed - accessibleEarly);
  const annualLadder = bridgeYears > 0 ? lockedPretax / Math.max(1, bridgeYears) : 0;
  const bridge = !early ? '' : `
    <div class="strat-section">
      <h3>1. Bridge the ${bridgeYears.toFixed(0)} years to age 59½</h3>
      <p class="sub">At ${fmt$(desired)}/yr that's ${fmt$k(bridgeNeed)} of spending before penalty-free access. Your directly-accessible ${fmt$k(accessibleEarly)} (taxable + Roth IRA basis) covers ~${bridgeCoverPct}%${rothBasis401k > 0 ? `; another ${fmt$k(rothBasis401k)} of Roth 401(k) basis is reachable once rolled to a Roth IRA` : ''}${shortfall > 0 ? ` — leaving a <strong>${fmt$k(shortfall)}</strong> gap to source from pre-tax (conversion ladder / 72(t))` : ''}.</p>
      <div class="strat-cards">
        ${card('Spend taxable &amp; Roth IRA basis first', '',
          `${bt.taxable > 0 ? `Spend your <strong>${fmt$k(bt.taxable)} taxable brokerage</strong> first (taxed only on gains), then ` : `You have no taxable brokerage projected, so lean on `}<strong>${fmt$k(rothBasisIRA)} of Roth IRA contribution basis</strong> (withdrawable anytime). ${rothBasis401k > 0 ? `Your other <strong>${fmt$k(rothBasis401k)} of Roth 401(k) basis</strong> is <em>not</em> directly reachable before 59½ — you'd first roll it to a Roth IRA, then its basis becomes accessible.` : ''} Roth <em>earnings</em> (~${fmt$k(lockedRothEarnings)}) stay locked until 59½ either way.`,
          'Flexible, tax-efficient, keeps pre-tax compounding.', rothBasis401k > 0 ? 'Roth 401(k) basis needs a rollover to a Roth IRA before it\'s early-accessible.' : 'Only Roth contributions (not earnings) are reachable before 59½.')}
        ${card('Roth conversion ladder', 'early',
          `Convert part of your <strong>${fmt$k(lockedPretax)} pre-tax</strong> to Roth each year; after a 5-year wait it's penalty-free. Spreading it over the bridge is ~${fmt$k(annualLadder)}/yr of conversions.`,
          'Converts at low early-retirement brackets; flexible.', 'Five-year lag — needs other funds for the first 5 years.')}
        ${card('Rule 72(t) / SEPP', 'early',
          `Take substantially-equal payments from your <strong>${fmt$k(lockedPretax)} pre-tax</strong> at any age, penalty-free — locked in until 59½ (${bridgeYears.toFixed(0)} yrs for you).`,
          'Unlocks pre-tax immediately, no taxable account needed.', 'Rigid — mistakes trigger retroactive penalties.')}
        ${shortfall > 0
          ? card('⚠ Mind the bridge gap', '',
              `Accessible funds cover most of the ${fmt$k(bridgeNeed)} bridge, with <strong>${fmt$k(shortfall)}</strong> left to plan for. Close it by adding taxable/Roth savings now, starting a ladder early, or part-time income in those years.`,
              '', 'Left unplanned, the bridge years would tap pre-tax early and owe the 10% penalty.')
          : card('Roth contributions (basis)', '',
              'Direct Roth contributions come out anytime, tax- and penalty-free — a handy flexible buffer on top of the above.',
              'No waiting period, no tax.', 'Limited to what you actually contributed.')}
      </div>
    </div>`;

  // 2. Withdrawal rate strategy.
  const w4 = projected * 0.04, w5 = projected * 0.05, w6 = projected * 0.06;
  const coversDesired = startWithdrawal + inputs.socialSecurityAnnual >= desired;
  const rate = `
    <div class="strat-section">
      <h3>${early ? '2' : '1'}. Decide how much to withdraw each year</h3>
      <p class="sub">On your projected ${fmt$k(projected)}, your ${wr.toFixed(1)}% rate is <strong>${fmt$(startWithdrawal)}/yr</strong>${inputs.socialSecurityAnnual ? ` + ${fmt$(inputs.socialSecurityAnnual)} Social Security` : ''} — ${coversDesired ? 'enough to' : 'short of your goal to'} cover your ${fmt$(desired)}/yr target.</p>
      <div class="strat-cards">
        ${card('Fixed 4% rule', '',
          `4% of ${fmt$k(projected)} = <strong>${fmt$(w4)}/yr</strong>, then inflation-adjusted. Simple and predictable.`,
          'Easy to follow; the classic benchmark.', 'Inflexible in downturns; conservative for very long retirements.')}
        ${card('Guyton-Klinger guardrails', 'best',
          `Start ~5% (<strong>${fmt$(w5)}/yr</strong>) with guardrails: trim if your rate climbs past ~6% (${fmt$(w6)}), raise it if it drops below ~4% (${fmt$(w4)}).`,
          'Higher income early, with automatic course-correction — ideal for a long FIRE horizon.', 'Requires reviewing spending yearly and accepting some variability.')}
        ${card('Dynamic / variable spending', '',
          `Withdraw a fixed % of the <em>current</em> balance each year, so spending floats with the market (≈${fmt$(startWithdrawal)} in year one).`,
          'Mathematically never depletes the portfolio.', 'Income can swing meaningfully year to year.')}
      </div>
    </div>`;

  // 3. Spending smile.
  const smile = `
    <div class="strat-section">
      <h3>${early ? '3' : '2'}. Plan for the "spending smile"</h3>
      <p class="sub">Research (Blanchett) shows real spending isn't flat — high early, dipping mid-retirement, rising late on healthcare. Applied to your ${fmt$(desired)}/yr target:</p>
      <div class="phase-row">
        <div class="phase"><h4>Go-go years</h4><div class="ages">~${startAge.toFixed(0)}–${(startAge + 15).toFixed(0)}</div>
          <p>Most active, most expensive — budget up to <strong>${fmt$(desired * 1.1)}/yr</strong>. A guardrails strategy lets you front-load confidently.</p></div>
        <div class="phase"><h4>Slow-go years</h4><div class="ages">~${(startAge + 15).toFixed(0)}–${(startAge + 30).toFixed(0)}</div>
          <p>Travel slows; real spending often drifts to ~<strong>${fmt$(desired * 0.85)}/yr</strong> — a natural buffer for the portfolio.</p></div>
        <div class="phase"><h4>No-go years</h4><div class="ages">~${(startAge + 30).toFixed(0)}+</div>
          <p>Less discretionary spend (~<strong>${fmt$(desired * 0.85)}/yr</strong>) but rising healthcare/long-term-care. Reserve a cushion.</p></div>
      </div>
    </div>`;

  // 4. Sequence-of-returns protection.
  const sequence = `
    <div class="strat-section">
      <h3>${early ? '4' : '3'}. Protect against a bad first decade (sequence risk)</h3>
      <p class="sub">A market crash in your first few retirement years — while you're withdrawing — does far more damage than the same crash later. Two common defenses:</p>
      <div class="strat-cards">
        ${card('Cash / bond bucket', '',
          `Hold 1–3 years of spending — for you, <strong>${fmt$(desired)}–${fmt$(desired * 3)}</strong> — in cash/short bonds. In a downturn, spend the bucket instead of selling stocks at a loss; refill in good years.`,
          'Simple, intuitive, avoids forced selling.', 'Cash drags on long-run returns.')}
        ${card('Bond tent', '',
          'Temporarily raise your bond allocation right around the retirement date (the riskiest window), then glide back toward stocks over the following decade.',
          'Directly targets the most vulnerable years; pairs well with guardrails.', 'More complex to implement and rebalance.')}
      </div>
    </div>`;

  // 5. ACA / tax management (relevant before Medicare at 65).
  const yearsToMedicare = Math.max(0, 65 - startAge);
  const healthEst = 15000; // rough unsubsidized marketplace cost (Phase 2 makes this configurable)
  const aca = startAge >= 65 ? '' : `
    <div class="strat-section">
      <h3>${early ? '5' : '4'}. Manage income for health insurance &amp; taxes</h3>
      <p class="sub">You retire ~${yearsToMedicare.toFixed(0)} years before Medicare at 65. Budget for health insurance — unsubsidized marketplace coverage can run ~${fmt$(healthEst)}/yr (≈<strong>${fmt$k(healthEst * yearsToMedicare)}</strong> over the gap), but ACA subsidies based on your Modified Adjusted Gross Income (MAGI) can cut that sharply.</p>
      <div class="strat-cards">
        ${card('Control MAGI for ACA subsidies', '',
          'Spending from taxable basis and Roth principal generates little taxable income, which can keep MAGI low and premium tax credits high. Size Roth conversions to fill — but not overflow — low tax brackets.',
          'Can save thousands per year in health-insurance premiums.', 'Going a dollar over key thresholds can sharply cut subsidies — model it carefully.')}
        ${card('Harvest gains/brackets deliberately', '',
          'In low-income early years, realize long-term gains at the 0% bracket or do Roth conversions to "fill up" cheap brackets — smoothing lifetime taxes.',
          'Reduces future required-distribution tax bombs.', 'Interacts with ACA MAGI — the two goals can conflict; balance them.')}
      </div>
    </div>`;

  const footnote = `
    <div class="panel" style="font-size:12px;color:var(--muted)">
      <strong>Sources &amp; further reading:</strong>
      Guyton-Klinger guardrails (<a href="https://www.kitces.com/blog/guyton-klinger-guardrails-retirement-income-rules-risk-based/" target="_blank" rel="noopener">Kitces</a>),
      the retirement spending smile (<a href="https://www.kitces.com/blog/estimating-changes-in-retirement-expenditures-and-the-retirement-spending-smile/" target="_blank" rel="noopener">Blanchett / Kitces</a>),
      accessing funds before 59½ (<a href="https://www.madfientist.com/how-to-access-retirement-funds-early/" target="_blank" rel="noopener">Mad Fientist</a>),
      Roth conversion ladders &amp; ACA (<a href="https://choosefi.com/tax-strategies/roth-conversion-ladder" target="_blank" rel="noopener">ChooseFI</a>).
    </div>`;

  const phaseRoadmap = renderPhaseRoadmap({
    startAge, ssStartAge: inputs.ssStartAge, desired,
    taxable: bt.taxable, rothBasisIRA, rothBasis401k, pretax: lockedPretax, total: proj.total,
  });
  const timeline = strategyTimeline(inputs, startAge);

  // Hierarchical: phase roadmap → conceptual cards → execution summary → sources.
  $('strategyBody').innerHTML = phaseRoadmap + bridge + rate + smile + sequence + aca + timeline + footnote;
}

// Unused tax-advantaged contribution room across the user's accounts this year.
// For 401(k) the ceiling is §415(c) total additions ($72k) — NOT the elective-
// deferral limit — so mega-backdoor (after-tax + in-plan conversion) headroom
// counts. Each account is measured against its owner's per-person limits.
function taxAdvantagedRoom() {
  let total = 0;
  const byType = {};
  accountGroups.forEach((g) => {
    const ownerAge = g.owner === 'partner' ? num('ageB') : num('ageA');
    let cap = null, used = 0;
    if (g.type === '401k' || g.type === '403b' || g.type === 'tsp') {
      cap = IRS_LIMITS.k401_total_415c; // §415(c) — enables mega-backdoor Roth
      used = g.subAccounts.filter((s) => s.addition).reduce((s, a) => s + getContribution(a, CURRENT_YEAR), 0);
    } else if (g.type === '457b') {
      cap = IRS_LIMITS.k401_employee + catchUp401k(ownerAge); // own elective-deferral limit
      used = g.subAccounts.filter((s) => s.deferral).reduce((s, a) => s + getContribution(a, CURRENT_YEAR), 0);
    } else if (g.type === 'ira') {
      cap = IRS_LIMITS.ira_combined + catchUpIRA(ownerAge);
      used = g.subAccounts.filter((s) => s.deferral).reduce((s, a) => s + getContribution(a, CURRENT_YEAR), 0);
    } else if (g.type === 'hsa') {
      cap = IRS_LIMITS.hsa_self + catchUpHSA(ownerAge);
      used = g.subAccounts.filter((s) => s.deferral).reduce((s, a) => s + getContribution(a, CURRENT_YEAR), 0);
    }
    if (cap != null) {
      const room = Math.max(0, cap - used);
      total += room;
      if (room > 0) byType[g.type] = (byType[g.type] || 0) + room;
    }
  });
  return { total, byType };
}

// Barista FIRE view: the hero number is the minimum part-time income needed,
// since Barista FIRE *assumes* you keep earning a little. Then: how to shrink
// that part-time need to $0 (i.e. reach Full FIRE) by investing more / working longer.
function renderBaristaHustle(inputs, f, targetAge, yearsAvail, projected, r) {
  const desired = inputs.desiredAnnualIncome;
  const portfolioIncome = projected * (inputs.withdrawalRate / 100);
  const minPartTime = Math.max(0, desired - portfolioIncome);
  const earlyNote = targetAge < 59.5
    ? `<p class="strat-note">Reaching this by ${targetAge.toFixed(0)} is before 59½ — see the <strong>Spending strategy</strong> tab for accessing the money penalty-free.</p>`
    : '';

  if (minPartTime <= 0) {
    $('hustleBody').innerHTML = `<div class="hustle-headline clear">
      Your portfolio alone covers your ${fmt$(desired)}/yr at age ${targetAge.toFixed(0)} — that's <strong>Full FIRE</strong>, no part-time work needed.
      <span class="big">$0 part-time</span>
      <div class="sub2">Projected ${fmt$k(projected)} → ${fmt$(portfolioIncome)}/yr at your ${inputs.withdrawalRate.toFixed(1)}% withdrawal rate, already covering your ${fmt$(desired)}/yr target.</div>
    </div>` + earlyNote;
    return;
  }

  // What it takes to drop the part-time need to $0 (reach Full FIRE) by targetAge.
  const needFull = requiredAnnualContribution(inputs.householdBalance, r, yearsAvail, f.fullFire);
  const extraForFull = Math.max(0, needFull - inputs.householdAnnual);
  const yrsToFull = yearsToReach(inputs.householdBalance, inputs.householdAnnual, r, f.fullFire);
  const ageFull = yrsToFull == null ? null : inputs.youngestAge + yrsToFull;

  // How long the Barista phase lasts: years for the portfolio to coast up to
  // Full FIRE while withdrawing only the SWR each year (excess return compounds).
  const yearsToCoastedFull = yearsFromBaristaToFull(projected, desired, inputs.withdrawalRate, r);
  const agePartTimeDropsToZero = yearsToCoastedFull != null ? targetAge + yearsToCoastedFull : null;
  const baristaHorizon = agePartTimeDropsToZero != null
    ? `Maintain this income from age <strong>${targetAge.toFixed(0)}</strong> up to age <strong>${agePartTimeDropsToZero.toFixed(0)}</strong> (about ${yearsToCoastedFull} years). At age ${agePartTimeDropsToZero.toFixed(0)}, your portfolio will have compounded to <strong>Full FIRE</strong> — $0 part-time needed.`
    : `Maintain this income until <strong>age 67</strong>, when Social Security kicks in to permanently reduce or eliminate your portfolio drawdown gap.`;

  const headline = `<div class="hustle-headline gap">
    Barista FIRE at age ${targetAge.toFixed(0)} means topping up your portfolio with a little part-time work.
    <span class="big">${fmt$(minPartTime)}/yr part-time</span>
    <div class="sub2">Your projected ${fmt$k(projected)} provides ${fmt$(portfolioIncome)}/yr; part-time work covers the remaining ${fmt$(minPartTime)} of your ${fmt$(desired)}/yr lifestyle (~${fmt$(minPartTime / 12)}/mo).</div>
  </div>`;

  const cards = `<div class="strat-section" style="margin-top:18px"><div class="strat-cards">
    <div class="strat-card hustle-card rec">
      <h4>☕ The Lifestyle Lever: Downshift to part-time</h4>
      <div class="num">${fmt$(minPartTime)}<span class="unit"> / yr part-time</span></div>
      <div class="barista-horizon">${baristaHorizon}</div>
      <div class="detail">About <strong>${fmt$(minPartTime / 12)}/mo</strong> — e.g. part-time, seasonal, or freelance work. Added to your portfolio's ${fmt$(portfolioIncome)}/yr, it funds your full ${fmt$(desired)}/yr without touching principal faster than planned.</div>
    </div>
    <div class="strat-card hustle-card">
      <h4>💪 The Income Lever: Save more now</h4>
      ${extraForFull > 0
        ? `<div class="num">${fmt$(extraForFull)}<span class="unit"> / yr extra</span></div>
           <div class="detail">Saving this much more would grow the portfolio enough to cover everything by ${targetAge.toFixed(0)} — no part-time work at all (that's Full FIRE).</div>`
        : `<div class="num">$0</div><div class="detail">You're already on track for Full FIRE by ${targetAge.toFixed(0)} — part-time is optional.</div>`}
    </div>
    <div class="strat-card hustle-card">
      <h4>⏳ The Time Lever: Work longer</h4>
      ${ageFull != null
        ? `<div class="num">age ${ageFull.toFixed(0)}</div><div class="detail">Keep your current saving and the portfolio covers your full lifestyle — no part-time — by about age <strong>${ageFull.toFixed(0)}</strong>.</div>`
        : `<div class="num">—</div><div class="detail">At the current saving rate the portfolio doesn't reach Full FIRE within the horizon; combine with investing more.</div>`}
    </div>
  </div></div>`;

  $('hustleBody').innerHTML = headline + cards + earlyNote;
}

// --- "How much do I still need to hustle?" tab -------------------------
function renderHustle() {
  const inputs = buildInputs();
  const f = forecast(inputs);

  // Default the target-age field to the household's earliest retirement age.
  const defaultAge = Math.round(inputs.youngestAge + inputs.yearsToRetirement);
  if (!$('hustleAge').value) $('hustleAge').value = defaultAge;

  const goal = $('hustleGoal').value;
  const targetAge = num('hustleAge');
  const investableSide = num('hustleInvest'); // $/yr they can realistically invest from side income

  // Item 5: show whose age "Reach it by age" refers to (the first retiree).
  const whoLabel = inputs.isCouple ? (inputs.firstRetiree === 'B' ? 'Person B' : 'Person A') : 'you';
  $('hustleAgeWho').textContent = `(${whoLabel}, now ${inputs.youngestAge})`;

  const GOAL_LABEL = { full: 'Full FIRE', lean: 'Lean FIRE', barista: 'Barista FIRE', fat: 'Fat FIRE' };
  const targets = {
    full: f.fullFire,
    lean: f.milestones.lean.target,
    barista: f.milestones.barista.target,
    fat: f.milestones.fat.target,
  };
  const target = targets[goal];
  const label = GOAL_LABEL[goal];

  const r = inputs.baseReturn;
  const yearsAvail = Math.max(0, targetAge - inputs.youngestAge);

  // Projected balance at the chosen age on the current plan (base return).
  const projected = projectBalance(inputs.householdBalance, inputs.householdAnnual, r, yearsAvail);
  const gap = target - projected;

  // Barista FIRE is fundamentally about part-time income, not hitting a huge
  // portfolio number. So for this goal, lead with the minimum part-time income
  // the portfolio can't cover — then show how to shrink it toward $0 (Full FIRE).
  if (goal === 'barista') { renderBaristaHustle(inputs, f, targetAge, yearsAvail, projected, r); return; }

  // Headline.
  let headline;
  if (gap <= 0) {
    // Already on track — show how early they actually hit it, and slack.
    const hitYears = yearsToReach(inputs.householdBalance, inputs.householdAnnual, r, target);
    const hitAge = hitYears == null ? null : inputs.youngestAge + hitYears;
    headline = `<div class="hustle-headline clear">
      You're already on track to reach <strong>${label}</strong> by age ${targetAge.toFixed(0)}.
      <span class="big">+${fmt$(-gap)} cushion</span>
      <div class="sub2">Projected ${fmt$k(projected)} vs. a ${fmt$k(target)} target${hitAge != null ? ` · you actually cross it around age ${hitAge.toFixed(0)}` : ''}. No extra hustle required — you could even ease off.</div>
    </div>`;
    $('hustleBody').innerHTML = headline;
    return;
  }

  // --- Three ways to close the gap ---
  // 1) Earn & invest more now.
  const needAnnual = requiredAnnualContribution(inputs.householdBalance, r, yearsAvail, target);
  const extraInvest = Math.max(0, needAnnual - inputs.householdAnnual);
  const investGapClosed = investableSide >= extraInvest;
  const stillShort = Math.max(0, extraInvest - investableSide);

  // Account-aware: how much of that extra fits in tax-advantaged space?
  // (401k room is §415(c)-based, so mega-backdoor headroom counts.)
  const room = taxAdvantagedRoom();
  const shelterable = Math.min(extraInvest, room.total);
  const partnerHint = inputs.isCouple && !accountGroups.some((g) => g.owner === 'partner')
    ? ` Your partner's accounts aren't modeled yet — add a <strong>Partner</strong> 401(k)/IRA to use their limits too.`
    : '';
  const roomNote = room.total <= 0
    ? `These accounts are at their §415(c) / IRS ceilings, so the extra goes to a <strong>taxable brokerage</strong>.${partnerHint}`
    : extraInvest <= room.total
      ? `All of it fits in <strong>${fmt$(room.total)}</strong> of unused tax-advantaged room (incl. mega-backdoor headroom).${partnerHint}`
      : `About <strong>${fmt$(shelterable)}</strong> fits in tax-advantaged room (incl. mega-backdoor headroom); the rest goes to a <strong>taxable brokerage</strong>.${partnerHint}`;

  // 2) Work a little longer (same contribution).
  const totalYears = yearsToReach(inputs.householdBalance, inputs.householdAnnual, r, target);
  const extraYears = totalYears == null ? null : Math.max(0, totalYears - yearsAvail);
  const laterAge = totalYears == null ? null : inputs.youngestAge + totalYears;

  // 3) Earn part-time in retirement (Barista FIRE) — minimum income needed.
  // No SS subtracted: at an early target age it hasn't started yet.
  const portfolioIncome = projected * (inputs.withdrawalRate / 100);
  const incomeShortfall = Math.max(0, inputs.desiredAnnualIncome - portfolioIncome);

  const yrsWord = `${yearsAvail.toFixed(0)} year${yearsAvail === 1 ? '' : 's'}`;
  headline = `<div class="hustle-headline gap">
    <strong>${label}</strong> by age ${targetAge.toFixed(0)} — just <strong>${yrsWord}</strong> away — is within reach with a few moves.
    <span class="big">${fmt$(gap)} to go</span>
    <div class="sub2">Projected ${fmt$k(projected)} vs. a ${fmt$k(target)} target over ${yrsWord}. ${yearsAvail <= 5 ? 'With this short a window the numbers run steep — a slightly later target age eases them. ' : ''}Here are three ways to close it:</div>
  </div>`;

  const cards = `<div class="strat-section" style="margin-top:18px"><div class="strat-cards">
    <div class="strat-card hustle-card rec">
      <h4>💪 The Income Lever: Save more now</h4>
      <div class="num">${fmt$(extraInvest)}<span class="unit"> / yr extra to invest</span></div>
      <div class="detail">That's about <strong>${fmt$(extraInvest / 12)}/mo</strong> on top of your current saving.</div>
      ${investableSide > 0
        ? `<div class="detail" style="margin-top:6px">You can invest <strong>${fmt$(investableSide)}/yr</strong> in extra savings — ${investGapClosed
            ? `that <strong>covers it</strong>, with ${fmt$(investableSide - extraInvest)}/yr to spare.`
            : `that gets you most of the way, with <strong>${fmt$(stillShort)}/yr</strong> still to go.`}</div>`
        : `<div class="detail" style="margin-top:6px">Enter the extra savings you could add above to test it against this number.</div>`}
      <div class="detail" style="margin-top:6px">${roomNote}</div>
    </div>
    <div class="strat-card hustle-card">
      <h4>⏳ The Time Lever: Work longer</h4>
      ${extraYears == null
        ? `<div class="num">—</div><div class="detail">Even with many more years, the current contribution doesn't reach this goal. Combine with saving more.</div>`
        : `<div class="num">+${extraYears.toFixed(1)}<span class="unit"> more years</span></div>
           <div class="detail">Keep your current savings rate and you'd hit ${label} around <strong>age ${laterAge.toFixed(0)}</strong> instead of ${targetAge.toFixed(0)} — no extra savings needed.</div>`}
    </div>
    <div class="strat-card hustle-card">
      <h4>☕ The Lifestyle Lever: Downshift to part-time</h4>
      ${incomeShortfall <= 0
        ? `<div class="num">$0<span class="unit"> / yr needed</span></div><div class="detail">Your projected portfolio income (${fmt$(portfolioIncome)}/yr) already covers your ${fmt$(inputs.desiredAnnualIncome)}/yr spending — no part-time work needed.</div>`
        : `<div class="num">${fmt$(incomeShortfall)}<span class="unit"> / yr minimum</span></div>
           <div class="detail"><strong>Minimum part-time income to earn:</strong> ~${fmt$(incomeShortfall / 12)}/mo. Combined with your portfolio's ${fmt$(portfolioIncome)}/yr, it covers your ${fmt$(inputs.desiredAnnualIncome)}/yr — so you could leave full-time work at ${targetAge.toFixed(0)}.</div>`}
    </div>
  </div></div>`;

  // Early-access reality check: hitting the number before 59½ ≠ being able to spend it.
  const earlyNote = targetAge < 59.5
    ? `<p class="strat-note">Note: reaching the <em>number</em> by age ${targetAge.toFixed(0)} is step one — accessing it before 59½ needs a bridge (Roth ladder, 72(t), or taxable/Roth savings). See the <strong>Spending strategy</strong> tab for your specific bridge math.</p>`
    : '';

  $('hustleBody').innerHTML = headline + cards + earlyNote;
}

function updateSliderLabels() {
  $('returnVal').textContent = num('returnRate').toFixed(1) + '%';
  $('wrVal').textContent = num('withdrawalRate').toFixed(1) + '%';
  // Goal Builder's withdrawal-rate slider is a second window onto the SAME
  // value as Forecast's #withdrawalRate (not a separate synced-from-Goal-
  // Builder field) — both directly editable, kept in lockstep via this plus
  // the dedicated #goalWithdrawalRate 'input' listener in the wiring section
  // below. Avoids the "which tab owns it" ambiguity entirely: there's only
  // ever one number, just two sliders pointed at it.
  if ($('goalWithdrawalRate')) {
    $('goalWithdrawalRate').value = num('withdrawalRate');
    $('goalWrVal').textContent = num('withdrawalRate').toFixed(1) + '%';
  }
  $('extraVal').textContent = fmt$(num('extraContribution'));
  // ageShift has no visible Forecast slider anymore (removed — Scenario
  // Playground's "Retirement age" field is the only thing that still sets
  // it, as its internal override mechanism), so no label to update here.
  syncScenarioRetirementAgeField();
}

// Scenario Playground keeps its OWN retirement-age what-if. It used to write
// the shared hidden #ageShift field, but that leaked onto every non-Goal tab
// (Forecast/Strategy/Debt all read #ageShift in buildInputs) — so setting a
// scenario age of 40 silently dragged the Forecast horizon to 40 too. Now the
// what-if lives in this module-level state and is applied ONLY to a local copy
// of inputs inside renderScenarioPlayground(); nothing global is mutated.
// null = follow the household's natural first-retirement age.
let scenarioRetirementAge = null;

function baseScenarioRetirementAge() {
  const isCouple = $('household').value === 'couple';
  const yearsA = num('retA') - num('ageA');
  const yearsB = isCouple ? num('retB') - num('ageB') : Infinity;
  return yearsB < yearsA ? num('retB') : num('retA');
}

// The retirement age the Scenario tab should model: the explicit what-if if set,
// otherwise the household's natural first-retirement age.
function scenarioEffectiveRetirementAge() {
  return scenarioRetirementAge != null ? scenarioRetirementAge : baseScenarioRetirementAge();
}

function syncScenarioRetirementAgeField() {
  const field = $('scenarioRetirementAge');
  if (!field || document.activeElement === field) return;
  const age = scenarioEffectiveRetirementAge();
  field.value = isFinite(age) && age > 0 ? Math.round(age) : '';
}

function applyScenarioRetirementAge() {
  const field = $('scenarioRetirementAge');
  if (!field) return;
  const targetAge = parseFloat(field.value);
  // Blank/invalid clears the override → fall back to the natural age.
  scenarioRetirementAge = (isFinite(targetAge) && targetAge > 0) ? Math.round(targetAge) : null;
  // Deliberately does NOT touch #ageShift anymore — the override is scenario-local.
  renderScenarioPlayground();
  saveState();
}

function recompute() {
  syncForecastHouseholdFromGoal();
  syncAcaHouseholdFromGoal();
  refreshLocation();
  syncLeanFatFromGoal();
  syncHealthcareFromGoal();
  updateSliderLabels();
  const inputs = buildInputs();
  const f = forecast(inputs);
  renderAssumptionsBar(inputs);
  renderGap(f.base, inputs);
  renderFireWarning(f, inputs);
  renderChart(f);
  renderProjectionTable(f);
  renderBalances(f);
  renderFire(f.milestones);
  renderAudit(f, inputs);
  renderForecastFireBreakdown(f, inputs);
  updatePullGoalButtons();
}

// Label the "Use Goal Builder spending" buttons with the live blended figure they'd
// apply, so the action is concrete (and obviously a no-op when no phases exist yet).
function updatePullGoalButtons() {
  const phases = goalPhases();
  const blended = phases.length ? Math.round(blendedDesiredIncome(phases)) : null;
  document.querySelectorAll('.pull-goal-btn').forEach((b) => {
    b.textContent = blended != null
      ? `⬇ Use Your Target spending: ${fmt$(blended)}/yr`
      : '⬇ Use Your Target spending';
    b.title = 'Sets your target income to the duration-weighted average of the spending phases you mapped in Your Target.';
  });
}

function toggleCouple() {
  const isCouple = $('household').value === 'couple';
  $('personB').classList.toggle('hidden', !isCouple);
  $('personA').querySelector('h3').textContent = isCouple ? 'Person A' : 'You';
  $('potTitle').textContent = isCouple ? 'Household accounts' : 'Accounts';
}

function toggleGoalCouple() {
  const isCouple = $('goalHousehold').value === 'couple';
  $('goalPersonB').classList.toggle('hidden', !isCouple);
}

// --- Accounts UI (Phase 1: tax-treatment splits) -----------------------
const CURRENT_YEAR = new Date().getFullYear();
// Categories come from the engine (accounts.js); each maps to a tax treatment.
const CAT_OPTIONS = Object.entries(SUBACCOUNT_CATEGORIES).map(([k, v]) => [k, v.label]);

// Which source categories make sense per account type, and labels that make the
// Roth IRA vs Roth 401(k) distinction explicit (it's the parent account that
// decides — same as the early-access rules in renderStrategy).
const CAT_BY_TYPE = {
  '401k': ['pretax', 'roth', 'match', 'rollover', 'roth_rollover', 'roth_conversion', 'aftertax', 'total'],
  '403b': ['pretax', 'roth', 'match', 'rollover', 'roth_rollover', 'roth_conversion', 'aftertax', 'total'],
  '457b': ['pretax', 'roth', 'rollover', 'roth_rollover', 'total'],
  'tsp': ['pretax', 'roth', 'match', 'rollover', 'roth_rollover', 'total'],
  'ira': ['pretax', 'roth', 'rollover', 'roth_rollover', 'total'],
  'hsa': ['pretax', 'total'],
  'brokerage': ['taxable', 'total'],
  'other': ['pretax', 'roth', 'aftertax', 'taxable', 'total'],
};
const CAT_LABEL_BY_TYPE = {
  '401k': { roth: 'Roth (401k)' },
  '403b': { roth: 'Roth (403b)' },
  '457b': { pretax: 'Pre-Tax (Traditional)', roth: 'Roth 457(b)' },
  'tsp': { pretax: 'Traditional (pre-tax)', roth: 'Roth TSP', match: 'Agency Match' },
  'ira': { pretax: 'Pre-Tax (Traditional)', roth: 'Roth IRA' },
  'hsa': { pretax: 'Contribution (pre-tax)' },
};
function categoryOptionsFor(type, currentCategory) {
  let keys = CAT_BY_TYPE[type] || CAT_BY_TYPE.other;
  if (currentCategory && !keys.includes(currentCategory)) keys = [currentCategory, ...keys]; // keep the current value visible
  const ov = CAT_LABEL_BY_TYPE[type] || {};
  return keys.map((k) => [k, ov[k] || (SUBACCOUNT_CATEGORIES[k] ? SUBACCOUNT_CATEGORIES[k].label : k)]);
}
// Tax treatments still drive the composition display colors.
const TT_OPTIONS = [['pretax', 'Pre-tax'], ['roth', 'Roth'], ['aftertax', 'After-tax'], ['taxable', 'Taxable']];
const ACCT_TYPES = [['401k', '401(k)'], ['403b', '403(b)'], ['457b', '457(b)'], ['tsp', 'TSP'], ['ira', 'IRA'], ['hsa', 'HSA'], ['brokerage', 'Brokerage'], ['other', 'Other']];

let accountGroups = [];               // array of AccountGroup (from accounts.js)
const collapsedGroups = new Set();    // UI-only: which cards are collapsed

function escAttr(s) { return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }

// Reusable "how was this computed" tooltip — a custom hover/focus bubble
// (not native title=, which is slow/unreliable and invisible on touch/keyboard).
function infoTip(text) {
  return `<span class="info-tip" tabindex="0">ⓘ<span class="info-tip-bubble">${escAttr(text)}</span></span>`;
}
function findGroup(gid) { return accountGroups.find((g) => g.id === gid); }
function findSub(group, sid) { return group && group.subAccounts.find((s) => s.id === sid); }

function accountsTotals() {
  let balance = 0, contribution = 0;
  accountGroups.forEach((g) => { balance += groupBalance(g); contribution += groupContribution(g, CURRENT_YEAR); });
  return { balance, contribution };
}

// Keep the hidden bal/con fields (which the forecast reads) in sync with accounts.
function syncLegacyFields() {
  const t = accountsTotals();
  $('bal').value = Math.round(t.balance);
  $('con').value = Math.round(t.contribution);
}

function subRowHTML(gid, s, groupType) {
  const cats = categoryOptionsFor(groupType, s.category).map(([v, l]) => `<option value="${v}" ${s.category === v ? 'selected' : ''}>${l}</option>`).join('');
  return `<div class="sub-row" data-sid="${s.id}">
    <select class="sub-cat" data-gid="${gid}" data-sid="${s.id}">${cats}</select>
    <input class="sub-bal" type="number" min="0" step="1000" data-gid="${gid}" data-sid="${s.id}" value="${s.balance}">
    <input class="sub-con" type="number" min="0" step="500" data-gid="${gid}" data-sid="${s.id}" value="${s.baseContribution}">
    <button type="button" class="x remove-sub-btn" data-gid="${gid}" data-sid="${s.id}" title="Remove treatment">×</button>
  </div>`;
}

const OWNER_OPTIONS = [['you', 'You'], ['partner', 'Partner'], ['joint', 'Joint']];

function groupCardHTML(group, isCouple) {
  const collapsed = collapsedGroups.has(group.id);
  const types = ACCT_TYPES.map(([v, l]) => `<option value="${v}" ${group.type === v ? 'selected' : ''}>${l}</option>`).join('');
  const owners = OWNER_OPTIONS.map(([v, l]) => `<option value="${v}" ${group.owner === v ? 'selected' : ''}>${l}</option>`).join('');
  const ownerSelect = isCouple
    ? `<select class="ac-owner" data-gid="${group.id}" aria-label="Account owner" title="Whose per-person limits apply">${owners}</select>`
    : '';
  const subs = group.subAccounts.map((s) => subRowHTML(group.id, s, group.type)).join('');
  // Public-sector toggles: agency matching (TSP/403(b)) and 457(b) penalty-free
  // withdrawal upon separation from service.
  let flagsHTML = '';
  if (group.type === 'tsp' || group.type === '403b') {
    flagsHTML = `<label class="ac-flag"><input type="checkbox" class="ac-agency-match" data-gid="${group.id}" ${group.agencyMatch ? 'checked' : ''}> Agency / employer matching</label>`;
  } else if (group.type === '457b') {
    flagsHTML = `<label class="ac-flag"><input type="checkbox" class="ac-penalty-free" data-gid="${group.id}" ${group.penaltyFreeSeparation ? 'checked' : ''}> Penalty-free withdrawal upon separation</label>`;
  }
  return `<div class="account-card ${collapsed ? 'collapsed' : 'open'}" data-gid="${group.id}">
    <div class="ac-head">
      <span class="twist">▶</span>
      <input class="ac-name" data-gid="${group.id}" value="${escAttr(group.name)}" aria-label="Account name">
      ${ownerSelect}
      <label class="ac-type-field">Type <select class="ac-type" data-gid="${group.id}" aria-label="Account type">${types}</select></label>
      <div class="ac-summary"><strong id="gtbal_${group.id}">—</strong><span id="gtcon_${group.id}"></span></div>
    </div>
    <div class="ac-body">
      <div class="sub-row"><span class="sub-head">Source</span><span class="sub-head">Balance</span><span class="sub-head">Annual contrib.</span><span></span></div>
      ${subs}
      ${flagsHTML ? `<div class="ac-flags">${flagsHTML}</div>` : ''}
      <div class="ac-actions">
        <button type="button" class="btn-link add-sub-btn" data-gid="${group.id}">+ Add tax treatment</button>
        <button type="button" class="btn-link remove-group-btn" data-gid="${group.id}" style="color:var(--bad)">Remove account</button>
      </div>
      <div class="ac-comp" id="gtcomp_${group.id}"></div>
      <div class="ac-warn hidden" id="gtwarn_${group.id}"></div>
      <div class="ac-hint hidden" id="gthint_${group.id}"></div>
    </div>
  </div>`;
}

function renderAccounts() {
  const isCouple = $('household').value === 'couple';
  $('accountsContainer').innerHTML = accountGroups.map((g) => groupCardHTML(g, isCouple)).join('');
  accountGroups.forEach((g) => updateGroupComputed(g.id));
  updateAccountsTotal();
}

// Update a card's totals/composition/warnings in place (no re-render → keeps focus).
function updateGroupComputed(gid) {
  const group = findGroup(gid);
  if (!group) return;
  const bal = groupBalance(group);
  const con = groupContribution(group, CURRENT_YEAR);
  const balEl = $(`gtbal_${gid}`); if (balEl) balEl.textContent = fmt$k(bal);
  const conEl = $(`gtcon_${gid}`); if (conEl) conEl.textContent = con ? ` · ${fmt$(con)}/yr` : '';

  // Composition by treatment (share of balance).
  const comp = { pretax: 0, roth: 0, aftertax: 0, taxable: 0 };
  group.subAccounts.forEach((s) => { comp[s.taxTreatment] += s.balance || 0; });
  const compEl = $(`gtcomp_${gid}`);
  if (compEl) {
    const segs = TT_OPTIONS.filter(([v]) => comp[v] > 0).map(([v, l]) =>
      `<span class="seg"><span class="dot tt-${v}"></span>${l} ${bal ? Math.round(comp[v] / bal * 100) : 0}%</span>`).join('');
    compEl.innerHTML = segs || '<span class="seg">No balance yet</span>';
  }

  // Validation against the OWNER's per-person limits (couples have two sets).
  const ownerAge = group.owner === 'partner' ? num('ageB') : num('ageA');
  const v = validateGroupYear(group, CURRENT_YEAR, { age: ownerAge, coverage: 'self' });
  const warnEl = $(`gtwarn_${gid}`);
  if (warnEl) {
    if (v.warnings.length) { warnEl.innerHTML = v.warnings.join('<br>'); warnEl.classList.remove('hidden'); }
    else warnEl.classList.add('hidden');
  }
  const hintEl = $(`gthint_${gid}`);
  if (hintEl) {
    if (v.hints && v.hints.length) { hintEl.innerHTML = v.hints.join('<br>'); hintEl.classList.remove('hidden'); }
    else hintEl.classList.add('hidden');
  }
}

function updateAccountsTotal() {
  const t = accountsTotals();
  $('accountsTotal').innerHTML =
    `<span>${accountGroups.length} account${accountGroups.length === 1 ? '' : 's'} · ${fmt$(t.contribution)}/yr contributions</span>` +
    `<strong>${fmt$(t.balance)} total</strong>`;
}

// Called after any account edit: sync derived fields, re-forecast, persist.
function onAccountsChanged() {
  syncLegacyFields();
  updateAccountsTotal();
  recompute();
  refreshActiveTab();
  saveState();
}

const ADD_ACCT_DEFAULTS = {
  '401k': { name: '401(k)', category: 'pretax' },
  '403b': { name: '403(b)', category: 'pretax' },
  '457b': { name: '457(b)', category: 'pretax' },
  'tsp': { name: 'TSP', category: 'pretax' },
  'ira': { name: 'IRA', category: 'roth' },        // defaults to a Roth IRA source
  'hsa': { name: 'HSA', category: 'pretax' },
  'brokerage': { name: 'Brokerage', category: 'taxable' },
};
function addGroup(type = 'brokerage') {
  const d = ADD_ACCT_DEFAULTS[type] || ADD_ACCT_DEFAULTS.brokerage;
  accountGroups.push(makeGroup({ name: d.name, type, subAccounts: [makeSubAccount({ category: d.category })] }));
  renderAccounts();
  onAccountsChanged();
}
function removeGroup(gid) {
  accountGroups = accountGroups.filter((g) => g.id !== gid);
  renderAccounts();
  onAccountsChanged();
}
function addSub(gid) {
  const g = findGroup(gid);
  if (g) g.subAccounts.push(makeSubAccount({ taxTreatment: 'pretax' }));
  renderAccounts();
  onAccountsChanged();
}
function removeSub(gid, sid) {
  const g = findGroup(gid);
  if (g) g.subAccounts = g.subAccounts.filter((s) => s.id !== sid);
  renderAccounts();
  onAccountsChanged();
}

// Event delegation on the accounts container.
function wireAccounts() {
  const c = $('accountsContainer');
  c.addEventListener('input', (e) => {
    const t = e.target;
    const g = findGroup(t.dataset.gid);
    if (!g) return;
    if (t.classList.contains('ac-name')) { g.name = t.value; updateAccountsTotal(); saveState(); }
    else if (t.classList.contains('sub-bal')) { const s = findSub(g, t.dataset.sid); if (s) s.balance = parseFloat(t.value) || 0; updateGroupComputed(g.id); onAccountsChanged(); }
    else if (t.classList.contains('sub-con')) { const s = findSub(g, t.dataset.sid); if (s) s.baseContribution = parseFloat(t.value) || 0; updateGroupComputed(g.id); onAccountsChanged(); }
    else return;
    e.stopPropagation(); // prevent the document-level handler from double-firing
  });
  c.addEventListener('change', (e) => {
    const t = e.target;
    const g = findGroup(t.dataset.gid);
    if (!g) return;
    if (t.classList.contains('ac-type')) { g.type = t.value; renderAccounts(); onAccountsChanged(); } // re-render: source options + flags depend on type
    else if (t.classList.contains('ac-owner')) { g.owner = t.value; updateGroupComputed(g.id); onAccountsChanged(); }
    else if (t.classList.contains('ac-agency-match')) { g.agencyMatch = t.checked; updateGroupComputed(g.id); onAccountsChanged(); }
    else if (t.classList.contains('ac-penalty-free')) { g.penaltyFreeSeparation = t.checked; onAccountsChanged(); }
    else if (t.classList.contains('sub-cat')) {
      const s = findSub(g, t.dataset.sid);
      if (s) {
        const info = SUBACCOUNT_CATEGORIES[t.value];
        s.category = t.value;
        s.taxTreatment = info.treatment; s.source = info.source;
        s.deferral = info.deferral; s.addition = info.addition;
      }
      updateGroupComputed(g.id); onAccountsChanged();
    }
    else return;
    e.stopPropagation();
  });
  c.addEventListener('click', (e) => {
    const t = e.target;
    if (t.classList.contains('add-sub-btn')) return addSub(t.dataset.gid);
    if (t.classList.contains('remove-sub-btn')) return removeSub(t.dataset.gid, t.dataset.sid);
    if (t.classList.contains('remove-group-btn')) return removeGroup(t.dataset.gid);
    // Toggle collapse when clicking the header chrome (not a field/button).
    const head = t.closest('.ac-head');
    if (head && !t.closest('input, select, button, label')) {
      const gid = head.parentElement.dataset.gid;
      collapsedGroups.has(gid) ? collapsedGroups.delete(gid) : collapsedGroups.add(gid);
      head.parentElement.classList.toggle('collapsed');
      head.parentElement.classList.toggle('open');
    }
  });
}

// Restore accounts from a saved blob, or migrate from the legacy bal/con fields.
function initAccounts(savedAccounts) {
  if (Array.isArray(savedAccounts) && savedAccounts.length) {
    accountGroups = savedAccounts.map(makeGroup);
  } else if (!accountGroups.length) {
    accountGroups = [migrateLegacy(num('bal'), num('con'), { name: 'Retirement savings' })];
  }
  renderAccounts();
  syncLegacyFields();
}

// --- Income streams (Phase 2: part-time, rental, pension…) --------------
let incomeStreams = [];
let _streamId = 0;
function makeStream(o = {}) {
  return { id: o.id || `str_${Date.now().toString(36)}_${_streamId++}`,
    label: o.label || 'Part-time work', annualAmount: o.annualAmount || 20000,
    startAge: o.startAge || 50, endAge: o.endAge == null ? 60 : o.endAge };
}
function streamRowHTML(s) {
  return `<div class="stream-row" data-sid="${s.id}">
    <input class="stream-label" data-sid="${s.id}" value="${escAttr(s.label)}" placeholder="Label" aria-label="Label">
    <input class="stream-amt" type="number" min="0" step="1000" data-sid="${s.id}" value="${s.annualAmount}" aria-label="$/yr" title="$/yr">
    <input class="stream-start" type="number" min="40" max="100" data-sid="${s.id}" value="${s.startAge}" aria-label="Start age" title="Start age">
    <input class="stream-end" type="number" min="40" max="110" data-sid="${s.id}" value="${s.endAge}" aria-label="End age" title="End age">
    <button type="button" class="x remove-stream-btn" data-sid="${s.id}" title="Remove">×</button>
  </div>`;
}
function renderStreams() {
  const c = $('streamsContainer');
  c.innerHTML = incomeStreams.length
    ? `<div class="stream-row stream-head"><span>Label</span><span>$/yr</span><span>From age</span><span>To age</span><span></span></div>` +
      incomeStreams.map(streamRowHTML).join('')
    : `<div class="streams-empty">No income streams — add part-time work, rental, or a pension to stretch your runway.</div>`;
}
function streamById(id) { return incomeStreams.find((s) => s.id === id); }
function onStreamsChanged() { renderStreams(); recompute(); refreshActiveTab(); saveState(); }
function addStream() { incomeStreams.push(makeStream()); onStreamsChanged(); }
function removeStream(id) { incomeStreams = incomeStreams.filter((s) => s.id !== id); onStreamsChanged(); }
function wireStreams() {
  const c = $('streamsContainer');
  c.addEventListener('input', (e) => {
    const s = streamById(e.target.dataset.sid); if (!s) return;
    const t = e.target;
    if (t.classList.contains('stream-label')) s.label = t.value;
    else if (t.classList.contains('stream-amt')) s.annualAmount = parseFloat(t.value) || 0;
    else if (t.classList.contains('stream-start')) s.startAge = parseFloat(t.value) || 0;
    else if (t.classList.contains('stream-end')) s.endAge = parseFloat(t.value) || 0;
    else return;
    recompute(); refreshActiveTab(); saveState();
    e.stopPropagation();
  });
  c.addEventListener('click', (e) => {
    if (e.target.classList.contains('remove-stream-btn')) removeStream(e.target.dataset.sid);
  });
}
function initStreams(saved) {
  if (Array.isArray(saved)) incomeStreams = saved.map(makeStream);
  renderStreams();
}

// ======================================================================
// v2: Goal Builder — spending timeline + summary
// ======================================================================

// Stacked-bar timeline of annual retirement expense by age. Segments: Base
// Living, Healthcare, Kids/529, One-Time (vehicle + one-off). Markers for the
// Retirement Age, Age 65 (Medicare), and Big-Ticket (vehicle) years.
function renderGoalTimeline(f, inputs) {
  const el = $('goalTimeline');
  if (!el) return;
  // Depletion-proof — see targetDrawdownSeries(): this chart shapes the
  // SPENDING you're planning for, not whether today's balance covers it.
  const series = targetDrawdownSeries(inputs, f);
  if (!series.length) { el.innerHTML = ''; return; }
  const inflPct = f.scenarios.base.inflation;
  const startAge = goalBuilderRetirementAge();
  const lc = inputs.lifecycle || {};
  // Explain the two things people ask about every time they look at this
  // chart: why it ends where it does, and why the Healthcare segment jumps
  // at the Medicare line — with the actual live numbers, not just in the
  // abstract.
  const endAge = Math.round(startAge + series.length - 1);
  const medicareTotal = Math.round(inputs.medicareAnnual * inputs.persons);
  const tip = `Plans through age ${endAge}. Each bar is that single year's spending, not a running total.\n` +
    `Healthcare before 65: ${fmt$(inputs.healthcareAnnual)}/yr. At 65 it switches to Medicare: ` +
    `${fmt$(inputs.medicareAnnual)}/person × ${inputs.persons} = ${fmt$(medicareTotal)}/yr.`;
  if ($('goalTimelineInfoTip')) $('goalTimelineInfoTip').outerHTML = `<span class="info-tip" id="goalTimelineInfoTip" tabindex="0">ⓘ<span class="info-tip-bubble">${escAttr(tip)}</span></span>`;
  // Build per-year stacked segments (deflated to today's $ when the toggle is on).
  const SEG = [
    ['base', 'Base living', 'var(--accent)'],
    ['health', 'Healthcare', '#0891b2'],
    ['kids', 'Kids', '#d97706'],
    ['custom', 'Custom', '#7c3aed'],
    ['onetime', 'One-time', '#e0436b'],
  ];
  const rows = series.map((p, i) => {
    const d = (v) => deflate(v, p.age - 1 - startAge, inflPct); // p.age is year-end
    const custom = p.custom || 0;
    const base = d(p.spend + Math.max(0, (p.lifecycle || 0) - (p.kids529 || 0) - custom));
    const health = d(p.healthcare || 0);
    const kids = d(p.kids529 || 0);
    const onetime = d((p.vehicle || 0) + Math.max(0, p.oneTime || 0));
    // Which vehicle(s) replace this year — for the marker label (display only).
    const yearOffset = i; // series[0] is age startAge+1, i.e. yearOffset 0
    const firing = (lc.vehicles || []).filter((v) => v.freq > 0 && yearOffset > 0 && yearOffset % Math.round(v.freq) === 0);
    const vehicleLabel = firing.map((v) => v.label || 'Vehicle').join(', ');
    return { age: Math.round(p.age - 1), base, health, kids, custom: d(custom), onetime, vehicleLabel, total: base + health + kids + d(custom) + onetime };
  });
  const W = 800, H = 320, ML = 60, MR = 16, MT = 16, MB = 34;
  const plotW = W - ML - MR, plotH = H - MT - MB;
  const yMax = Math.max(1, ...rows.map((r) => r.total)) * 1.05;
  const n = rows.length;
  const bw = Math.max(1, plotW / n * 0.8);
  const X = (i) => ML + (i + 0.5) * (plotW / n);
  const Y = (v) => MT + (1 - v / yMax) * plotH;

  let grid = '', yticks = '';
  for (let i = 0; i <= 4; i++) {
    const val = (yMax / 4) * i, yy = Y(val);
    grid += `<line class="chart-grid" x1="${ML}" y1="${yy.toFixed(1)}" x2="${W - MR}" y2="${yy.toFixed(1)}"/>`;
    yticks += `<text class="chart-tick" x="${ML - 6}" y="${(yy + 3).toFixed(1)}" text-anchor="end">${fmt$k(val)}</text>`;
  }
  let bars = '';
  rows.forEach((r, i) => {
    let yAcc = 0;
    SEG.forEach(([k, , color]) => {
      const v = r[k];
      if (v <= 0) return;
      const h = (v / yMax) * plotH;
      const yTop = Y(yAcc + v);
      bars += `<rect x="${(X(i) - bw / 2).toFixed(1)}" y="${yTop.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" fill="${color}"><title>Age ${r.age} · ${k}: ${fmt$k(v)}</title></rect>`;
      yAcc += v;
    });
  });
  // X ticks + markers
  let xticks = '', marks = '';
  const span = rows[n - 1].age - rows[0].age || 1;
  const step = Math.max(1, Math.round(span / 8 / 5) * 5);
  rows.forEach((r, i) => { if ((r.age - rows[0].age) % step === 0) xticks += `<text class="chart-tick" x="${X(i).toFixed(1)}" y="${H - 8}" text-anchor="middle">${r.age}</text>`; });
  // Two markers landing on the same age (e.g. retiring exactly at 65 — both
  // "Retire" and "Medicare" fall on the same column) used to draw their text
  // at the identical fixed y, overlapping into illegible garbled text. Track
  // how many labels have already landed on each age column and stack
  // additional ones underneath instead.
  const labelRowsAtAge = {};
  const markAt = (age, label, color) => {
    const i = rows.findIndex((r) => r.age === Math.round(age));
    if (i < 0) return;
    const x = X(i);
    const ageKey = Math.round(age);
    const row = labelRowsAtAge[ageKey] || 0;
    labelRowsAtAge[ageKey] = row + 1;
    marks += `<line x1="${x.toFixed(1)}" y1="${MT}" x2="${x.toFixed(1)}" y2="${MT + plotH}" stroke="${color}" stroke-dasharray="4 3" opacity="0.8"/>`;
    marks += `<text class="ms-label" x="${x.toFixed(1)}" y="${MT + 10 + row * 12}" text-anchor="middle" fill="${color}">${label}</text>`;
  };
  markAt(rows[0].age, 'Retire', 'var(--text)');
  markAt(65, 'Medicare', '#0891b2');
  // Big-ticket (vehicle replacement) years — labeled with the vehicle's name.
  rows.forEach((r) => { if (r.vehicleLabel && r.age !== rows[0].age) markAt(r.age, r.vehicleLabel, '#e0436b'); });

  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Annual retirement expense by age">
    ${grid}
    <line class="chart-axis" x1="${ML}" y1="${MT}" x2="${ML}" y2="${MT + plotH}"/>
    <line class="chart-axis" x1="${ML}" y1="${MT + plotH}" x2="${W - MR}" y2="${MT + plotH}"/>
    ${bars}${marks}${yticks}${xticks}
  </svg>`;
  // #7 — hide any category that's $0 across the whole horizon from the legend
  // (the stacked bars already skip zero segments per-year above).
  $('goalTimelineLegend').innerHTML = SEG.filter(([k]) => rows.some((r) => r[k] > 0)).map(([, label, color]) =>
    `<span class="lg"><span class="swatch" style="background:${color}"></span>${label}</span>`).join('') +
    `<span class="lg"><span class="swatch" style="background:#0891b2"></span>↑ Age 65 = Medicare</span>`;
  // The bars climbing steeply is the #1 thing people ask about — explain it in
  // plain terms instead of leaving it to look like runaway overspending.
  if ($('goalTimelineDisclaimer')) {
    $('goalTimelineDisclaimer').textContent = inflMode === 'today'
      ? `Shown in today's dollars — your actual lifestyle/spending power, with inflation already removed. That's why the bars are much flatter than "Future Nominal" mode.`
      : `These dollar amounts grow every year because of inflation — your spending power (what you can actually buy) stays the same; only the price tag in future dollars goes up. Switch to "Today's Dollars" above to see the flatter, real version.`;
  }
}

// Read household/age/SS from Goal Builder tab if present, otherwise fall back to Forecast
function getGoalBuilderHouseholdInputs() {
  const goalHousehold = $('goalHousehold');
  if (!goalHousehold) {
    // Goal Builder fields not in DOM yet, fall back to Forecast
    return {
      isCouple: $('household').value === 'couple',
      ageA: num('ageA'),
      retA: num('retA'),
      ssA: num('ssA'),
      ageB: num('ageB'),
      retB: num('retB'),
      ssB: num('ssB'),
    };
  }

  const isCouple = goalHousehold.value === 'couple';
  return {
    isCouple,
    ageA: num('goalAgeA'),
    retA: num('goalRetA'),
    ssA: num('goalSsA'),
    ageB: isCouple ? num('goalAgeB') : 0,
    retB: isCouple ? num('goalRetB') : 0,
    ssB: isCouple ? num('goalSsB') : 0,
  };
}

// Goal Builder's own claiming-age assumption for Social Security — "claim
// early, worst case", same figure the net-of-SS PV cards already used
// (formerly a local const duplicated inside computeFireCards; hoisted here
// so targetDrawdownSeries can share it). Deliberately NOT
// inputs.ssStartAge — see goalBuilderSsAnnual() below for why.
const GOAL_SS_CLAIM_AGE = 62;

// inputs.socialSecurityAnnual reflects the Forecast-only "Use PIA model"
// checkbox when it's on — silently overriding whatever's typed into Goal
// Builder's own goalSsA/goalSsB fields with a number computed from
// Forecast-tab-only inputs (PIA $, claiming age) that aren't visible here.
// Goal Builder must read its OWN fields directly, always, so editing
// goalSsA/goalSsB always actually changes the number being shown.
function goalBuilderSsAnnual() {
  const isCouple = $('goalHousehold') && $('goalHousehold').value === 'couple';
  return num('goalSsA') + (isCouple ? num('goalSsB') : 0);
}

// inputs.youngestAge + inputs.yearsToRetirement bakes in the Forecast tab's
// "Shift retirement age" what-if slider (and Scenario Playground's retirement-
// age field, which sets the same underlying value behind the scenes) — that's
// correct for Forecast's OWN what-if exploration, but Goal Builder's target
// must always reflect the age you actually typed into goalRetA/goalRetB, with
// zero influence from a what-if lever that has no UI on Goal Builder at all.
// Found via a real report: shifting Forecast's retirement age moved the "Base
// FIRE & All-in FIRE breakdown" panel's numbers even though Goal Builder's own
// age fields hadn't changed. Mirrors getGoalBuilderHouseholdInputs()'s own
// age/retirement-age math, deliberately independent of buildInputs()'s output.
function goalBuilderRetirementAge() {
  const hh = getGoalBuilderHouseholdInputs();
  const yearsA = hh.retA - hh.ageA;
  const yearsB = hh.isCouple ? hh.retB - hh.ageB : Infinity;
  const yearsToRetirement = Math.max(0, Math.min(yearsA, yearsB));
  const youngestAge = yearsB < yearsA ? hh.ageB : hh.ageA;
  return youngestAge + yearsToRetirement;
}

// `f.base.drawdown.series` (from forecast()) stops early if the household's
// CURRENT account balance can't sustain the spending (simulateDrawdown
// returns as soon as balance <= 0 — correct for Forecast's runway/audit, but
// wrong for "how much do I need?" math: that target must not be contingent
// on whether today's balance already covers it (circular — a Goal Builder
// number could end up small just because your portfolio runs out fast).
// Re-runs the SAME base-scenario drawdown with an effectively infinite
// starting balance so every per-year cost line (spend/healthcare/lifecycle/
// tax — none of which actually depend on the balance value itself, only the
// final balance -= and the depletion check do) comes out identical, just
// without the early cutoff.
//
// ALSO strips every cross-tab item that isn't actually on the Goal Builder
// tab — mortgage (Debt Destroyer), income streams + government pension
// (Forecast's own lists/fields), and the accounts-based early-withdrawal
// penalty (Forecast's Accounts section) — per an explicit product decision:
// Goal Builder's target must be a pure function of what's actually entered
// on THIS tab (spend categories/phases, healthcare/ACA, SS, lifecycle), not
// a number that silently moves because of a mortgage or pension entered on
// a tab the user hasn't even looked at yet. (Those items legitimately
// belong in Forecast's own comprehensive picture — they're just not part of
// "what's my goal number," which is what this tab answers.) Used for the
// Spending Timeline chart and every FIRE-target card — NOT for anything
// that's supposed to reflect the real, balance-aware situation (Forecast's
// gap banner/runway/audit keep using the real `f.base.drawdown` untouched).
function targetDrawdownSeries(inputs, f) {
  const retirementAge = goalBuilderRetirementAge();
  // Plan through the same longevity age (95) phaseDefaults() already uses for
  // a fresh spending phase — NOT inputs.retirementYears (the Forecast tab's
  // separate "Years in retirement" field, default 30). That field is an
  // unrelated what-if slider on a different tab; silently capping the target
  // horizon to it caused exactly the kind of confusing, disconnected-field
  // bug this whole pass has been fixing elsewhere (chart/target stopping at
  // age 80 with zero explanation, while the user is still defining the goal
  // and hasn't touched anything on Forecast).
  const horizonYears = Math.max(1, Math.round(PHASE_PLANNING_AGE - retirementAge));
  return simulateDrawdown({
    startBalance: 1e15, startAge: retirementAge, annualSpend: inputs.desiredAnnualIncome,
    returnPct: f.scenarios.base.return, inflationPct: f.scenarios.base.inflation, horizonYears,
    healthcareAnnual: inputs.healthcareAnnual, incomeStreams: [], // no Forecast streams/pension — Goal Builder-only
    socialSecurityAnnual: goalBuilderSsAnnual(), ssStartAge: GOAL_SS_CLAIM_AGE, filingStatus: inputs.filingStatus,
    mortgage: null, earlyPenaltyRate: 0, penaltyExemptBalance: 0, // no Debt Destroyer/Accounts dependency
    phases: inputs.phases, medicareAnnual: inputs.medicareAnnual, persons: inputs.persons, lifecycle: inputs.lifecycle,
  }).series;
}

// Builds every FIRE-number card (Full FIRE, Full FIRE net-of-SS, All-in FIRE,
// All-in FIRE net-of-SS, Pre-65 healthcare, Medicare, Social Security) once.
// renderGoalSummary keeps only the 2 headline All-in cards; everything else is
// rendered into the Forecast tab's "How is this calculated?" expander by
// renderForecastFireBreakdown — single computation, no duplicated math.
function computeFireCards(f, inputs) {
  const phases = goalPhases();
  const totalYears = phases.reduce((s, p) => s + p.years, 0);
  const cards = [];
  const hasPhases = phases.length > 0;
  const blendedIncome = hasPhases ? Math.round(blendedDesiredIncome(phases)) : null;
  // The FIRE-number cards below must reflect what you've actually shaped in Goal
  // Builder — your spending phases — not the separate "Desired household income"
  // field, which lives on the Forecast tab and only updates when you click a Pull
  // button. Using the stale field here was the actual bug: enter a $100k/yr phase and
  // the headline FIRE numbers kept computing off an untouched $80k.
  // No "Desired income (live)" card — Goal Builder is the first step now, so its own
  // spending phases ARE the source of truth. (Removed: a separate card pointing at the
  // Forecast tab's field just reintroduced the old confusion.) liveIncome below is what
  // every FIRE-number card actually uses: phase-blended when phases exist, falling back
  // to the shared "desired" field only when Goal Builder has no phases at all.
  const liveIncome = hasPhases ? blendedIncome : inputs.desiredAnnualIncome;
  const withdrawalRate = num('withdrawalRate');
  const liveFullFire = fireNumber(liveIncome, withdrawalRate);
  cards.push(['Full FIRE', fmt$k(liveFullFire),
    hasPhases ? `based on your ${fmt$(blendedIncome)}/yr phase-blended spending` : `at ${withdrawalRate.toFixed(1)}% withdrawal — add spending phases above to refine this`,
    `FIRE number = ${hasPhases ? 'phase-blended spending' : 'desired income'} ÷ withdrawal rate (${fmt$(liveIncome)} ÷ ${withdrawalRate.toFixed(1)}%) = ${fmt$k(liveFullFire)}. The "25× rule" at a 4% rate.\n` +
    (hasPhases ? `Phase-blended = Σ(phase spend × years) ÷ Σ(years) = ${fmt$(blendedIncome)}/yr (your spending phases above).\n` : '') +
    `Deliberately portfolio-only — it does NOT subtract Social Security (see the "net of SS" card), so an early retiree's target isn't understated before SS starts.`]);
  // "Net of SS" target — Net Present Value. Social Security is a future asset, so it
  // should REDUCE today's target, never inflate it. (An earlier version added a flat,
  // un-invested "bridge bucket" of cash on top of the post-SS shortfall — that made the
  // net-of-SS number bigger than the base FIRE number, which is backwards: subtracting
  // SS should never raise your target.) Here we value the future SS stream as a
  // portfolio-equivalent lump sum, then discount it back to today using the withdrawal
  // rate as a conservative stand-in for investment growth — so money you don't need
  // until SS starts keeps compounding instead of sitting idle. This guarantees
  // netOfSS <= baseTarget always.
  const wr = withdrawalRate / 100;
  const baseTarget = liveFullFire; // = liveIncome / wr, computed once above
  // Fixed at the earliest claiming age (62), not inputs.ssStartAge — that field lives
  // on the Forecast tab (defaults to 67) and is unrelated to Goal Builder's own
  // household. This card's premise is a "claim early, worst case" estimate, so it
  // always assumes 62 regardless of what the Forecast tab's SS-start field is set to.
  const ssAge = GOAL_SS_CLAIM_AGE;
  const retAge = goalBuilderRetirementAge();
  const bridgeYears = Math.max(0, ssAge - retAge);
  // goalBuilderSsAnnual(), not inputs.socialSecurityAnnual — the latter silently
  // reflects Forecast's "Use PIA model" override when it's checked, which would
  // make editing goalSsA/goalSsB here do nothing. See goalBuilderSsAnnual().
  const ssAnnual = goalBuilderSsAnnual();
  const ssPortfolioEquivalent = ssAnnual / wr; // value of the SS stream once it starts
  const presentValueOfSS = ssPortfolioEquivalent / Math.pow(1 + wr, bridgeYears); // discounted back to retirement age
  const netOfSS = Math.max(0, baseTarget - presentValueOfSS);
  cards.push(['Full FIRE (net of SS)', fmt$k(netOfSS),
    `Reduces your ${fmt$k(baseTarget)} target by ${fmt$k(presentValueOfSS)} (Present Value of SS)`,
    `Accounts for investment growth during the ${bridgeYears.toFixed(1)}-year bridge to age ${ssAge} (assumed earliest Social Security claiming age — independent of the Forecast tab's SS-start field) — money you don't need until Social Security starts keeps compounding instead of sitting idle, so you need less today.\n` +
    `Full FIRE Target = ${hasPhases ? 'phase-blended spending' : 'desired income'} ÷ withdrawal rate (${fmt$(liveIncome)} ÷ ${withdrawalRate.toFixed(1)}%) = ${fmt$k(baseTarget)} (same live figure as the "Full FIRE" card above).\n` +
    `Portfolio equivalent of SS at age ${ssAge} = Social Security ÷ withdrawal rate (${fmt$(ssAnnual)} ÷ ${withdrawalRate.toFixed(1)}%) = ${fmt$k(ssPortfolioEquivalent)}.\n` +
    `Present value of that SS benefit today, discounted ${bridgeYears.toFixed(1)} years at ${withdrawalRate.toFixed(1)}% (the withdrawal rate, used as a conservative proxy for the real investment-growth/discount rate) = ${fmt$k(ssPortfolioEquivalent)} ÷ (1 + ${withdrawalRate.toFixed(1)}%)^${bridgeYears.toFixed(1)} = ${fmt$k(presentValueOfSS)}.\n` +
    `Net Target = Full FIRE − present value of Social Security = ${fmt$k(baseTarget)} − ${fmt$k(presentValueOfSS)} = ${fmt$k(netOfSS)}.`]);
  // All-in FIRE — the REAL number, built from a modeled drawdown of just what's
  // on THIS tab (targetDrawdownSeries) instead of a flat 25x on stated spending.
  // Bakes in the healthcare transition (ACA pre-65 → Medicare AT AGE 65, evaluated
  // against each year's real age — never assumed to start at retirement), lifecycle
  // costs (home, vehicles, kids/529, custom — netDraw's lcRecurring bucket already
  // sums all of these together, see lifecycleAnnual() in calc.js), and taxes, because
  // those are exactly what simulateDrawdown computes year by year. Deliberately
  // does NOT include mortgage/income-streams/pension/early-withdrawal-penalty —
  // those are real, but they live on OTHER tabs (Debt Destroyer/Forecast/Accounts)
  // and this number must be a pure function of what's actually on Goal Builder; see
  // targetDrawdownSeries(). Averaging RAW nominal dollars across a 30–65 year
  // horizon would badly overstate this (inflation alone roughly triples year-45
  // dollars vs year-1), so each year is converted to today's dollars FIRST,
  // independent of the page's nominal/today's-$ display toggle. Depletion-proof
  // (see targetDrawdownSeries) — the target must not shrink just because today's
  // balance runs out early.
  const series = targetDrawdownSeries(inputs, f);
  if (series.length) {
    const inflPct = f.scenarios.base.inflation;
    const startAge = goalBuilderRetirementAge();
    const totalRealSpend = series.reduce((sum, p) => {
      // netDraw is already net of SS (no income streams here — targetDrawdownSeries
      // passes none); add it back to recover the GROSS annual outlay. Do NOT add
      // p.kids529/p.custom again here — they're only broken out as separate series
      // fields for the Spending Timeline chart's stacked segments; their dollars are
      // already folded into netDraw via lcRecurring. p.penalty/p.streams are always
      // 0 here (targetDrawdownSeries zeroes the penalty rate and passes no streams)
      // but are kept in the sum for safety if that ever changes.
      const gross = p.netDraw + p.tax + p.penalty + p.streams + p.ss;
      return sum + toTodaysDollars(gross, p.age - 1 - startAge, inflPct);
    }, 0);
    const avgRealSpend = totalRealSpend / series.length;
    const compTarget = avgRealSpend / wr;
    const compTargetNetSS = Math.max(0, compTarget - presentValueOfSS);
    cards.push(['All-in FIRE', fmt$k(compTarget), `avg. all-in spend: ${fmt$(Math.round(avgRealSpend))}/yr (today's $)`,
      `Average all-in annual cost (today's $) = ${fmt$(Math.round(avgRealSpend))}/yr — base spending, healthcare, lifecycle costs, and taxes, averaged across all ${series.length} years of retirement.\n` +
      `All-in FIRE = average cost ÷ withdrawal rate (${fmt$(Math.round(avgRealSpend))} ÷ ${withdrawalRate.toFixed(1)}%) = ${fmt$k(compTarget)}.`]);
    cards.push(['All-in FIRE (net of SS)', fmt$k(compTargetNetSS), `${fmt$k(compTarget)} − ${fmt$k(presentValueOfSS)} present value of Social Security`,
      `Same All-in FIRE as above, reduced by the same Present Value of Social Security used in "Full FIRE (net of SS)" (assumes claiming at age ${ssAge}).\n` +
      `Net Target = ${fmt$k(compTarget)} − ${fmt$k(presentValueOfSS)} = ${fmt$k(compTargetNetSS)}.`]);
  }
  const aca = goalAca();
  if (aca && aca.magiOn) {
    cards.push(['Pre-65 healthcare', fmt$(aca.netPremium) + '/yr', aca.cliff ? 'above 400% FPL — no subsidy' : `after ${fmt$(aca.subsidy)} ACA subsidy`,
      `Benchmark premium ${fmt$(aca.benchmark)}/yr (household size ${num('acaHousehold')}, ZIP-region factor).\n` +
      `MAGI ${fmt$(num('acaMagi'))} = ${(aca.fplRatio * 100).toFixed(0)}% of the Federal Poverty Line.\n` +
      (aca.cliff ? 'Above 400% FPL → no subsidy (the "subsidy cliff").' : `Expected contribution ${fmt$(aca.expectedContribution)} → subsidy = benchmark − contribution = ${fmt$(aca.subsidy)}.`) +
      `\nEstimate only — no real per-ZIP benchmark data available offline.`]);
  }
  cards.push(['Medicare (65+)', fmt$(inputs.medicareAnnual * inputs.persons) + '/yr', `${inputs.persons} person${inputs.persons > 1 ? 's' : ''} × ${fmt$(inputs.medicareAnnual)}`,
    `Hard-coded estimate: $${inputs.medicareAnnual.toLocaleString()}/person/yr (Part B + Part D + Medigap) × ${inputs.persons} = ${fmt$(inputs.medicareAnnual * inputs.persons)}/yr. Auto-replaces pre-65 healthcare cost starting at age 65.`]);
  // Social Security card moved to the end — it's a supporting input, not a headline target.
  const portfolioNeeded = Math.max(0, liveIncome - ssAnnual);
  cards.push(['Social Security at retirement', fmt$(ssAnnual) + '/yr',
    ssAnnual > 0 ? `leaves ${fmt$(portfolioNeeded)}/yr for your portfolio to cover` : 'not entered yet — add it above',
    `Portfolio income still needed = ${hasPhases ? 'phase-blended spending' : 'desired income'} − Social Security (${fmt$(liveIncome)} − ${fmt$(ssAnnual)}) = ${fmt$(portfolioNeeded)}/yr.\n` +
    `Feeds the "Full FIRE (net of SS)" card above. The plain "Full FIRE" stays portfolio-only by design.`]);
  return cards;
}

function cardsToHTML(cards) {
  return cards.map(([t, v, s, calc]) => `<div class="card"><div class="ctitle">${t} ${calc ? infoTip(calc) : ''}</div><div class="cval">${v}</div><div class="csub">${s}</div></div>`).join('');
}

// #1 — Goal Builder keeps only the 2 headline All-in-FIRE cards (live-updating,
// built from the actual modeled drawdown). Everything else moves to Forecast.
function renderGoalSummary(cards) {
  const el = $('goalSummary');
  if (!el) return;
  const headline = cards.filter((c) => c[0] === 'All-in FIRE' || c[0] === 'All-in FIRE (net of SS)');
  const fallback = headline.length ? headline : cards.filter((c) => c[0] === 'Full FIRE' || c[0] === 'Full FIRE (net of SS)');
  el.innerHTML = cardsToHTML(fallback);
}

// All cards EXCEPT the 2 headline ones Goal Builder already shows.
function renderForecastFireBreakdown(f, inputs) {
  const el = $('fireBreakdown');
  if (!el || !$('goalHousehold')) return;
  const cards = computeFireCards(f, inputs);
  const rest = cards.filter((c) => c[0] !== 'All-in FIRE' && c[0] !== 'All-in FIRE (net of SS)');
  el.innerHTML = cardsToHTML(rest);
}

function renderGoalBuilder() {
  // buildInputs() already reads the Goal Builder household natively (activeTab is
  // 'goal' here), so no overrides are needed — it's the single source of truth.
  const inputs = buildInputs();
  const f = forecast(inputs);
  if (!f.base || !f.base.drawdown || !f.base.drawdown.series) return; // nothing to draw yet
  syncGoalDesiredInput();
  if ($('goalInputs')) formatMoneyInputs($('goalInputs'));
  // ACA readout
  const aca = goalAca();
  if ($('acaResult')) {
    $('acaResult').innerHTML = (aca && aca.magiOn)
      ? `Estimated pre-65 cost: <strong>${fmt$(aca.netPremium)}/yr</strong> (benchmark ${fmt$(aca.benchmark)} − subsidy ${fmt$(aca.subsidy)}). ${aca.cliff ? '⚠️ Above 400% FPL — no subsidy (the cliff).' : `At ${(aca.fplRatio * 100).toFixed(0)}% of the federal poverty line.`} <span class="csub">Estimate only — feeds your pre-65 healthcare cost.</span>`
      : `Enter a MAGI to estimate ACA subsidies; otherwise the "Pre-65 health insurance" field on the Forecast tab is used.`;
  }
  renderGoalTimeline(f, inputs);
  renderGoalSummary(computeFireCards(f, inputs));
  // Skip the category list's full rebuild while the user is actively
  // interacting with one of its controls. This function runs on every single
  // 'input' tick (the document-level listener calls recompute()+
  // refreshActiveTab() per keystroke AND per slider-drag tick) — innerHTML-
  // rebuilding the container mid-drag destroys the very <input type="range">
  // the browser has mouse-capture on, which silently kills the drag after the
  // first pixel of movement. The container's own 'change' listener (below)
  // does the full rebuild once the drag/typing actually finishes.
  const catContainer = $('spendCategoriesContainer');
  const interacting = catContainer && document.activeElement && catContainer.contains(document.activeElement);
  if (!interacting) renderSpendCategories();
}

// ======================================================================
// v2: Scenario Playground — event library + baseline vs impacted chart
// ======================================================================
let scenarioEvents = [];
let _evId = 0;
const EVENT_DEFAULTS = {
  correction: { dropPct: 30 },
  oneTime: { kind: 'expense', amount: 50000 },
  incomeShift: { newSalary: 50000 },
  geo: { multiplier: 0.7 },
};
function makeEvent(o = {}) {
  const y = new Date().getFullYear();
  return {
    id: o.id || `ev_${Date.now().toString(36)}_${_evId++}`,
    type: o.type || 'oneTime',
    year: o.year || (y + 5),
    endYear: o.endYear || (y + 10),
    dropPct: o.dropPct != null ? o.dropPct : 30,
    recoveryDuration: o.recoveryDuration != null ? o.recoveryDuration : 3,
    recoveryBoost: o.recoveryBoost != null ? o.recoveryBoost : 3,
    kind: o.kind || 'expense',
    amount: o.amount != null ? o.amount : 50000,
    newSalary: o.newSalary != null ? o.newSalary : 50000,
    multiplier: o.multiplier != null ? o.multiplier : 0.7,
  };
}
const EVENT_TITLES = { correction: '📉 Market correction', oneTime: '💸 Expense / windfall', incomeShift: '💼 Additional investment', geo: '✈️ Geo-arbitrage' };
const EVENT_HINTS = {
  correction: 'Market crash reduces portfolio, then recovery boost adds extra return for X years to model market rebound',
  oneTime: 'One-time deduction (expense) or addition (windfall) to portfolio',
  incomeShift: 'Additional annual amount available to invest for retirement',
  geo: 'Annual spending reduced by multiplier (e.g., 0.7 = 30% cheaper)'
};
function eventRowHTML(e) {
  const y = new Date().getFullYear();
  const yr = (f, val, label) => `<label>${label}<input class="ev-f" data-id="${e.id}" data-f="${f}" type="number" min="${y}" max="${y + 70}" value="${val}"></label>`;
  let fields = '';
  if (e.type === 'correction') {
    const recoveryDurationTip = 'Number of years after the crash during which the recovery boost is applied. E.g., 3 years means boosted returns for ages X+1 to X+3.';
    const recoveryBoostTip = 'Extra annual return % applied during recovery window. E.g., +3% means portfolio grows at base return + 3% per year during recovery.';
    fields = yr('year', e.year, 'Year') +
      `<label>% drop<input class="ev-f" data-id="${e.id}" data-f="dropPct" type="number" min="0" max="100" value="${e.dropPct}"></label>` +
      `<div style="width: 100%; display: flex; gap: 10px; flex-wrap: wrap;">` +
        `<label style="flex: 1 1 140px;">Recovery duration (yrs) ${infoTip(recoveryDurationTip)}<input class="ev-f" data-id="${e.id}" data-f="recoveryDuration" type="number" min="0" max="10" value="${e.recoveryDuration}"></label>` +
        `<label style="flex: 1 1 140px;">Recovery boost (%/yr) ${infoTip(recoveryBoostTip)}<input class="ev-f" data-id="${e.id}" data-f="recoveryBoost" type="number" min="0" max="10" step="0.5" value="${e.recoveryBoost}"></label>` +
      `</div>`;
  } else if (e.type === 'oneTime') {
    fields = yr('year', e.year, 'Year') +
      `<label>Kind<select class="ev-f" data-id="${e.id}" data-f="kind"><option value="expense"${e.kind === 'expense' ? ' selected' : ''}>Expense</option><option value="windfall"${e.kind === 'windfall' ? ' selected' : ''}>Windfall</option></select></label>` +
      `<label>Amount $<input class="ev-f" data-id="${e.id}" data-f="amount" type="number" min="0" step="1000" value="${e.amount}" data-money></label>`;
  } else if (e.type === 'incomeShift') {
    fields = yr('year', e.year, 'Start year') + yr('endYear', e.endYear, 'End year') +
      `<label>Additional annual amount $<input class="ev-f" data-id="${e.id}" data-f="newSalary" type="number" min="0" step="1000" value="${e.newSalary}" data-money></label>`;
  } else {
    fields = yr('year', e.year, 'Move year') +
      `<label>Multiplier<input class="ev-f" data-id="${e.id}" data-f="multiplier" type="number" min="0.1" max="3" step="0.05" value="${e.multiplier}"></label>`;
  }
  return `<div class="event-row" data-id="${e.id}">
    <div class="ev-head"><span class="ev-type">${EVENT_TITLES[e.type]}</span><button type="button" class="x remove-event-btn" data-id="${e.id}" title="Remove">×</button></div>
    <div class="ev-hint">${EVENT_HINTS[e.type]}</div>
    <div class="ev-fields">${fields}</div>
  </div>`;
}
function renderEvents() {
  const c = $('eventsContainer');
  if (!c) return;
  c.innerHTML = scenarioEvents.map(eventRowHTML).join('');
  if ($('eventsEmpty')) $('eventsEmpty').classList.toggle('hidden', scenarioEvents.length > 0);
}
function eventById(id) { return scenarioEvents.find((e) => e.id === id); }
// Convert UI events (calendar-year based) to the engine's age-based shape.
function eventsForEngine(youngestAge) {
  const ageOf = (yr) => youngestAge + ((yr || CURRENT_YEAR) - CURRENT_YEAR);
  return scenarioEvents.map((e) => {
    if (e.type === 'correction') return { type: 'correction', age: ageOf(e.year), dropPct: (e.dropPct || 0) / 100 };
    if (e.type === 'oneTime') return { type: 'oneTime', age: ageOf(e.year), amount: (e.kind === 'windfall' ? -1 : 1) * (e.amount || 0) };
    if (e.type === 'geo') return { type: 'geo', age: ageOf(e.year), multiplier: e.multiplier || 1 };
    return { type: 'incomeShift', startAge: ageOf(e.year), endAge: ageOf(e.endYear), newSalary: e.newSalary || 0 };
  });
}
function onEventsChanged() { renderEvents(); renderScenarioPlayground(); recompute(); saveState(); }
function addEvent(type) { scenarioEvents.push(makeEvent(Object.assign({ type }, EVENT_DEFAULTS[type]))); onEventsChanged(); }
function removeEvent(id) { scenarioEvents = scenarioEvents.filter((e) => e.id !== id); onEventsChanged(); }
function wireEvents() {
  const c = $('eventsContainer');
  if (!c) return;
  const apply = (t) => {
    const e = eventById(t.dataset.id); if (!e) return false;
    const f = t.dataset.f;
    e[f] = (f === 'kind') ? t.value : (parseFloat(t.value) || 0);
    return true;
  };
  c.addEventListener('input', (e) => { if (e.target.classList.contains('ev-f') && apply(e.target)) { renderScenarioPlayground(); saveState(); e.stopPropagation(); } });
  c.addEventListener('change', (e) => { if (e.target.classList.contains('ev-f') && apply(e.target)) { renderScenarioPlayground(); saveState(); e.stopPropagation(); } });
  c.addEventListener('click', (e) => { if (e.target.classList.contains('remove-event-btn')) removeEvent(e.target.dataset.id); });
}
function initEvents(saved) {
  if (Array.isArray(saved)) scenarioEvents = saved.map(makeEvent);
  renderEvents();
}

// Two-line chart: baseline (dashed grey) vs impacted (solid accent, on top).
// Label + color per event type, for the chart markers and (later) any list UI.
const EVENT_MARKER = {
  correction: (e) => ({ label: `Correction (−${e.dropPct}%)`, color: '#e0436b' }),
  oneTime: (e) => ({ label: e.kind === 'windfall' ? 'Windfall' : 'Expense', color: e.kind === 'windfall' ? '#1f9d6b' : '#e0436b' }),
  geo: (e) => ({ label: 'Move', color: '#0891b2' }),
  incomeShift: (e) => ({ label: 'Income shift', color: '#d97706' }),
};

function renderScenarioChart(baseSeries, impSeries, inputs, events) {
  const el = $('scenarioChart');
  if (!el) return;
  const inflPct = inputs.baseInflation;
  const baseD = deflateSeries(baseSeries, inflPct);
  const impD = deflateSeries(impSeries, inflPct);
  if (!baseD.length) { el.innerHTML = ''; return; }
  const W = 800, H = 340, ML = 60, MR = 16, MT = 16, MB = 30;
  const plotW = W - ML - MR, plotH = H - MT - MB;
  const allAges = baseD.concat(impD);
  const xMin = Math.min(...allAges.map((p) => p.age)), xMax = Math.max(...allAges.map((p) => p.age));
  const yMax = Math.max(1, ...allAges.map((p) => p.balance)) * 1.05;
  const xspan = Math.max(1e-9, xMax - xMin);
  const X = (age) => ML + ((age - xMin) / xspan) * plotW;
  const Y = (bal) => MT + (1 - Math.max(0, bal) / yMax) * plotH;
  const path = (pts) => pts.map((p, i) => `${i ? 'L' : 'M'}${X(p.age).toFixed(1)},${Y(p.balance).toFixed(1)}`).join(' ');
  let grid = '', yticks = '';
  for (let i = 0; i <= 4; i++) {
    const val = (yMax / 4) * i, yy = Y(val);
    grid += `<line class="chart-grid" x1="${ML}" y1="${yy.toFixed(1)}" x2="${W - MR}" y2="${yy.toFixed(1)}"/>`;
    yticks += `<text class="chart-tick" x="${ML - 6}" y="${(yy + 3).toFixed(1)}" text-anchor="end">${fmt$k(val)}</text>`;
  }
  let xticks = '';
  const step = Math.max(1, Math.round((xMax - xMin) / 6 / 5) * 5);
  for (let age = Math.ceil(xMin); age <= xMax; age += step) xticks += `<text class="chart-tick" x="${X(age).toFixed(1)}" y="${H - 8}" text-anchor="middle">${age}</text>`;

  // Add scenario event markers
  let eventMarkers = '';
  const engineEvents = eventsForEngine(inputs.youngestAge);
  for (const ev of engineEvents) {
    const evAge = Math.round(ev.age);
    if (evAge >= xMin && evAge <= xMax) {
      const xx = X(evAge);
      const eventIcon = ev.type === 'correction' ? '📉' : ev.type === 'oneTime' ? '💸' : ev.type === 'geo' ? '✈️' : '💼';
      eventMarkers += `<circle cx="${xx.toFixed(1)}" cy="${(MT + plotH + 15).toFixed(1)}" r="5" fill="var(--warn)" opacity="0.6" class="event-marker" data-age="${evAge}" data-type="${ev.type}"/>`;
    }
  }

  // Baseline first (dashed grey), impacted on top (solid accent).
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Baseline vs impacted plan">
    ${grid}
    <line class="chart-axis" x1="${ML}" y1="${MT}" x2="${ML}" y2="${MT + plotH}"/>
    <line class="chart-axis" x1="${ML}" y1="${MT + plotH}" x2="${W - MR}" y2="${MT + plotH}"/>
    <path d="${path(baseD)}" fill="none" stroke="var(--muted)" stroke-width="2" stroke-dasharray="6 4"/>
    <path d="${path(impD)}" fill="none" stroke="var(--accent)" stroke-width="3.5"/>
    ${eventMarkers}
    ${yticks}${xticks}
  </svg>`;

  // Add tooltip on hover
  el.addEventListener('mousemove', (e) => {
    const rect = el.getBoundingClientRect();
    const svgX = (e.clientX - rect.left) / rect.width * W;
    const hoveredAge = Math.round(xMin + ((svgX - ML) / plotW) * xspan);

    const basePt = baseD.find(p => Math.round(p.age) === hoveredAge);
    const impPt = impD.find(p => Math.round(p.age) === hoveredAge);

    if (basePt && impPt) {
      // Find events at this age
      const eventsAtAge = engineEvents.filter(ev => Math.round(ev.age) === hoveredAge);
      let eventText = '';
      if (eventsAtAge.length > 0) {
        eventText = '<div style="margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--border);">';
        for (const ev of eventsAtAge) {
          if (ev.type === 'correction') {
            eventText += `<div><strong>Market Correction:</strong> −${(ev.dropPct * 100).toFixed(0)}% portfolio</div>`;
            if (ev.recoveryDuration && ev.recoveryDuration > 0) {
              eventText += `<div style="font-size: 11px; color: var(--muted);">Recovery: +${(ev.recoveryBoost || 0).toFixed(1)}% for ${ev.recoveryDuration} yrs</div>`;
            }
          } else if (ev.type === 'oneTime') {
            eventText += `<div><strong>${ev.amount > 0 ? 'Expense' : 'Windfall'}:</strong> ${fmt$(Math.abs(ev.amount))}</div>`;
          } else if (ev.type === 'incomeShift') {
            eventText += `<div><strong>Additional Investment:</strong> ${fmt$(ev.newSalary)}/yr</div>`;
          } else if (ev.type === 'geo') {
            eventText += `<div><strong>Geo-arbitrage:</strong> ${(ev.multiplier * 100).toFixed(0)}% spending</div>`;
          }
        }
        eventText += '</div>';
      }

      el.title = `Age ${hoveredAge}\nBaseline: ${fmt$k(basePt.balance)}\nImpacted: ${fmt$k(impPt.balance)}${eventText ? '\n---\n' + eventsAtAge.map(e => e.type).join(', ') : ''}`;
    }
  });

  $('scenarioChartLegend').innerHTML =
    `<span class="lg"><span class="swatch" style="background:var(--muted)"></span>Baseline plan</span>` +
    `<span class="lg"><span class="swatch" style="background:var(--accent)"></span>Impacted plan</span>`;
}

function renderScenarioSummary(baseline, impacted, inputs) {
  const el = $('scenarioSummary');
  if (!el) return;
  const endBal = (r) => r.series.length ? r.series[r.series.length - 1].balance : 0;
  const bEnd = endBal(baseline), iEnd = endBal(impacted);
  const delta = iEnd - bEnd;
  const fmtRunway = (r) => (r.depletionAge == null ? 'never depletes' : `depletes ~age ${Math.round(r.depletionAge)}`);
  const horizonYears = inputs.retirementYears > 0 ? inputs.retirementYears : 60;
  const lastAge = baseline.series.length ? baseline.series[baseline.series.length - 1].age : null;
  const baseCalc = `Starting balance ${fmt$k(inputs.householdBalance)} + ${fmt$(inputs.householdAnnual)}/yr contributions, compounded monthly at ${num('returnRate').toFixed(1)}% for ${inputs.yearsToRetirement} yrs to retirement (age ${baseline.retirementAge}).\n` +
    `Then drawn down for ${horizonYears} yrs (to age ${lastAge}) at ${fmt$(inputs.desiredAnnualIncome)}/yr spend, with NO events applied.\n` +
    `This is NOMINAL (future) dollars unless you toggle "Today's Dollars" — large multi-decade numbers are expected.`;
  const impCalc = `Same projection as Baseline, but with all ${scenarioEvents.length} event(s) applied (corrections, windfalls/expenses, income shifts, geo-arbitrage) at the ages you set them.`;
  const deltaCalc = `Net impact = impacted ending balance − baseline ending balance (${fmt$k(iEnd)} − ${fmt$k(bEnd)}).`;
  el.innerHTML = [
    ['Baseline ending balance', fmt$k(bEnd), fmtRunway(baseline), baseCalc],
    ['Impacted ending balance', fmt$k(iEnd), fmtRunway(impacted), impCalc],
    ['Net impact', (delta >= 0 ? '+' : '−') + fmt$k(Math.abs(delta)), scenarioEvents.length ? `${scenarioEvents.length} event${scenarioEvents.length > 1 ? 's' : ''} applied` : 'no events yet', deltaCalc],
  ].map(([t, v, s, calc]) => `<div class="card"><div class="ctitle">${t} ${infoTip(calc)}</div><div class="cval">${v}</div><div class="csub">${s}</div></div>`).join('');
}

function renderScenarioPlayground() {
  if (!$('scenarioChart')) return;
  const base = buildInputs();
  // Apply the scenario-local retirement-age what-if to a COPY only. Both
  // forecast() and forecastWithEvents() derive retirement age purely from
  // youngestAge + yearsToRetirement, so overriding yearsToRetirement here
  // reproduces exactly what the old #ageShift did — without leaking to any
  // other tab. (baristaPartTimeIncome is 0 app-wide, so no stream window
  // depends on the old shifted age.)
  const retAge = scenarioEffectiveRetirementAge();
  const inputs = Object.assign({}, base, {
    yearsToRetirement: Math.max(0, retAge - base.youngestAge),
  });
  const engineEvents = eventsForEngine(inputs.youngestAge);
  const baseline = forecastWithEvents(inputs, []);
  const impacted = forecastWithEvents(inputs, engineEvents);
  renderScenarioChart(baseline.series, impacted.series, inputs);
  renderScenarioSummary(baseline, impacted, inputs);
}

// --- Debt Destroyer (mortgage / loan payoff) ---------------------------
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

// One-time lump sums ride alongside the DOM debt fields (like income streams):
// kept in a JS array, persisted under __debtLumps, never as id'd inputs.
let debtLumpSums = [];
let _lumpId = 0;
function makeLump(o = {}) {
  return { id: o.id || `lump_${Date.now().toString(36)}_${_lumpId++}`,
    amount: o.amount || 10000, date: o.date || '' };
}
// Convert a UI lump ({amount, date:"YYYY-MM"}) to the engine shape ({amount, year, month}).
function parseLump(l) {
  if (!l || !l.date || !(l.amount > 0)) return null;
  const [y, m] = l.date.split('-').map(Number);
  if (!y || !m) return null;
  return { amount: l.amount, year: y, month: m };
}

// Whole months from this calendar month to a "YYYY-MM" maturity date.
// Returns null if absent, malformed, or in the past.
function monthsUntil(dateStr) {
  if (!dateStr) return null;
  const [y, m] = dateStr.split('-').map(Number);
  if (!y || !m) return null;
  const now = new Date();
  const months = (y - now.getFullYear()) * 12 + (m - (now.getMonth() + 1));
  return months > 0 ? months : null;
}
function monthLabel(dateStr) {
  const [y, m] = dateStr.split('-').map(Number);
  return (m >= 1 && m <= 12) ? `${MONTH_NAMES[m - 1]} ${y}` : dateStr;
}

// Maturity date = Month + Year dropdowns (friendlier than the native month picker),
// backed by the hidden #debtMaturity field that holds the canonical "YYYY-MM" value
// — so monthsUntil/debtFieldInputs/persistence all stay unchanged.
function populateDebtMaturityYears() {
  const ysel = $('debtMaturityYear');
  if (!ysel || ysel.options.length > 1) return; // already filled
  const y0 = new Date().getFullYear();
  for (let y = y0; y <= y0 + 40; y++) {
    const o = document.createElement('option');
    o.value = String(y); o.textContent = String(y);
    ysel.appendChild(o);
  }
}
function updateDebtMaturityFromSelects() {
  const m = $('debtMaturityMonth') && $('debtMaturityMonth').value;
  const y = $('debtMaturityYear') && $('debtMaturityYear').value;
  if ($('debtMaturity')) $('debtMaturity').value = (m && y) ? `${y}-${String(m).padStart(2, '0')}` : '';
}
function syncDebtMaturitySelects() {
  populateDebtMaturityYears();
  const m = $('debtMaturityMonth'), y = $('debtMaturityYear');
  if (!m || !y) return;
  const v = ($('debtMaturity') && $('debtMaturity').value) || '';
  if (/^\d{4}-\d{1,2}$/.test(v)) {
    const [yy, mm] = v.split('-');
    y.value = String(Number(yy)); m.value = String(Number(mm));
  } else { y.value = ''; m.value = ''; }
}

// Read the debt inputs. If no monthly payment is entered, fall back to the
// standard fully-amortizing payment for the balance/rate/term so the tool is
// useful immediately.
function debtFieldInputs() {
  const balance = num('debtBalance');
  const annualRatePct = num('debtRate');
  // A maturity date (if the user doesn't know the remaining term) derives the
  // term and takes precedence over the term-years field.
  const maturityVal = $('debtMaturity').value;
  const maturityMonths = monthsUntil(maturityVal);
  const usingMaturity = maturityMonths != null;
  const termMonths = usingMaturity ? maturityMonths : Math.round(num('debtTerm') * 12);
  const enteredPayment = num('debtPayment');
  const effectivePayment = enteredPayment > 0 ? enteredPayment : standardPayment(balance, annualRatePct, termMonths);
  const extraMonthly = num('debtExtra');
  const lumpSums = debtLumpSums.map(parseLump).filter(Boolean);
  return { balance, annualRatePct, termMonths, usingMaturity, maturityVal, enteredPayment, effectivePayment, extraMonthly, lumpSums };
}

// Run both the accelerated (extra principal + lump sums) and the baseline
// (payment only) amortizations. `active` is false when there's nothing to model.
function computeDebt() {
  const d = debtFieldInputs();
  if (!(d.balance > 0) || !(d.effectivePayment > 0)) return { d, active: false };
  const accel = calculateMortgage({
    balance: d.balance, annualRatePct: d.annualRatePct, monthlyPayment: d.effectivePayment,
    extraMonthly: d.extraMonthly, lumpSums: d.lumpSums,
  });
  const baseline = calculateMortgage({
    balance: d.balance, annualRatePct: d.annualRatePct, monthlyPayment: d.effectivePayment,
  });
  return { d, active: true, accel, baseline };
}

function lumpRowHTML(l) {
  return `<div class="stream-row lump-row" data-lid="${l.id}">
    <input class="lump-amt" type="number" min="0" step="1000" data-lid="${l.id}" value="${l.amount}" aria-label="Amount ($)" title="Amount ($)">
    <input class="lump-date" type="month" data-lid="${l.id}" value="${l.date}" aria-label="Date" title="Date applied">
    <button type="button" class="x remove-lump-btn" data-lid="${l.id}" title="Remove">×</button>
  </div>`;
}
function renderLumps() {
  const c = $('lumpsContainer');
  c.innerHTML = debtLumpSums.length
    ? `<div class="stream-row stream-head lump-row"><span>Amount</span><span>Date</span><span></span></div>` +
      debtLumpSums.map(lumpRowHTML).join('')
    : `<div class="streams-empty">No lump sums yet — add a bonus, tax refund, or windfall to model a one-time extra payment.</div>`;
}

// Two-line payoff chart: standard (muted, dashed) vs accelerated (accent).
function renderDebtChart(stdSchedule, accSchedule) {
  const W = 760, H = 300, ML = 64, MR = 16, MT = 14, MB = 28;
  const plotW = W - ML - MR, plotH = H - MT - MB;
  const maxMonths = Math.max(stdSchedule.length, accSchedule.length) - 1;
  const yMax = Math.max(stdSchedule[0].balance, 1) * 1.02;
  const X = (mi) => ML + (mi / Math.max(1, maxMonths)) * plotW;
  const Y = (b) => MT + (1 - b / yMax) * plotH;
  const path = (s) => s.map((p, i) => `${i ? 'L' : 'M'}${X(p.monthIndex).toFixed(1)},${Y(p.balance).toFixed(1)}`).join(' ');

  let grid = '', yticks = '';
  for (let i = 0; i <= 4; i++) {
    const val = (yMax / 4) * i, yy = Y(val);
    grid += `<line class="chart-grid" x1="${ML}" y1="${yy.toFixed(1)}" x2="${W - MR}" y2="${yy.toFixed(1)}"/>`;
    yticks += `<text class="chart-tick" x="${ML - 6}" y="${(yy + 3).toFixed(1)}" text-anchor="end">${fmt$k(val)}</text>`;
  }
  let xticks = '';
  const maxYears = maxMonths / 12;
  const stepY = Math.max(1, Math.round(maxYears / 6));
  for (let yr = 0; yr <= maxYears + 0.001; yr += stepY) {
    xticks += `<text class="chart-tick" x="${X(yr * 12).toFixed(1)}" y="${H - 8}" text-anchor="middle">${yr}y</text>`;
  }

  $('debtChart').innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Loan balance over time: standard vs accelerated payoff">
    ${grid}
    <line class="chart-axis" x1="${ML}" y1="${MT}" x2="${ML}" y2="${MT + plotH}"/>
    <line class="chart-axis" x1="${ML}" y1="${MT + plotH}" x2="${W - MR}" y2="${MT + plotH}"/>
    <path class="debt-line-std" d="${path(stdSchedule)}"/>
    <path class="debt-line-acc" d="${path(accSchedule)}"/>
    ${yticks}${xticks}
  </svg>`;
  $('debtChartLegend').innerHTML = [
    `<span class="lg"><span class="swatch" style="background:var(--accent)"></span>Accelerated payoff</span>`,
    `<span class="lg"><span class="swatch" style="background:var(--muted)"></span>Standard payoff</span>`,
  ].join('');
}

// The hero payoff card + secondary stats + chart. Re-rendered on every input
// change (but NOT the lump table — that would steal focus mid-type).
function renderDebtDestroyer() {
  const { d, active, accel, baseline } = computeDebt();
  const hero = $('debtHero'), stats = $('debtStats');

  // Maturity-date note: confirm the derived remaining term and that it overrides
  // the term field.
  $('debtTermNote').innerHTML = d.usingMaturity
    ? `Maturity ${monthLabel(d.maturityVal)} → about <strong>${(d.termMonths / 12).toFixed(1)} years</strong> remaining (overrides the term field).`
    : '';

  // Computed-payment hint when the user hasn't entered their own payment.
  $('debtPayHint').innerHTML = (d.balance > 0 && d.enteredPayment <= 0 && d.effectivePayment > 0)
    ? `Using a computed fully-amortizing payment of <strong>${fmt$(d.effectivePayment)}/mo</strong> over ${(d.termMonths / 12).toFixed(1)} years. Enter your own above to override.`
    : '';

  if (!active) {
    hero.innerHTML = `<div class="debt-hero-label">Estimated Payoff Date</div>
      <div class="debt-hero-date">—</div>
      <div class="debt-hero-sub">${d.balance > 0
        ? 'Enter a monthly payment (or a term so we can compute one) to see your payoff date.'
        : 'Enter your current loan balance to get started.'}</div>`;
    stats.innerHTML = '';
    $('debtChart').innerHTML = '';
    $('debtChartLegend').innerHTML = '';
    return;
  }

  const paidOff = accel.finalBalance <= 0;
  const dateStr = paidOff ? `${MONTH_NAMES[accel.payoffMonth - 1]} ${accel.payoffYear}` : 'Beyond term';
  const monthsSaved = Math.max(0, baseline.months - accel.months);
  const interestSaved = Math.max(0, baseline.totalInterest - accel.totalInterest);
  const accelerated = accel.months < baseline.months;

  let heroSub;
  if (!paidOff) {
    heroSub = `Your payment doesn't cover the interest at this balance and rate — increase the monthly payment to make progress.`;
  } else if (accelerated) {
    const ys = Math.floor(monthsSaved / 12), ms = monthsSaved % 12;
    const timeStr = [ys ? `${ys} yr${ys === 1 ? '' : 's'}` : '', ms ? `${ms} mo` : ''].filter(Boolean).join(' ') || 'no time';
    heroSub = `<strong>${timeStr} sooner</strong> than the ${MONTH_NAMES[baseline.payoffMonth - 1]} ${baseline.payoffYear} standard payoff — saving <strong>${fmt$(interestSaved)}</strong> in interest.`;
  } else {
    heroSub = `On schedule with your current payment. Add extra principal or a lump sum to pay off sooner.`;
  }

  hero.innerHTML = `<div class="debt-hero-label">Estimated Payoff Date</div>
    <div class="debt-hero-date">${dateStr}</div>
    <div class="debt-hero-sub">${heroSub}</div>`;

  stats.innerHTML = `
    <div class="card">
      <div class="ctitle">Total interest saved</div>
      <div class="cval" style="color:var(--good)">${fmt$(interestSaved)}</div>
      <div class="csub">${accelerated ? `${(monthsSaved / 12).toFixed(1)} yrs off the schedule` : 'No acceleration yet'}</div>
    </div>
    <div class="card">
      <div class="ctitle">Total interest paid</div>
      <div class="cval">${fmt$(accel.totalInterest)}</div>
      <div class="csub">vs ${fmt$(baseline.totalInterest)} on the standard schedule</div>
    </div>`;

  renderDebtChart(baseline.schedule, accel.schedule);
}

function lumpById(id) { return debtLumpSums.find((l) => l.id === id); }
function onLumpsChanged() { renderLumps(); renderDebtDestroyer(); recompute(); saveState(); }
function addLump() { debtLumpSums.push(makeLump()); onLumpsChanged(); }
function removeLump(id) { debtLumpSums = debtLumpSums.filter((l) => l.id !== id); onLumpsChanged(); }
function wireLumps() {
  const c = $('lumpsContainer');
  c.addEventListener('input', (e) => {
    const l = lumpById(e.target.dataset.lid); if (!l) return;
    const t = e.target;
    if (t.classList.contains('lump-amt')) l.amount = parseFloat(t.value) || 0;
    else if (t.classList.contains('lump-date')) l.date = t.value;
    else return;
    renderDebtDestroyer(); recompute(); saveState(); // update results, not the lump table (keeps focus)
    e.stopPropagation();
  });
  c.addEventListener('click', (e) => {
    if (e.target.classList.contains('remove-lump-btn')) removeLump(e.target.dataset.lid);
  });
}
function initLumps(saved) {
  if (Array.isArray(saved)) debtLumpSums = saved.map(makeLump);
  renderLumps();
}

// --- Persistence (localStorage) ----------------------------------------

const STORAGE_KEY = 'retirementCalc.v1';

// Every input/select with an id is part of the saved state, except UI-only
// controls flagged data-nostate (scenario picker, file input).
function stateFields() {
  return [...document.querySelectorAll('input[id]:not([data-nostate]), select[id]:not([data-nostate])')];
}

// The HTML default value of each field — used by Reset (no page reload).
function defaultState() {
  const data = {};
  stateFields().forEach((el) => {
    if (el.tagName === 'SELECT') {
      const def = [...el.options].find((o) => o.defaultSelected) || el.options[0];
      data[el.id] = def ? def.value : '';
    } else if (el.type === 'checkbox') {
      data[el.id] = el.defaultChecked;
    } else {
      data[el.id] = el.defaultValue;
    }
  });
  return data;
}

// Collect / apply the full field state as a plain object. The structured
// accounts ride along under __accounts (they aren't DOM fields).
function collectState() {
  const data = {};
  stateFields().forEach((el) => { data[el.id] = el.type === 'checkbox' ? el.checked : el.value; });
  // Deep-copy so snapshots (undo) don't alias the live account/stream objects.
  data.__accounts = JSON.parse(JSON.stringify(accountGroups));
  data.__streams = JSON.parse(JSON.stringify(incomeStreams));
  data.__debtLumps = JSON.parse(JSON.stringify(debtLumpSums));
  data.__events = JSON.parse(JSON.stringify(scenarioEvents));
  data.__goalPhases = JSON.parse(JSON.stringify(spendingPhases));
  data.__vehicles = JSON.parse(JSON.stringify(vehicleItems));
  data.__support = JSON.parse(JSON.stringify(supportItems));
  data.__kids529 = JSON.parse(JSON.stringify(kids529Items));
  data.__customExpenses = JSON.parse(JSON.stringify(customExpenseItems));
  data.__spendCategories = JSON.parse(JSON.stringify(spendCategories));
  data.__spendCategoryEdited = JSON.parse(JSON.stringify(spendCategoryEdited));
  data.__activeSpendTier = activeSpendTier;
  data.__scenarioRetAge = scenarioRetirementAge;
  return data;
}
function applyState(data) {
  if (!data) return false;
  stateFields().forEach((el) => {
    if (data[el.id] == null) return;
    if (el.type === 'checkbox') el.checked = !!data[el.id];
    else el.value = data[el.id];
  });
  if (Array.isArray(data.__accounts)) {
    accountGroups = data.__accounts.map(makeGroup);
  } else {
    // Older blob (scenario/import/share) without structured accounts:
    // migrate from the applied bal/con so the cards match.
    accountGroups = [migrateLegacy(num('bal'), num('con'), { name: 'Retirement savings' })];
  }
  incomeStreams = Array.isArray(data.__streams) ? data.__streams.map(makeStream) : [];
  debtLumpSums = Array.isArray(data.__debtLumps) ? data.__debtLumps.map(makeLump) : [];
  scenarioEvents = Array.isArray(data.__events) ? data.__events.map(makeEvent) : [];
  // Older blobs predate the dynamic phases list (key absent) — fall back to the
  // single-phase default initPhases() seeds on a fresh load. An array that's
  // present-but-empty means the user deliberately cleared their phases, which
  // undo/restore must honor exactly, not silently re-seed. The untouched OLD
  // three-phase default is migrated to the new single default (see initPhases).
  const savedPhases = isLegacyDefaultPhases(data.__goalPhases) ? null : data.__goalPhases;
  spendingPhases = Array.isArray(savedPhases)
    ? savedPhases.map(makePhase) : phaseDefaults().map(makePhase);
  vehicleItems = Array.isArray(data.__vehicles) ? data.__vehicles.map(makeVehicle) : [];
  supportItems = Array.isArray(data.__support) ? data.__support.map(makeSupport) : [];
  kids529Items = Array.isArray(data.__kids529) ? data.__kids529.map(makeKid529) : [];
  customExpenseItems = Array.isArray(data.__customExpenses) ? data.__customExpenses.map(makeCustomExpense) : [];
  spendCategories = data.__spendCategories ? Object.assign({}, SPEND_BASE_CATEGORIES, data.__spendCategories) : Object.assign({}, SPEND_BASE_CATEGORIES);
  spendCategoryEdited = data.__spendCategoryEdited ? Object.assign({ housing: false, food: false, transportation: false, travel: false, other: false }, data.__spendCategoryEdited) : { housing: false, food: false, transportation: false, travel: false, other: false };
  activeSpendTier = data.__activeSpendTier !== undefined ? data.__activeSpendTier : 'base';
  scenarioRetirementAge = (data.__scenarioRetAge != null) ? data.__scenarioRetAge : null;
  renderAccounts();
  renderStreams();
  renderLumps();
  renderEvents();
  renderPhases();
  renderVehicles();
  renderSupport();
  renderKids529();
  renderCustomExpenses();
  syncLegacyFields();
  syncDebtMaturitySelects(); // reflect the applied "YYYY-MM" in the Month/Year dropdowns
  syncScenarioRetirementAgeField(); // reflect the restored scenario what-if age
  return true;
}

let saveTimer = null;
function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(collectState()));
    flashStatus('Saved ✓');
  } catch (e) { /* storage unavailable (private mode, quota) — fail silently */ }
}

function loadState() {
  let data;
  try { data = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); }
  catch (e) { data = null; }
  return applyState(data);
}

function flashStatus(msg) {
  const el = $('saveStatus');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => el.classList.remove('show'), 1600);
}

// --- Undo (one-step) for destructive replacements ----------------------
// Any action that wholesale-replaces the working inputs first snapshots the
// current state here, so the user can revert a mistaken Reset/Import/Load.
let undoSnapshot = null;
let undoTimer = null;

function snapshotForUndo(actionLabel) {
  undoSnapshot = collectState();
  const btn = $('undoBtn');
  btn.textContent = `Undo ${actionLabel}`;
  btn.classList.remove('hidden');
  clearTimeout(undoTimer);
  undoTimer = setTimeout(hideUndo, 12000); // offer the undo for 12s
}
function hideUndo() {
  $('undoBtn').classList.add('hidden');
  clearTimeout(undoTimer);
}
function performUndo() {
  if (!undoSnapshot) return;
  applyState(undoSnapshot);
  undoSnapshot = null;
  hideUndo();
  afterStateChange();
  flashStatus('Reverted ✓');
}

function resetDefaults() {
  snapshotForUndo('reset');
  applyState(defaultState());
  accountGroups = [migrateLegacy(num('bal'), num('con'), { name: 'Retirement savings' })];
  renderAccounts();
  history.replaceState(null, '', location.pathname); // drop any ?s= share param
  afterStateChange();
  $('scenarioSelect').value = '';
  flashStatus('Reset to defaults — Undo to revert');
}

// --- Option A: portable saving (export / import / share URL) -----------

function exportJSON() {
  const blob = new Blob([JSON.stringify(collectState(), null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'retirement-scenario.json';
  a.click();
  URL.revokeObjectURL(url);
  flashStatus('Exported ✓');
}

function importJSON(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      snapshotForUndo('import');
      applyState(data);
      afterStateChange();
      flashStatus('Imported ✓ — Undo to revert');
    } catch (e) { flashStatus('Invalid file ✗'); }
  };
  reader.readAsText(file);
}

// Share link: base64-encode state into ?s= so the URL fully restores it.
function shareLink() {
  const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(collectState()))));
  const url = `${location.origin}${location.pathname}?s=${encoded}`;
  history.replaceState(null, '', url);
  if (navigator.clipboard) {
    navigator.clipboard.writeText(url).then(
      () => flashStatus('Link copied ✓'),
      () => flashStatus('Link in address bar')
    );
  } else {
    flashStatus('Link in address bar');
  }
}

// If the page was opened with a ?s= share param, decode and apply it.
function applyShareParam() {
  const s = new URLSearchParams(location.search).get('s');
  if (!s) return false;
  try {
    const data = JSON.parse(decodeURIComponent(escape(atob(s))));
    return applyState(data);
  } catch (e) { return false; }
}

// Re-sync derived UI + persist after a bulk state change (import/share).
function afterStateChange() {
  toggleCouple();
  recompute();
  refreshActiveTab();
  saveState();
}

// --- Named scenarios (multiple saved slots) ----------------------------
const SCENARIOS_KEY = 'retirementCalc.scenarios.v1';

function loadScenarios() {
  try { return JSON.parse(localStorage.getItem(SCENARIOS_KEY) || '{}') || {}; }
  catch (e) { return {}; }
}
function persistScenarios(obj) {
  try { localStorage.setItem(SCENARIOS_KEY, JSON.stringify(obj)); } catch (e) { /* ignore */ }
}

// Rebuild the dropdown from saved scenarios, keeping `selected` if still present.
function refreshScenarioDropdown(selected) {
  const scenarios = loadScenarios();
  const names = Object.keys(scenarios).sort((a, b) => a.localeCompare(b));
  const sel = $('scenarioSelect');
  sel.innerHTML = '<option value="">— Saved scenarios —</option>' +
    names.map((n) => `<option value="${n.replace(/"/g, '&quot;')}">${n}</option>`).join('');
  if (selected && scenarios[selected]) sel.value = selected;
}

// Save-as / Rename use an inline name field (native prompt() is blocked in
// sandboxed/embedded contexts, which is why "Save as" appeared to do nothing).
let saveAsMode = 'new';
let renameFrom = '';
function openSaveAsForm(mode) {
  if (mode === 'rename') {
    const cur = $('scenarioSelect').value;
    if (!cur) { flashStatus('Pick a scenario to rename'); return; }
    renameFrom = cur; $('scenarioNameInput').value = cur;
  } else {
    renameFrom = ''; $('scenarioNameInput').value = '';
  }
  saveAsMode = mode;
  $('scenarioSaveAs').classList.remove('hidden');
  const input = $('scenarioNameInput');
  input.focus(); input.select();
}
function cancelSaveAs() { $('scenarioSaveAs').classList.add('hidden'); }
function confirmSaveAs() {
  const name = ($('scenarioNameInput').value || '').trim();
  if (!name) { flashStatus('Enter a name'); return; }
  const scenarios = loadScenarios();
  if (saveAsMode === 'rename') {
    if (name !== renameFrom) { scenarios[name] = scenarios[renameFrom]; delete scenarios[renameFrom]; }
  } else {
    scenarios[name] = collectState();
  }
  persistScenarios(scenarios);
  refreshScenarioDropdown(name);
  cancelSaveAs();
  flashStatus(saveAsMode === 'rename' ? `Renamed to "${name}" ✓` : `Saved "${name}" ✓`);
}

// Loading replaces inputs but is fully reversible via Undo — no blocking dialog.
function loadScenario(name) {
  if (!name) return;
  const scenarios = loadScenarios();
  if (!scenarios[name]) return;
  snapshotForUndo('load');
  applyState(scenarios[name]);
  afterStateChange();
  $('scenarioSelect').value = name;
  flashStatus(`Loaded "${name}" — Undo to revert`);
}

// Delete isn't undoable, so it uses a two-click confirm (no native dialog).
let pendingDelete = null;
let deleteTimer = null;
function resetDeleteBtn() {
  pendingDelete = null;
  const btn = $('deleteScenarioBtn');
  btn.textContent = 'Delete'; btn.classList.remove('danger');
  clearTimeout(deleteTimer);
}
function deleteScenario() {
  const name = $('scenarioSelect').value;
  if (!name) { flashStatus('Pick a scenario to delete'); return; }
  if (pendingDelete === name) {
    const scenarios = loadScenarios();
    delete scenarios[name];
    persistScenarios(scenarios);
    refreshScenarioDropdown('');
    resetDeleteBtn();
    flashStatus(`Deleted "${name}"`);
  } else {
    pendingDelete = name;
    const btn = $('deleteScenarioBtn');
    btn.textContent = 'Confirm delete?'; btn.classList.add('danger');
    clearTimeout(deleteTimer);
    deleteTimer = setTimeout(resetDeleteBtn, 4000);
  }
}

// --- Tabs --------------------------------------------------------------
let activeTab = 'goal';
// The inflation toggle only changes anything on tabs that read inflMode.
const INFLATION_AWARE_TABS = ['forecast', 'goal', 'scenario'];
// Tabs that live under the Tools menu rather than the primary journey. Only
// released tools appear here; the "Soon" items are disabled and never switch.
const TOOL_TABS = ['debt'];

// --- Tools dropdown open/close ----------------------------------------
function openToolsMenu() {
  const dd = $('toolsDropdown'); const trigger = $('toolsTrigger');
  if (!dd || !trigger) return;
  dd.hidden = false;
  trigger.setAttribute('aria-expanded', 'true');
}
function closeToolsMenu() {
  const dd = $('toolsDropdown'); const trigger = $('toolsTrigger');
  if (!dd || !trigger) return;
  dd.hidden = true;
  trigger.setAttribute('aria-expanded', 'false');
}
function toggleToolsMenu() {
  const dd = $('toolsDropdown');
  if (dd && dd.hidden) openToolsMenu(); else closeToolsMenu();
}

function switchTab(name) {
  activeTab = name;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  // Accessible selected state on the primary step tabs.
  document.querySelectorAll('.tab[data-tab][role="tab"]').forEach((t) => t.setAttribute('aria-selected', t.dataset.tab === name ? 'true' : 'false'));
  // The Tools trigger reflects an active state whenever a tool tab is showing.
  const toolsTrigger = $('toolsTrigger');
  if (toolsTrigger) toolsTrigger.classList.toggle('active', TOOL_TABS.includes(name));
  closeToolsMenu();
  document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('hidden', p.id !== `tab-${name}`));
  if ($('globalControls')) $('globalControls').classList.toggle('hidden', !INFLATION_AWARE_TABS.includes(name));
  if (name === 'debt') renderLumps(); // render the dynamic table once on entry
  if (name === 'scenario') renderEvents();
  // Rebuild with the new tab's household (Goal Builder has its own) so the
  // assumptions bar + forecast reflect the tab you just opened, not the last one.
  recompute();
  refreshActiveTab();
}

// Re-render whichever secondary tab is showing (forecast is always live).
function refreshActiveTab() {
  if (activeTab === 'strategy') renderStrategy();
  else if (activeTab === 'hustle') renderHustle();
  else if (activeTab === 'debt') renderDebtDestroyer();
  else if (activeTab === 'goal') renderGoalBuilder();
  else if (activeTab === 'scenario') renderScenarioPlayground();
}

// --- Wiring ------------------------------------------------------------
// input fires on every keystroke/drag -> instant recompute + autosave + tab refresh.
document.addEventListener('input', () => { recompute(); refreshActiveTab(); saveState(); });
$('household').addEventListener('change', () => { toggleCouple(); renderAccounts(); recompute(); refreshActiveTab(); saveState(); });
$('goalHousehold').addEventListener('change', () => { toggleGoalCouple(); recompute(); refreshActiveTab(); saveState(); });
$('hustleGoal').addEventListener('change', renderHustle);
$('resetBtn').addEventListener('click', resetDefaults);
$('exportBtn').addEventListener('click', exportJSON);
$('importBtn').addEventListener('click', () => $('importFile').click());
$('importFile').addEventListener('change', (e) => { if (e.target.files[0]) importJSON(e.target.files[0]); e.target.value = ''; });
$('shareBtn').addEventListener('click', shareLink);
$('undoBtn').addEventListener('click', performUndo);
$('saveAsBtn').addEventListener('click', () => openSaveAsForm('new'));
$('renameBtn').addEventListener('click', () => openSaveAsForm('rename'));
$('deleteScenarioBtn').addEventListener('click', deleteScenario);
$('saveAsConfirm').addEventListener('click', confirmSaveAs);
$('saveAsCancel').addEventListener('click', cancelSaveAs);
$('scenarioNameInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); confirmSaveAs(); }
  else if (e.key === 'Escape') cancelSaveAs();
});
$('scenarioSelect').addEventListener('change', (e) => loadScenario(e.target.value));
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));

// --- Tools dropdown wiring --------------------------------------------
if ($('toolsTrigger')) {
  $('toolsTrigger').addEventListener('click', (e) => { e.stopPropagation(); toggleToolsMenu(); });
  // Click outside closes the menu.
  document.addEventListener('click', (e) => {
    const menu = $('toolsMenu');
    if (menu && !menu.contains(e.target)) closeToolsMenu();
  });
  // Escape closes and returns focus to the trigger.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('toolsDropdown').hidden) { closeToolsMenu(); $('toolsTrigger').focus(); }
  });
}

// --- Forward step CTAs: append a "next step" bar to each primary panel -
// Keeps the Target -> Timeline -> What-If journey obvious. Injected in JS so
// the CTA always lands full-width below the panel's grid columns.
function injectStepCta(panelId, ctas) {
  const panel = $(panelId);
  if (!panel || panel.querySelector('.step-cta-bar')) return;
  const bar = document.createElement('div');
  bar.className = 'step-cta-bar';
  ctas.forEach((c) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'step-cta' + (c.secondary ? ' secondary' : '');
    btn.textContent = c.label;
    btn.addEventListener('click', () => { switchTab(c.target); window.scrollTo({ top: 0, behavior: 'smooth' }); });
    bar.appendChild(btn);
  });
  panel.appendChild(bar);
}
injectStepCta('tab-goal', [{ label: 'See when you’ll reach it →', target: 'forecast' }]);
injectStepCta('tab-forecast', [{ label: 'Explore ways to reach it sooner →', target: 'scenario' }]);
document.querySelectorAll('.add-acct').forEach((b) => b.addEventListener('click', () => addGroup(b.dataset.type)));
$('addStreamBtn').addEventListener('click', addStream);
$('addLumpBtn').addEventListener('click', addLump);
// Maturity Month/Year dropdowns → keep the hidden #debtMaturity in sync. These run
// in the target phase (before the document-level 'input' handler bubbles up), so the
// recompute it triggers reads the fresh value. Clear is a button, so it recomputes itself.
populateDebtMaturityYears();
['debtMaturityMonth', 'debtMaturityYear'].forEach((id) => {
  if ($(id)) $(id).addEventListener('input', updateDebtMaturityFromSelects);
});
if ($('debtMaturityClear')) $('debtMaturityClear').addEventListener('click', () => {
  if ($('debtMaturityMonth')) $('debtMaturityMonth').value = '';
  if ($('debtMaturityYear')) $('debtMaturityYear').value = '';
  updateDebtMaturityFromSelects();
  recompute(); refreshActiveTab(); saveState();
});
document.querySelectorAll('.add-event').forEach((b) => b.addEventListener('click', () => addEvent(b.dataset.type)));
document.querySelectorAll('.pull-goal-btn').forEach((b) => b.addEventListener('click', () => pullDesiredFromGoalBuilder(b)));
$('addPhaseBtn').addEventListener('click', addPhase);
$('addVehicleBtn').addEventListener('click', addVehicle);
$('addSupportBtn').addEventListener('click', addSupport);
$('addKid529Btn').addEventListener('click', addKid529);
if ($('addCustomExpenseBtn')) $('addCustomExpenseBtn').addEventListener('click', addCustomExpense);
if ($('addHomeBtn')) $('addHomeBtn').addEventListener('click', () => { revealHomeSection(); if ($('homeValue')) $('homeValue').focus(); });
if ($('removeHomeBtn')) $('removeHomeBtn').addEventListener('click', removeHomeSection);
// Goal Builder's withdrawal-rate slider writes straight into the canonical
// #withdrawalRate field (target-phase listener fires before this bubbles to
// the document-level recompute() handler, so #withdrawalRate is already
// correct by the time updateSliderLabels() reads it back) — see the
// updateSliderLabels() comment for why this is a mirror, not a synced copy.
if ($('goalWithdrawalRate')) $('goalWithdrawalRate').addEventListener('input', () => {
  $('withdrawalRate').value = $('goalWithdrawalRate').value;
});
if ($('goalDesiredIncome')) {
  $('goalDesiredIncome').addEventListener('input', (e) => { applyGoalDesiredInput(); e.stopPropagation(); });
  $('goalDesiredIncome').addEventListener('change', (e) => { applyGoalDesiredInput({ format: true }); e.stopPropagation(); });
}
// Info-tip bubbles are min-width 420px and centered on a 15px icon. In the
// narrow left input column that icon sits near the viewport edge, so half the
// bubble runs off-screen and gets clipped. On hover/focus, clamp the bubble
// into the viewport and counter-shift its arrow so it still points at the icon.
function positionInfoTip(tip) {
  const bubble = tip.querySelector('.info-tip-bubble');
  if (!bubble) return;
  bubble.style.marginLeft = '0px';
  bubble.style.setProperty('--tip-arrow-shift', '0px');
  const rect = bubble.getBoundingClientRect();
  const pad = 8;
  let shift = 0;
  if (rect.left < pad) shift = pad - rect.left;
  else if (rect.right > window.innerWidth - pad) shift = (window.innerWidth - pad) - rect.right;
  if (shift) {
    bubble.style.marginLeft = shift + 'px';
    bubble.style.setProperty('--tip-arrow-shift', (-shift) + 'px');
  }
}
document.addEventListener('mouseover', (e) => {
  const tip = e.target.closest && e.target.closest('.info-tip');
  if (tip) positionInfoTip(tip);
});
document.addEventListener('focusin', (e) => {
  const tip = e.target.closest && e.target.closest('.info-tip');
  if (tip) positionInfoTip(tip);
});
wireAccounts();
wireStreams();
wireLumps();
wireEvents();
wirePhases();
wireVehicles();
wireSupport();
wireKids529();
wireCustomExpenses();
wireSpendTiers();

// #6 — jump links between tabs (Forecast/Timeline → Goal Builder, the single
// source of truth for household/age/SS/location, and vice versa). Delegated
// on document, not querySelectorAll'd once at boot — several of these links
// (the timeline depletion note, the location-changed banner) are generated
// dynamically well after this wiring runs, so a one-time querySelectorAll
// would miss them.
document.addEventListener('click', (e) => {
  const a = e.target.closest('[data-jump-tab]');
  if (!a) return;
  e.preventDefault();
  switchTab(a.dataset.jumpTab);
  if (a.dataset.jumpTab === 'goal' && $('goalHousehold')) $('goalHousehold').focus();
});
// #2/#12 — Lifecycle accordion quick-add chips: open the accordion, jump to
// (and where relevant, click "+ Add") the right sub-section.
document.querySelectorAll('#lifecycleQuickAdd .lc-chip').forEach((b) => b.addEventListener('click', () => {
  if ($('lifecycleAccordion')) $('lifecycleAccordion').open = true;
  const addBtn = b.dataset.add && $(b.dataset.add);
  if (addBtn) addBtn.click();
  const jumpEl = $(b.dataset.jump);
  if (jumpEl) {
    jumpEl.scrollIntoView({ block: 'center' });
    // "+ home" has no add button (homeValue is a single field, not a list) —
    // scrollIntoView alone is invisible when the target's already in the
    // viewport (which it usually is, right inside the same accordion), so it
    // can look like the click did nothing. Focusing it gives a visible cursor.
    if (!addBtn && typeof jumpEl.focus === 'function') jumpEl.focus();
  }
}));
// #6 — Healthcare household size defaults from Goal Builder's Household
// selector until the user explicitly edits it themselves.
if ($('acaHousehold')) $('acaHousehold').addEventListener('input', () => { acaHouseholdEdited = true; });

// v2: global inflation display toggle (Today's Dollars vs Future Nominal).
document.querySelectorAll('#inflationToggle .seg').forEach((b) => b.addEventListener('click', () => {
  inflMode = b.dataset.mode === 'today' ? 'today' : 'nominal';
  document.querySelectorAll('#inflationToggle .seg').forEach((s) => s.classList.toggle('active', s === b));
  recompute(); refreshActiveTab();
}));
if ($('scenarioRetirementAge')) {
  $('scenarioRetirementAge').addEventListener('input', (e) => { applyScenarioRetirementAge(); e.stopPropagation(); });
  $('scenarioRetirementAge').addEventListener('change', (e) => { syncScenarioRetirementAgeField(); e.stopPropagation(); });
}

// v2: money formatter — accept commas while preserving numeric calculations.
document.addEventListener('blur', (e) => {
  const t = e.target;
  if (t && t.matches && t.matches('input[data-money]')) {
    formatMoneyInput(t);
    recompute(); refreshActiveTab(); saveState();
  }
}, true);

// ======================================================================
// Easy Onboarding Wizard — a guided first-run flow that seeds the engine
// from a handful of questions, then hands off to the full dashboard.
// ======================================================================
const WIZ_TOTAL = 7;   // total step count (step 1 = welcome)
const WIZ_GOAL_TOTAL = 3; // goal-builder track step count (excludes welcome/choice)
const WIZ_AGE_MAX = 90; // upper bound for current age & retirement age (mirrors the main inputs)
// track: 'forecast' (know your number → full quick setup) | 'goal' (not yet → Goal Builder pathway)
const wiz = { step: 1, goalStep: 1, track: 'forecast', household: 'single', goalHousehold: 'single', assetMode: 'single', knowsFireNumber: null };

// Strip '$', ',' and whitespace, then parse. Returns null for blank (so we can
// tell "user left it empty" from "user typed 0" and apply the right fallback).
function wizSanitize(v) { return String(v == null ? '' : v).replace(/[$,\s]/g, ''); }

// Pretty thousands-separators on the wizard's dollar fields (inputmode="decimal").
// Purely cosmetic — wizRawNum strips the commas again on read. Skips blank inputs
// so optional fields keep their placeholder instead of showing "0".
function wizFormatMoneyFields() {
  document.querySelectorAll('#onboarding-wizard input[inputmode="decimal"]')
    .forEach((t) => { if (t.value.trim() !== '') t.value = fmtInput(t.value); });
}
function wizRawNum(id) {
  const v = wizSanitize($(id).value);
  if (v === '') return null;
  const n = parseFloat(v);
  return isNaN(n) ? null : n;
}

function wizSetHousehold(val) {
  wiz.household = val === 'couple' ? 'couple' : 'single';
  document.querySelectorAll('#wizHouseholdChoice .wiz-choice')
    .forEach((b) => b.classList.toggle('active', b.dataset.household === wiz.household));
  document.querySelectorAll('.wiz-couple-only')
    .forEach((el) => el.classList.toggle('hidden', wiz.household !== 'couple'));
  wizValidateLive();
}

function wizSetAssetMode(val) {
  wiz.assetMode = val === 'breakdown' ? 'breakdown' : 'single';
  document.querySelectorAll('#wizAssetChoice .wiz-choice')
    .forEach((b) => b.classList.toggle('active', b.dataset.assetmode === wiz.assetMode));
  $('wizAssetSingle').classList.toggle('hidden', wiz.assetMode !== 'single');
  $('wizAssetBreakdown').classList.toggle('hidden', wiz.assetMode !== 'breakdown');
}

function wizSetFireKnown(val) {
  wiz.knowsFireNumber = val === 'yes' ? 'yes' : (val === 'no' ? 'no' : null);
  document.querySelectorAll('#wizFireChoice .wiz-choice')
    .forEach((b) => b.classList.toggle('active', b.dataset.fireknown === wiz.knowsFireNumber));
  wizValidateLive();
}

// Per-step validation. Returns { ok, msg, bad:[ids] }.
//  - Ages (step 3) & retirement ages (step 4) & desired income (step 7) are required.
//  - Retirement age must be >= current age.
function wizValidateStep(step) {
  const isCouple = wiz.household === 'couple';
  const bad = [];
  if (step === 2) {
    if (!wiz.knowsFireNumber) return { ok: false, msg: 'Please choose whether you know your FIRE number.', bad: [] };
  } else if (step === 3) {
    const a = wizRawNum('wizAgeA'); if (a == null || a <= 0 || a > WIZ_AGE_MAX) bad.push('wizAgeA');
    if (isCouple) { const b = wizRawNum('wizAgeB'); if (b == null || b <= 0 || b > WIZ_AGE_MAX) bad.push('wizAgeB'); }
    if (bad.length) return { ok: false, msg: `Please enter a current age between 1 and ${WIZ_AGE_MAX}.`, bad };
  } else if (step === 4) {
    const a = wizRawNum('wizAgeA'), b = wizRawNum('wizAgeB');
    const ra = wizRawNum('wizRetA');
    if (ra == null || ra <= 0) return { ok: false, msg: 'Please enter a desired retirement age.', bad: ['wizRetA'] };
    if (ra > WIZ_AGE_MAX) return { ok: false, msg: `Retirement age must be ${WIZ_AGE_MAX} or under.`, bad: ['wizRetA'] };
    if (a != null && ra < a) return { ok: false, msg: 'Retirement age must be at or after your current age.', bad: ['wizRetA'] };
    if (isCouple) {
      const rb = wizRawNum('wizRetB');
      if (rb == null || rb <= 0) return { ok: false, msg: "Please enter your partner's retirement age.", bad: ['wizRetB'] };
      if (rb > WIZ_AGE_MAX) return { ok: false, msg: `Partner's retirement age must be ${WIZ_AGE_MAX} or under.`, bad: ['wizRetB'] };
      if (b != null && rb < b) return { ok: false, msg: "Partner's retirement age must be at or after their current age.", bad: ['wizRetB'] };
    }
  } else if (step === 7) {
    const d = wizRawNum('wizDesired');
    if (d == null || d <= 0) return { ok: false, msg: 'Please enter your desired retirement income.', bad: ['wizDesired'] };
  }
  return { ok: true, msg: '', bad: [] };
}

// Live feedback: disable Next when invalid; surface the message only once the
// user has actually typed something wrong (don't scold an untouched field).
function wizValidateLive() {
  const res = wiz.track === 'goal' ? wizGoalValidateStep(wiz.goalStep) : wizValidateStep(wiz.step);
  $('wizNextBtn').disabled = !res.ok;
  document.querySelectorAll('.wizard-step input').forEach((i) => i.classList.remove('wiz-invalid'));
  const touched = res.bad.filter((id) => wizSanitize($(id).value) !== '');
  const err = $('wizError');
  if (!res.ok && touched.length) {
    err.textContent = res.msg; err.classList.remove('hidden');
    touched.forEach((id) => $(id).classList.add('wiz-invalid'));
  } else {
    err.textContent = ''; err.classList.add('hidden');
  }
}

function wizShow(step) {
  wiz.track = 'forecast';
  wiz.step = Math.max(1, Math.min(WIZ_TOTAL, step));
  document.querySelectorAll('.wizard-step')
    .forEach((s) => s.classList.toggle('hidden', +s.dataset.step !== wiz.step));
  $('wizProgressBar').style.width = (wiz.step / WIZ_TOTAL * 100) + '%';
  const isWelcome = wiz.step === 1;
  $('wizNav').classList.toggle('hidden', isWelcome);
  $('wizBackBtn').classList.toggle('hidden', wiz.step <= 2);
  $('wizNextBtn').textContent = wiz.step === WIZ_TOTAL ? 'Finish' : 'Next';
  $('wizStepCount').textContent = isWelcome ? '' : `Step ${wiz.step - 1} of ${WIZ_TOTAL - 1}`;
  const firstInput = document.querySelector(`.wizard-step[data-step="${wiz.step}"] input`);
  if (firstInput) setTimeout(() => firstInput.focus(), 30);
  wizFormatMoneyFields();
  wizValidateLive();
}

function wizNext() {
  if (wiz.track === 'goal') return wizGoalNext();
  const res = wizValidateStep(wiz.step);
  if (!res.ok) { // guard (Next is normally disabled when invalid)
    $('wizError').textContent = res.msg; $('wizError').classList.remove('hidden');
    res.bad.forEach((id) => $(id).classList.add('wiz-invalid'));
    return;
  }
  if (wiz.step === 2 && wiz.knowsFireNumber === 'no') return wizStartGoalTrack();
  if (wiz.step === WIZ_TOTAL) return wizFinish();
  wizShow(wiz.step + 1);
}
function wizBack() {
  if (wiz.track === 'goal') return wizGoalBack();
  if (wiz.step > 2) wizShow(wiz.step - 1);
}

// ---- Goal Builder track: a guided pathway for users who don't yet know their
//      number. Shapes the Goal Builder fields instead of the full forecast. ----
function wizSetGoalHousehold(val) {
  wiz.goalHousehold = val === 'couple' ? 'couple' : 'single';
  document.querySelectorAll('#wizGoalHouseholdChoice .wiz-choice')
    .forEach((b) => b.classList.toggle('active', b.dataset.ghousehold === wiz.goalHousehold));
  document.querySelectorAll('.wiz-gcouple-only')
    .forEach((el) => el.classList.toggle('hidden', wiz.goalHousehold !== 'couple'));
  // Step 3 ("People in your household") used to stay frozen at whatever it was
  // seeded with at wizard start, completely ignoring the Single/Couple choice
  // made right here in step 1 — picking "Couple" still showed "1" later. Keep
  // it in sync with the household choice; the user can still type a different
  // number in step 3 themselves (e.g. couple + kids).
  if ($('wizGoalHouseholdSize')) $('wizGoalHouseholdSize').value = wiz.goalHousehold === 'couple' ? 2 : 1;
  wizValidateLive();
}

function wizStartGoalTrack() {
  // Seed from any existing Goal Builder values so a re-run shows current inputs.
  $('wizGoalAgeA').value = $('goalAgeA') ? $('goalAgeA').value : '';
  $('wizGoalRetA').value = $('goalRetA') ? $('goalRetA').value : '';
  $('wizGoalAgeB').value = $('goalAgeB') ? $('goalAgeB').value : '';
  $('wizGoalRetB').value = $('goalRetB') ? $('goalRetB').value : '';
  if ($('acaHousehold')) $('wizGoalHouseholdSize').value = $('acaHousehold').value || '';
  if (spendingPhases[0]) $('wizGoalSpend').value = spendingPhases[0].annualSpend || '';
  wizSetGoalHousehold($('goalHousehold') && $('goalHousehold').value === 'couple' ? 'couple' : 'single');
  wizGoalShow(1);
}

function wizGoalShow(n) {
  wiz.track = 'goal';
  wiz.goalStep = Math.max(1, Math.min(WIZ_GOAL_TOTAL, n));
  document.querySelectorAll('.wizard-step')
    .forEach((s) => s.classList.toggle('hidden', +s.dataset.goalstep !== wiz.goalStep));
  $('wizProgressBar').style.width = (wiz.goalStep / WIZ_GOAL_TOTAL * 100) + '%';
  $('wizNav').classList.remove('hidden');
  $('wizBackBtn').classList.remove('hidden'); // Back always available (step 1 → the choice)
  $('wizNextBtn').textContent = wiz.goalStep === WIZ_GOAL_TOTAL ? 'Finish' : 'Next';
  $('wizStepCount').textContent = `Step ${wiz.goalStep} of ${WIZ_GOAL_TOTAL}`;
  const firstInput = document.querySelector(`.wizard-step[data-goalstep="${wiz.goalStep}"] input`);
  if (firstInput) setTimeout(() => firstInput.focus(), 30);
  wizFormatMoneyFields();
  wizValidateLive();
}

function wizGoalNext() {
  const res = wizGoalValidateStep(wiz.goalStep);
  if (!res.ok) {
    $('wizError').textContent = res.msg; $('wizError').classList.remove('hidden');
    res.bad.forEach((id) => $(id).classList.add('wiz-invalid'));
    return;
  }
  if (wiz.goalStep === WIZ_GOAL_TOTAL) return wizGoalFinish();
  wizGoalShow(wiz.goalStep + 1);
}

function wizGoalBack() {
  if (wiz.goalStep > 1) { wizGoalShow(wiz.goalStep - 1); return; }
  wizShow(2); // back from goal step 1 returns to the "know your number?" choice
}

function wizGoalValidateStep(step) {
  const isCouple = wiz.goalHousehold === 'couple';
  if (step === 1) {
    const bad = [];
    const a = wizRawNum('wizGoalAgeA'); if (a == null || a <= 0 || a > WIZ_AGE_MAX) bad.push('wizGoalAgeA');
    const ra = wizRawNum('wizGoalRetA'); if (ra == null || ra <= 0 || ra > WIZ_AGE_MAX) bad.push('wizGoalRetA');
    if (isCouple) {
      const b = wizRawNum('wizGoalAgeB'); if (b == null || b <= 0 || b > WIZ_AGE_MAX) bad.push('wizGoalAgeB');
      const rb = wizRawNum('wizGoalRetB'); if (rb == null || rb <= 0 || rb > WIZ_AGE_MAX) bad.push('wizGoalRetB');
    }
    if (bad.length) return { ok: false, msg: `Please enter ages between 1 and ${WIZ_AGE_MAX}.`, bad };
    if (a != null && ra != null && ra < a) return { ok: false, msg: 'Retirement age must be at or after your current age.', bad: ['wizGoalRetA'] };
  } else if (step === 2) {
    const s = wizRawNum('wizGoalSpend');
    if (s == null || s <= 0) return { ok: false, msg: 'Please enter your estimated annual spending.', bad: ['wizGoalSpend'] };
  }
  return { ok: true, msg: '', bad: [] }; // step 3 (household size) is optional
}

function wizGoalFinish() {
  const isCouple = wiz.goalHousehold === 'couple';
  if ($('goalHousehold')) $('goalHousehold').value = isCouple ? 'couple' : 'single';
  if ($('goalAgeA')) $('goalAgeA').value = wizRawNum('wizGoalAgeA');
  if ($('goalRetA')) $('goalRetA').value = wizRawNum('wizGoalRetA');
  if (isCouple) {
    if ($('goalAgeB')) $('goalAgeB').value = wizRawNum('wizGoalAgeB');
    if ($('goalRetB')) $('goalRetB').value = wizRawNum('wizGoalRetB');
  }
  // Spending → a single starting phase (duration derived from the retirement age
  // just set), and mirror it into the Forecast "desired income" so the tabs agree.
  const spend = wizRawNum('wizGoalSpend') || 0;
  if (spend > 0) {
    const def = phaseDefaults()[0];
    spendingPhases = [makePhase({ name: 'Retirement spending', annualSpend: spend, years: def.years, info: def.info })];
    if ($('desired')) $('desired').value = spend;
  }
  const hh = wizRawNum('wizGoalHouseholdSize');
  if (hh != null && hh > 0 && $('acaHousehold')) $('acaHousehold').value = hh;

  if (typeof toggleGoalCouple === 'function') toggleGoalCouple();
  renderPhases();
  closeWizard();
  recompute();
  switchTab('goal');
  saveState();
  flashStatus('Your Target is ready ✓');
}

function openWizard(prefill) {
  wiz.track = 'forecast'; // always start at the shared welcome/choice
  wizSetFireKnown(null);
  if (prefill) { // re-run: seed the form from the current live inputs
    $('wizAgeA').value = $('ageA').value;
    $('wizRetA').value = $('retA').value;
    $('wizAgeB').value = $('ageB').value;
    $('wizRetB').value = $('retB').value;
    $('wizDesired').value = $('desired').value;
    if ($('healthcare').value) $('wizHealthcare').value = $('healthcare').value;
    wizSetHousehold($('household').value === 'couple' ? 'couple' : 'single');
  } else {
    wizSetHousehold('single');
  }
  wizSetAssetMode('single');
  const o = $('onboarding-wizard');
  o.classList.remove('hidden');
  o.setAttribute('aria-hidden', 'false');
  document.body.classList.add('wiz-open');
  wizShow(1);
}

function closeWizard() {
  const o = $('onboarding-wizard');
  o.classList.add('hidden');
  o.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('wiz-open');
}

// Apply the wizard answers to the live dashboard, seed the account engine,
// then recompute + persist.
function wizFinish() {
  const isCouple = wiz.household === 'couple';

  // --- Map basics onto the existing DOM fields ---
  $('household').value = isCouple ? 'couple' : 'single';
  $('ageA').value = wizRawNum('wizAgeA');
  $('retA').value = wizRawNum('wizRetA');
  if (isCouple) {
    $('ageB').value = wizRawNum('wizAgeB');
    $('retB').value = wizRawNum('wizRetB');
  }
  $('desired').value = wizRawNum('wizDesired');
  // Healthcare fallback: blank -> $6k (single) / $12k (couple).
  const hc = wizRawNum('wizHealthcare');
  $('healthcare').value = hc == null ? (isCouple ? 12000 : 6000) : hc;

  // --- Clear existing engine collections so re-running doesn't double-count.
  //     (This app models contributions/income via accounts + income streams;
  //      there is no separate `expenses` array to clear.) ---
  accountGroups = [];
  incomeStreams = [];
  debtLumpSums = [];      // v2 cleanup-on-finish
  scenarioEvents = [];    // v2 cleanup-on-finish
  spendingPhases = phaseDefaults().map(makePhase); // v2.1: reset Goal Builder phases to defaults
  vehicleItems = [];      // v2.1 cleanup-on-finish
  supportItems = [];      // v2.1 cleanup-on-finish
  kids529Items = [];      // v2.1 cleanup-on-finish
  customExpenseItems = []; // v2.1 cleanup-on-finish

  // Blank assets / contributions default to 0.
  const contributions = wizRawNum('wizContributions') || 0;

  if (wiz.assetMode === 'breakdown') {
    const pretax  = wizRawNum('wizPretax')  || 0;
    const roth    = wizRawNum('wizRoth')    || 0;
    const hsa     = wizRawNum('wizHSA')     || 0;
    const c457    = wizRawNum('wiz457')     || 0;
    const taxable = wizRawNum('wizTaxable') || 0;
    accountGroups.push(makeGroup({ name: 'Initial Savings', type: 'other', subAccounts: [
      // Step-6 total contribution defaults onto the Pre-tax sub-account.
      makeSubAccount({ category: 'pretax',  label: 'Pre-tax', balance: pretax, baseContribution: contributions }),
      makeSubAccount({ category: 'roth',    label: 'Roth',    balance: roth }),
      makeSubAccount({ category: 'pretax',  label: 'HSA',     balance: hsa }),
      makeSubAccount({ category: 'pretax',  label: '457(b)',  balance: c457 }),
      makeSubAccount({ category: 'taxable', label: 'Taxable', balance: taxable }),
    ] }));
    // Future pension -> a lifetime income stream starting at retirement.
    const pension = wizRawNum('wizPension') || 0;
    if (pension > 0) {
      const startAge = wizRawNum('wizRetA') || num('retA');
      incomeStreams.push(makeStream({ label: 'Pension', annualAmount: pension, startAge, endAge: 110 }));
    }
  } else {
    const total = wizRawNum('wizTotalSavings') || 0;
    accountGroups.push(makeGroup({ name: 'Initial Savings', type: 'other', subAccounts: [
      makeSubAccount({ category: 'total', label: 'Total', balance: total, baseContribution: contributions }),
    ] }));
  }

  // --- Re-sync derived UI, recompute, persist ---
  toggleCouple();
  renderAccounts();
  syncLegacyFields();
  renderStreams();
  renderLumps();
  renderEvents();
  renderPhases();
  renderVehicles();
  renderSupport();
  renderKids529();
  renderCustomExpenses();
  closeWizard();
  recompute();
  switchTab('forecast'); // full Quick Setup → show the forecast result they just built
  saveState();
  flashStatus('Setup complete ✓');
}

// Wizard wiring
$('wizStartBtn').addEventListener('click', () => wizShow(2));
// Skip / close: leave the wizard at any time, persisting current state so we
// don't nag on reload. Both land the user on the dashboard (Goal Builder).
// Skipping loads the starter assumptions — say exactly that (never imply the
// user saved anything they didn't enter).
const wizDismiss = () => { closeWizard(); saveState(); flashStatus('Using starter assumptions — edit anytime'); };
$('wizSkipBtn').addEventListener('click', wizDismiss);
if ($('wizCloseBtn')) $('wizCloseBtn').addEventListener('click', wizDismiss);
$('wizNextBtn').addEventListener('click', wizNext);
$('wizBackBtn').addEventListener('click', wizBack);
$('rerunWizardBtn').addEventListener('click', () => openWizard(true));
document.querySelectorAll('#wizFireChoice .wiz-choice')
  .forEach((b) => b.addEventListener('click', () => wizSetFireKnown(b.dataset.fireknown)));
document.querySelectorAll('#wizHouseholdChoice .wiz-choice')
  .forEach((b) => b.addEventListener('click', () => wizSetHousehold(b.dataset.household)));
document.querySelectorAll('#wizGoalHouseholdChoice .wiz-choice')
  .forEach((b) => b.addEventListener('click', () => wizSetGoalHousehold(b.dataset.ghousehold)));
document.querySelectorAll('#wizAssetChoice .wiz-choice')
  .forEach((b) => b.addEventListener('click', () => wizSetAssetMode(b.dataset.assetmode)));
// Keep wizard typing out of the global recompute/autosave (stopPropagation) and
// run live validation instead. (Inputs are also data-nostate, so they never
// leak into collectState.)
$('onboarding-wizard').addEventListener('input', (e) => { wizValidateLive(); e.stopPropagation(); });
// Format dollar fields with thousands separators when the user leaves them.
$('onboarding-wizard').addEventListener('focusout', (e) => {
  const t = e.target;
  if (t && t.matches && t.matches('input[inputmode="decimal"]') && t.value.trim() !== '') {
    t.value = fmtInput(t.value);
  }
});
$('onboarding-wizard').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && wiz.step >= 2) { e.preventDefault(); wizNext(); }
  else if (e.key === 'Escape') closeWizard();
});

// A share-param URL takes precedence over saved localStorage.
let __saved = null;
try { __saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); } catch (e) { __saved = null; }
const __hadShare = applyShareParam();
if (!__hadShare) loadState();
initAccounts(__saved && __saved.__accounts); // restore accounts, or migrate from legacy bal/con
initStreams(__saved && __saved.__streams);
initLumps(__saved && __saved.__debtLumps);
initEvents(__saved && __saved.__events);
initPhases(__saved && __saved.__goalPhases);
initVehicles(__saved && __saved.__vehicles);
initSupport(__saved && __saved.__support);
initKids529(__saved && __saved.__kids529);
initCustomExpenses(__saved && __saved.__customExpenses);
syncDebtMaturitySelects(); // reflect any saved maturity date in the Month/Year dropdowns
refreshScenarioDropdown('');
toggleCouple();
toggleGoalCouple(); // mirror toggleCouple() above — without this, a restored 'couple' household
                    // shows the select set to "Couple" but Person B stays hidden until the user
                    // re-touches the dropdown (it was only wired to the 'change' event, not boot).
syncHomeSectionVisibility(); // same idea — a returning user with a saved home value shouldn't
                             // have to click "+ Add home" again to see their own numbers.
// "Years in retirement" defaulted to a flat 30 regardless of retirement age,
// silently capping the Savings Growth chart well short of a longevity age —
// same complaint Goal Builder's phaseDefaults() (95 − retireAge) already
// solved for its own horizon. Only adjusts the field if it's still sitting
// at its untouched HTML default ("30") — a real saved scenario with a
// deliberately-set value of exactly 30 would look identical to "never
// touched" here, a one-time false positive this app already accepts
// elsewhere (see isLegacyDefaultPhases for the same tradeoff).
if ($('retYears') && $('retYears').value === '30') {
  const retAge = goalBuilderRetirementAge();
  $('retYears').value = Math.min(75, Math.max(10, Math.round(95 - retAge)));
}
if ($('globalControls')) $('globalControls').classList.toggle('hidden', !INFLATION_AWARE_TABS.includes(activeTab));
recompute();
formatMoneyInputs();
// Sync the visible panel to the default tab (Goal Builder). The HTML can't be the
// source of truth here — switchTab toggles panel visibility AND renders the active
// secondary tab, so the landing page actually shows Goal Builder, not Forecast.
switchTab(activeTab);

// First-run onboarding: show the wizard when there's no saved scenario and the
// page wasn't opened from a share link.
if (!__saved && !__hadShare) openWizard(false);

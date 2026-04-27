import { readFileSync } from 'fs';

const defaultConfig = JSON.parse(readFileSync(new URL('../leboncoin-resale.config.json', import.meta.url), 'utf8'));

const BULKINESS_RANK = {
  tiny: 0,
  small: 1,
  medium: 2,
  large: 3,
  oversized: 4,
};

const FRAGILITY_RANK = {
  low: 0,
  medium: 1,
  high: 2,
};

function clamp(value, min = 0, max = 1) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function numberOr(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function normalizeCategory(value) {
  return String(value || '').trim().toLowerCase();
}

function validateLeboncoinResaleConfig(config = defaultConfig) {
  const errors = [];

  if (!config.location?.label || typeof config.location.label !== 'string') {
    errors.push('location.label must be a non-empty string');
  }

  if (!Number.isFinite(config.location?.radiusKm) || config.location.radiusKm <= 0) {
    errors.push('location.radiusKm must be a positive number');
  }

  for (const coordinateKey of ['latitude', 'longitude']) {
    const coordinate = config.location?.[coordinateKey];
    if (coordinate !== null && coordinate !== undefined && !Number.isFinite(coordinate)) {
      errors.push(`location.${coordinateKey} must be a number, null, or omitted`);
    }
  }

  const maxPurchasePrice = config.budget?.maxPurchasePriceHard ?? config.budget?.maxPurchasePriceWithoutValidation ?? config.budget?.maxPurchasePrice;
  if (!Number.isFinite(maxPurchasePrice) || maxPurchasePrice <= 0) {
    errors.push('budget.maxPurchasePriceHard must be a positive number');
  }

  if (!Number.isFinite(config.budget?.maxTotalExposure) || config.budget.maxTotalExposure < maxPurchasePrice) {
    errors.push('budget.maxTotalExposure must be greater than or equal to the hard purchase budget');
  }

  if (config.browserPolicy?.browserOnly !== true) {
    errors.push('browserPolicy.browserOnly must be true');
  }

  for (const forbiddenPolicy of ['forbidDirectLeboncoinApi', 'forbidHiddenEndpoints', 'forbidInternalApiScraping']) {
    if (config.browserPolicy?.[forbiddenPolicy] !== true) {
      errors.push(`browserPolicy.${forbiddenPolicy} must be true`);
    }
  }

  if (config.supervision?.allowAutonomousPurchase !== false || config.supervision?.allowAutonomousPayment !== false) {
    errors.push('supervision must forbid autonomous purchase and payment');
  }

  if (config.storage?.phase !== 1) {
    errors.push('storage.phase must be 1 for the small-objects-only resale phase');
  }

  if (!config.storage?.smallObjectsOnly) {
    errors.push('storage.smallObjectsOnly must be true');
  }

  if (!(config.storage?.maxBulkiness in BULKINESS_RANK)) {
    errors.push('storage.maxBulkiness must be tiny, small, medium, large, or oversized');
  }

  if (!(config.storage?.maxFragility in FRAGILITY_RANK)) {
    errors.push('storage.maxFragility must be low, medium, or high');
  }

  const allowed = asArray(config.categories?.allowed).map(normalizeCategory);
  const banned = asArray(config.categories?.banned).map(normalizeCategory);
  if (allowed.length === 0) errors.push('categories.allowed must include at least one category');
  if (allowed.some((category) => banned.includes(category))) {
    errors.push('categories.allowed and categories.banned must not overlap');
  }

  if (!Number.isFinite(config.margins?.minGrossMarginPercent) || config.margins.minGrossMarginPercent < 0) {
    errors.push('margins.minGrossMarginPercent must be a non-negative number');
  }

  if (!Number.isFinite(config.margins?.minNetProfit) || config.margins.minNetProfit < 0) {
    errors.push('margins.minNetProfit must be a non-negative number');
  }

  const weights = config.scoring?.weights || {};
  const weightKeys = ['margin', 'demand', 'resaleSpeed', 'risk', 'distance', 'bulkiness', 'fragility', 'storageTime'];
  for (const key of weightKeys) {
    if (!Number.isFinite(weights[key]) || weights[key] < 0) errors.push(`scoring.weights.${key} must be a non-negative number`);
  }
  const totalWeight = weightKeys.reduce((sum, key) => sum + numberOr(weights[key], 0), 0);
  if (Math.abs(totalWeight - 1) > 0.001) errors.push('scoring.weights must sum to 1');

  const thresholds = config.scoring || {};
  if (!(thresholds.buyDirectScore > thresholds.negotiateScore && thresholds.negotiateScore > thresholds.watchScore && thresholds.watchScore >= thresholds.ignoreBelowScore)) {
    errors.push('scoring thresholds must satisfy buyDirectScore > negotiateScore > watchScore >= ignoreBelowScore');
  }

  if (!Array.isArray(config.listingAgeBuckets) || config.listingAgeBuckets.length === 0) {
    errors.push('listingAgeBuckets must include at least one bucket');
  }

  for (const templateKey of ['askAvailability', 'negotiateAggressive', 'negotiateStandard', 'abandonCounterAboveCeiling']) {
    if (typeof config.messageTemplates?.[templateKey] !== 'string' || config.messageTemplates[templateKey].length === 0) {
      errors.push(`messageTemplates.${templateKey} must be a non-empty string`);
    }
  }

  return { ok: errors.length === 0, errors };
}

function getListingAgeBucket(ageDays, config = defaultConfig) {
  const days = numberOr(ageDays, 0);
  return config.listingAgeBuckets.find((bucket) => bucket.maxDays === null || days <= bucket.maxDays) || null;
}

function estimateNetProfit(listing, config = defaultConfig, offerPrice = listing.price) {
  const resalePrice = numberOr(listing.estimatedResalePrice, 0);
  const purchasePrice = numberOr(offerPrice, 0);
  const platformFee = resalePrice * (numberOr(config.margins?.platformFeePercent, 0) / 100);
  const repairBuffer = numberOr(listing.estimatedRepairCost, numberOr(config.margins?.repairCostBuffer, 0));
  return resalePrice - purchasePrice - platformFee - repairBuffer;
}

function getHardPurchaseBudget(config = defaultConfig) {
  return config.budget?.maxPurchasePriceHard
    ?? config.budget?.maxPurchasePriceWithoutValidation
    ?? config.budget?.maxPurchasePrice
    ?? Infinity;
}

function getRequiredNetProfit(purchasePrice, config = defaultConfig) {
  const bands = asArray(config.margins?.netProfitByPurchaseBand);
  const matchingBand = bands.find((band) => band.maxPrice === null || purchasePrice <= band.maxPrice);
  return numberOr(matchingBand?.minNetProfit, numberOr(config.margins?.minNetProfit, 0));
}

function calculateProfitableMaxOffer(listing, config = defaultConfig) {
  const resalePrice = numberOr(listing.estimatedResalePrice, 0);
  const baseMinNetProfit = numberOr(config.margins?.minNetProfit, 0);
  const platformFee = resalePrice * (numberOr(config.margins?.platformFeePercent, 0) / 100);
  const repairBuffer = numberOr(listing.estimatedRepairCost, numberOr(config.margins?.repairCostBuffer, 0));
  const marginCeiling = resalePrice / (1 + numberOr(config.margins?.minGrossMarginPercent, 0) / 100);
  const baseProfitCeiling = resalePrice - platformFee - repairBuffer - baseMinNetProfit;
  const initialCeiling = Math.max(0, Math.floor(Math.min(marginCeiling, baseProfitCeiling, numberOr(getHardPurchaseBudget(config), Infinity))));
  const requiredNetProfit = getRequiredNetProfit(initialCeiling, config);
  const bandProfitCeiling = resalePrice - platformFee - repairBuffer - requiredNetProfit;
  return Math.max(0, Math.floor(Math.min(marginCeiling, bandProfitCeiling, numberOr(getHardPurchaseBudget(config), Infinity))));
}

function categoryDecision(listing, config) {
  const category = normalizeCategory(listing.category);
  const allowed = asArray(config.categories?.allowed).map(normalizeCategory);
  const banned = asArray(config.categories?.banned).map(normalizeCategory);
  const exceptionalOnly = asArray(config.categories?.exceptionalOnly).map(normalizeCategory);

  if (banned.includes(category)) return { ok: false, reason: 'banned_category' };
  if (exceptionalOnly.includes(category)) return { ok: true, exceptionalOnly: true };
  if (!allowed.includes(category)) return { ok: false, reason: 'category_not_allowed' };
  return { ok: true };
}

function storageDecision(listing, config) {
  const bulkiness = normalizeCategory(listing.bulkiness || 'medium');
  const fragility = normalizeCategory(listing.fragility || 'medium');
  const attributes = asArray(listing.attributes).map(normalizeCategory);
  const bannedAttributes = asArray(config.storage?.bannedAttributes).map(normalizeCategory);

  if (config.storage?.smallObjectsOnly && BULKINESS_RANK[bulkiness] > BULKINESS_RANK.small) {
    return { ok: false, reason: 'not_phase_1_small_object' };
  }

  if (BULKINESS_RANK[bulkiness] > BULKINESS_RANK[config.storage?.maxBulkiness]) {
    return { ok: false, reason: 'too_bulky' };
  }

  if (FRAGILITY_RANK[fragility] > FRAGILITY_RANK[config.storage?.maxFragility]) {
    return { ok: false, reason: 'too_fragile' };
  }

  if (attributes.some((attribute) => bannedAttributes.includes(attribute))) {
    return { ok: false, reason: 'banned_storage_attribute' };
  }

  if (numberOr(listing.expectedStorageDays, 0) > numberOr(config.storage?.maxStorageDays, Infinity)) {
    return { ok: false, reason: 'storage_time_too_long' };
  }

  return { ok: true };
}

function renderTemplate(template, values) {
  return String(template || '').replace(/\{(\w+)\}/g, (_, key) => values[key] ?? '');
}

function scoreLeboncoinListing(listing, config = defaultConfig) {
  const validation = validateLeboncoinResaleConfig(config);
  if (!validation.ok) return { decision: 'invalid_config', validation, score: 0 };

  const categoryResult = categoryDecision(listing, config);
  const storageResult = storageDecision(listing, config);
  const failed = [categoryResult, storageResult].find((result) => !result.ok);
  if (failed) return { decision: 'ignore', reason: failed.reason, score: 0 };

  if (numberOr(listing.price, 0) > numberOr(getHardPurchaseBudget(config), Infinity)) {
    const staleRule = config.specialRules?.overpriced_but_stale;
    const ageDays = numberOr(listing.ageDays, 0);
    const profitableMaxOffer = calculateProfitableMaxOffer(listing, config);
    const isOverpricedButStale = staleRule?.enabled
      && ageDays >= numberOr(staleRule.minAgeDays, Infinity)
      && numberOr(listing.price, 0) > profitableMaxOffer * numberOr(staleRule.overpricedRatio, 1);

    if (isOverpricedButStale && profitableMaxOffer > 0) {
      const openingOffer = Math.max(1, Math.floor(profitableMaxOffer * (1 - numberOr(staleRule.openingOfferDiscountPercent, 0) / 100)));
      return {
        decision: 'aggressive_negotiation',
        reason: 'overpriced_but_stale',
        score: 0,
        profitableMaxOffer,
        openingOffer,
        abandonIfCounterAbove: profitableMaxOffer,
        message: renderTemplate(config.messageTemplates.negotiateAggressive, { offer: openingOffer }),
      };
    }

    return { decision: 'ignore', reason: 'over_budget', score: 0 };
  }

  if (numberOr(listing.distanceKm, 0) > numberOr(config.location?.radiusKm, Infinity)) {
    return { decision: 'ignore', reason: 'outside_radius', score: 0 };
  }

  const netProfit = estimateNetProfit(listing, config);
  const grossMarginPercent = numberOr(listing.price, 0) > 0 ? ((numberOr(listing.estimatedResalePrice, 0) - listing.price) / listing.price) * 100 : 0;
  const requiredNetProfit = getRequiredNetProfit(numberOr(listing.price, 0), config);
  if (netProfit < requiredNetProfit || grossMarginPercent < numberOr(config.margins?.minGrossMarginPercent, 0)) {
    const staleRule = config.specialRules?.overpriced_but_stale;
    const profitableMaxOffer = calculateProfitableMaxOffer(listing, config);
    const isOverpricedButStale = staleRule?.enabled
      && numberOr(listing.ageDays, 0) >= numberOr(staleRule.minAgeDays, Infinity)
      && profitableMaxOffer > 0
      && numberOr(listing.price, 0) > profitableMaxOffer * numberOr(staleRule.overpricedRatio, 1);

    if (isOverpricedButStale) {
      const openingOffer = Math.max(1, Math.floor(profitableMaxOffer * (1 - numberOr(staleRule.openingOfferDiscountPercent, 0) / 100)));
      return {
        decision: 'aggressive_negotiation',
        reason: 'overpriced_but_stale',
        score: 0,
        netProfit,
        grossMarginPercent,
        requiredNetProfit,
        profitableMaxOffer,
        openingOffer,
        abandonIfCounterAbove: profitableMaxOffer,
        message: renderTemplate(config.messageTemplates.negotiateAggressive, { offer: openingOffer }),
      };
    }

    return { decision: 'ignore', reason: 'insufficient_margin', score: 0, netProfit, grossMarginPercent, requiredNetProfit };
  }

  if (categoryResult.exceptionalOnly) {
    const exceptional = config.storage || {};
    if (netProfit < numberOr(exceptional.exceptionalMarginNetProfit, Infinity)
      && grossMarginPercent < numberOr(exceptional.exceptionalMarginPercent, Infinity)) {
      return { decision: 'ignore', reason: 'exceptional_category_requires_exceptional_margin', score: 0, netProfit, grossMarginPercent };
    }
  }

  const weights = config.scoring.weights;
  const bulkinessRank = BULKINESS_RANK[normalizeCategory(listing.bulkiness || 'small')] ?? BULKINESS_RANK.medium;
  const fragilityRank = FRAGILITY_RANK[normalizeCategory(listing.fragility || 'medium')] ?? FRAGILITY_RANK.medium;
  const maxStorageDays = numberOr(config.storage?.maxStorageDays, 1);
  const factors = {
    margin: clamp(netProfit / Math.max(numberOr(config.margins?.minNetProfit, 1) * 3, 1)),
    demand: clamp(numberOr(listing.demandScore, 0.5)),
    resaleSpeed: clamp(numberOr(listing.resaleSpeedScore, 0.5)),
    risk: 1 - clamp(numberOr(listing.riskScore, 0.5)),
    distance: 1 - clamp(numberOr(listing.distanceKm, 0) / numberOr(config.location?.radiusKm, 1)),
    bulkiness: 1 - clamp(bulkinessRank / BULKINESS_RANK.oversized),
    fragility: 1 - clamp(fragilityRank / FRAGILITY_RANK.high),
    storageTime: 1 - clamp(numberOr(listing.expectedStorageDays, 0) / maxStorageDays),
  };
  const score = Math.round(Object.entries(weights).reduce((sum, [key, weight]) => sum + factors[key] * weight, 0) * 100);
  const excellentDeal = config.specialRules?.excellent_deal_no_negotiation;
  const shouldBuyDirect = excellentDeal?.enabled
    && netProfit >= numberOr(excellentDeal.minNetProfit, Infinity)
    && grossMarginPercent >= numberOr(excellentDeal.minGrossMarginPercent, Infinity)
    && numberOr(listing.riskScore, 1) <= numberOr(excellentDeal.maxRiskScore, 0);
  const decision = shouldBuyDirect || score >= config.scoring.buyDirectScore
    ? 'buy_direct'
    : score >= config.scoring.negotiateScore
      ? 'negotiate'
      : score >= config.scoring.watchScore
        ? 'watch'
        : 'ignore';
  const profitableMaxOffer = calculateProfitableMaxOffer(listing, config);
  const offer = Math.min(numberOr(listing.price, 0), profitableMaxOffer);

  return {
    decision,
    reason: decision === 'ignore' ? 'score_below_threshold' : shouldBuyDirect ? 'excellent_deal_no_negotiation' : 'rules_passed',
    score,
    factors,
    netProfit,
    requiredNetProfit,
    grossMarginPercent,
    listingAgeBucket: getListingAgeBucket(listing.ageDays, config),
    profitableMaxOffer,
    abandonIfCounterAbove: profitableMaxOffer,
    message: decision === 'negotiate'
      ? renderTemplate(config.messageTemplates.negotiateStandard, { offer })
      : decision === 'buy_direct'
        ? config.messageTemplates.buyDirect
        : config.messageTemplates.askAvailability,
  };
}

function evaluateLeboncoinCounterOffer(listing, counterOffer, config = defaultConfig) {
  const profitableMaxOffer = calculateProfitableMaxOffer(listing, config);
  if (numberOr(counterOffer, 0) > profitableMaxOffer) {
    return {
      decision: 'abandon',
      reason: 'counter_above_profitable_ceiling',
      profitableMaxOffer,
      message: config.messageTemplates.abandonCounterAboveCeiling,
    };
  }

  return {
    decision: 'continue_negotiation',
    reason: 'counter_within_profitable_ceiling',
    profitableMaxOffer,
  };
}

export {
  calculateProfitableMaxOffer,
  defaultConfig as defaultLeboncoinResaleConfig,
  estimateNetProfit,
  getRequiredNetProfit,
  evaluateLeboncoinCounterOffer,
  getListingAgeBucket,
  scoreLeboncoinListing,
  validateLeboncoinResaleConfig,
};

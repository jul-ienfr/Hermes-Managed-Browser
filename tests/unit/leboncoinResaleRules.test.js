import { describe, expect, test } from '@jest/globals';
import {
  calculateProfitableMaxOffer,
  defaultLeboncoinResaleConfig,
  evaluateLeboncoinCounterOffer,
  getRequiredNetProfit,
  getListingAgeBucket,
  scoreLeboncoinListing,
  validateLeboncoinResaleConfig,
} from '../../lib/leboncoin-resale-rules.js';

function validListing(overrides = {}) {
  return {
    title: 'Nintendo Switch Lite',
    category: 'video_games',
    price: 70,
    estimatedResalePrice: 125,
    estimatedRepairCost: 5,
    distanceKm: 5,
    bulkiness: 'small',
    fragility: 'medium',
    expectedStorageDays: 7,
    demandScore: 0.9,
    resaleSpeedScore: 0.8,
    riskScore: 0.2,
    ageDays: 3,
    attributes: [],
    ...overrides,
  };
}

describe('leboncoin resale rules', () => {
  test('validates the default resale config', () => {
    expect(validateLeboncoinResaleConfig(defaultLeboncoinResaleConfig)).toEqual({
      ok: true,
      errors: [],
    });
  });

  test('rejects invalid config with overlapping categories and bad weights', () => {
    const config = structuredClone(defaultLeboncoinResaleConfig);
    config.categories.banned.push('video_games');
    config.scoring.weights.margin = 0.5;

    const validation = validateLeboncoinResaleConfig(config);

    expect(validation.ok).toBe(false);
    expect(validation.errors).toContain('categories.allowed and categories.banned must not overlap');
    expect(validation.errors).toContain('scoring.weights must sum to 1');
  });

  test('enforces phase 1 small-object storage rules', () => {
    const result = scoreLeboncoinListing(validListing({ bulkiness: 'medium' }));

    expect(result).toMatchObject({
      decision: 'ignore',
      reason: 'not_phase_1_small_object',
      score: 0,
    });
  });

  test('rejects banned categories before scoring', () => {
    const result = scoreLeboncoinListing(validListing({ category: 'furniture' }));

    expect(result).toMatchObject({
      decision: 'ignore',
      reason: 'banned_category',
      score: 0,
    });
  });

  test('scores a profitable nearby listing as buy', () => {
    const result = scoreLeboncoinListing(validListing());

    expect(result.decision).toBe('negotiate');
    expect(result.score).toBeGreaterThanOrEqual(defaultLeboncoinResaleConfig.scoring.negotiateScore);
    expect(result.netProfit).toBe(50);
    expect(result.requiredNetProfit).toBe(40);
    expect(result.grossMarginPercent).toBeCloseTo(78.57, 1);
    expect(result.listingAgeBucket.name).toBe('normal');
    expect(result.message).toContain('70 €');
  });

  test('recommends aggressive negotiation for overpriced but stale listings', () => {
    const result = scoreLeboncoinListing(validListing({
      price: 260,
      estimatedResalePrice: 300,
      ageDays: 30,
    }));

    expect(result).toMatchObject({
      decision: 'aggressive_negotiation',
      reason: 'overpriced_but_stale',
      profitableMaxOffer: 225,
      openingOffer: 180,
      abandonIfCounterAbove: 225,
    });
    expect(result.message).toContain('180 €');
  });

  test('abandons negotiation when counter-offer exceeds profitable ceiling', () => {
    const listing = validListing({ price: 140, estimatedResalePrice: 150 });

    expect(evaluateLeboncoinCounterOffer(listing, 112)).toMatchObject({
      decision: 'abandon',
      reason: 'counter_above_profitable_ceiling',
      profitableMaxOffer: 105,
    });
  });

  test('continues negotiation when counter-offer is profitable', () => {
    const listing = validListing({ price: 140, estimatedResalePrice: 150 });

    expect(evaluateLeboncoinCounterOffer(listing, 100)).toMatchObject({
      decision: 'continue_negotiation',
      reason: 'counter_within_profitable_ceiling',
      profitableMaxOffer: 105,
    });
  });

  test('returns listing age buckets', () => {
    expect(getListingAgeBucket(1).name).toBe('fresh');
    expect(getListingAgeBucket(20).name).toBe('stale');
    expect(getListingAgeBucket(90).name).toBe('very_stale');
  });

  test('caps profitable offer by margin, profit, and budget constraints', () => {
    expect(calculateProfitableMaxOffer(validListing({ estimatedResalePrice: 300 }))).toBe(225);
  });

  test('applies price-band net profit thresholds', () => {
    expect(getRequiredNetProfit(40)).toBe(20);
    expect(getRequiredNetProfit(70)).toBe(40);
    expect(getRequiredNetProfit(180)).toBe(70);
    expect(getRequiredNetProfit(260)).toBe(120);
  });

  test('forbids non-browser Leboncoin access policies in config', () => {
    const config = structuredClone(defaultLeboncoinResaleConfig);
    config.browserPolicy.forbidDirectLeboncoinApi = false;

    const validation = validateLeboncoinResaleConfig(config);

    expect(validation.ok).toBe(false);
    expect(validation.errors).toContain('browserPolicy.forbidDirectLeboncoinApi must be true');
  });

  test('forces excellent deals to buy direct instead of negotiating', () => {
    const result = scoreLeboncoinListing(validListing({
      price: 80,
      estimatedResalePrice: 210,
      demandScore: 0.95,
      resaleSpeedScore: 0.95,
      riskScore: 0.1,
    }));

    expect(result).toMatchObject({
      decision: 'buy_direct',
      reason: 'excellent_deal_no_negotiation',
    });
    expect(result.message).toBe(defaultLeboncoinResaleConfig.messageTemplates.buyDirect);
  });

  test('keeps exceptional-only bulky categories ignored unless margin is exceptional', () => {
    const result = scoreLeboncoinListing(validListing({
      category: 'yoyo_stroller',
      price: 110,
      estimatedResalePrice: 160,
    }));

    expect(result).toMatchObject({
      decision: 'ignore',
      reason: 'exceptional_category_requires_exceptional_margin',
    });
  });
});

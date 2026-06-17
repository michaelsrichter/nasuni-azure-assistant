import { describe, it, expect } from 'vitest';
import { estimateCost, formatCost, MODEL_PRICES } from '../pricing';

describe('estimateCost', () => {
  it('computes cost for gpt-4.1-mini against known rates', () => {
    const price = MODEL_PRICES['gpt-4.1-mini'];
    const cost = estimateCost('gpt-4.1-mini', { inputTokens: 1_000_000, outputTokens: 0 });
    expect(cost).toBeCloseTo(price.inputPer1M, 6);
  });

  it('sums input + output for a small usage', () => {
    // 4295 in @ $0.40/1M + 88 out @ $1.60/1M
    const cost = estimateCost('gpt-4.1-mini', { inputTokens: 4295, outputTokens: 88 });
    const expected = (4295 / 1_000_000) * 0.40 + (88 / 1_000_000) * 1.60;
    expect(cost).toBeCloseTo(expected, 8);
  });

  it('returns null for unknown models', () => {
    expect(estimateCost('something-new', { inputTokens: 100, outputTokens: 100 })).toBeNull();
  });
});

describe('formatCost', () => {
  it('shows < $0.0001 for very small costs', () => {
    expect(formatCost(0.00001)).toBe('< $0.0001');
  });

  it('shows 5 decimals for mid-range costs', () => {
    expect(formatCost(0.00123)).toBe('$0.00123');
  });

  it('shows 4 decimals for larger costs', () => {
    expect(formatCost(0.5)).toBe('$0.5000');
  });

  it('shows em dash for null', () => {
    expect(formatCost(null)).toBe('—');
  });
});

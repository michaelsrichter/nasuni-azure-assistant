// Public list prices for Foundry-hosted OpenAI models, in USD per 1M tokens.
// Verified 2026-06-17 from https://azure.microsoft.com/en-us/pricing/details/cognitive-services/openai-service/
// Update this table when you swap models or when Microsoft revises pricing.

export interface ModelPrice {
  inputPer1M: number;
  outputPer1M: number;
}

export const MODEL_PRICES: Record<string, ModelPrice> = {
  'gpt-4.1-mini': { inputPer1M: 0.40, outputPer1M: 1.60 },
  'gpt-4.1': { inputPer1M: 2.00, outputPer1M: 8.00 },
  'gpt-4o-mini': { inputPer1M: 0.15, outputPer1M: 0.60 },
  'gpt-4o': { inputPer1M: 2.50, outputPer1M: 10.00 },
};

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens?: number;
}

export function estimateCost(model: string, usage: TokenUsage): number | null {
  const price = MODEL_PRICES[model] ?? MODEL_PRICES[model.toLowerCase()];
  if (!price) return null;
  return (
    (usage.inputTokens / 1_000_000) * price.inputPer1M +
    (usage.outputTokens / 1_000_000) * price.outputPer1M
  );
}

export function formatCost(cost: number | null): string {
  if (cost === null) return '—';
  if (cost < 0.0001) return '< $0.0001';
  if (cost < 0.01) return `$${cost.toFixed(5)}`;
  return `$${cost.toFixed(4)}`;
}

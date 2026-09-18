/** USD list prices verified on 2026-09-18. Each calculated charge saves its own rate snapshot. */
export const ASTRA_PRICING = {
  model: "gpt-6-astra",
  currency: "USD",
  verifiedAt: "2026-09-18",
  source: "https://developers.openai.com/api/docs/models/gpt-6-astra",
  inputPerMillion: 10,
  cachedInputPerMillion: 1,
  cacheWritePerMillion: 12.5,
  outputPerMillion: 50,
  longContextThreshold: 272000,
} as const;

export type ModelUsage = {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  serviceTier?: string;
  cost?: number;
  costSource?: "provider" | "calculated";
  costNote?: string;
  pricing?: typeof ASTRA_PRICING & {
    inputMultiplier: number;
    outputMultiplier: number;
  };
  costBreakdown?: {
    input: number;
    cachedInput: number;
    cacheWrite: number;
    output: number;
  };
};

export type RunCost = {
  currency: "USD";
  totalUsd: number | null;
  reportedUsd: number;
  calculatedUsd: number;
  pricedRequests: number;
  unpricedRequests: number;
  pendingRequests: number;
  estimated: boolean;
  complete: boolean;
};

export const finiteCost = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
const tokens = (value: unknown): value is number =>
  finiteCost(value) && Number.isSafeInteger(value);
export const roundUsd = (value: number) => Math.round(value * 1e12) / 1e12;
export function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function priceAstraUsage(usage: ModelUsage, model: string): ModelUsage {
  if (finiteCost(usage.cost)) return usage;
  if (!/^gpt-6-astra(?:-\d{4}-\d{2}-\d{2})?$/.test(model))
    return { ...usage, costNote: "No verified price for this model." };
  if (usage.serviceTier !== "default")
    return {
      ...usage,
      costNote: "The served pricing tier is unknown or unsupported.",
    };
  const { inputTokens: input, outputTokens: output } = usage;
  if (!tokens(input) || !tokens(output))
    return { ...usage, costNote: "Token usage was not reported." };
  // The documented minimum cacheable prefix is 1,024 visible tokens.
  const cached = usage.cachedInputTokens ?? (input < 1024 ? 0 : undefined);
  const written = usage.cacheWriteTokens ?? (input < 1024 ? 0 : undefined);
  if (!tokens(cached) || !tokens(written) || cached + written > input)
    return {
      ...usage,
      costNote: "Cache token counts are missing or inconsistent.",
    };
  const inputMultiplier = input > ASTRA_PRICING.longContextThreshold ? 2 : 1;
  const outputMultiplier = input > ASTRA_PRICING.longContextThreshold ? 1.5 : 1;
  const costBreakdown = {
    input: roundUsd(
      ((input - cached - written) *
        ASTRA_PRICING.inputPerMillion *
        inputMultiplier) /
        1e6,
    ),
    cachedInput: roundUsd(
      (cached * ASTRA_PRICING.cachedInputPerMillion * inputMultiplier) / 1e6,
    ),
    cacheWrite: roundUsd(
      (written * ASTRA_PRICING.cacheWritePerMillion * inputMultiplier) / 1e6,
    ),
    // output_tokens already includes reasoning; never add reasoning_tokens again.
    output: roundUsd(
      (output * ASTRA_PRICING.outputPerMillion * outputMultiplier) / 1e6,
    ),
  };
  return {
    ...usage,
    cachedInputTokens: cached,
    cacheWriteTokens: written,
    cost: roundUsd(Object.values(costBreakdown).reduce((a, b) => a + b, 0)),
    costSource: "calculated",
    pricing: { ...ASTRA_PRICING, inputMultiplier, outputMultiplier },
    costBreakdown,
  };
}

/** Keep only billing fields; never persist raw provider responses or reasoning content. */
export function readUsage(
  value: unknown,
  provider: "openai" | "openrouter",
  model: string,
  serviceTier?: unknown,
): ModelUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = object(value);
  const input = object(raw.input_tokens_details ?? raw.prompt_tokens_details);
  const output = object(
    raw.output_tokens_details ?? raw.completion_tokens_details,
  );
  const usage: ModelUsage = {};
  for (const [name, count] of Object.entries({
    inputTokens: raw.input_tokens ?? raw.prompt_tokens,
    outputTokens: raw.output_tokens ?? raw.completion_tokens,
    cachedInputTokens: input.cached_tokens,
    cacheWriteTokens: input.cache_write_tokens,
    reasoningTokens: output.reasoning_tokens,
  }))
    if (tokens(count)) Object.assign(usage, { [name]: count });
  if (provider === "openrouter") {
    if (finiteCost(raw.cost))
      Object.assign(usage, { cost: raw.cost, costSource: "provider" });
    else usage.costNote = "OpenRouter did not report a charge.";
    return usage;
  }
  usage.serviceTier = typeof serviceTier === "string" ? serviceTier : "default";
  return priceAstraUsage(usage, model);
}

export const formatUsd = (value: number | null) =>
  value === null
    ? "—"
    : value > 0 && value < 0.000001
      ? "<$0.000001"
      : `$${value.toFixed(value === 0 ? 2 : value < 0.01 ? 6 : value < 1 ? 5 : 4)}`;
export function costDescription(cost: RunCost): string {
  const basis = cost.estimated
    ? "Calculated from token usage"
    : "Provider reported";
  const gaps = [
    cost.unpricedRequests ? `${cost.unpricedRequests} unpriced` : "",
    cost.pendingRequests ? `${cost.pendingRequests} pending` : "",
  ].filter(Boolean);
  return gaps.length
    ? `${basis} · ${gaps.join(" · ")}`
    : cost.pricedRequests
      ? basis
      : "No requests yet";
}

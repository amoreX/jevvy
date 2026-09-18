export const MODELS = {
  jev: {
    name: "Jev",
    label: "Jev 1.13",
    id: "typesafe/jev-1.13",
    provider: "openrouter",
    keyName: "OPENROUTER_API_KEY",
    reasoning: null,
  },
  astra: {
    name: "Astra",
    label: "GPT-6 Astra · Medium",
    id: "gpt-6-astra",
    provider: "openai",
    keyName: "OPENAI_API_KEY",
    reasoning: "medium",
  },
  glm: {
    name: "GLM",
    label: "GLM 5.3 · Low",
    id: "z-ai/glm-5.3",
    provider: "openrouter",
    keyName: "OPENROUTER_API_KEY",
    reasoning: "low",
  },
} as const;
export type PlayerId = keyof typeof MODELS;
export type ProviderId = (typeof MODELS)[PlayerId]["provider"];
export const PROVIDERS = {
  openai: "OpenAI",
  openrouter: "OpenRouter",
} as const;
export function isPlayerId(value: unknown): value is PlayerId {
  return typeof value === "string" && Object.hasOwn(MODELS, value);
}

/** Historical labels use the settings saved with the run, not today's defaults. */
export function modelLabel(
  model: PlayerId,
  reasoning: string | null = MODELS[model].reasoning,
) {
  const base = MODELS[model].label.split(" · ")[0];
  return reasoning
    ? `${base} · ${reasoning[0].toUpperCase()}${reasoning.slice(1)}`
    : base;
}

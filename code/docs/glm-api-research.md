# GLM 5.3 through OpenRouter

Checked 18 September 2026 against the live public catalog and official documentation. Research only: no keys read and no paid inference requests made.

## Model selection

Use **`z-ai/glm-5.3`**, currently mapped to canonical slug **`z-ai/glm-5.3-20260816`**. Z.ai identifies GLM 5.3 as its latest flagship. OpenRouter lists its release as 18 August 2026. GLM 5.3 Flash was listed later, on 26 August, but is a separate efficiency-oriented variant; it does not supersede the flagship requested for this comparison. No later flagship appeared in the live catalog. Save the actual response model alongside the requested ID. [Live catalog](https://openrouter.ai/api/v1/models), [GLM 5.3 model page](https://openrouter.ai/z-ai/glm-5.3), [GLM 5.3 Flash](https://openrouter.ai/z-ai/glm-5.3-flash), [Z.ai model documentation](https://docs.z.ai/guides/llm/glm-5.3).

The catalog reports mandatory reasoning with supported efforts `max`, `high`, and `low`, defaulting to `max`. **There is no `medium` setting.** Z.ai independently documents the same restriction and rejects disabling thinking. Use OpenRouter's normalized `reasoning` object rather than copying Z.ai's direct-provider `thinking` fields. [Live catalog](https://openrouter.ai/api/v1/models), [Z.ai migration guide](https://docs.z.ai/guides/overview/migrate-to-glm-new).

## Request and response

Call server-side **`POST https://openrouter.ai/api/v1/chat/completions`**, with the existing OpenRouter Bearer key and JSON content type. This uses standard chat completions, unlike Jev's Decisions API. Send the same chess state, SAN history, and all legal moves used for Astra, without Stockfish scores or rankings. [OpenRouter request examples](https://openrouter.ai/docs/guides/routing/provider-selection).

Recommended application settings:

```json
{
  "model": "z-ai/glm-5.3",
  "messages": [
    { "role": "system", "content": "Choose the strongest legal chess move for White. Return the requested JSON." },
    { "role": "user", "content": "<serialized current state and all legal moves>" }
  ],
  "reasoning": { "effort": "max", "exclude": true },
  "max_tokens": 16384,
  "stream": false,
  "provider": { "require_parameters": true },
  "response_format": {
    "type": "json_schema",
    "json_schema": {
      "name": "chess_move",
      "strict": true,
      "schema": {
        "type": "object",
        "properties": { "move": { "type": "string", "enum": ["<every legal UCI move>"] } },
        "required": ["move"],
        "additionalProperties": false
      }
    }
  }
}
```

The placeholder enum must be replaced with the complete legal move set. OpenRouter documents this strict JSON-schema form and recommends `provider.require_parameters: true`. The live GLM model advertises `response_format` and `structured_outputs`; multiple provider endpoints advertise those capabilities plus reasoning. `require_parameters` excludes endpoints that would ignore requested parameters, while default provider failover remains enabled. Do not hard-pin a provider unless required; record the actual returned provider for reproducibility. [Structured outputs](https://openrouter.ai/docs/guides/features/structured-outputs), [Provider routing](https://openrouter.ai/docs/guides/routing/provider-selection), [Live GLM endpoints](https://openrouter.ai/api/v1/models/z-ai/glm-5.3/endpoints).

Parse `choices[0].message.content` as JSON and independently validate its move against the exact position. Preserve billing before checking completion validity. Reject missing content, invalid JSON, refusals, illegal moves, and incomplete responses instead of substituting an engine move.

`reasoning.exclude: true` hides returned reasoning text; it does not disable thinking or remove its charge. Reasoning and visible output generally share `max_tokens`. A budget-exhausted response can have `finish_reason: "length"`, empty content, and billable usage. The 16,384-token cap and a 300-second application timeout are implementation choices, not provider guarantees. Retain failed-attempt receipts and mark unavailable charges unknown. [Reasoning controls and token limits](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens).

## Limits and billing

Z.ai documents 1M context and 128K maximum output. OpenRouter's aggregated catalog reports 1,310,720 context, but actual endpoint limits differ; several endpoints advertise 131,072 output while others advertise more. The proposed 16,384 cap fits the inspected endpoints. Do not treat the largest aggregated limit as universal. [Z.ai model documentation](https://docs.z.ai/guides/llm/glm-5.3), [Live endpoint limits](https://openrouter.ai/api/v1/models/z-ai/glm-5.3/endpoints).

The live catalog snapshot showed **$1.40/M input, $4.40/M output, and $0.26/M cached input**. Individual providers had different prices and discounts, and model-page values changed between retrievals. These figures are context only: use the response's **`usage.cost`** as the recorded OpenRouter inference charge. Save response ID, provider, model, tokens, cost, and request settings. An absent cost is unknown, never zero. Credit-purchase fees are separate from per-request inference cost. [Live pricing](https://openrouter.ai/api/v1/models), [OpenRouter billing support](https://openrouter.ai/support).

Current usage documentation says detailed accounting is returned automatically for non-streaming responses and the final streaming event. **`usage: { include: true }` and `stream_options.include_usage` are deprecated and have no effect**, despite older support/blog examples. Omit both. `usage.cost` is the total charged to the account; `cost_details.upstream_inference_cost` is a distinct upstream cost and must not replace it. The generation ID can also retrieve historical usage via the generation endpoint. [Current usage accounting documentation](https://openrouter.ai/docs/cookbook/administration/usage-accounting).

This establishes catalog-level compatibility, not this account's runtime access or reliability. The first authorized benchmark game should verify real parsing and cost receipts before increasing concurrency. Report the comparison as **GLM 5.3 Max versus Astra Medium**: keeping chess rules and opponent settings equal does not make their reasoning budgets equivalent.

## Runtime follow-up

The initial Max run repeatedly exhausted the 16,384-token cap and sometimes timed out. It was stopped with 20 partial games, no completed results, $2.261918662 in reported charges and four attempts with unknown charges. These logs remain in `data/benchmarks/2026-09-18-glm-50/`. A separate fresh 50-game run uses **Low reasoning**, and the site now labels that setting explicitly. Historical logs retain their original Max label; switching a saved run to another reasoning setting is rejected. Low is an application choice for practical completion, not the model default or an equivalent of Astra Medium.

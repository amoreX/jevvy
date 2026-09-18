import { MODELS } from "./models";
import type { JevDecision } from "./jev";
import { createDecisionRequest } from "./server-jev";
import { EngineError } from "./native-stockfish";
import { object, readUsage } from "./costs";
import { ProviderError, type ProviderReceipt } from "./provider-error";

export function createGlmRequest(input: unknown) {
  const context = createDecisionRequest(input);
  return {
    model: MODELS.glm.id,
    reasoning: { effort: MODELS.glm.reasoning, exclude: true },
    max_tokens: 16384,
    stream: false,
    provider: { require_parameters: true },
    messages: [
      {
        role: "system",
        content: `${context.questions.move.instructions} Return only the selected UCI move in the required JSON object.`,
      },
      {
        role: "user",
        content: JSON.stringify({
          state: context.state,
          legal_moves: context.questions.move.criteria,
        }),
      },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "chess_move",
        strict: true,
        schema: {
          type: "object",
          properties: {
            move: {
              type: "string",
              enum: Object.keys(context.questions.move.criteria),
            },
          },
          required: ["move"],
          additionalProperties: false,
        },
      },
    },
  };
}

let activeRequests = 0;
const requestLimit = Math.min(
  50,
  Math.max(
    2,
    Math.floor(Number(process.env.CHESS_BENCHMARK_GLM_CONCURRENCY) || 2),
  ),
);

export async function chooseGlmMove(
  input: unknown,
  signal: AbortSignal,
): Promise<JevDecision> {
  const context = createDecisionRequest(input);
  const payload = createGlmRequest(input);
  const key = process.env.OPENROUTER_API_KEY?.trim();
  if (!key)
    throw new EngineError(
      "Add OPENROUTER_API_KEY to code/.env.local and restart the server, then retry.",
    );
  if (signal.aborted) throw new EngineError("GLM request cancelled.", 499);
  if (activeRequests >= requestLimit)
    throw new EngineError("GLM is busy. Retry in a moment.", 429);
  activeRequests++;
  const started = Date.now();
  const timeout = AbortSignal.timeout(300000);
  let receipt: ProviderReceipt = {};
  try {
    const response = await fetch(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",
        cache: "no-store",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.any([signal, timeout]),
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      const messages: Record<number, string> = {
        401: "OpenRouter rejected the API key. Check the server configuration.",
        402: "OpenRouter needs credits before GLM can play.",
        403: "This OpenRouter account cannot access GLM 5.3.",
        404: "GLM 5.3 has no available provider for the requested settings.",
        429: "OpenRouter's rate limit was reached. Wait a moment, then retry.",
      };
      throw new EngineError(
        messages[response.status] ??
          "GLM could not respond. Retry to continue.",
        response.status === 429 ? 429 : 502,
      );
    }
    const data = object(await response.json());
    receipt = {
      model: typeof data.model === "string" ? data.model : MODELS.glm.id,
      ...(typeof data.id === "string" ? { responseId: data.id } : {}),
      usage: readUsage(data.usage, "openrouter", MODELS.glm.id),
    };
    const choice = object(Array.isArray(data.choices) ? data.choices[0] : null);
    const message = object(choice.message);
    if (choice.finish_reason === "length")
      throw new EngineError(
        "GLM reached its response token limit before choosing a move. Retry to continue.",
        502,
      );
    if (
      choice.finish_reason !== "stop" ||
      message.refusal ||
      typeof message.content !== "string"
    )
      throw new EngineError(
        "GLM did not complete a move. Retry to continue.",
        502,
      );
    let move: unknown;
    try {
      move = JSON.parse(message.content).move;
    } catch {
      throw new EngineError(
        "GLM returned invalid move JSON. Retry to continue.",
        502,
      );
    }
    if (
      typeof move !== "string" ||
      !Object.hasOwn(context.questions.move.criteria, move)
    )
      throw new EngineError(
        "GLM did not select a legal move. Retry to continue.",
        502,
      );
    if (
      typeof data.model !== "string" ||
      !/^z-ai\/glm-5\.3(?:-\d{8})?$/.test(data.model)
    )
      throw new EngineError(
        "OpenRouter returned a different model than GLM 5.3.",
        502,
      );
    return {
      move,
      fen: context.state.fen,
      model: data.model,
      reasoning: MODELS.glm.reasoning,
      choices: Object.keys(context.questions.move.criteria),
      latencyMs: Date.now() - started,
      ...(receipt.responseId ? { responseId: receipt.responseId } : {}),
      ...(receipt.usage ? { usage: receipt.usage } : {}),
    };
  } catch (error) {
    const failure = signal.aborted
      ? new EngineError("GLM request cancelled.", 499)
      : timeout.aborted
        ? new EngineError(
            "GLM took too long to respond. Retry to continue.",
            504,
          )
        : error instanceof EngineError
          ? error
          : new EngineError(
              "Could not read GLM's response. Retry to continue.",
              502,
            );
    throw new ProviderError(failure.message, failure.status, receipt);
  } finally {
    activeRequests--;
  }
}

import { MODELS } from "./models";
import type { JevDecision } from "./jev";
import { createDecisionRequest } from "./server-jev";
import { EngineError } from "./native-stockfish";
import { readUsage } from "./costs";
import { ProviderError, type ProviderReceipt } from "./provider-error";

export function createAstraRequest(input: unknown) {
  const context = createDecisionRequest(input);
  return {
    model: MODELS.astra.id,
    reasoning: { effort: "medium" },
    max_output_tokens: Math.min(
      16384,
      Math.max(
        4096,
        Math.floor(
          Number(process.env.CHESS_BENCHMARK_ASTRA_MAX_OUTPUT_TOKENS) || 4096,
        ),
      ),
    ),
    store: false,
    service_tier: "default",
    input: [
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
    text: {
      format: {
        type: "json_schema",
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
// A separate benchmark process may opt into a larger pool; the website defaults to two.
const requestLimit = Math.min(
  50,
  Math.max(
    2,
    Math.floor(Number(process.env.CHESS_BENCHMARK_ASTRA_CONCURRENCY) || 2),
  ),
);
export async function chooseAstraMove(
  input: unknown,
  signal: AbortSignal,
): Promise<JevDecision> {
  const context = createDecisionRequest(input);
  const payload = createAstraRequest(input);
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key)
    throw new EngineError(
      "Add OPENAI_API_KEY to code/.env.local and restart the server, then retry.",
    );
  if (signal.aborted) throw new EngineError("Astra request cancelled.", 499);
  if (activeRequests >= requestLimit)
    throw new EngineError("Astra is busy. Retry in a moment.", 429);
  activeRequests++;
  const started = Date.now();
  const timeout = AbortSignal.timeout(
    Math.min(
      300000,
      Math.max(
        90000,
        Number(process.env.CHESS_BENCHMARK_ASTRA_TIMEOUT_MS) || 90000,
      ),
    ),
  );
  let receipt: ProviderReceipt = {};
  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      cache: "no-store",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.any([signal, timeout]),
    });
    if (!response.ok) {
      await response.body?.cancel();
      const message =
        response.status === 401
          ? "OpenAI rejected the API key. Check the server configuration."
          : response.status === 403 || response.status === 404
            ? "GPT-6 Astra is unavailable to this OpenAI project. Check model access."
            : response.status === 429
              ? "OpenAI's rate limit or quota was reached. Check API billing or wait, then retry."
              : "Astra could not respond. Retry to continue.";
      throw new EngineError(message, response.status === 429 ? 429 : 502);
    }
    const data = await response.json();
    receipt = {
      model: typeof data.model === "string" ? data.model : MODELS.astra.id,
      ...(typeof data.id === "string" ? { responseId: data.id } : {}),
      usage: readUsage(
        data.usage,
        "openai",
        typeof data.model === "string" ? data.model : MODELS.astra.id,
        data.service_tier,
      ),
    };
    if (
      data.status === "incomplete" &&
      data.incomplete_details?.reason === "max_output_tokens"
    )
      throw new EngineError(
        "Astra reached its response token limit before choosing a move. Retry to continue.",
        502,
      );
    if (data.status !== "completed" || !Array.isArray(data.output))
      throw new EngineError(
        "Astra did not complete its response. Retry to continue.",
        502,
      );
    const texts: string[] = [];
    for (const item of data.output) {
      if (item?.type !== "message" || !Array.isArray(item.content)) continue;
      for (const part of item.content) {
        if (part?.type === "refusal")
          throw new EngineError(
            "Astra declined to choose a move. Retry to continue.",
            502,
          );
        if (part?.type === "output_text" && typeof part.text === "string")
          texts.push(part.text);
      }
    }
    const content = texts.join("");
    if (!content || typeof data.model !== "string")
      throw new EngineError(
        "Astra did not return a move. Retry to continue.",
        502,
      );
    let move: unknown;
    try {
      move = JSON.parse(content).move;
    } catch {
      throw new EngineError(
        "Astra returned invalid move JSON. Retry to continue.",
        502,
      );
    }
    if (
      typeof move !== "string" ||
      !Object.hasOwn(context.questions.move.criteria, move)
    )
      throw new EngineError(
        "Astra did not select a legal move. Retry to continue.",
        502,
      );
    return {
      move,
      fen: context.state.fen,
      model: data.model,
      reasoning: "medium",
      choices: Object.keys(context.questions.move.criteria),
      latencyMs: Date.now() - started,
      ...(receipt.responseId ? { responseId: receipt.responseId } : {}),
      ...(receipt.usage ? { usage: receipt.usage } : {}),
    };
  } catch (error) {
    const failure = signal.aborted
      ? new EngineError("Astra request cancelled.", 499)
      : timeout.aborted
        ? new EngineError(
            "Astra took too long to respond. Retry to continue.",
            504,
          )
        : error instanceof EngineError
          ? error
          : new EngineError(
              "Could not read Astra's response. Retry to continue.",
              502,
            );
    throw new ProviderError(failure.message, failure.status, receipt);
  } finally {
    activeRequests--;
  }
}

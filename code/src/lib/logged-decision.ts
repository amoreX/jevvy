import { randomUUID } from "node:crypto";
import { createRun, readRun, appendRunEvent } from "./run-store";
import { createDecisionRequest, chooseJevMove } from "./server-jev";
import { createAstraRequest, chooseAstraMove } from "./server-astra";
import { createGlmRequest, chooseGlmMove } from "./server-glm";
import { EngineError } from "./native-stockfish";
import { MODELS, type PlayerId } from "./models";
import { runProvider } from "./run-types";
import { ProviderError } from "./provider-error";

/** Record the exact model input before spending credits, then the outcome of every attempt. */
export async function loggedDecision(
  model: PlayerId,
  input: unknown,
  signal: AbortSignal,
) {
  const context = createDecisionRequest(input);
  const players = {
    jev: { choose: chooseJevMove, request: createDecisionRequest },
    astra: { choose: chooseAstraMove, request: createAstraRequest },
    glm: { choose: chooseGlmMove, request: createGlmRequest },
  };
  const { choose, request } = players[model];
  if (!process.env[MODELS[model].keyName]?.trim()) return choose(input, signal);
  const suppliedId = (input as Record<string, unknown>).runId;
  if (suppliedId !== undefined && typeof suppliedId !== "string")
    throw new EngineError("Invalid run ID.", 400);
  const log = suppliedId
    ? await readRun(suppliedId)
    : await createRun(model, context.state.fen);
  if (
    log.model !== model ||
    log.modelId !== MODELS[model].id ||
    log.reasoning !== MODELS[model].reasoning ||
    runProvider(log) !== MODELS[model].provider
  )
    throw new EngineError(
      "This run belongs to a different model, provider or reasoning setting. Start a new game to change models.",
      409,
    );
  const requestId = randomUUID();
  await appendRunEvent(log.id, "decision_request", {
    requestId,
    provider: MODELS[model].provider,
    request: request(input),
  });
  try {
    const decision = await choose(input, signal);
    await appendRunEvent(log.id, "decision_result", { requestId, ...decision });
    return decision;
  } catch (error) {
    await appendRunEvent(log.id, "decision_error", {
      requestId,
      message:
        error instanceof EngineError
          ? error.message
          : "The model request failed.",
      status: error instanceof EngineError ? error.status : 503,
      ...(error instanceof ProviderError ? error.receipt : {}),
    });
    throw error;
  }
}

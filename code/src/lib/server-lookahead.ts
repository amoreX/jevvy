import {
  analyzeLegalMoves,
  parseEngineRequest,
  EngineError,
} from "./native-stockfish";
import {
  describeContinuation,
  LOOKAHEAD_SETTINGS,
  type LookaheadSettings,
} from "./lookahead";
import type { createDecisionRequest } from "./server-jev";

export async function prepareLookahead(
  input: unknown,
  payload: ReturnType<typeof createDecisionRequest>,
  signal: AbortSignal,
  settings: LookaheadSettings,
) {
  if (
    Object.entries(LOOKAHEAD_SETTINGS).some(
      ([key, value]) => settings[key as keyof LookaheadSettings] !== value,
    )
  ) {
    throw new EngineError(
      "This run uses different lookahead settings. Start a new game.",
      409,
    );
  }
  const started = Date.now();
  const position = (input as Record<string, unknown>).position;
  const search = { position, difficulty: "club" };
  const analysis = await analyzeLegalMoves(search, signal, settings);
  const { chess } = parseEngineRequest(search);
  const criteria = { ...payload.questions.move.criteria };
  try {
    for (const move of Object.keys(criteria)) {
      const pv = analysis.lines[move];
      if (!pv) throw new Error("Missing continuation.");
      const consequences = describeContinuation(
        chess,
        move,
        pv,
        settings.displayPlies,
      );
      criteria[move] +=
        " Predicted best-play continuation; actual play may differ. " +
        JSON.stringify(consequences);
    }
  } catch {
    throw new EngineError(
      "Stockfish returned an invalid lookahead continuation. Retry to continue.",
      503,
    );
  }
  return {
    payload: {
      ...payload,
      questions: { move: { ...payload.questions.move, criteria } },
    },
    metadata: {
      engine: analysis.engine,
      settings,
      depth: analysis.depth,
      analysisMs: Date.now() - started,
    },
  };
}

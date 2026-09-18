import { JEV_MODEL, type JevDecision } from "./jev";
import { EngineError, parseEngineRequest } from "./native-stockfish";
import { readUsage } from "./costs";
import { ProviderError, type ProviderReceipt } from "./provider-error";

const PIECES = {
  p: "pawn",
  n: "knight",
  b: "bishop",
  r: "rook",
  q: "queen",
  k: "king",
};

export function createDecisionRequest(input: unknown) {
  if (!input || typeof input !== "object")
    throw new EngineError("A chess position is required.", 400);
  const { chess } = parseEngineRequest({
    position: (input as Record<string, unknown>).position,
    difficulty: "club",
  });
  if (chess.turn() !== "w")
    throw new EngineError("Jev plays White. It is Black's turn.", 422);
  const moves = chess.moves({ verbose: true });
  if (moves.length > 255)
    throw new EngineError("This position exceeds Jev's 255-choice limit.", 422);
  const criteria = Object.fromEntries(
    moves.map((move) => [
      move.lan,
      `${move.san}: white ${PIECES[move.piece]} from ${move.from} to ${move.to}` +
        (move.captured
          ? `, captures a ${PIECES[move.captured]}${move.isEnPassant() ? " en passant" : ""}`
          : "") +
        (move.promotion ? `, promotes to ${PIECES[move.promotion]}` : "") +
        (move.isKingsideCastle() ? ", castles kingside" : "") +
        (move.isQueensideCastle() ? ", castles queenside" : "") +
        ".",
    ]),
  );
  const [, , castling, enPassant, halfmoves, fullmove] = chess.fen().split(" ");
  return {
    model: JEV_MODEL,
    state: {
      game: "standard chess",
      your_color: "white",
      side_to_move: "white",
      fen: chess.fen(),
      pieces: chess
        .board()
        .flat()
        .filter((piece) => piece !== null)
        .map(
          (piece) =>
            `${piece.color === "w" ? "white" : "black"} ${PIECES[piece.type]} on ${piece.square}`,
        ),
      move_history_san: chess.history(),
      in_check: chess.isCheck(),
      castling_rights: castling,
      en_passant_square: enPassant,
      halfmoves_since_pawn_move_or_capture: Number(halfmoves),
      fullmove_number: Number(fullmove),
    },
    questions: {
      move: {
        type: "choice" as const,
        instructions:
          "Choose the best next legal chess move for White to improve its position and ultimately checkmate Black. Each option is legal in this exact position. Select one move.",
        criteria,
      },
    },
  };
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

let activeRequests = 0;

export async function chooseJevMove(
  input: unknown,
  signal: AbortSignal,
  preparedPayload?: ReturnType<typeof createDecisionRequest>,
): Promise<JevDecision> {
  const payload = preparedPayload ?? createDecisionRequest(input);
  const key = process.env.OPENROUTER_API_KEY?.trim();
  if (!key)
    throw new EngineError(
      "Add OPENROUTER_API_KEY to code/.env.local and restart the server, then retry.",
      503,
    );
  if (signal.aborted) throw new EngineError("Jev request cancelled.", 499);
  if (activeRequests >= 2)
    throw new EngineError("Jev is busy. Retry in a moment.", 429);
  activeRequests++;
  const started = Date.now();
  const timeout = AbortSignal.timeout(30000);
  let receipt: ProviderReceipt = {};
  try {
    const response = await fetch("https://openrouter.ai/api/alpha/decisions", {
      method: "POST",
      cache: "no-store",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.any([signal, timeout]),
    });
    if (!response.ok) {
      const messages: Record<number, string> = {
        401: "OpenRouter rejected the API key. Check code/.env.local and restart the server.",
        402: "OpenRouter needs credits before Jev can play.",
        403: "This OpenRouter account cannot access Jev's Decisions API.",
        404: "Jev's model or Decisions endpoint is unavailable.",
        413: "The game state exceeds Jev's request limit.",
        429: "OpenRouter's rate limit was reached. Wait a moment, then retry.",
      };
      // Never forward an upstream body that could contain credentials or other private data.
      await response.body?.cancel();
      throw new EngineError(
        messages[response.status] ??
          "Jev could not respond. Retry to continue.",
        response.status === 429 ? 429 : 502,
      );
    }
    const data = object(await response.json());
    receipt = {
      model: typeof data.model === "string" ? data.model : JEV_MODEL,
      ...(typeof data.id === "string" ? { responseId: data.id } : {}),
      usage: readUsage(
        data.usage,
        "openrouter",
        typeof data.model === "string" ? data.model : JEV_MODEL,
      ),
    };
    const answer = object(object(data.answers).move);
    if (
      answer.type !== "choice" ||
      typeof answer.choice !== "string" ||
      !Object.hasOwn(payload.questions.move.criteria, answer.choice)
    ) {
      throw new EngineError(
        "Jev did not select a legal move. Retry to continue.",
        502,
      );
    }
    if (typeof data.model !== "string")
      throw new EngineError("Jev returned an invalid model response.", 502);
    return {
      move: answer.choice,
      fen: payload.state.fen,
      model: data.model,
      choices: Object.keys(payload.questions.move.criteria),
      latencyMs: Date.now() - started,
      ...(finite(answer.confidence) && answer.confidence <= 1
        ? { confidence: answer.confidence }
        : {}),
      ...(receipt.responseId ? { responseId: receipt.responseId } : {}),
      ...(receipt.usage ? { usage: receipt.usage } : {}),
    };
  } catch (error) {
    const failure = signal.aborted
      ? new EngineError("Jev request cancelled.", 499)
      : timeout.aborted
        ? new EngineError(
            "Jev took too long to respond. Retry to continue.",
            504,
          )
        : error instanceof EngineError
          ? error
          : new EngineError(
              "Could not read Jev's response. Retry to continue.",
              502,
            );
    throw new ProviderError(failure.message, failure.status, receipt);
  } finally {
    activeRequests--;
  }
}

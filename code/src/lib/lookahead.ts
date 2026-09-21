import { Chess } from "chess.js";

export const LOOKAHEAD_SETTINGS = {
  version: 1,
  skill: 20,
  depth: 16,
  timeMs: 3000,
  threads: 1,
  hashMb: 16,
  displayPlies: 6,
} as const;
export type LookaheadSettings = typeof LOOKAHEAD_SETTINGS;
export type DecisionStage = "lookahead" | "choosing";
export type LookaheadLines = { depth: number; lines: Record<string, string[]> };

/** Keep only complete MultiPV iterations, keyed by move rather than engine rank. */
export class LookaheadCollector {
  private iterations = new Map<number, Map<number, string[]>>();
  complete: LookaheadLines | undefined;
  constructor(private legalMoves: string[]) {}

  accept(line: string) {
    if (!line.startsWith("info ") || /\b(upperbound|lowerbound)\b/.test(line))
      return;
    const depth = Number(/\bdepth (\d+)/.exec(line)?.[1]);
    const index = Number(/\bmultipv (\d+)/.exec(line)?.[1]);
    const pv = /\bpv (.+)$/.exec(line)?.[1].trim().split(/\s+/);
    if (
      !depth ||
      !index ||
      index > this.legalMoves.length ||
      !pv ||
      !this.legalMoves.includes(pv[0]) ||
      pv.some((move) => !/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(move))
    )
      return;
    if (this.complete && depth < this.complete.depth) return;
    const frame = this.iterations.get(depth) ?? new Map<number, string[]>();
    frame.set(index, pv);
    this.iterations.set(depth, frame);
    const byMove = new Map(
      [...frame.values()].map((moves) => [moves[0], moves]),
    );
    if (
      frame.size === this.legalMoves.length &&
      byMove.size === this.legalMoves.length
    ) {
      this.complete = {
        depth,
        lines: Object.fromEntries(
          this.legalMoves.map((move) => [move, byMove.get(move)!]),
        ),
      };
    }
    // Stockfish streams iterations in increasing depth; retain only recent frames.
    for (const oldDepth of this.iterations.keys()) {
      if (oldDepth < depth - 1) this.iterations.delete(oldDepth);
    }
  }
}

const names = {
  p: "pawn",
  n: "knight",
  b: "bishop",
  r: "rook",
  q: "queen",
  k: "king",
};

/** Replay the original history first, preserving repetition and fifty-move rules. */
export function describeContinuation(
  original: Chess,
  candidate: string,
  pv: string[],
  plies = 6,
) {
  if (pv[0] !== candidate)
    throw new Error("Continuation starts with the wrong move.");
  const history = original.history({ verbose: true });
  const chess = new Chess(history[0]?.before ?? original.fen());
  for (const move of history) chess.move(move.lan);
  const continuation: string[] = [];
  const consequences: string[] = [];
  for (const uci of pv.slice(0, plies)) {
    if (chess.isGameOver()) break;
    const move = chess.move(uci); // Reject an illegal engine line; never guess a repair.
    const color = move.color === "w" ? "White" : "Black";
    continuation.push(move.san);
    if (move.captured)
      consequences.push(
        `${color} captures a ${names[move.captured]} with ${move.san}${move.isEnPassant() ? " (en passant)" : ""}.`,
      );
    if (move.promotion)
      consequences.push(
        `${color} promotes to ${names[move.promotion]} with ${move.san}.`,
      );
    if (move.isKingsideCastle() || move.isQueensideCastle())
      consequences.push(
        `${color} castles ${move.isKingsideCastle() ? "kingside" : "queenside"}.`,
      );
    if (chess.isCheck())
      consequences.push(`${color} gives check with ${move.san}.`);
  }
  const outcome = chess.isCheckmate()
    ? `${chess.turn() === "b" ? "White" : "Black"} checkmates in this line.`
    : chess.isStalemate()
      ? "Draw by stalemate in this line."
      : chess.isThreefoldRepetition()
        ? "Draw by threefold repetition in this line."
        : chess.isInsufficientMaterial()
          ? "Draw by insufficient material in this line."
          : chess.isDrawByFiftyMoves()
            ? "Draw by the fifty-move rule in this line."
            : "Game continues after the displayed line.";
  return {
    continuation_san: continuation,
    resulting_fen: chess.fen(),
    consequences,
    outcome,
  };
}

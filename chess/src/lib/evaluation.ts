export type Evaluation = {
  fen: string;
  cp: number | null;
  mate: number | null;
  depth: number;
  terminal: boolean;
  winner: "w" | "b" | null;
};

/** UCI scores are relative to the side to move; the UI always uses White's view. */
export function parseEvaluation(line: string, fen: string): Evaluation | null {
  if (!line.startsWith("info ") || /\b(upperbound|lowerbound)\b/.test(line))
    return null;
  const pv = /\bmultipv (\d+)/.exec(line);
  if (pv && pv[1] !== "1") return null;
  const score = /\bscore (cp|mate) (-?\d+)/.exec(line);
  const depth = /\bdepth (\d+)/.exec(line);
  if (!score || !depth) return null;
  const value = Number(score[2]) * (fen.split(" ")[1] === "w" ? 1 : -1);
  return {
    fen,
    cp: score[1] === "cp" ? value : null,
    mate: score[1] === "mate" ? value : null,
    depth: Number(depth[1]),
    terminal: false,
    winner: null,
  };
}

export function evaluationLabel(e: Evaluation | null, whiteName: string) {
  if (!e) return "Waiting for evaluation";
  if (e.terminal)
    return e.winner
      ? `${e.winner === "w" ? whiteName : "Stockfish"} wins`
      : "Draw";
  if (e.mate !== null)
    return `${e.mate > 0 ? whiteName : "Stockfish"} has mate in ${Math.abs(e.mate)}`;
  const cp = e.cp ?? 0;
  return Math.abs(cp) < 30
    ? "Position is balanced"
    : `${cp > 0 ? whiteName : "Stockfish"} is ahead`;
}
export function evaluationScore(e: Evaluation | null) {
  if (!e) return "—";
  if (e.terminal && e.winner) return e.winner === "w" ? "1–0" : "0–1";
  if (e.mate !== null) return `${e.mate < 0 ? "−" : ""}M${Math.abs(e.mate)}`;
  const value = (e.cp ?? 0) / 100;
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}`;
}
export function whiteShare(e: Evaluation | null) {
  if (!e) return 50;
  if (e.terminal) return e.winner === "w" ? 100 : e.winner === "b" ? 0 : 50;
  if (e.mate !== null) return e.mate > 0 ? 98 : 2;
  // Visual scale only, not a win probability.
  return Math.max(3, Math.min(97, 50 + 47 * Math.tanh((e.cp ?? 0) / 400)));
}

/** Keep the last estimate visible without presenting it as the new board's score. */
export function evaluationPresentation(
  game: {
    evaluation: Evaluation | null;
    fen: string;
    analyzing: boolean;
    evaluationError: string | null;
  },
  whiteName: string,
) {
  const displayed = game.evaluation;
  const stale = !!displayed && displayed.fen !== game.fen;
  const label = stale
    ? `Previous position — ${game.evaluationError ?? "updating evaluation…"}`
    : (game.evaluationError ??
      (game.analyzing
        ? "Analyzing position…"
        : evaluationLabel(displayed, whiteName)));
  return {
    displayed,
    stale,
    label,
    score: evaluationScore(displayed),
    share: whiteShare(displayed),
  };
}

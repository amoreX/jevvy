import type { Color } from "chess.js";
import type { GameSnapshot } from "@/lib/chess-session";
import { evaluationLabel, evaluationScore, whiteShare } from "@/lib/evaluation";
import { MODELS } from "@/lib/models";

export function EvaluationBar({
  game,
  orientation,
}: {
  game: GameSnapshot;
  orientation: Color;
}) {
  const current = game.evaluation?.fen === game.fen ? game.evaluation : null;
  const label =
    game.evaluationError ??
    (game.analyzing
      ? "Analyzing position…"
      : evaluationLabel(current, MODELS[game.model].name));
  return (
    <div
      className={`evaluation-rail ${orientation === "b" ? "rail-flipped" : ""}`}
      role="img"
      aria-label={`Stockfish evaluation: ${evaluationScore(current)}. ${label}. Positive scores favor White.`}
      title={`${label}. Positive scores favor White; this is an engine estimate.`}
    >
      <div
        className="evaluation-fill"
        style={{ transform: `scaleY(${whiteShare(current) / 100})` }}
      />
      <span className="evaluation-number">{evaluationScore(current)}</span>
    </div>
  );
}
export function EvaluationStatus({
  game,
  whiteName,
}: {
  game: GameSnapshot;
  whiteName: string;
}) {
  const current = game.evaluation?.fen === game.fen ? game.evaluation : null;
  if (!current && !game.evaluationError) return null;
  return (
    <div
      className="evaluation-status"
      aria-live="polite"
      title={`Stockfish estimate · depth ${current?.depth ?? "—"} · positive favors White`}
    >
      <strong>{evaluationScore(current)}</strong>
      <span>{game.evaluationError ?? evaluationLabel(current, whiteName)}</span>
    </div>
  );
}

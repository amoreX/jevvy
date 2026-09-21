import type { Color } from "chess.js";
import type { GameSnapshot } from "@/lib/chess-session";
import { evaluationPresentation } from "@/lib/evaluation";
import { MODELS } from "@/lib/models";

export function EvaluationBar({
  game,
  orientation,
}: {
  game: GameSnapshot;
  orientation: Color;
}) {
  const { label, score, share, stale } = evaluationPresentation(
    game,
    MODELS[game.model].name,
  );
  return (
    <div
      className={`evaluation-rail ${orientation === "b" ? "rail-flipped" : ""}`}
      role="img"
      aria-label={`Stockfish evaluation: ${score}. ${label}. Positive scores favor White.`}
      aria-busy={game.analyzing}
      data-stale={stale || undefined}
      title={`${label}. Positive scores favor White; this is an engine estimate.`}
    >
      <div
        className="evaluation-fill"
        style={{ transform: `scaleY(${share / 100})` }}
      />
      <span className="evaluation-number">{score}</span>
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
  const { displayed, label, score } = evaluationPresentation(game, whiteName);
  if (!displayed && !game.evaluationError) return null;
  return (
    <div
      className="evaluation-status"
      aria-live="polite"
      title={`${label} · depth ${displayed?.depth ?? "—"} · positive favors White`}
    >
      <strong>{score}</strong>
      <span>{label}</span>
    </div>
  );
}

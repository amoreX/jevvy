import { Chess } from "chess.js";
import { describeContinuation, LookaheadCollector } from "./lookahead";
import { createDecisionRequest } from "./server-jev";
import { parseEngineRequest } from "./native-stockfish";

export type ReplayScore = { kind: "cp" | "mate"; value: number };
export type ReplayAnalysis = {
  depth: number;
  lines: Record<string, string[]>;
  scores: Record<string, ReplayScore>;
};

/** Evaluation stays in the experiment's assessor, never in model inputs. */
export class ReplayCollector {
  private collector: LookaheadCollector;
  private frames = new Map<
    number,
    Map<string, { pv: string[]; score: ReplayScore }>
  >();
  complete: ReplayAnalysis | undefined;
  constructor(legalMoves: string[]) {
    this.collector = new LookaheadCollector(legalMoves);
  }
  accept(line: string) {
    if (/\b(upperbound|lowerbound)\b/.test(line)) return;
    const depth = Number(/\bdepth (\d+)/.exec(line)?.[1]);
    const score = /\bscore (cp|mate) (-?\d+)/.exec(line);
    const pv = /\bpv (.+)$/.exec(line)?.[1].trim().split(/\s+/);
    if (!depth || !score || !pv) return;
    const frame = this.frames.get(depth) ?? new Map();
    frame.set(pv[0], {
      pv,
      score: { kind: score[1] as ReplayScore["kind"], value: Number(score[2]) },
    });
    this.frames.set(depth, frame);
    this.collector.accept(line);
    const complete = this.collector.complete;
    if (
      complete?.depth === depth &&
      Object.entries(complete.lines).every(
        ([move, moves]) => frame.get(move)?.pv.join(" ") === moves.join(" "),
      )
    ) {
      this.complete = {
        ...complete,
        scores: Object.fromEntries(
          Object.keys(complete.lines).map((move) => [
            move,
            frame.get(move)!.score,
          ]),
        ),
      };
    }
    for (const oldDepth of this.frames.keys())
      if (oldDepth < depth - 1) this.frames.delete(oldDepth);
  }
}

export function createReplayPayload(
  position: string,
  lines: Record<string, string[]>,
  displayPlies: number,
) {
  if (!Number.isInteger(displayPlies) || displayPlies < 1 || displayPlies > 64)
    throw new Error("Invalid replay horizon.");
  const payload = createDecisionRequest({ position });
  const { chess } = parseEngineRequest({ position, difficulty: "club" });
  const criteria = Object.fromEntries(
    Object.entries(payload.questions.move.criteria).map(
      ([move, description]) => {
        const pv = lines[move];
        if (!pv) throw new Error(`Missing continuation for ${move}`);
        const details = describeContinuation(chess, move, pv, displayPlies);
        const leaf = new Chess(details.resulting_fen);
        return [
          move,
          description +
            " Predicted best-play continuation; actual play may differ. " +
            JSON.stringify({
              ...details,
              resulting_board: leaf.ascii(),
              resulting_side_to_move: leaf.turn() === "w" ? "white" : "black",
              displayed_plies: details.continuation_san.length,
              horizon_note:
                "This is a finite prediction. Unshown replies and consequences beyond this line remain possible.",
            }),
        ];
      },
    ),
  );
  return {
    ...payload,
    state: {
      ...payload.state,
      board_legend:
        "Uppercase pieces are White; lowercase pieces are Black. K king, Q queen, R rook, B bishop, N knight, P pawn; . empty.",
    },
    questions: {
      move: {
        ...payload.questions.move,
        criteria,
        instructions:
          "Choose the best legal move for White by comparing the resulting positions against strong opponent replies in the supplied continuations. Consider checkmate threats, king safety, piece activity, positional compensation and material together. Sacrifices can be correct; a check or capture alone does not establish that a move is best. The displayed futures are limited predictions, not guaranteed play or complete proof. Select one move.",
      },
    },
  };
}

/** Positive means a is better for White. Mate distance is not centipawns. */
export function compareReplayScores(a: ReplayScore, b: ReplayScore) {
  const category = (s: ReplayScore) =>
    s.kind === "cp" ? 0 : s.value > 0 ? 1 : -1;
  const categories = category(a) - category(b);
  if (categories) return categories;
  return a.kind === "cp" ? a.value - b.value : b.value - a.value;
}

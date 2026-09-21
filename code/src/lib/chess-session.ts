import {
  Chess,
  DEFAULT_POSITION,
  type Color,
  type Move,
  type PieceSymbol,
  type Square,
} from "chess.js";
import { StockfishEngine, type ChessEngine } from "./stockfish";
import { JevPlayer, type DecisionPlayer, type JevDecision } from "./jev";

import { MODELS, isPlayerId, type PlayerId } from "./models";
import type { Evaluation } from "./evaluation";
import { HttpRunLogger, type RunLogger, type RunState } from "./run-types";
import type { DecisionStage } from "./lookahead";

export type GameOptions = {
  fen?: string;
  model?: PlayerId;
  lookahead?: boolean;
};
export type GamePhase =
  "idle" | "loading" | "playing" | "paused" | "finished" | "error";
export type GameSnapshot = {
  lookahead: boolean;
  decisionStage: DecisionStage | null;
  fen: string;
  history: Move[];
  phase: GamePhase;
  turn: Color;
  inCheck: boolean;
  thinking: boolean;
  result: string | null;
  error: string | null;
  decisions: (JevDecision & { ply: number })[];
  model: PlayerId;
  runId: string | null;
  evaluation: Evaluation | null;
  analyzing: boolean;
  evaluationError: string | null;
  logError: string | null;
  logRevision: number;
};

/** One board and one serial turn loop, shared by the UI and browser API. */
export class ChessSession {
  private chess = new Chess();
  private initialFen = DEFAULT_POSITION;
  private engine: ChessEngine | null = null;
  private jev: DecisionPlayer | null = null;
  private generation = 0;
  private listeners = new Set<() => void>();
  private snapshot: GameSnapshot = {
    lookahead: false,
    decisionStage: null,
    fen: DEFAULT_POSITION,
    history: [],
    phase: "idle",
    turn: "w",
    inCheck: false,
    thinking: false,
    result: null,
    error: null,
    decisions: [],
    model: "jev",
    runId: null,
    evaluation: null,
    analyzing: false,
    evaluationError: null,
    logError: null,
    logRevision: 0,
  };

  constructor(
    private createEngine: () => ChessEngine = () => new StockfishEngine(),
    private createJev: (
      model: PlayerId,
      runId: string,
      onStage?: (stage: DecisionStage) => void,
    ) => DecisionPlayer = (model, runId, onStage) =>
      new JevPlayer(model, runId, onStage),
    private logs: RunLogger = new HttpRunLogger(),
  ) {}

  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private publish(patch: Partial<GameSnapshot> = {}) {
    this.snapshot = {
      ...this.snapshot,
      fen: this.chess.fen(),
      history: this.chess.history({ verbose: true }),
      turn: this.chess.turn(),
      inCheck: this.chess.isCheck(),
      ...patch,
    };
    this.listeners.forEach((listener) => listener());
  }

  private cancel() {
    this.generation++;
    this.engine?.dispose();
    this.jev?.dispose();
    this.engine = null;
    this.jev = null;
    this.publish({ decisionStage: null });
  }

  private save(
    reason: string,
    phase = this.snapshot.phase as string,
    move?: RunState["move"],
  ): Promise<void> {
    const id = this.snapshot.runId;
    if (!id) return Promise.resolve();
    return this.logs
      .state(id, {
        reason,
        phase,
        fen: this.chess.fen(),
        pgn: this.chess.pgn(),
        plies: this.chess.history().length,
        result: this.snapshot.result,
        error: this.snapshot.error,
        evaluation:
          this.snapshot.evaluation?.fen === this.chess.fen()
            ? this.snapshot.evaluation
            : null,
        ...(move ? { move } : {}),
      })
      .then(() => {
        if (id === this.snapshot.runId)
          this.publish({ logRevision: this.snapshot.logRevision + 1 });
      })
      .catch((error) => {
        if (id === this.snapshot.runId) throw error;
        this.publish({
          logError:
            "An earlier run's final update could not be saved. Its recorded decisions are still available.",
        });
      });
  }

  private logFailure = () => {
    this.cancel();
    this.publish({
      phase: "error",
      thinking: false,
      analyzing: false,
      logError:
        "The run log could not be saved. Check the server before retrying.",
      error: "Logging stopped. Retry to save this position and continue.",
    });
  };

  private async evaluate(generation: number, engine: ChessEngine) {
    if (!engine.evaluate) return;
    const fen = this.chess.fen();
    this.publish({ analyzing: true, evaluationError: null });
    let evaluation: Evaluation;
    try {
      evaluation = await engine.evaluate(this.position());
    } catch {
      if (generation === this.generation)
        this.publish({
          analyzing: false,
          evaluationError: "Evaluation unavailable",
        });
      return;
    }
    if (generation !== this.generation || fen !== this.chess.fen()) return;
    if (evaluation.fen !== fen) {
      this.publish({
        analyzing: false,
        evaluationError: "Evaluation unavailable",
      });
      return;
    }
    this.publish({ evaluation, analyzing: false });
    await this.save("evaluation");
  }

  private finishIfOver(): boolean {
    if (!this.chess.isGameOver()) return false;
    let result = "Draw — an even match.";
    let score = "1/2-1/2";
    if (this.chess.isCheckmate()) {
      result =
        this.chess.turn() === "w"
          ? "Checkmate. Stockfish wins."
          : `Checkmate. ${MODELS[this.snapshot.model].name} wins!`;
      score = this.chess.turn() === "w" ? "0-1" : "1-0";
    } else if (this.chess.isStalemate()) result = "Draw by stalemate.";
    else if (this.chess.isThreefoldRepetition())
      result = "Draw by threefold repetition.";
    else if (this.chess.isInsufficientMaterial())
      result = "Draw — insufficient material.";
    else if (this.chess.isDrawByFiftyMoves())
      result = "Draw by the fifty-move rule.";
    this.chess.setHeader("Result", score);
    this.cancel();
    const winner = this.chess.isCheckmate()
      ? this.chess.turn() === "w"
        ? "b"
        : "w"
      : null;
    this.publish({
      phase: "finished",
      thinking: false,
      analyzing: false,
      result,
      evaluation: {
        fen: this.chess.fen(),
        cp: winner ? null : 0,
        mate: winner ? 0 : null,
        depth: 0,
        terminal: true,
        winner,
      },
    });
    void this.save("finished").catch(this.logFailure);
    return true;
  }

  async start(options: GameOptions = {}) {
    // Validate before replacing a running game.
    const next = new Chess(options.fen ?? DEFAULT_POSITION);
    const model = options.model ?? "jev";
    if (!isPlayerId(model)) throw new Error("Unknown player model.");
    const lookahead = options.lookahead ?? false;
    if (typeof lookahead !== "boolean" || (lookahead && model !== "jev"))
      throw new Error("Stockfish lookahead is available for Jev only.");
    if (this.snapshot.runId && this.snapshot.phase !== "finished")
      void this.save("new_game", "stopped").catch(() => undefined);
    this.cancel();
    const generation = this.generation;
    this.chess = next;
    this.initialFen = next.fen();
    this.chess.setHeader(
      "Event",
      `Opening · ${MODELS[model].label} vs Stockfish`,
    );
    this.chess.setHeader("White", MODELS[model].label);
    this.chess.setHeader("Black", "Stockfish 19");
    this.chess.setHeader("StockfishLookahead", lookahead ? "On" : "Off");
    this.chess.setHeader("Result", "*");
    this.publish({
      phase: "loading",
      thinking: false,
      result: null,
      error: null,
      decisions: [],
      model,
      lookahead,
      runId: null,
      evaluation: null,
      analyzing: false,
      evaluationError: null,
      logError: null,
      logRevision: 0,
    });
    try {
      const runId = await this.logs.create(model, this.initialFen, lookahead);
      if (generation !== this.generation) {
        await this.logs.state(runId, {
          phase: "stopped",
          reason: "cancelled_before_start",
          fen: next.fen(),
          pgn: next.pgn(),
          plies: 0,
          result: null,
          error: null,
          evaluation: null,
        });
        return;
      }
      this.publish({ runId });
      await this.save("started");
      if (generation !== this.generation) return;
      if (!this.finishIfOver()) await this.connect();
    } catch (error) {
      this.fail(error, generation);
    }
  }

  private fail(error: unknown, generation: number) {
    if (generation !== this.generation) return;
    this.cancel();
    this.publish({
      phase: "error",
      thinking: false,
      analyzing: false,
      error:
        error instanceof Error
          ? error.message
          : "The player could not respond. Retry to continue.",
    });
    void this.save("error").catch(this.logFailure);
  }

  private async connect() {
    const generation = this.generation;
    const jev = this.createJev(
      this.snapshot.model,
      this.snapshot.runId!,
      (stage) => {
        if (generation === this.generation)
          this.publish({ decisionStage: stage });
      },
    );
    const engine = this.createEngine();
    this.jev = jev;
    this.engine = engine;
    try {
      // This checks local configuration only; no paid request until the turn loop.
      await jev.init();
      if (generation !== this.generation) return;
      await engine.init();
      if (generation !== this.generation) return;
      this.publish({ phase: "playing", error: null });
      void this.play(generation, jev, engine);
    } catch (error) {
      this.fail(error, generation);
    }
  }

  private position() {
    const moves = this.chess
      .history({ verbose: true })
      .map((move) => move.lan)
      .join(" ");
    return `position fen ${this.initialFen}${moves ? ` moves ${moves}` : ""}`;
  }

  private async play(
    generation: number,
    jev: DecisionPlayer,
    engine: ChessEngine,
  ) {
    try {
      while (
        generation === this.generation &&
        this.snapshot.phase === "playing"
      ) {
        if (this.finishIfOver()) return;
        await this.evaluate(generation, engine);
        if (generation !== this.generation || this.snapshot.phase !== "playing")
          return;
        const expectedFen = this.chess.fen();
        const white = this.chess.turn() === "w";
        this.publish({
          thinking: true,
          decisionStage: white && this.snapshot.lookahead ? "lookahead" : null,
        });
        let decision: JevDecision | undefined;
        const uci = white
          ? (decision = await jev.choose(this.position())).move
          : await engine.bestMove(this.position(), "club");
        if (generation !== this.generation || expectedFen !== this.chess.fen())
          return;
        if (decision && decision.fen !== expectedFen)
          throw new Error(
            `${MODELS[this.snapshot.model].name} replied for a different position. Retry to continue.`,
          );
        const legal = this.chess
          .moves({ verbose: true })
          .find((move) => move.lan === uci);
        if (!legal)
          throw new Error(
            `${white ? MODELS[this.snapshot.model].name : "Stockfish"} did not return a legal move. Retry to continue.`,
          );
        this.chess.move(legal);
        this.publish({
          thinking: false,
          decisionStage: null,
          ...(decision
            ? {
                decisions: [
                  ...this.snapshot.decisions,
                  { ...decision, ply: this.chess.history().length },
                ],
              }
            : {}),
        });
        await this.save("move", undefined, {
          uci: legal.lan,
          san: legal.san,
          color: legal.color,
        });
        if (generation !== this.generation) return;
        if (this.finishIfOver()) return;
      }
    } catch (error) {
      this.fail(error, generation);
    }
  }

  pause = () => {
    if (this.snapshot.phase !== "playing" && this.snapshot.phase !== "loading")
      return;
    this.cancel();
    this.publish({ phase: "paused", thinking: false, analyzing: false });
    void this.save("paused").catch(this.logFailure);
  };

  resume = async () => {
    if (this.snapshot.phase !== "paused" && this.snapshot.phase !== "error")
      return;
    if (!this.snapshot.runId) {
      await this.start({
        model: this.snapshot.model,
        fen: this.chess.fen(),
        lookahead: this.snapshot.lookahead,
      });
      return;
    }
    this.cancel();
    this.publish({ phase: "loading", thinking: false, error: null });
    const generation = this.generation;
    try {
      await this.save("resumed");
      if (generation !== this.generation) return;
      this.publish({ logError: null });
      if (!this.finishIfOver()) await this.connect();
    } catch {
      if (generation === this.generation) this.logFailure();
    }
  };

  retry = this.resume;

  // Explicit console edits are allowed only while paused, never during autoplay.
  move = (from: Square, to: Square, promotion: PieceSymbol = "q"): boolean => {
    if (this.snapshot.phase !== "paused") return false;
    try {
      this.chess.move({ from, to, promotion });
    } catch {
      return false;
    }
    this.chess.setHeader(
      "Event",
      `Opening · ${MODELS[this.snapshot.model].label} vs Stockfish · edited position`,
    );
    this.publish({ evaluation: null });
    void this.save("manual_move").catch(this.logFailure);
    this.finishIfOver();
    return true;
  };

  legalMoves = (square: Square) => this.chess.moves({ square, verbose: true });
  pgn = () => this.chess.pgn();

  undo = (): boolean => {
    if (!this.chess.history().length) return false;
    this.cancel();
    this.chess.undo();
    // Return to White's previous choice, when there is one to take back.
    if (this.chess.turn() === "b" && this.chess.history().length)
      this.chess.undo();
    this.chess.setHeader("Result", "*");
    this.publish({
      phase: "paused",
      thinking: false,
      analyzing: false,
      evaluation: null,
      result: null,
      error: null,
      decisions: this.snapshot.decisions.filter(
        (decision) => decision.ply <= this.chess.history().length,
      ),
    });
    void this.save("undo").catch(this.logFailure);
    return true;
  };

  reset = () => {
    if (this.snapshot.runId && this.snapshot.phase !== "finished")
      void this.save("reset", "stopped").catch(() => undefined);
    this.cancel();
    this.chess = new Chess();
    this.initialFen = DEFAULT_POSITION;
    this.publish({
      phase: "idle",
      thinking: false,
      result: null,
      error: null,
      decisions: [],
      runId: null,
      evaluation: null,
      analyzing: false,
      evaluationError: null,
      logError: null,
      logRevision: 0,
    });
  };

  dispose = () => {
    if (
      this.snapshot.runId &&
      (this.snapshot.phase === "playing" || this.snapshot.phase === "loading")
    )
      void this.save("page_closed", "paused").catch(() => undefined);
    this.cancel();
  };
}

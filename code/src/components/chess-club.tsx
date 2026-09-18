"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import type { Color, PieceSymbol, Square } from "chess.js";
import {
  FlipVertical2,
  LoaderCircle,
  Pause,
  Play,
  RotateCcw,
} from "lucide-react";
import {
  ChessSession,
  type GameOptions,
  type GameSnapshot,
} from "@/lib/chess-session";
import { MODELS, type PlayerId } from "@/lib/models";
import { EvaluationBar, EvaluationStatus } from "./evaluation-bar";
import { RunHistory } from "./run-history";
import { RunCost } from "./run-cost";
import { ChessPiece } from "./chess-piece";
import { ChessBoard } from "./chess-board";

export type OpeningAPI = {
  start: (options?: GameOptions) => Promise<void>;
  pause: () => void;
  resume: () => Promise<void>;
  move: (from: Square, to: Square, promotion?: PieceSymbol) => boolean;
  undo: () => boolean;
  reset: () => void;
  getState: () => GameSnapshot;
  pgn: () => string;
};
declare global {
  interface Window {
    opening?: OpeningAPI;
  }
}

function PlayerStrip({
  color,
  model,
  active,
  captures,
}: {
  color: Color;
  model: PlayerId;
  active: boolean;
  captures: PieceSymbol[];
}) {
  return (
    <div className="player-strip">
      <span className={`player-color color-${color}`} aria-hidden="true" />
      <span className="player-name">
        {color === "w" ? MODELS[model].label : "Stockfish 19"}
      </span>
      <span className="sr-only">
        Playing {color === "w" ? "white" : "black"}
      </span>
      {active && <span className="turn-dot" aria-label="To move" />}
      {captures.length > 0 && (
        <div
          className="captured-pieces"
          aria-label={`${captures.length} captured pieces`}
        >
          {captures.map((type, index) => (
            <ChessPiece
              key={index}
              type={type}
              color={color === "w" ? "b" : "w"}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function ChessClub() {
  const [session] = useState(() => new ChessSession());
  const game = useSyncExternalStore(
    session.subscribe,
    session.getSnapshot,
    session.getSnapshot,
  );
  const [selectedModel, setSelectedModel] = useState<PlayerId>("jev");
  const [flipped, setFlipped] = useState(false);
  const [confirmNew, setConfirmNew] = useState(false);
  const started = game.phase !== "idle";
  const model = started ? game.model : selectedModel;
  const modelName = MODELS[model].name;
  const running = game.phase === "playing" || game.phase === "loading";
  const orientation: Color = flipped ? "b" : "w";
  const topColor: Color = orientation === "w" ? "b" : "w";

  useEffect(() => {
    window.opening = {
      start: (options) => session.start(options),
      pause: session.pause,
      resume: session.resume,
      move: session.move,
      undo: session.undo,
      reset: session.reset,
      getState: session.getSnapshot,
      pgn: session.pgn,
    };
    const onPageHide = () => session.pause();
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      delete window.opening;
      session.dispose();
    };
  }, [session]);

  let status = "Ready";
  if (game.phase === "loading") status = "Connecting…";
  else if (game.phase === "error") status = "Connection error";
  else if (game.phase === "paused") status = "Paused";
  else if (game.result) status = game.result;
  else if (game.analyzing) status = "Analyzing…";
  else if (game.thinking)
    status = `${game.turn === "w" ? modelName : "Stockfish"} is thinking…`;
  else if (started)
    status = `${game.turn === "w" ? modelName : "Stockfish"} to move`;
  if (game.inCheck && running) status += " · Check";

  const captures = (color: Color) =>
    game.history
      .filter((move) => move.color === color && move.captured)
      .map((move) => move.captured!);

  return (
    <div className="site-shell">
      <main aria-label="Chess game">
        <div className="game-layout">
          <section
            className="board-column"
            aria-label={`${modelName} against Stockfish`}
          >
            <PlayerStrip
              model={model}
              color={topColor}
              active={running && game.turn === topColor}
              captures={captures(topColor)}
            />
            <div className="board-with-evaluation">
              <EvaluationBar game={game} orientation={orientation} />
              <ChessBoard
                game={game}
                orientation={orientation}
                whiteName={modelName}
              />
            </div>
            <div className="board-footer">
              <PlayerStrip
                model={model}
                color={orientation}
                active={running && game.turn === orientation}
                captures={captures(orientation)}
              />
              <div className="board-tools">
                <button
                  className="icon-button"
                  onClick={() => setFlipped(!flipped)}
                  aria-label="Flip board"
                  title="Flip board"
                >
                  <FlipVertical2 size={18} />
                </button>
                <button
                  className="icon-button"
                  onClick={session.undo}
                  disabled={!game.history.length}
                  aria-label="Undo last turn and pause"
                  title="Undo last turn and pause"
                >
                  <RotateCcw size={18} />
                </button>
              </div>
            </div>
          </section>
          <section className="game-controls" aria-label="Game controls">
            <div className="controls-row">
              <div className="model-picker">
                <label htmlFor="white-model">White model</label>
                <select
                  id="white-model"
                  value={model}
                  disabled={started}
                  onChange={(event) =>
                    setSelectedModel(event.target.value as PlayerId)
                  }
                >
                  {Object.entries(MODELS).map(([id, value]) => (
                    <option key={id} value={id}>
                      {value.label}
                    </option>
                  ))}
                </select>
              </div>
              {!started ? (
                <button
                  className="start-button"
                  onClick={() => {
                    setConfirmNew(false);
                    void session.start({ model: selectedModel });
                  }}
                >
                  <Play size={16} />
                  <span>Start game</span>
                </button>
              ) : confirmNew ? (
                <div className="confirm-action">
                  <span>Start over?</span>
                  <button
                    className="confirm-yes"
                    onClick={() => {
                      session.reset();
                      setConfirmNew(false);
                    }}
                  >
                    New game
                  </button>
                  <button
                    className="text-button"
                    onClick={() => setConfirmNew(false)}
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <div className="game-action-row">
                  {running && (
                    <button onClick={session.pause}>
                      <Pause size={16} />
                      Pause
                    </button>
                  )}
                  {game.phase === "paused" && (
                    <button onClick={() => void session.resume()}>
                      <Play size={16} />
                      Resume
                    </button>
                  )}
                  {game.phase === "error" && (
                    <button onClick={() => void session.retry()}>
                      <RotateCcw size={16} />
                      Retry
                    </button>
                  )}
                  <button
                    onClick={() => {
                      if (!game.history.length || game.phase === "finished")
                        session.reset();
                      else {
                        session.pause();
                        setConfirmNew(true);
                      }
                    }}
                  >
                    <RotateCcw size={16} />
                    New game
                  </button>
                </div>
              )}
            </div>
            {started && (
              <div className="game-metrics">
                <div className="game-status" role="status" aria-live="polite">
                  {(game.phase === "loading" ||
                    game.thinking ||
                    game.analyzing) && (
                    <LoaderCircle className="spin" size={15} />
                  )}
                  <span>{status}</span>
                </div>
                <EvaluationStatus game={game} whiteName={modelName} />
                {game.runId && (
                  <RunCost
                    key={game.runId}
                    runId={game.runId}
                    revision={game.logRevision}
                  />
                )}
              </div>
            )}
            {game.phase === "error" && (
              <p className="engine-error" role="alert">
                {game.error}
              </p>
            )}
            {game.logError && (
              <p className="engine-error" role="alert">
                {game.logError}
              </p>
            )}
          </section>
        </div>
        <details className="history-disclosure">
          <summary>Run history</summary>
          <RunHistory refreshKey={`${game.runId}:${game.logRevision}`} />
        </details>
      </main>
      <div className="sr-only" role="status" aria-live="polite">
        {game.history.length
          ? `Last move: ${game.history.at(-1)?.color === "w" ? "White" : "Black"} ${game.history.at(-1)?.san}. ${status}`
          : status}
      </div>
    </div>
  );
}

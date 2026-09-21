"use client";

import { useMemo, useRef, type KeyboardEvent } from "react";
import { Chess, type Color, type Square } from "chess.js";
import { ChessPiece, PIECE_NAMES } from "./chess-piece";
import type { GameSnapshot } from "@/lib/chess-session";

/** Spectator board: both players move through the session, never through gestures. */
export function ChessBoard({
  game,
  orientation,
  whiteName,
}: {
  game: GameSnapshot;
  orientation: Color;
  whiteName: string;
}) {
  const chess = useMemo(() => new Chess(game.fen), [game.fen]);
  const board = useRef<HTMLDivElement>(null);
  const files = orientation === "w" ? "abcdefgh" : "hgfedcba";
  const ranks = orientation === "w" ? "87654321" : "12345678";
  const squares = [...ranks].flatMap((rank) =>
    [...files].map((file) => `${file}${rank}` as Square),
  );
  const last = game.history.at(-1);

  function keyboard(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const offset: Record<string, number> = {
      ArrowLeft: -1,
      ArrowRight: 1,
      ArrowUp: -8,
      ArrowDown: 8,
    };
    if (event.key in offset) {
      event.preventDefault();
      const next = Math.min(63, Math.max(0, index + offset[event.key]));
      board.current
        ?.querySelector<HTMLButtonElement>(`[data-square="${squares[next]}"]`)
        ?.focus();
    }
  }

  return (
    <div className="board-frame">
      <div
        ref={board}
        className="chess-board"
        role="group"
        aria-label={`Chess board. ${whiteName} plays White and Stockfish plays Black. Use arrow keys to inspect squares.`}
        data-testid="chess-board"
        data-fen={game.fen}
      >
        {squares.map((square, index) => {
          const piece = chess.get(square);
          const light =
            (square.charCodeAt(0) - 97 + Number(square[1])) % 2 === 0;
          const check =
            game.inCheck && piece?.type === "k" && piece.color === game.turn;
          return (
            <button
              type="button"
              key={square}
              data-square={square}
              data-piece={piece ? `${piece.color}${piece.type}` : ""}
              data-movable="false"
              className={`square ${light ? "square-light" : "square-dark"} ${last?.from === square || last?.to === square ? "square-last" : ""} ${check ? "square-check" : ""}`}
              aria-label={`${square}${piece ? `, ${piece.color === "w" ? "white" : "black"} ${PIECE_NAMES[piece.type]}` : ", empty"}${check ? ", in check" : ""}`}
              aria-disabled="true"
              tabIndex={index === 56 ? 0 : -1}
              onKeyDown={(event) => keyboard(event, index)}
            >
              {index % 8 === 0 && (
                <span className="rank-label" aria-hidden="true">
                  {square[1]}
                </span>
              )}
              {index >= 56 && (
                <span className="file-label" aria-hidden="true">
                  {square[0]}
                </span>
              )}
              {piece && <ChessPiece type={piece.type} color={piece.color} />}
            </button>
          );
        })}
      </div>
    </div>
  );
}

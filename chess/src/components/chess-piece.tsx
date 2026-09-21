import type { Color, PieceSymbol } from "chess.js";

export const PIECE_NAMES: Record<PieceSymbol, string> = {
  p: "pawn",
  n: "knight",
  b: "bishop",
  r: "rook",
  q: "queen",
  k: "king",
};

export function ChessPiece({
  type,
  color,
  className = "",
}: {
  type: PieceSymbol;
  color: Color;
  className?: string;
}) {
  const detail = color === "w" ? "#35443a" : "#afbcaa";
  return (
    <svg
      viewBox="0 0 64 64"
      fill={color === "w" ? "#faf7ee" : "#293d31"}
      stroke="#24372d"
      strokeWidth="1.65"
      strokeLinejoin="round"
      strokeLinecap="round"
      aria-hidden="true"
      className={`chess-piece ${className}`}
    >
      {type === "p" && (
        <>
          <circle cx="32" cy="17" r="8" />
          <path d="M25 26h14l-2 6c-1 7 0 10 5 14H22c5-4 6-7 5-14z" />
          <path d="M22 46h20l4 8H18z" />
          <path d="M23 49h18" stroke={detail} />
        </>
      )}
      {type === "r" && (
        <>
          <path d="M18 11h8v7h6v-7h6v7h8v-7h2v17l-7 5 2 14H21l2-14-7-5V11z" />
          <path d="M21 47h22l4 7H17z" />
          <path d="M22 27h20M24 33h16M22 49h20" stroke={detail} />
        </>
      )}
      {type === "n" && (
        <>
          <path d="M19 47c0-9 8-14 16-20l-8 1-7 7-8-5 8-14 9-5 2-7 7 7c12 4 14 18 8 36z" />
          <path
            d="m20 19 8-3M34 18c9 8 9 17 5 26"
            fill="none"
            stroke={detail}
          />
          <circle cx="28" cy="21" r="1.6" fill={detail} stroke="none" />
          <path d="M19 47h27l3 7H16z" />
          <path d="M22 50h22" stroke={detail} />
        </>
      )}
      {type === "b" && (
        <>
          <circle cx="32" cy="8" r="3" />
          <path d="M32 11c-5 5-13 12-12 18 1 5 5 7 12 7s11-2 12-7c1-6-7-13-12-18z" />
          <path d="m34 18-5 10" stroke={detail} strokeWidth="2.5" />
          <path d="M26 36h12l3 11H23z" />
          <path d="M22 47h20l5 7H17z" />
          <path d="M24 50h16" stroke={detail} />
        </>
      )}
      {type === "q" && (
        <>
          <path d="m16 20 10 7 6-12 6 12 10-7-6 17H22z" />
          <circle cx="15" cy="17" r="3" />
          <circle cx="32" cy="11" r="3" />
          <circle cx="49" cy="17" r="3" />
          <path d="M23 37h18l-3 5 4 5H22l4-5z" />
          <path d="M21 47h22l5 7H16z" />
          <path d="M24 33h16M24 50h16" stroke={detail} />
        </>
      )}
      {type === "k" && (
        <>
          <path d="M29 5h6v6h6v5h-6v7h-6v-7h-6v-5h6z" />
          <path d="M32 28c-6-15-24-6-15 6l7 7h16l7-7c9-12-9-21-15-6z" />
          <path d="M24 41h16l2 7H22z" />
          <path d="M21 48h22l5 6H16z" />
          <path d="M32 28v10M25 44h14M24 51h16" stroke={detail} />
        </>
      )}
    </svg>
  );
}

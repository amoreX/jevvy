import type { Evaluation } from "./evaluation";
export type Difficulty = "casual" | "club" | "expert";

export const LEVELS = {
  casual: {
    name: "Casual",
    skill: 0,
    depth: 3,
    time: 250,
    description: "Find your footing. Room to experiment.",
  },
  club: {
    name: "Club",
    skill: 6,
    depth: 9,
    time: 650,
    description: "A thoughtful challenge. Stay a move ahead.",
  },
  expert: {
    name: "Expert",
    skill: 18,
    depth: 17,
    time: 1200,
    description: "Bring your best. Every move matters.",
  },
} as const;

export interface ChessEngine {
  init(): Promise<void>;
  bestMove(position: string, difficulty: Difficulty): Promise<string>;
  evaluate?(position: string): Promise<Evaluation>;
  dispose(): void;
}

/** Lazy connection to the native Stockfish process on the Next.js server. */
export class StockfishEngine implements ChessEngine {
  private controller = new AbortController();
  private ready: Promise<void> | null = null;

  private async request(body?: {
    position: string;
    difficulty: Difficulty;
    analyze?: boolean;
  }) {
    const response = await fetch("/api/stockfish", {
      method: body ? "POST" : "GET",
      cache: "no-store",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.any([
        this.controller.signal,
        AbortSignal.timeout(20000),
      ]),
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(
        data.error || "Stockfish could not respond. Please retry.",
      );
    }
    return data;
  }

  init(): Promise<void> {
    this.ready ??= this.request().then(() => undefined);
    return this.ready;
  }

  async bestMove(position: string, difficulty: Difficulty) {
    await this.init();
    const { move } = await this.request({ position, difficulty });
    if (
      typeof move !== "string" ||
      !/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(move)
    ) {
      throw new Error(
        "Stockfish did not return a playable move. Please retry.",
      );
    }
    return move;
  }

  async evaluate(position: string): Promise<Evaluation> {
    return this.request({ position, difficulty: "club", analyze: true });
  }

  dispose() {
    this.controller.abort();
  }
}

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { Chess } from "chess.js";
import { LEVELS, type Difficulty } from "./stockfish";
import { parseEvaluation, type Evaluation } from "./evaluation";
import {
  LookaheadCollector,
  LOOKAHEAD_SETTINGS,
  type LookaheadLines,
  type LookaheadSettings,
} from "./lookahead";

export class EngineError extends Error {
  constructor(
    message: string,
    readonly status = 503,
  ) {
    super(message);
  }
}

export function parseEngineRequest(input: unknown, allowFinished = false) {
  if (!input || typeof input !== "object")
    throw new EngineError("A chess position is required.", 400);
  const { position, difficulty } = input as Record<string, unknown>;
  if (
    typeof difficulty !== "string" ||
    !Object.hasOwn(LEVELS, difficulty) ||
    typeof position !== "string" ||
    position.length > 16384 ||
    /[\r\n]/.test(position)
  )
    throw new EngineError("Invalid position or difficulty.", 400);

  // Only a FEN and legal UCI moves may cross the process boundary.
  const match =
    /^position fen ([^ ]+ [wb] [KQkq-]+ [a-h1-8-]+ \d+ \d+)(?: moves (.+))?$/.exec(
      position,
    );
  if (!match) throw new EngineError("Invalid chess position.", 400);
  let chess: Chess;
  let initialFen: string;
  const moves = match[2]?.split(" ") ?? [];
  if (moves.length > 2048)
    throw new EngineError("This game is too long to analyze.", 400);
  try {
    chess = new Chess(match[1]);
    initialFen = chess.fen();
    const otherKing = chess
      .board()
      .flat()
      .find((piece) => piece?.type === "k" && piece.color !== chess.turn());
    if (otherKing && chess.isAttacked(otherKing.square, chess.turn()))
      throw new Error("The non-moving king is in check.");
    for (const move of moves) {
      if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(move))
        throw new Error("Invalid move format.");
      chess.move({
        from: move.slice(0, 2),
        to: move.slice(2, 4),
        promotion: move[4],
      });
    }
  } catch {
    throw new EngineError("The position or move history is not legal.", 400);
  }
  if (chess.isGameOver() && !allowFinished)
    throw new EngineError("This game has already finished.", 422);

  return {
    position: `position fen ${initialFen}${moves.length ? ` moves ${moves.join(" ")}` : ""}`,
    difficulty: difficulty as Difficulty,
    chess,
  };
}

function executable() {
  if (process.env.STOCKFISH_PATH) return process.env.STOCKFISH_PATH;
  const candidates = [
    "/opt/homebrew/bin/stockfish",
    "/usr/local/bin/stockfish",
    "/usr/games/stockfish",
  ];
  return (
    candidates.find((path) => existsSync(path)) ??
    (process.platform === "win32" ? "stockfish.exe" : "stockfish")
  );
}

let activeProcesses = 0;

/** One bounded native process per request; no shared positions between games. */
async function runStockfish(
  search: ReturnType<typeof parseEngineRequest> | undefined,
  signal: AbortSignal,
  analyze = false,
  lookahead?: LookaheadSettings,
): Promise<{
  name: string;
  move?: string;
  evaluation?: Evaluation;
  lookahead?: LookaheadLines;
}> {
  if (signal.aborted) throw new EngineError("Engine request cancelled.", 499);
  if (activeProcesses >= 4)
    throw new EngineError("Stockfish is busy. Please retry in a moment.", 503);
  activeProcesses++;
  try {
    return await new Promise((resolve, reject) => {
      // Stockfish is installed on the host, not bundled into the Next.js build.
      const child = spawn(/* turbopackIgnore: true */ executable(), [], {
        stdio: ["pipe", "pipe", "ignore"],
        windowsHide: true,
      });
      const lines = createInterface({ input: child.stdout });
      let name = "Stockfish";
      let evaluation: Evaluation | undefined;
      const collector =
        lookahead && search
          ? new LookaheadCollector(
              search.chess.moves({ verbose: true }).map((move) => move.lan),
            )
          : undefined;
      let settled = false;
      const timeout = setTimeout(
        () =>
          finish(
            new EngineError(
              "Stockfish took too long to respond. Please retry.",
            ),
          ),
        10000,
      );
      const abort = () =>
        finish(new EngineError("Engine request cancelled.", 499));

      function finish(error?: Error, move?: string) {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal.removeEventListener("abort", abort);
        lines.close();
        child.kill();
        const killTimer = setTimeout(() => child.kill("SIGKILL"), 300);
        killTimer.unref();
        child.once("close", () => clearTimeout(killTimer));
        if (error) reject(error);
        else
          resolve({
            name,
            ...(move ? { move } : {}),
            ...(evaluation ? { evaluation } : {}),
            ...(collector?.complete ? { lookahead: collector.complete } : {}),
          });
      }

      child.on("error", () =>
        finish(
          new EngineError(
            "Native Stockfish could not start. Install Stockfish or set STOCKFISH_PATH on the server, then retry.",
          ),
        ),
      );
      child.stdin.on("error", () =>
        finish(
          new EngineError("The Stockfish connection closed. Please retry."),
        ),
      );
      child.on("close", () =>
        finish(
          new EngineError("Stockfish stopped unexpectedly. Please retry."),
        ),
      );
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) {
        abort();
        return;
      }

      lines.on("line", (raw: string) => {
        if (settled) return;
        const line = raw.trim();
        collector?.accept(line);
        if (analyze && search) {
          const score = parseEvaluation(line, search.chess.fen());
          if (score) evaluation = score;
        }
        if (line.startsWith("id name ")) name = line.slice(8);
        if (line === "uciok") {
          child.stdin.write(
            "setoption name Threads value 1\nsetoption name Hash value 16\n" +
              (lookahead && search
                ? `setoption name MultiPV value ${search.chess.moves().length}\n`
                : "") +
              "ucinewgame\nisready\n",
          );
        } else if (line === "readyok") {
          if (!search) {
            finish();
            return;
          }
          const level = lookahead
            ? {
                skill: lookahead.skill,
                depth: lookahead.depth,
                time: lookahead.timeMs,
              }
            : analyze
              ? { skill: 20, depth: 16, time: 600 }
              : LEVELS[search.difficulty];
          child.stdin.write(
            `setoption name Skill Level value ${level.skill}\n${search.position}\ngo depth ${level.depth} movetime ${level.time}\n`,
          );
        } else if (line.startsWith("bestmove ")) {
          const move = line.split(/\s+/)[1];
          if (
            !search?.chess
              .moves({ verbose: true })
              .some((legal) => legal.lan === move)
          ) {
            finish(
              new EngineError(
                "Stockfish did not return a legal move. Please retry.",
              ),
            );
          } else finish(undefined, move);
        }
      });
      child.stdin.write("uci\n");
    });
  } finally {
    activeProcesses--;
  }
}

export function probeStockfish(signal: AbortSignal) {
  return runStockfish(undefined, signal);
}

export function findBestMove(input: unknown, signal: AbortSignal) {
  return runStockfish(parseEngineRequest(input), signal);
}

export async function analyzeLegalMoves(
  input: unknown,
  signal: AbortSignal,
  settings = LOOKAHEAD_SETTINGS,
) {
  const parsed = parseEngineRequest(input);
  if (parsed.chess.turn() !== "w")
    throw new EngineError("Jev lookahead requires White to move.", 422);
  const result = await runStockfish(parsed, signal, false, settings);
  if (!result.lookahead)
    throw new EngineError(
      "Stockfish lookahead did not cover every legal move. Retry to continue.",
      503,
    );
  return { ...result.lookahead, engine: result.name, settings };
}

export async function evaluatePosition(
  input: unknown,
  signal: AbortSignal,
): Promise<Evaluation> {
  const parsed = parseEngineRequest(input, true);
  const chess = parsed.chess;
  if (chess.isGameOver())
    return {
      fen: chess.fen(),
      cp: chess.isCheckmate() ? null : 0,
      mate: chess.isCheckmate() ? 0 : null,
      depth: 0,
      terminal: true,
      winner: chess.isCheckmate() ? (chess.turn() === "w" ? "b" : "w") : null,
    };
  const result = await runStockfish(parsed, signal, true);
  if (!result.evaluation)
    throw new EngineError(
      "Stockfish did not return an evaluation. Please retry.",
    );
  return result.evaluation;
}

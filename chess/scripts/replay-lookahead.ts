import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { Chess } from "chess.js";
import { chooseJevMove, createDecisionRequest } from "../src/lib/server-jev";
import { parseEngineRequest } from "../src/lib/native-stockfish";
import {
  createReplayPayload,
  ReplayCollector,
  compareReplayScores,
  type ReplayAnalysis,
  type ReplayScore,
} from "../src/lib/replay-lookahead";
import type { RunLog } from "../src/lib/run-types";
import type { JevDecision } from "../src/lib/jev";

// Preparation is offline. --live authorizes at most twelve provider requests.
// Reusing the output directory skips every attempted call, including failures.
async function main() {
  const [sourceArg, outputArg, liveArg] = process.argv.slice(2);
  if (!sourceArg || !outputArg || (liveArg && liveArg !== "--live"))
    throw new Error(
      "Usage: node --env-file=.env.local --import tsx scripts/replay-lookahead.ts source-run.json output-directory [--live]",
    );
  const sourcePath = resolve(sourceArg);
  const output = resolve(outputArg);
  const live = liveArg === "--live";
  const configuration = {
    version: 1,
    fullmoves: [13, 16, 19],
    horizons: [6, 18],
    repetitions: 2,
    search: { depth: 22, timeMs: 15000, threads: 1, hashMb: 64, skill: 20 },
  };
  const sourceText = await readFile(sourcePath, "utf8");
  const source = JSON.parse(sourceText) as RunLog;
  const sourceHash = createHash("sha256").update(sourceText).digest("hex");
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());

  type Case = {
    fullmove: number;
    position: string;
    fen: string;
    historicalMove: string;
    analysis: ReplayAnalysis & { engine: string; elapsedMs: number };
    payloads: Record<string, ReturnType<typeof createReplayPayload>>;
    horizons: Record<string, { min: number; max: number; mean: number }>;
  };
  type Attempt = {
    fullmove: number;
    horizon: number;
    repetition: number;
    status: "started" | "complete" | "error";
    startedAt: string;
    payloadSha256: string;
    decision?: JevDecision;
    error?: string;
    selectedSan?: string;
    selectedScore?: ReplayScore;
    bestMoves?: string[];
    bestScore?: ReplayScore;
    lossCp?: number | null;
  };
  type Experiment = {
    configuration: typeof configuration;
    sourceRun: string;
    sourceHash: string;
    createdAt: string;
    cases: Case[];
    attempts: Attempt[];
  };
  await mkdir(output, { recursive: true });
  const manifest = join(output, "experiment.json");
  let experiment: Experiment;
  try {
    experiment = JSON.parse(await readFile(manifest, "utf8"));
    if (
      experiment.sourceHash !== sourceHash ||
      JSON.stringify(experiment.configuration) !== JSON.stringify(configuration)
    )
      throw new Error(
        "Existing experiment does not match source or configuration. Use a new output directory.",
      );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    experiment = {
      configuration,
      sourceRun: source.id,
      sourceHash,
      createdAt: new Date().toISOString(),
      cases: [],
      attempts: [],
    };
  }
  async function save() {
    await writeFile(
      manifest + ".tmp",
      JSON.stringify(experiment, null, 2) + "\n",
      { mode: 0o600 },
    );
    await rename(manifest + ".tmp", manifest);
  }

  async function analyze(position: string): Promise<Case["analysis"]> {
    const { chess, position: safePosition } = parseEngineRequest({
      position,
      difficulty: "club",
    });
    const legalMoves = chess.moves({ verbose: true }).map((m) => m.lan);
    const collector = new ReplayCollector(legalMoves);
    const started = Date.now();
    return new Promise((resolveAnalysis, reject) => {
      const child = spawn(process.env.STOCKFISH_PATH || "stockfish", [], {
        windowsHide: true,
        stdio: ["pipe", "pipe", "ignore"],
      });
      const reader = createInterface({ input: child.stdout });
      let engine = "Stockfish";
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        controller.signal.removeEventListener("abort", abort);
        reader.close();
        child.kill();
        if (error) reject(error);
        else if (!collector.complete)
          reject(new Error("No complete scored MultiPV frame"));
        else
          resolveAnalysis({
            ...collector.complete,
            engine,
            elapsedMs: Date.now() - started,
          });
      };
      const timeout = setTimeout(
        () => finish(new Error("Analysis timed out")),
        configuration.search.timeMs + 10000,
      );
      const abort = () => finish(new Error("Experiment cancelled"));
      controller.signal.addEventListener("abort", abort, { once: true });
      child.on("error", () => finish(new Error("Stockfish failed to start")));
      child.stdin.on("error", () =>
        finish(new Error("Stockfish input closed")),
      );
      child.on("close", () => finish(new Error("Stockfish closed early")));
      reader.on("line", (line: string) => {
        if (settled) return;
        collector.accept(line.trim());
        if (line.startsWith("id name ")) engine = line.slice(8).trim();
        if (line.trim() === "uciok")
          child.stdin.write(
            `setoption name Threads value 1\nsetoption name Hash value 64\nsetoption name Skill Level value 20\nsetoption name MultiPV value ${legalMoves.length}\nucinewgame\nisready\n`,
          );
        if (line.trim() === "readyok")
          child.stdin.write(
            `${safePosition}\ngo depth ${configuration.search.depth} movetime ${configuration.search.timeMs}\n`,
          );
        if (line.startsWith("bestmove ")) finish();
      });
      if (controller.signal.aborted) abort();
      else child.stdin.write("uci\n");
    });
  }

  for (const fullmove of configuration.fullmoves) {
    if (experiment.cases.some((c) => c.fullmove === fullmove)) continue;
    if (controller.signal.aborted) throw new Error("Experiment cancelled");
    const event = source.events.find(
      (e) =>
        e.type === "decision_request" &&
        (e.data.request as ReturnType<typeof createDecisionRequest> | undefined)
          ?.state.fullmove_number === fullmove,
    );
    if (!event) throw new Error(`Missing saved position ${fullmove}`);
    const saved = event.data.request as ReturnType<
      typeof createDecisionRequest
    >;
    const board = new Chess(source.initialFen);
    for (const san of saved.state.move_history_san) board.move(san);
    if (board.fen() !== saved.state.fen)
      throw new Error("Saved history and FEN disagree");
    const position = `position fen ${source.initialFen} moves ${board
      .history({ verbose: true })
      .map((m) => m.lan)
      .join(" ")}`;
    const historical = source.events.find(
      (e) =>
        e.type === "decision_result" &&
        e.data.requestId === event.data.requestId,
    );
    if (typeof historical?.data.move !== "string")
      throw new Error("Missing historical move");
    console.log(
      `Preparing move ${fullmove}: ${board.moves().length} legal choices, ${configuration.search.timeMs / 1000}s Stockfish budget`,
    );
    const analysis = await analyze(position);
    const payloads = Object.fromEntries(
      configuration.horizons.map((h) => [
        h,
        createReplayPayload(position, analysis.lines, h),
      ]),
    );
    const horizons = Object.fromEntries(
      Object.entries(payloads).map(([h, payload]) => {
        const lengths = Object.values(payload.questions.move.criteria).map(
          (text) =>
            JSON.parse(text.slice(text.indexOf('{"continuation_san"')))
              .displayed_plies as number,
        );
        return [
          h,
          {
            min: Math.min(...lengths),
            max: Math.max(...lengths),
            mean: lengths.reduce((a, b) => a + b, 0) / lengths.length,
          },
        ];
      }),
    );
    experiment.cases.push({
      fullmove,
      position,
      fen: board.fen(),
      historicalMove: historical.data.move,
      analysis,
      payloads,
      horizons,
    });
    await save();
    console.log(
      `Prepared move ${fullmove}, complete depth ${analysis.depth}; displayed plies ${JSON.stringify(horizons)}`,
    );
  }

  if (live) {
    if (!process.env.OPENROUTER_API_KEY?.trim())
      throw new Error("OPENROUTER_API_KEY is required for --live");
    for (
      let repetition = 1;
      repetition <= configuration.repetitions;
      repetition++
    ) {
      for (const c of experiment.cases) {
        // Reverse order on the second repeat to reduce order/time confounding.
        const horizons =
          repetition % 2
            ? configuration.horizons
            : [...configuration.horizons].reverse();
        for (const horizon of horizons) {
          if (controller.signal.aborted)
            throw new Error("Experiment cancelled");
          if (
            experiment.attempts.some(
              (a) =>
                a.fullmove === c.fullmove &&
                a.horizon === horizon &&
                a.repetition === repetition,
            )
          )
            continue;
          const payload = c.payloads[horizon];
          const attempt: Attempt = {
            fullmove: c.fullmove,
            horizon,
            repetition,
            status: "started",
            startedAt: new Date().toISOString(),
            payloadSha256: createHash("sha256")
              .update(JSON.stringify(payload))
              .digest("hex"),
          };
          experiment.attempts.push(attempt);
          await save(); // Record the exact immutable payload before any paid request.
          try {
            const decision = await chooseJevMove(
              { position: c.position },
              controller.signal,
              payload,
            );
            const best = Object.keys(c.analysis.scores).reduce((a, b) =>
              compareReplayScores(c.analysis.scores[a], c.analysis.scores[b]) >=
              0
                ? a
                : b,
            );
            const bestScore = c.analysis.scores[best];
            const selectedScore = c.analysis.scores[decision.move];
            Object.assign(attempt, {
              status: "complete",
              decision,
              selectedSan: new Chess(c.fen).move(decision.move).san,
              selectedScore,
              bestScore,
              bestMoves: Object.keys(c.analysis.scores).filter(
                (m) =>
                  compareReplayScores(c.analysis.scores[m], bestScore) === 0,
              ),
              lossCp:
                bestScore.kind === "cp" && selectedScore.kind === "cp"
                  ? bestScore.value - selectedScore.value
                  : null,
            });
            console.log(
              `Move ${c.fullmove}, ${horizon} plies, repeat ${repetition}: ${attempt.selectedSan}; loss ${attempt.lossCp ?? "mate comparison"} cp`,
            );
          } catch (error) {
            attempt.status = "error";
            attempt.error =
              error instanceof Error ? error.message : "Decision failed";
            console.log(
              `Move ${c.fullmove}, ${horizon} plies: ${attempt.error}`,
            );
          }
          await save();
          if (attempt.status === "error")
            throw new Error(
              "Stopped after failed provider attempt; no automatic retry.",
            );
        }
      }
    }
  }

  const scoreText = (score: ReplayScore) =>
    score.kind === "cp"
      ? (score.value / 100).toFixed(2)
      : `mate ${score.value}`;
  const rows = experiment.attempts.map(
    (a) =>
      `| ${a.fullmove} | ${a.horizon} | ${a.repetition} | ${a.selectedSan ?? a.status} | ${a.selectedScore ? scoreText(a.selectedScore) : "—"} | ${a.lossCp === null || a.lossCp === undefined ? "—" : (a.lossCp / 100).toFixed(2)} |`,
  );
  const completed = experiment.attempts.filter((a) => a.status === "complete");
  const costs = completed.map((a) => a.decision?.usage?.cost);
  const knownCost = costs.reduce<number>((sum, cost) => sum + (cost ?? 0), 0);
  const summary = configuration.horizons.map((h) => {
    const attempts = completed.filter((a) => a.horizon === h);
    const losses = attempts
      .map((a) => a.lossCp)
      .filter((n): n is number => typeof n === "number");
    return `- ${h}-ply cap: ${attempts.length} completed; mean centipawn loss ${losses.length ? (losses.reduce((a, b) => a + b, 0) / losses.length).toFixed(1) : "unavailable"} (${losses.length} non-mate comparisons).`;
  });
  await writeFile(
    join(output, "report.md"),
    [
      "# Jev continuation replay",
      "",
      `Source run: ${source.id}. Positions before White moves 13, 16 and 19.`,
      "",
      "Two repeats per condition. Both conditions share the same full game history, legal-choice order, Stockfish analysis snapshot, instructions and board representation. Only displayed horizon differs. Scores, rankings and recommendations are withheld from Jev; assessment uses the full search score for the candidate, not material or evaluation of the truncated leaf.",
      "",
      "Search: Stockfish, skill 20, one thread, 64 MiB, depth cap 22, 15 seconds per position. PVs can end before the cap; actual lengths are recorded in experiment.json. No automatic provider retries.",
      "",
      "| White move | Ply cap | Repeat | Jev choice | White evaluation | Loss vs best (pawn units) |",
      "|---|---|---|---|---|---|",
      ...rows,
      "",
      ...summary,
      "",
      `Known provider cost: $${knownCost.toFixed(6)}; ${costs.filter((c) => c === undefined).length} completed calls without cost; ${experiment.attempts.length - completed.length} failed or unfinished attempts may have unknown costs.`,
      "",
      "This is a small diagnostic on selected losing-game positions, not a strength benchmark or proof about sacrifices. Both conditions have clearer board representation and instructions than the historical run, so differences from historical choices cannot be attributed solely to preview length.",
      "",
    ].join("\n"),
  );
  console.log(
    `Saved ${manifest}; ${completed.length} completed provider decisions; known cost $${knownCost.toFixed(6)}.`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Replay failed");
  process.exitCode = 1;
});

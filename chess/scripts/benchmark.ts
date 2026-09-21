import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Chess, DEFAULT_POSITION } from "chess.js";
import { loggedDecision } from "../src/lib/logged-decision";
import { MODELS, isPlayerId, type PlayerId } from "../src/lib/models";
import {
  EngineError,
  evaluatePosition,
  findBestMove,
  probeStockfish,
} from "../src/lib/native-stockfish";
import {
  appendRunEvent,
  createRun,
  readRun,
  runsDirectory,
  summarizeRun,
} from "../src/lib/run-store";
import type { RunState, RunSummary } from "../src/lib/run-types";

// Usage: node --env-file=.env.local --import tsx scripts/benchmark.ts [manifest.json]
// Passing an existing manifest resumes unfinished games without replaying paid moves.
const manifestPath = resolve(
  process.argv[2] ??
    `${dirname(runsDirectory())}/benchmarks/${new Date().toISOString().replaceAll(":", "-")}/results.json`,
);
const requestedModels = (
  process.env.CHESS_BENCHMARK_MODELS ?? "jev,astra"
).split(",");
if (
  !requestedModels.length ||
  requestedModels.some((model) => !isPlayerId(model))
)
  throw new Error("Unknown benchmark model");
const selectedModels = [...new Set(requestedModels)] as PlayerId[];
const MAX_PLIES = 400;
const ASTRA_CONCURRENCY = Math.min(
  50,
  Math.max(
    2,
    Math.floor(Number(process.env.CHESS_BENCHMARK_ASTRA_CONCURRENCY) || 2),
  ),
);
const concurrency: Record<PlayerId, number> = {
  jev: 2,
  astra: ASTRA_CONCURRENCY,
  glm: Math.min(
    50,
    Math.max(
      2,
      Math.floor(Number(process.env.CHESS_BENCHMARK_GLM_CONCURRENCY) || 2),
    ),
  ),
};
const batchModels = () => [...new Set(batch.jobs.map((job) => job.model))];
// Queue native searches rather than exceeding the engine's four-process limit.
let engineSlots = 4;
const engineWaiters: (() => void)[] = [];
async function withEngine<T>(work: () => Promise<T>): Promise<T> {
  if (engineSlots > 0) engineSlots--;
  else await new Promise<void>((resolve) => engineWaiters.push(resolve));
  try {
    return await work();
  } finally {
    const next = engineWaiters.shift();
    if (next) next();
    else engineSlots++;
  }
}
type Job = {
  model: PlayerId;
  game: number;
  runId?: string;
  status: "queued" | "playing" | "finished" | "error" | "capped";
  plies: number;
  result: string | null;
  reason?: string;
  summary?: RunSummary;
};
type Batch = {
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  configuration: Record<string, unknown>;
  jobs: Job[];
};
let batch: Batch;
let saveQueue = Promise.resolve();
let stopping = false;
const halted = new Set<PlayerId>();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    stopping = true;
    console.log(
      "Stopping after in-flight moves are saved; resume using the manifest path.",
    );
  });
}

function totals(model: PlayerId) {
  const jobs = batch.jobs.filter((job) => job.model === model);
  const wins = jobs.filter((job) => job.result === "1-0").length;
  const draws = jobs.filter((job) => job.result === "1/2-1/2").length;
  const losses = jobs.filter((job) => job.result === "0-1").length;
  const completed = wins + draws + losses;
  const decisions = jobs.reduce(
    (n, job) => n + (job.summary?.decisions ?? 0),
    0,
  );
  const latency = jobs.reduce(
    (n, job) =>
      n + (job.summary?.avgLatencyMs ?? 0) * (job.summary?.decisions ?? 0),
    0,
  );
  return {
    model,
    completed,
    wins,
    draws,
    losses,
    points: wins + draws / 2,
    scorePercent: completed ? (100 * (wins + draws / 2)) / completed : null,
    unfinished: jobs.length - completed,
    knownCostUsd: jobs.reduce(
      (n, job) => n + (job.summary?.billing.totalUsd ?? 0),
      0,
    ),
    unpricedRequests: jobs.reduce(
      (n, job) => n + (job.summary?.billing.unpricedRequests ?? 0),
      0,
    ),
    pendingRequests: jobs.reduce(
      (n, job) => n + (job.summary?.billing.pendingRequests ?? 0),
      0,
    ),
    requests: jobs.reduce((n, job) => n + (job.summary?.requests ?? 0), 0),
    decisions,
    averageDecisionMs: decisions ? latency / decisions : null,
  };
}

async function saveBatch() {
  batch.updatedAt = new Date().toISOString();
  const content =
    JSON.stringify({ ...batch, totals: batchModels().map(totals) }, null, 2) +
    "\n";
  saveQueue = saveQueue.then(async () => {
    await mkdir(dirname(manifestPath), { recursive: true });
    await writeFile(`${manifestPath}.tmp`, content, { mode: 0o600 });
    await rename(`${manifestPath}.tmp`, manifestPath);
  });
  await saveQueue;
}

function terminal(chess: Chess) {
  if (chess.isCheckmate())
    return {
      result: chess.turn() === "w" ? "0-1" : "1-0",
      reason: "Checkmate",
    };
  if (chess.isStalemate()) return { result: "1/2-1/2", reason: "Stalemate" };
  if (chess.isThreefoldRepetition())
    return { result: "1/2-1/2", reason: "Threefold repetition" };
  if (chess.isInsufficientMaterial())
    return { result: "1/2-1/2", reason: "Insufficient material" };
  if (chess.isDrawByFiftyMoves())
    return { result: "1/2-1/2", reason: "Fifty-move rule" };
  if (chess.isDraw()) return { result: "1/2-1/2", reason: "Draw" };
  return null;
}

async function play(job: Job) {
  const chess = new Chess();
  if (!job.runId) {
    const run = await createRun(job.model, chess.fen());
    job.runId = run.id;
    // Save ownership before any paid call, making restarts safe.
    await saveBatch();
    await appendRunEvent(run.id, "benchmark", {
      batch: manifestPath,
      game: job.game,
      maxPlies: MAX_PLIES,
    });
  }
  const runId = job.runId;
  let saved = await readRun(runId);
  const state = saved.events.findLast((event) => event.type === "state")
    ?.data as RunState | undefined;
  if (state?.pgn) chess.loadPgn(state.pgn);
  chess.setHeader("Event", "Models versus Stockfish benchmark");
  chess.setHeader("Round", String(job.game));
  chess.setHeader("White", MODELS[job.model].label);
  chess.setHeader("Black", "Stockfish 19 (Club)");
  chess.setHeader("Result", "*");
  job.status = "playing";
  job.reason = undefined;
  job.plies = chess.history().length;
  await saveBatch();
  console.log(
    `START ${job.model} game ${job.game}/50, ply ${job.plies}, run ${runId}`,
  );
  const controller = new AbortController();
  const position = () =>
    `position fen ${DEFAULT_POSITION}${
      chess.history().length
        ? ` moves ${chess
            .history({ verbose: true })
            .map((move) => move.lan)
            .join(" ")}`
        : ""
    }`;
  async function persist(
    phase: string,
    reason: string,
    move?: RunState["move"],
    error: string | null = null,
  ) {
    const evaluation =
      phase === "finished" || phase === "capped"
        ? await withEngine(() =>
            evaluatePosition(
              { position: position(), difficulty: "club" },
              controller.signal,
            ),
          )
        : null;
    await appendRunEvent(runId, "state", {
      phase,
      reason,
      fen: chess.fen(),
      pgn: chess.pgn(),
      plies: chess.history().length,
      result: job.result,
      error,
      evaluation,
      ...(move ? { move } : {}),
    });
    job.summary = summarizeRun(await readRun(runId));
    await saveBatch();
  }
  try {
    while (!stopping) {
      const ended = terminal(chess);
      if (ended) {
        job.status = "finished";
        job.result = ended.result;
        job.reason = ended.reason;
        chess.setHeader("Result", ended.result);
        await persist("finished", ended.reason);
        break;
      }
      if (chess.history().length >= MAX_PLIES) {
        job.status = "capped";
        job.reason = "Stopped at 400 plies; not counted as a draw";
        await persist("capped", job.reason);
        break;
      }
      let uci: string | undefined;
      if (chess.turn() === "w") {
        // Recover a successful response persisted immediately before an interrupted state write.
        saved = await readRun(runId);
        const lastStateIndex = saved.events.findLastIndex(
          (event) => event.type === "state",
        );
        const reusable = saved.events
          .slice(lastStateIndex + 1)
          .findLast(
            (event) =>
              event.type === "decision_result" &&
              event.data.fen === chess.fen(),
          );
        if (reusable) uci = String(reusable.data.move);
      }
      for (let attempt = 1; !uci; attempt++) {
        try {
          if (chess.turn() === "w") {
            const decision = await loggedDecision(
              job.model,
              { position: position(), runId },
              controller.signal,
            );
            if (decision.fen !== chess.fen())
              throw new Error("Decision position mismatch");
            uci = decision.move;
          } else {
            const reply = await withEngine(() =>
              findBestMove(
                { position: position(), difficulty: "club" },
                controller.signal,
              ),
            );
            uci = reply.move;
            if (!uci) throw new Error("Stockfish returned no move");
          }
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Unknown failure";
          const credentials =
            /API key|unavailable to this OpenAI|credits|billing|quota/i.test(
              message,
            );
          if (
            credentials &&
            !(error instanceof EngineError && error.status === 429)
          )
            halted.add(job.model);
          if (halted.has(job.model) || attempt >= 3 || stopping) throw error;
          await appendRunEvent(runId, "benchmark_retry", {
            attempt,
            message,
            ply: chess.history().length,
          });
          console.log(
            `RETRY ${job.model} game ${job.game}, ply ${chess.history().length}: ${message}`,
          );
          await sleep(attempt * 5000);
        }
      }
      const legal = chess
        .moves({ verbose: true })
        .find((move) => move.lan === uci);
      if (!legal) throw new Error("Benchmark rejected an illegal move");
      const move = chess.move(legal);
      job.plies = chess.history().length;
      await persist("playing", "Move played", {
        uci: move.lan,
        san: move.san,
        color: move.color,
      });
    }
    if (stopping && job.status === "playing") {
      job.status = "queued";
      await persist("paused", "Benchmark interrupted; safe to resume");
    }
  } catch (error) {
    job.status = "error";
    job.reason = error instanceof Error ? error.message : "Unknown failure";
    await persist("error", "Benchmark interrupted", undefined, job.reason);
  }
  await writeFile(
    resolve(
      dirname(manifestPath),
      `${job.model}-${String(job.game).padStart(2, "0")}.pgn`,
    ),
    chess.pgn() + "\n",
  );
  console.log(
    `END ${job.model} game ${job.game}: ${job.result ?? job.status}, ${job.plies} plies, $${job.summary?.cost ?? "unknown"}, ${job.reason ?? "paused"}`,
  );
}

async function worker(model: PlayerId) {
  while (!stopping && !halted.has(model)) {
    const job = batch.jobs.find(
      (entry) => entry.model === model && entry.status === "queued",
    );
    if (!job) return;
    job.status = "playing";
    await play(job);
  }
}

function progress() {
  console.log(
    JSON.stringify({
      at: new Date().toISOString(),
      totals: batchModels().map(totals),
      active: batch.jobs
        .filter((job) => job.status === "playing")
        .map(({ model, game, plies }) => ({ model, game, plies })),
    }),
  );
}

async function main() {
  const originalFetch = globalThis.fetch;
  let loggedLimits = false;
  globalThis.fetch = async (...args) => {
    const response = await originalFetch(...args);
    if (
      !loggedLimits &&
      String(args[0]) === "https://api.openai.com/v1/responses"
    ) {
      const limits = Object.fromEntries(
        [
          "x-ratelimit-limit-requests",
          "x-ratelimit-limit-tokens",
          "x-ratelimit-remaining-requests",
          "x-ratelimit-remaining-tokens",
          "x-ratelimit-reset-requests",
          "x-ratelimit-reset-tokens",
        ].map((name) => [name, response.headers.get(name)]),
      );
      console.log(`OPENAI_RATE_LIMITS ${JSON.stringify(limits)}`);
      loggedLimits = true;
    }
    return response;
  };
  for (const model of selectedModels) {
    if (!process.env[MODELS[model].keyName]?.trim())
      throw new Error(`Missing ${MODELS[model].keyName}`);
  }
  const engine = await probeStockfish(new AbortController().signal);
  if (!engine.name.startsWith("Stockfish 19"))
    throw new Error(`Unexpected engine: ${engine.name}`);
  try {
    batch = JSON.parse(await readFile(manifestPath, "utf8"));
    for (const job of batch.jobs)
      if (job.status === "playing" || job.status === "error")
        job.status = "queued";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    batch = {
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      configuration: {
        gamesPerModel: 50,
        white: Object.fromEntries(
          selectedModels.map((model) => [model, MODELS[model]]),
        ),
        black: engine.name,
        stockfish: { skill: 6, depth: 9, timeMs: 650, threads: 1, hashMb: 16 },
        initialFen: DEFAULT_POSITION,
        maxPlies: MAX_PLIES,
        concurrencyPerModel: Object.fromEntries(
          selectedModels.map((model) => [model, concurrency[model]]),
        ),
        maxAttemptsPerMove: 3,
        scoring:
          "Win=1, draw=0.5, loss=0. Errors and 400-ply caps are unfinished, not draws or losses.",
        input:
          "Same app prompts: full position, SAN history and all legal moves. No engine evaluation is shown to any model.",
        evaluations:
          "Terminal positions and capped games only; display-only analysis is skipped during play.",
      },
      jobs: selectedModels.flatMap((model) =>
        Array.from({ length: 50 }, (_, index) => ({
          model: model as PlayerId,
          game: index + 1,
          status: "queued" as const,
          plies: 0,
          result: null,
        })),
      ),
    };
  }
  const concurrencyHistory = (batch.configuration.concurrencyHistory ??=
    []) as Record<string, unknown>[];
  concurrencyHistory.push({
    at: new Date().toISOString(),
    jev: 2,
    astra: ASTRA_CONCURRENCY,
    glm: concurrency.glm,
    glmReasoning: MODELS.glm.reasoning,
    glmMaxOutputTokens: 16384,
    glmTimeoutMs: 300000,
    astraMaxOutputTokens: Math.min(
      16384,
      Math.max(
        4096,
        Math.floor(
          Number(process.env.CHESS_BENCHMARK_ASTRA_MAX_OUTPUT_TOKENS) || 4096,
        ),
      ),
    ),
    astraTimeoutMs: Math.min(
      300000,
      Math.max(
        90000,
        Number(process.env.CHESS_BENCHMARK_ASTRA_TIMEOUT_MS) || 90000,
      ),
    ),
  });
  await saveBatch();
  console.log(`BENCHMARK ${manifestPath}`);
  const interval = setInterval(progress, 30000);
  try {
    const workers = await Promise.allSettled(
      batchModels().flatMap((model) =>
        Array.from({ length: concurrency[model] }, () => worker(model)),
      ),
    );
    for (const result of workers)
      if (result.status === "rejected") {
        console.error(
          result.reason instanceof Error
            ? result.reason.message
            : "Benchmark worker failed",
        );
      }
    if (batch.jobs.every((job) => job.status === "finished"))
      batch.finishedAt = new Date().toISOString();
    await saveBatch();
    progress();
  } finally {
    clearInterval(interval);
  }
  if (!batch.finishedAt) process.exitCode = 1;
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Benchmark failed");
  process.exitCode = 1;
});

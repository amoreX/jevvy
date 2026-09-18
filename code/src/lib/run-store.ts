import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { Chess } from "chess.js";
import { MODELS, type PlayerId } from "./models";
import { EngineError } from "./native-stockfish";
import type { RunLog, RunEvent, RunSummary, RunState } from "./run-types";
import { runProvider } from "./run-types";
import { withRunCosts, summarizeCosts } from "./run-costs";

const globalStore = globalThis as typeof globalThis & {
  chessRunWrites?: Map<string, Promise<unknown>>;
};
const writes = (globalStore.chessRunWrites ??= new Map<
  string,
  Promise<unknown>
>());
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export function runsDirectory() {
  return process.env.CHESS_RUNS_DIR || join(process.cwd(), "data", "runs");
}
function file(id: string) {
  if (!UUID.test(id)) throw new EngineError("Invalid run ID.", 400);
  return join(runsDirectory(), `${id}.json`);
}
async function write(log: RunLog) {
  await mkdir(runsDirectory(), { recursive: true });
  const target = file(log.id);
  const temp = `${target}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(withRunCosts(log), null, 2) + "\n", {
    mode: 0o600,
  });
  await rename(temp, target);
}
export async function createRun(
  model: PlayerId,
  initialFen: string,
): Promise<RunLog> {
  let fen: string;
  try {
    fen = new Chess(initialFen).fen();
  } catch {
    throw new EngineError("Invalid starting FEN.", 400);
  }
  const log: RunLog = {
    id: randomUUID(),
    version: 1,
    model,
    modelId: MODELS[model].id,
    provider: MODELS[model].provider,
    reasoning: MODELS[model].reasoning,
    startedAt: new Date().toISOString(),
    initialFen: fen,
    opponent: { name: "Stockfish 19", skill: 6, depth: 9, timeMs: 650 },
    evaluation: { depth: 16, timeMs: 600, perspective: "white" },
    events: [],
  };
  await write(log);
  return log;
}
export async function readRun(id: string): Promise<RunLog> {
  for (let attempt = 0; ; attempt++) {
    try {
      return withRunCosts(
        JSON.parse(
          await readFile(/* turbopackIgnore: true */ file(id), "utf8"),
        ),
      );
    } catch (error) {
      if (error instanceof EngineError) throw error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") throw new EngineError("Run not found.", 404);
      // Cloud-backed folders can briefly return empty data during an atomic replacement.
      const transient =
        error instanceof SyntaxError ||
        ["EIO", "EBUSY", "EAGAIN", "ETIMEDOUT"].includes(code ?? "");
      if (transient && attempt < 3) {
        await sleep([50, 150, 500][attempt]);
        continue;
      }
      throw new EngineError("Could not read the run log.", 503);
    }
  }
}
export async function appendRunEvent(
  id: string,
  type: string,
  data: Record<string, unknown>,
  eventId: string = randomUUID(),
) {
  const key = file(id);
  const update = (writes.get(key) ?? Promise.resolve())
    .catch(() => undefined)
    .then(async () => {
      const log = await readRun(id);
      if (log.events.some((event) => event.id === eventId)) return;
      const event: RunEvent = {
        id: eventId,
        at: new Date().toISOString(),
        type,
        data,
      };
      log.events.push(event);
      await write(log);
    });
  writes.set(key, update);
  try {
    await update;
  } finally {
    if (writes.get(key) === update) writes.delete(key);
  }
}
export function summarizeRun(log: RunLog): RunSummary {
  const states = log.events.filter((event) => event.type === "state");
  const latest = states.at(-1)?.data as RunState | undefined;
  const results = log.events.filter(
    (event) => event.type === "decision_result",
  );
  const billing = summarizeCosts(withRunCosts(log));
  return {
    id: log.id,
    model: log.model,
    reasoning: log.reasoning,
    provider: runProvider(log),
    startedAt: log.startedAt,
    phase: latest?.phase ?? "created",
    plies: latest?.plies ?? 0,
    result: latest?.result ?? null,
    requests: log.events.filter((event) => event.type === "decision_request")
      .length,
    decisions: results.length,
    cost: billing.totalUsd,
    billing,
    avgLatencyMs: results.length
      ? results.reduce(
          (sum, event) => sum + Number(event.data.latencyMs ?? 0),
          0,
        ) / results.length
      : null,
    evaluation: latest?.evaluation ?? null,
  };
}
export async function listRuns(): Promise<RunSummary[]> {
  await mkdir(runsDirectory(), { recursive: true });
  const names = (
    await readdir(/* turbopackIgnore: true */ runsDirectory())
  ).filter((name) => name.endsWith(".json") && UUID.test(name.slice(0, -5)));
  const logs = await Promise.all(
    names.map((name) => readRun(name.slice(0, -5))),
  );
  return logs
    .map(summarizeRun)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

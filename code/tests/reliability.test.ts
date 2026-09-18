import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Chess } from "chess.js";
import { appendRunEvent, createRun, readRun } from "../src/lib/run-store";
import { HttpRunLogger, type RunState } from "../src/lib/run-types";
import { evaluationPresentation, parseEvaluation } from "../src/lib/evaluation";

const state: RunState = {
  phase: "playing",
  fen: new Chess().fen(),
  pgn: "*",
  plies: 0,
  result: null,
  reason: "move",
  error: null,
  evaluation: null,
};

test("evaluation rail retains the last score during a move, labels it stale, and clears on reset", () => {
  const chess = new Chess();
  const evaluation = parseEvaluation(
    "info depth 16 score cp -650",
    chess.fen(),
  )!;
  const game = {
    evaluation,
    fen: chess.fen(),
    analyzing: false,
    evaluationError: null,
  };
  const before = evaluationPresentation(game, "Jev");
  chess.move("e4");
  const pending = evaluationPresentation(
    { ...game, fen: chess.fen(), analyzing: true },
    "Jev",
  );
  assert.equal(pending.share, before.share);
  assert.equal(pending.score, "-6.50");
  assert.equal(pending.stale, true);
  assert.match(pending.label, /Previous position.*updating/);
  const after = evaluationPresentation(
    {
      ...game,
      fen: chess.fen(),
      evaluation: { ...evaluation, fen: chess.fen(), cp: -700 },
    },
    "Jev",
  );
  assert.equal(after.stale, false);
  assert.equal(after.score, "-7.00");
  assert.equal(
    evaluationPresentation({ ...game, evaluation: null }, "Jev").score,
    "—",
  );
});

test("temporary Windows replacement locks retry the same pending log without losing events", async (t) => {
  const directory = await fs.mkdtemp(join(tmpdir(), "jev-replace-"));
  const previous = process.env.CHESS_RUNS_DIR;
  process.env.CHESS_RUNS_DIR = directory;
  t.after(async () => {
    if (previous === undefined) delete process.env.CHESS_RUNS_DIR;
    else process.env.CHESS_RUNS_DIR = previous;
    await fs.rm(directory, { recursive: true, force: true });
  });
  const run = await createRun("jev", state.fen);
  const rename = fs.rename;
  let attempts = 0;
  const sources: string[] = [];
  t.mock.method(fs, "rename", async (from: string, to: string) => {
    sources.push(from);
    attempts++;
    if (attempts <= 2)
      throw Object.assign(new Error("Windows sharing violation"), {
        code: "EPERM",
      });
    return rename(from, to);
  });
  await appendRunEvent(run.id, "state", state, "same-event");
  await appendRunEvent(run.id, "state", state, "same-event");
  assert.equal(attempts, 3);
  assert.equal(new Set(sources).size, 1);
  assert.equal((await readRun(run.id)).events.length, 1);
  assert.equal(
    (await fs.readdir(directory)).filter((f) => f.endsWith(".tmp")).length,
    0,
  );
});

test("browser retries lost save responses with the same event ID and preserves queued order", async (t) => {
  const bodies: string[] = [];
  const stored = new Map<string, RunState>();
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: unknown, options: RequestInit) => {
      bodies.push(String(options.body));
      const { eventId, state: savedState } = JSON.parse(String(options.body));
      if (bodies.length === 2) return new Response("busy", { status: 503 });
      stored.set(eventId, savedState);
      if (bodies.length === 1) throw new TypeError("fetch failed after save");
      return Response.json({ saved: true });
    },
  );
  const logger = new HttpRunLogger();
  await Promise.all([
    logger.state("run", state),
    logger.state("run", { ...state, reason: "paused" }),
  ]);
  assert.equal(bodies.length, 4);
  assert.equal(bodies[0], bodies[1]);
  assert.equal(bodies[1], bodies[2]);
  assert.notEqual(JSON.parse(bodies[2]).eventId, JSON.parse(bodies[3]).eventId);
  assert.deepEqual(
    [...stored.values()].map((s) => s.reason),
    ["move", "paused"],
  );
});

test("save retries are bounded and do not retry validation failures", async (t) => {
  let calls = 0;
  let status = 400;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return new Response("unavailable", { status });
  });
  const logger = new HttpRunLogger();
  await assert.rejects(logger.state("run", state), /save/);
  assert.equal(calls, 1);
  calls = 0;
  status = 503;
  await assert.rejects(logger.state("run", state), /save/);
  assert.equal(calls, 3);
});

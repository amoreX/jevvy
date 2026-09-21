import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Chess } from "chess.js";
import { appendRunEvent, createRun, readRun } from "../src/lib/run-store";

test("a transient empty read recovers the existing run and billing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chess-log-recovery-"));
  const previous = process.env.CHESS_RUNS_DIR;
  process.env.CHESS_RUNS_DIR = directory;
  try {
    const run = await createRun("jev", new Chess().fen());
    await appendRunEvent(run.id, "decision_request", {
      requestId: "paid-move",
    });
    await appendRunEvent(run.id, "decision_result", {
      requestId: "paid-move",
      move: "e2e4",
      usage: { cost: 0.000123, costSource: "provider" },
    });
    const path = join(directory, `${run.id}.json`);
    const original = await readFile(path, "utf8");
    await writeFile(path, "");
    const restore = sleep(20).then(() => writeFile(path, original));
    const recovered = await readRun(run.id);
    await restore;
    assert.equal(recovered.id, run.id);
    assert.deepEqual(recovered.events, JSON.parse(original).events);
    assert.equal(recovered.billing?.totalUsd, 0.000123);
    assert.equal(recovered.billing?.complete, true);
  } finally {
    if (previous === undefined) delete process.env.CHESS_RUNS_DIR;
    else process.env.CHESS_RUNS_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test("persistent corrupt logs fail after bounded retries instead of becoming empty runs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chess-log-corrupt-"));
  const previous = process.env.CHESS_RUNS_DIR;
  process.env.CHESS_RUNS_DIR = directory;
  try {
    const run = await createRun("jev", new Chess().fen());
    await writeFile(join(directory, `${run.id}.json`), "{");
    await assert.rejects(readRun(run.id), /Could not read the run log/);
  } finally {
    if (previous === undefined) delete process.env.CHESS_RUNS_DIR;
    else process.env.CHESS_RUNS_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

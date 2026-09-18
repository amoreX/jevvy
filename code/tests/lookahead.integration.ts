import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Chess } from "chess.js";
import { createRun, readRun } from "../src/lib/run-store";
import { loggedDecision } from "../src/lib/logged-decision";
import { createDecisionRequest } from "../src/lib/server-jev";
import { LOOKAHEAD_SETTINGS } from "../src/lib/lookahead";
import { POST as jevPost } from "../src/app/api/jev/route";
import { POST as runsPost } from "../src/app/api/runs/route";

test("real MultiPV enriches every legal choice; saved payload equals transmitted payload without scores", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "jev-lookahead-"));
  const originalDir = process.env.CHESS_RUNS_DIR;
  const originalKey = process.env.OPENROUTER_API_KEY;
  process.env.CHESS_RUNS_DIR = directory;
  process.env.OPENROUTER_API_KEY = "fake-test-key";
  t.after(async () => {
    if (originalDir === undefined) delete process.env.CHESS_RUNS_DIR;
    else process.env.CHESS_RUNS_DIR = originalDir;
    if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalKey;
    await rm(directory, { recursive: true, force: true });
  });
  let sent: ReturnType<typeof createDecisionRequest> | undefined;
  let calls = 0;
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: unknown, options: RequestInit) => {
      calls++;
      sent = JSON.parse(String(options.body));
      return Response.json({
        model: "typesafe/jev-1.13",
        answers: { move: { type: "choice", choice: "e2e4" } },
      });
    },
  );
  const fen = new Chess().fen();
  const run = await createRun("jev", fen, true);
  assert.deepEqual(run.lookahead, LOOKAHEAD_SETTINGS);
  const input = { position: `position fen ${fen}`, runId: run.id };
  const response = await jevPost(
    new Request("http://localhost/api/jev", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/x-ndjson",
        origin: "http://localhost",
      },
      body: JSON.stringify(input),
    }),
  );
  const events = (await response.text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(events.slice(0, 2), [
    { stage: "lookahead" },
    { stage: "choosing" },
  ]);
  assert.equal(events[2].decision.move, "e2e4");
  assert.equal(calls, 1);
  const saved = await readRun(run.id);
  const request = saved.events.find(
    (event) => event.type === "decision_request",
  )!;
  assert.deepEqual(request.data.request, sent);
  const metadata = request.data.lookahead as {
    engine: string;
    depth: number;
    analysisMs: number;
  };
  assert.match(metadata.engine, /Stockfish 19/);
  assert.ok(metadata.depth > 0);
  assert.ok(metadata.analysisMs > 0);
  const original = createDecisionRequest(input);
  assert.deepEqual(
    Object.keys(sent!.questions.move.criteria),
    Object.keys(original.questions.move.criteria),
  );
  for (const [move, description] of Object.entries(
    sent!.questions.move.criteria,
  )) {
    assert.ok(description.startsWith(original.questions.move.criteria[move]));
    assert.match(description, /Predicted best-play continuation/);
    const details = JSON.parse(
      description.slice(description.indexOf('{"continuation_san"')),
    );
    const board = new Chess(fen);
    for (const san of details.continuation_san) board.move(san);
    assert.equal(board.fen(), details.resulting_fen);
    assert.ok(details.continuation_san.length <= 6);
    assert.doesNotMatch(
      description,
      /"(?:score|cp|rank|multipv|win_probability)"/,
    );
  }

  // Off is the exact baseline payload, even if a caller asks to override a saved run.
  const baseline = await createRun("jev", fen);
  await loggedDecision(
    "jev",
    { ...input, runId: baseline.id, lookahead: true },
    new AbortController().signal,
  );
  assert.deepEqual(sent, original);
  assert.equal((await readRun(baseline.id)).lookahead, null);

  // Cancellation during preparation never starts a paid request or pending billing item.
  const cancelled = await createRun("jev", fen, true);
  const controller = new AbortController();
  await assert.rejects(
    loggedDecision(
      "jev",
      { ...input, runId: cancelled.id },
      controller.signal,
      () => controller.abort(),
    ),
    /cancelled/,
  );
  assert.equal(calls, 2);
  const cancelledLog = await readRun(cancelled.id);
  assert.equal(
    cancelledLog.events.some((event) => event.type === "decision_request"),
    false,
  );
  assert.equal(cancelledLog.events[0].type, "lookahead_error");

  await assert.rejects(createRun("glm", fen, true), /Jev only/);
  const invalid = await runsPost(
    new Request("http://localhost/api/runs", {
      method: "POST",
      body: JSON.stringify({ model: "jev", initialFen: fen, lookahead: "yes" }),
    }),
  );
  assert.equal(invalid.status, 400);
});

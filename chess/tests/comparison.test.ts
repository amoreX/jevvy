import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_POSITION } from "chess.js";
import {
  parseEvaluation,
  evaluationScore,
  evaluationLabel,
  whiteShare,
} from "../src/lib/evaluation";
import { createAstraRequest, chooseAstraMove } from "../src/lib/server-astra";
import { createDecisionRequest } from "../src/lib/server-jev";
import {
  createRun,
  appendRunEvent,
  readRun,
  listRuns,
  summarizeRun,
} from "../src/lib/run-store";
import { loggedDecision } from "../src/lib/logged-decision";
import { GET, POST } from "../src/app/api/runs/[id]/route";
import { GET as astraConfig } from "../src/app/api/astra/route";
import { JevPlayer } from "../src/lib/jev";
import { MODELS } from "../src/lib/models";
const position = `position fen ${DEFAULT_POSITION}`;
const signal = () => new AbortController().signal;
process.env.OPENROUTER_API_KEY = "test-only-never-live";
process.env.OPENAI_API_KEY = "openai-test-only-never-live";

test("evaluation normalizes centipawns and mate distances to White, ignoring bounds and secondary lines", () => {
  const blackFen = DEFAULT_POSITION.replace(" w ", " b ");
  const w = parseEvaluation(
    "info depth 15 score cp 130 nodes 20 pv e2e4",
    DEFAULT_POSITION,
  )!;
  const b = parseEvaluation("info depth 15 score cp 130", blackFen)!;
  assert.equal(w.cp, 130);
  assert.equal(b.cp, -130);
  assert.equal(evaluationScore(w), "+1.30");
  assert.equal(evaluationScore(b), "-1.30");
  assert.equal(evaluationLabel(b, "Astra"), "Stockfish is ahead");
  assert.ok(whiteShare(w) > 50);
  assert.ok(whiteShare(b) < 50);
  const mate = parseEvaluation("info depth 12 score mate -3", blackFen)!;
  assert.equal(mate.mate, 3);
  assert.equal(evaluationScore(mate), "M3");
  assert.match(evaluationLabel(mate, "Astra"), /Astra has mate in 3/);
  for (const line of [
    "info depth 12 score cp 50 lowerbound",
    "info depth 10 multipv 2 score cp 80",
    "bestmove e2e4",
  ])
    assert.equal(parseEvaluation(line, DEFAULT_POSITION), null);
  assert.equal(evaluationScore(null), "—");
  assert.equal(
    evaluationScore({ ...w, terminal: true, winner: "b", mate: 0, cp: null }),
    "0–1",
  );
});

test("Astra gets the same state and complete choices as Jev, with medium reasoning and constrained JSON", () => {
  const astra = createAstraRequest({ position });
  const jev = createDecisionRequest({ position });
  const input = JSON.parse(astra.input[1].content);
  assert.equal(astra.model, "gpt-6-astra");
  assert.deepEqual(astra.reasoning, { effort: "medium" });
  assert.equal(astra.store, false);
  assert.deepEqual(input.state, jev.state);
  assert.deepEqual(input.legal_moves, jev.questions.move.criteria);
  assert.deepEqual(
    astra.text.format.schema.properties.move.enum,
    Object.keys(jev.questions.move.criteria),
  );
  assert.equal(astra.text.format.strict, true);
  assert.ok(!JSON.stringify(input).includes('"evaluation"'));
});

test("Astra transport validates responses and keeps reasoning fixed to medium", async (t) => {
  let content = '{"move":"e2e4"}';
  let status = "completed";
  let partType = "output_text";
  t.mock.method(
    globalThis,
    "fetch",
    async (url: string, options: RequestInit) => {
      assert.equal(url, "https://api.openai.com/v1/responses");
      assert.equal(
        new Headers(options.headers).get("authorization"),
        "Bearer openai-test-only-never-live",
      );
      assert.equal(JSON.parse(String(options.body)).reasoning.effort, "medium");
      return Response.json({
        id: "request-test",
        model: MODELS.astra.id,
        status,
        incomplete_details:
          status === "incomplete" ? { reason: "max_output_tokens" } : null,
        output: [
          { type: "reasoning", summary: [] },
          { type: "message", content: [{ type: partType, text: content }] },
        ],
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          output_tokens_details: { reasoning_tokens: 12 },
        },
      });
    },
  );
  const result = await chooseAstraMove({ position }, signal());
  assert.equal(result.move, "e2e4");
  assert.equal(result.reasoning, "medium");
  assert.equal(result.usage?.inputTokens, 100);
  assert.equal(result.usage?.outputTokens, 20);
  assert.equal(result.usage?.reasoningTokens, 12);
  assert.equal(result.usage?.cost, 0.002);
  assert.equal(result.usage?.costSource, "calculated");
  assert.equal(result.choices.length, 20);
  for (content of ['{"move":"e2e5"}', "not json", '{"move":"toString"}'])
    await assert.rejects(chooseAstraMove({ position }, signal()));
  status = "incomplete";
  await assert.rejects(chooseAstraMove({ position }, signal()), /token limit/);
  status = "failed";
  await assert.rejects(
    chooseAstraMove({ position }, signal()),
    /did not complete/,
  );
  status = "completed";
  partType = "refusal";
  await assert.rejects(chooseAstraMove({ position }, signal()), /declined/);
});

test("Astra cancellation and upstream errors are bounded and sanitized", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    async () => new Response("secret upstream body", { status: 401 }),
  );
  await assert.rejects(
    chooseAstraMove({ position }, signal()),
    /OpenAI rejected/,
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    chooseAstraMove({ position }, controller.signal),
    /cancelled/,
  );
});

test("Astra requires its own OpenAI key and never falls back to OpenRouter", async (t) => {
  const key = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  t.after(() => {
    process.env.OPENAI_API_KEY = key;
  });
  const mock = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("Unexpected network call");
  });
  assert.equal((await (await astraConfig()).json()).configured, false);
  await assert.rejects(
    loggedDecision("astra", { position }, signal()),
    /OPENAI_API_KEY/,
  );
  assert.equal(mock.mock.callCount(), 0);
});

test("browser model selector routes Astra with run ID, without a browser credential", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    async (url: string, options: RequestInit) => {
      assert.equal(url, "/api/astra");
      assert.equal(new Headers(options.headers).has("authorization"), false);
      if (options.method === "GET") return Response.json({ configured: true });
      assert.deepEqual(JSON.parse(String(options.body)), {
        position,
        runId: "run-test",
      });
      return Response.json({
        move: "e2e4",
        fen: DEFAULT_POSITION,
        choices: ["e2e4"],
        model: MODELS.astra.id,
        latencyMs: 1,
      });
    },
  );
  const astra = new JevPlayer("astra", "run-test");
  await astra.init();
  assert.equal((await astra.choose(position)).move, "e2e4");
  astra.dispose();
});

test("run files preserve concurrent events, deduplicate retries, and survive independent reads", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "chess-logs-test-"));
  process.env.CHESS_RUNS_DIR = dir;
  t.after(async () => {
    delete process.env.CHESS_RUNS_DIR;
    await rm(dir, { recursive: true });
  });
  const log = await createRun("astra", DEFAULT_POSITION);
  await Promise.all(
    Array.from({ length: 12 }, (_, n) =>
      appendRunEvent(
        log.id,
        "state",
        { phase: "paused", plies: n, reason: `state-${n}` },
        `event-${n}`,
      ),
    ),
  );
  await appendRunEvent(log.id, "state", { phase: "error" }, "event-3");
  assert.equal((await readRun(log.id)).events.length, 12);
  const disk = JSON.parse(await readFile(join(dir, `${log.id}.json`), "utf8"));
  assert.equal(disk.reasoning, "medium");
  assert.equal(disk.provider, "openai");
  assert.equal(disk.opponent.skill, 6);
  assert.equal((await listRuns())[0].plies, 11);
  await assert.rejects(readRun("../../.env.local"), /Invalid run ID/);
});

test("every provider attempt records exact input and success or error without logging keys", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "chess-decisions-test-"));
  process.env.CHESS_RUNS_DIR = dir;
  t.after(async () => {
    delete process.env.CHESS_RUNS_DIR;
    await rm(dir, { recursive: true });
  });
  const log = await createRun("astra", DEFAULT_POSITION);
  let successful = true;
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    assert.equal(
      (await readRun(log.id)).events.at(-1)?.type,
      "decision_request",
    );
    return successful
      ? Response.json({
          model: MODELS.astra.id,
          status: "completed",
          output: [
            {
              type: "message",
              content: [{ type: "output_text", text: '{"move":"e2e4"}' }],
            },
          ],
          usage: { input_tokens: 1, output_tokens: 1 },
        })
      : new Response("private", { status: 429 });
  });
  await loggedDecision("astra", { position, runId: log.id }, signal());
  successful = false;
  await assert.rejects(
    loggedDecision("astra", { position, runId: log.id }, signal()),
    /rate limit/,
  );
  const saved = await readRun(log.id);
  assert.deepEqual(
    saved.events.map((e) => e.type),
    [
      "decision_request",
      "decision_result",
      "decision_request",
      "decision_error",
    ],
  );
  const encoded = JSON.stringify(saved);
  assert.equal(saved.events[0].data.provider, "openai");
  assert.equal(summarizeRun(saved).cost, 0.00006);
  assert.equal(summarizeRun(saved).billing.unpricedRequests, 1);
  assert.equal(summarizeRun(saved).billing.complete, false);
  assert.equal(encoded.includes("test-only-never-live"), false);
  assert.equal(encoded.includes("Authorization"), false);
  await assert.rejects(
    loggedDecision("jev", { position, runId: log.id }, signal()),
    /different model/,
  );
  assert.equal(calls, 2);
});

test("legacy OpenRouter runs keep their provider and cannot silently switch to direct OpenAI", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "chess-legacy-test-"));
  process.env.CHESS_RUNS_DIR = dir;
  t.after(async () => {
    delete process.env.CHESS_RUNS_DIR;
    await rm(dir, { recursive: true });
  });
  const log = await createRun("astra", DEFAULT_POSITION);
  delete log.provider;
  log.modelId = "openai/gpt-6-astra";
  await writeFile(join(dir, `${log.id}.json`), JSON.stringify(log));
  assert.equal((await listRuns())[0].provider, "openrouter");
  const mock = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("Unexpected network call");
  });
  await assert.rejects(
    loggedDecision("astra", { position, runId: log.id }, signal()),
    /different model.*provider/,
  );
  assert.equal(mock.mock.callCount(), 0);
  assert.equal((await readRun(log.id)).events.length, 0);
});

test("run API persists validated states and exports JSON and PGN", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "chess-route-test-"));
  process.env.CHESS_RUNS_DIR = dir;
  t.after(async () => {
    delete process.env.CHESS_RUNS_DIR;
    await rm(dir, { recursive: true });
  });
  const log = await createRun("jev", DEFAULT_POSITION);
  const context = { params: Promise.resolve({ id: log.id }) };
  const response = await POST(
    new Request(`http://localhost/api/runs/${log.id}`, {
      method: "POST",
      body: JSON.stringify({
        eventId: "state-1",
        state: {
          phase: "paused",
          fen: DEFAULT_POSITION,
          pgn: '[White "Jev"]\n\n*',
          plies: 0,
          reason: "paused",
        },
      }),
    }),
    context,
  );
  assert.equal(response.status, 200);
  const pgn = await GET(
    new Request(`http://localhost/api/runs/${log.id}?format=pgn`),
    context,
  );
  assert.match(pgn.headers.get("content-disposition")!, /attachment/);
  assert.match(await pgn.text(), /White "Jev"/);
  const json = await GET(
    new Request(`http://localhost/api/runs/${log.id}?format=json`),
    context,
  );
  assert.equal((await json.json()).events.length, 1);
  const bad = await POST(
    new Request(`http://localhost/api/runs/${log.id}`, {
      method: "POST",
      body: JSON.stringify({ eventId: "x", state: {} }),
    }),
    context,
  );
  assert.equal(bad.status, 400);
});

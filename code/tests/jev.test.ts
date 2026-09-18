import assert from "node:assert/strict";
import { test } from "node:test";
import { Chess, DEFAULT_POSITION } from "chess.js";
import { createDecisionRequest, chooseJevMove } from "../src/lib/server-jev";
import { JevPlayer, JEV_MODEL } from "../src/lib/jev";
import { GET, POST } from "../src/app/api/jev/route";

const position = `position fen ${DEFAULT_POSITION}`;
const signal = () => new AbortController().signal;
// This test file always stubs fetch before invoking the provider adapter.
process.env.OPENROUTER_API_KEY = "test-only-never-live";

test("the opening payload contains all 20 moves, structured state and no engine rankings", () => {
  const payload = createDecisionRequest({
    position,
    criteria: { e2e4: "Only this one" },
  });
  assert.equal(payload.model, JEV_MODEL);
  assert.equal(payload.state.pieces.length, 32);
  assert.equal(payload.state.fen, DEFAULT_POSITION);
  assert.equal(Object.keys(payload.questions.move.criteria).length, 20);
  assert.match(payload.questions.move.criteria.e2e4, /pawn from e2 to e4/);
  assert.equal(JSON.stringify(payload).includes("evaluation"), false);
});

test("special moves and all four promotions remain distinct choices", () => {
  for (const [fen, wanted] of [
    ["r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1", ["e1g1", "e1c1"]],
    ["4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1", ["e5d6"]],
    ["7k/P7/8/8/8/8/8/7K w - - 0 1", ["a7a8q", "a7a8r", "a7a8b", "a7a8n"]],
    ["4r2k/8/8/8/8/8/8/4K3 w - - 0 1", ["e1d1", "e1f1"]],
  ] as const) {
    const payload = createDecisionRequest({ position: `position fen ${fen}` });
    const choices = Object.keys(payload.questions.move.criteria);
    const board = new Chess(fen);
    assert.deepEqual(
      choices,
      board.moves({ verbose: true }).map((move) => move.lan),
    );
    for (const move of wanted) assert.ok(choices.includes(move));
  }
});

test("state is rebuilt with full history and rejects Black turns, terminal games and command injection", () => {
  const payload = createDecisionRequest({
    position: `${position} moves e2e4 e7e5`,
  });
  assert.deepEqual(payload.state.move_history_san, ["e4", "e5"]);
  for (const invalid of [
    null,
    { position: `${position}\nquit` },
    { position: `${position} moves e2e5` },
    { position: `${position} moves e2e4` },
    { position: `${position} moves g1f3 g8f6 f3g1 f6g8 g1f3 g8f6 f3g1 f6g8` },
    { position: "position fen 7k/8/6K1/8/8/8/8/R7 w - - 100 51" },
  ])
    assert.throws(() => createDecisionRequest(invalid));
});

test("server uses the Decisions endpoint, keeps auth private, and accepts optional confidence", async (t) => {
  let calls = 0;
  t.mock.method(
    globalThis,
    "fetch",
    async (url: string, options: RequestInit) => {
      calls++;
      assert.equal(url, "https://openrouter.ai/api/alpha/decisions");
      assert.equal(
        new Headers(options.headers).get("authorization"),
        "Bearer test-only-never-live",
      );
      const body = JSON.parse(String(options.body));
      assert.equal(body.questions.move.type, "choice");
      assert.equal(Object.keys(body.questions.move.criteria).length, 20);
      assert.equal(body.model, JEV_MODEL);
      return Response.json({
        model: JEV_MODEL,
        answers: { move: { type: "choice", choice: "g1f3" } },
        usage: { input_tokens: 700, output_tokens: 20, cost: 0.00003 },
      });
    },
  );
  const result = await chooseJevMove({ position }, signal());
  assert.equal(result.move, "g1f3");
  assert.equal(result.fen, DEFAULT_POSITION);
  assert.equal(result.confidence, undefined);
  assert.equal(result.choices.length, 20);
  assert.deepEqual(result.usage, {
    inputTokens: 700,
    outputTokens: 20,
    cost: 0.00003,
    costSource: "provider",
  });
  assert.ok(!JSON.stringify(result).includes("test-only"));
  assert.equal(calls, 1);
});

test("invalid provider choices cannot cross the boundary", async (t) => {
  let answer: unknown;
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({ model: JEV_MODEL, answers: { move: answer } }),
  );
  for (answer of [
    null,
    { type: "score", choice: "e2e4" },
    { type: "choice", choice: "e2e5" },
    { type: "choice", choice: "toString" },
  ]) {
    await assert.rejects(chooseJevMove({ position }, signal()), /legal move/);
  }
});

test("provider auth, credit, rate-limit and server failures never leak their bodies or retry automatically", async (t) => {
  let status = 401;
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return new Response("private upstream message test-only-never-live", {
      status,
    });
  });
  for (status of [401, 402, 403, 429, 500]) {
    await assert.rejects(
      chooseJevMove({ position }, signal()),
      (error: Error) =>
        !error.message.includes("private") &&
        !error.message.includes("test-only"),
    );
  }
  assert.equal(calls, 5);
});

test("cancellation and timeout release the provider slot", async (t) => {
  const timeout = new AbortController();
  t.mock.method(AbortSignal, "timeout", () => timeout.signal);
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: string, options: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        options.signal!.addEventListener(
          "abort",
          () => reject(new Error("aborted")),
          { once: true },
        );
      }),
  );
  const controller = new AbortController();
  const pending = chooseJevMove({ position }, controller.signal);
  controller.abort();
  await assert.rejects(pending, /cancelled/);
  const timed = chooseJevMove({ position }, signal());
  timeout.abort();
  await assert.rejects(timed, /too long/);
});

test("the route checks configuration without calling the provider and rejects bad inputs", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    throw new Error("Must not call");
  });
  const health = await GET();
  assert.deepEqual(await health.json(), { model: JEV_MODEL, configured: true });
  for (const [body, status, origin] of [
    ["not JSON", 400, undefined],
    ["x".repeat(33000), 413, undefined],
    [JSON.stringify({ position: `${position} moves e2e5` }), 400, undefined],
    [JSON.stringify({ position }), 403, "https://another-site.test"],
  ] as const) {
    const response = await POST(
      new Request("http://localhost/api/jev", {
        method: "POST",
        body,
        headers: origin ? { origin } : undefined,
      }),
    );
    assert.equal(response.status, status);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
  delete process.env.OPENROUTER_API_KEY;
  try {
    assert.deepEqual(await (await GET()).json(), {
      model: JEV_MODEL,
      configured: false,
    });
    const response = await POST(
      new Request("http://localhost/api/jev", {
        method: "POST",
        body: JSON.stringify({ position }),
      }),
    );
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /OPENROUTER_API_KEY/);
  } finally {
    process.env.OPENROUTER_API_KEY = "test-only-never-live";
  }
  assert.equal(calls, 0);
});

test("browser adapter checks config, submits history without a key, and aborts on disposal", async (t) => {
  const requests: RequestInit[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (url: string, options: RequestInit) => {
      assert.equal(url, "/api/jev");
      requests.push(options);
      assert.equal(new Headers(options.headers).has("authorization"), false);
      return Response.json(
        options.method === "GET"
          ? { configured: true }
          : {
              move: "e2e4",
              fen: DEFAULT_POSITION,
              model: JEV_MODEL,
              choices: ["e2e4"],
              latencyMs: 1,
            },
      );
    },
  );
  const player = new JevPlayer();
  assert.equal(requests.length, 0);
  await player.init();
  await player.choose(position);
  assert.deepEqual(JSON.parse(String(requests[1].body)), { position });
  player.dispose();
  assert.equal(requests[1].signal!.aborted, true);
});

test("browser adapter rejects missing configuration before any inference", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({ configured: false }),
  );
  await assert.rejects(new JevPlayer().init(), /OPENROUTER_API_KEY/);
});

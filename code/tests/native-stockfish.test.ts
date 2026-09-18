import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_POSITION } from "chess.js";
import { EngineError, parseEngineRequest } from "../src/lib/native-stockfish";
import { POST } from "../src/app/api/stockfish/route";
import { StockfishEngine } from "../src/lib/stockfish";

const position = `position fen ${DEFAULT_POSITION}`;

test("the native boundary preserves full legal history and rejects commands and illegal moves", () => {
  const parsed = parseEngineRequest({
    position: `${position} moves e2e4 e7e5 g1f3`,
    difficulty: "club",
  });
  assert.equal(parsed.position, `${position} moves e2e4 e7e5 g1f3`);
  assert.equal(parsed.chess.turn(), "b");
  for (const invalid of [
    null,
    { position, difficulty: "toString" },
    { position: `${position}\nquit`, difficulty: "club" },
    { position: `${position} moves e2e5`, difficulty: "club" },
    { position: `${position} moves e7e5`, difficulty: "club" },
    { position: `${position} moves e2e4;quit`, difficulty: "club" },
    { position: "position fen invalid", difficulty: "club" },
  ]) {
    assert.throws(
      () => parseEngineRequest(invalid),
      (error) => error instanceof EngineError && error.status === 400,
    );
  }
});

test("finished games never reach the engine", () => {
  assert.throws(
    () =>
      parseEngineRequest({
        position: "position fen 7k/5Q2/6K1/8/8/8/8/8 b - - 0 1",
        difficulty: "casual",
      }),
    (error) => error instanceof EngineError && error.status === 422,
  );
});

test("the API returns useful errors for invalid JSON, oversized requests, and illegal moves", async () => {
  for (const [body, status] of [
    ["not JSON", 400],
    ["x".repeat(33000), 413],
    [
      JSON.stringify({
        position: `${position} moves e2e5`,
        difficulty: "club",
      }),
      400,
    ],
  ] as const) {
    const response = await POST(
      new Request("http://localhost/api/stockfish", { method: "POST", body }),
    );
    assert.equal(response.status, status);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(typeof (await response.json()).error, "string");
  }
});

test("the browser adapter stays idle until Start and sends full history to the native API", async (t) => {
  const requests: RequestInit[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (url: string, options: RequestInit) => {
      assert.equal(url, "/api/stockfish");
      requests.push(options);
      return Response.json(
        options.method === "GET"
          ? { name: "Stockfish 18" }
          : { name: "Stockfish 18", move: "e7e5" },
      );
    },
  );
  const engine = new StockfishEngine();
  assert.equal(requests.length, 0);
  await engine.init();
  assert.equal(await engine.bestMove(`${position} moves e2e4`, "club"), "e7e5");
  assert.deepEqual(
    requests.map((request) => request.method),
    ["GET", "POST"],
  );
  assert.deepEqual(JSON.parse(String(requests[1].body)), {
    position: `${position} moves e2e4`,
    difficulty: "club",
  });
  engine.dispose();
  assert.equal(requests[1].signal?.aborted, true);
});

test("reset aborts a pending native API request", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: string, options: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        options.signal?.addEventListener(
          "abort",
          () => reject(new Error("cancelled")),
          { once: true },
        );
      });
    },
  );
  const engine = new StockfishEngine();
  const initialization = engine.init();
  engine.dispose();
  await assert.rejects(initialization, /cancelled/);
});

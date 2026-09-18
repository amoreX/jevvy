import assert from "node:assert/strict";
import { test } from "node:test";
import { Chess, DEFAULT_POSITION } from "chess.js";
import { findBestMove, probeStockfish } from "../src/lib/native-stockfish";
import { GET, POST } from "../src/app/api/stockfish/route";

const position = `position fen ${DEFAULT_POSITION}`;
const signal = () => new AbortController().signal;

test("GET starts the real native Stockfish and reports its version", async () => {
  const response = await GET(new Request("http://localhost/api/stockfish"));
  assert.equal(response.status, 200);
  assert.match((await response.json()).name, /Stockfish \d+/);
});

test("real Stockfish automatically replies after each human move", async () => {
  const chess = new Chess();
  const moves: string[] = [];
  for (let turn = 0; turn < 3; turn++) {
    const human = chess.moves({ verbose: true })[0];
    chess.move(human.lan);
    moves.push(human.lan);
    const response = await POST(
      new Request("http://localhost/api/stockfish", {
        method: "POST",
        body: JSON.stringify({
          position: `${position} moves ${moves.join(" ")}`,
          difficulty: "casual",
        }),
      }),
    );
    assert.equal(response.status, 200);
    const { move } = await response.json();
    assert.equal(chess.move(move).color, "b");
    moves.push(move);
    assert.equal(chess.turn(), "w");
  }
});

test("choosing Black allows a native engine opening; independent games can run together", async () => {
  const results = await Promise.all([
    findBestMove({ position, difficulty: "casual" }, signal()),
    findBestMove(
      { position: `${position} moves e2e4`, difficulty: "club" },
      signal(),
    ),
  ]);
  const first = new Chess();
  const second = new Chess();
  second.move("e4");
  assert.equal(first.move(results[0].move!).color, "w");
  assert.equal(second.move(results[1].move!).color, "b");
});

test("aborting a real native search cancels it and the next game still works", async () => {
  const controller = new AbortController();
  const searching = findBestMove(
    { position, difficulty: "expert" },
    controller.signal,
  );
  controller.abort();
  await assert.rejects(searching, /cancelled/);
  assert.match((await probeStockfish(signal())).name, /Stockfish/);
});

test("a missing native binary returns an actionable API error", async (t) => {
  const original = process.env.STOCKFISH_PATH;
  t.after(() => {
    if (original === undefined) delete process.env.STOCKFISH_PATH;
    else process.env.STOCKFISH_PATH = original;
  });
  process.env.STOCKFISH_PATH = "/does-not-exist/stockfish";
  const response = await GET(new Request("http://localhost/api/stockfish"));
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /STOCKFISH_PATH/);
});

test("real Stockfish evaluations report the exact position and handle terminal boards", async () => {
  const { evaluatePosition } = await import("../src/lib/native-stockfish");
  const evaluation = await evaluatePosition(
    { position, difficulty: "club" },
    signal(),
  );
  assert.equal(evaluation.fen, DEFAULT_POSITION);
  assert.ok(evaluation.depth > 0);
  assert.equal(typeof evaluation.cp, "number");
  const mate = await evaluatePosition(
    {
      position: "position fen 7k/6Q1/6K1/8/8/8/8/8 b - - 0 1",
      difficulty: "club",
    },
    signal(),
  );
  assert.equal(mate.terminal, true);
  assert.equal(mate.winner, "w");
  const draw = await evaluatePosition(
    {
      position: "position fen 7k/5Q2/6K1/8/8/8/8/8 b - - 0 1",
      difficulty: "club",
    },
    signal(),
  );
  assert.equal(draw.terminal, true);
  assert.equal(draw.cp, 0);
  assert.equal(draw.winner, null);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { Chess } from "chess.js";
import { LookaheadCollector, describeContinuation } from "../src/lib/lookahead";

test("MultiPV requires all distinct legal choices at a common depth and removes rank/score ordering", () => {
  const collector = new LookaheadCollector(["e2e4", "d2d4"]);
  collector.accept("info depth 5 multipv 1 score cp 50 pv d2d4 d7d5");
  assert.equal(typeof collector.complete, "undefined");
  collector.accept(
    "info depth 5 multipv 2 score cp 20 upperbound pv e2e4 e7e5",
  );
  assert.equal(typeof collector.complete, "undefined");
  collector.accept("info depth 5 multipv 2 score cp 20 pv e2e4 e7e5");
  assert.deepEqual(collector.complete, {
    depth: 5,
    lines: { e2e4: ["e2e4", "e7e5"], d2d4: ["d2d4", "d7d5"] },
  });
  collector.accept("info depth 6 multipv 1 score cp 80 pv e2e4 e7e5");
  collector.accept("info depth 6 multipv 2 score cp 30 pv e2e4 c7c5");
  assert.equal(
    collector.complete?.depth,
    5,
    "an incomplete/new ranking must not replace the full iteration",
  );
  collector.accept("info depth 6 multipv 2 score cp 30 pv d2d4 d7d5");
  assert.equal(collector.complete?.depth, 6);
  assert.deepEqual(Object.keys(collector.complete!.lines), ["e2e4", "d2d4"]);
  assert.doesNotMatch(JSON.stringify(collector.complete), /score|multipv|rank/);
});

test("continuations describe captures and checks, validate legality and limit the displayed horizon", () => {
  const chess = new Chess();
  const result = describeContinuation(chess, "e2e4", [
    "e2e4",
    "d7d5",
    "e4d5",
    "d8d5",
    "b1c3",
    "d5e5",
    "f1e2",
  ]);
  assert.equal(result.continuation_san.length, 6);
  assert.match(result.consequences.join(" "), /White captures a pawn/);
  assert.match(result.consequences.join(" "), /Black captures a pawn/);
  assert.match(result.consequences.join(" "), /Black gives check/);
  assert.equal(chess.history().length, 0);
  assert.throws(
    () => describeContinuation(chess, "e2e4", ["d2d4"]),
    /wrong move/,
  );
  assert.throws(() => describeContinuation(chess, "e2e4", ["e2e4", "e2e5"]));
});

test("continuations preserve repetition history and stop at a rule-based draw", () => {
  const chess = new Chess();
  for (const move of ["Nf3", "Nf6", "Ng1", "Ng8", "Nf3", "Nf6"])
    chess.move(move);
  const result = describeContinuation(chess, "f3g1", ["f3g1", "f6g8", "e2e4"]);
  assert.deepEqual(result.continuation_san, ["Ng1", "Ng8"]);
  assert.match(result.outcome, /threefold/);
});

test("continuations handle en passant, castling, promotion, mate and stalemate", () => {
  const cases = [
    {
      fen: "4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 2",
      move: "e5d6",
      match: /en passant/,
    },
    {
      fen: "r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1",
      move: "e1g1",
      match: /castles kingside/,
    },
    {
      fen: "7k/P7/8/8/8/8/8/7K w - - 0 1",
      move: "a7a8n",
      match: /promotes to knight/,
    },
    {
      fen: "7k/8/5KQ1/8/8/8/8/8 w - - 0 1",
      move: "g6g7",
      match: /White checkmates/,
    },
    { fen: "7k/8/5KQ1/8/8/8/8/8 w - - 0 1", move: "g6f7", match: /stalemate/ },
  ];
  for (const c of cases)
    assert.match(
      JSON.stringify(describeContinuation(new Chess(c.fen), c.move, [c.move])),
      c.match,
    );
});

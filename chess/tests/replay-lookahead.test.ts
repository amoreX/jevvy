import assert from "node:assert/strict";
import { test } from "node:test";
import { Chess } from "chess.js";
import {
  createReplayPayload,
  ReplayCollector,
  compareReplayScores,
} from "../src/lib/replay-lookahead";

test("replay assessor uses complete same-depth scores and does not accept bounds or partial frames", () => {
  const c = new ReplayCollector(["e2e4", "d2d4"]);
  c.accept("info depth 8 multipv 1 score cp 45 pv d2d4 d7d5");
  c.accept("info depth 8 multipv 2 score cp 30 lowerbound pv e2e4 e7e5");
  assert.equal(typeof c.complete, "undefined");
  c.accept("info depth 8 multipv 2 score cp 30 pv e2e4 e7e5");
  assert.deepEqual(c.complete?.scores, {
    e2e4: { kind: "cp", value: 30 },
    d2d4: { kind: "cp", value: 45 },
  });
  c.accept("info depth 9 multipv 1 score mate 4 pv e2e4 c7c5");
  assert.equal(c.complete?.depth, 8);
  c.accept("info depth 9 multipv 2 score cp 60 pv d2d4 g8f6");
  assert.equal(c.complete?.depth, 9);
  assert.deepEqual(c.complete?.scores.e2e4, { kind: "mate", value: 4 });
  assert.ok(
    compareReplayScores(
      { kind: "mate", value: 4 },
      { kind: "cp", value: 9999 },
    ) > 0,
  );
  assert.ok(
    compareReplayScores(
      { kind: "mate", value: -8 },
      { kind: "mate", value: -3 },
    ) > 0,
  );
});

test("paired replay keeps history and instructions fixed, exposes boards and never assessor scores", () => {
  const chess = new Chess();
  for (const san of ["Nf3", "Nf6", "Ng1", "Ng8"]) chess.move(san);
  const position = `position fen ${chess.history({ verbose: true })[0].before} moves ${chess
    .history({ verbose: true })
    .map((m) => m.lan)
    .join(" ")}`;
  const lines = Object.fromEntries(
    chess.moves({ verbose: true }).map((move) => {
      const board = new Chess(chess.fen());
      board.move(move.lan);
      const continuation = [move.lan];
      while (continuation.length < 8 && !board.isGameOver())
        continuation.push(board.move(board.moves()[0]).lan);
      return [move.lan, continuation];
    }),
  );
  const short = createReplayPayload(position, lines, 2);
  const long = createReplayPayload(position, lines, 8);
  assert.deepEqual(short.state, long.state);
  assert.deepEqual(short.state.move_history_san, chess.history());
  assert.equal(
    short.questions.move.instructions,
    long.questions.move.instructions,
  );
  assert.deepEqual(
    Object.keys(short.questions.move.criteria),
    chess.moves({ verbose: true }).map((m) => m.lan),
  );
  for (const payload of [short, long]) {
    assert.doesNotMatch(
      JSON.stringify(payload),
      /"(?:score|scores|cp|rank|multipv|win_probability|material_summary|current_material)"/,
    );
    for (const text of Object.values(payload.questions.move.criteria)) {
      const details = JSON.parse(
        text.slice(text.indexOf('{"continuation_san"')),
      );
      const board = new Chess(chess.fen());
      for (const san of details.continuation_san) board.move(san);
      assert.equal(details.resulting_board, board.ascii());
      assert.equal(details.resulting_fen, board.fen());
      assert.ok(details.displayed_plies <= (payload === short ? 2 : 8));
    }
  }
  assert.throws(
    () => createReplayPayload(position, {}, 6),
    /Missing continuation/,
  );
});

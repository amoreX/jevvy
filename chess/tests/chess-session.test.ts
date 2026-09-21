import assert from "node:assert/strict";
import { test } from "node:test";
import { Chess, DEFAULT_POSITION } from "chess.js";
import { ChessSession } from "../src/lib/chess-session";
import type { RunLogger } from "../src/lib/run-types";
const memoryLogs: RunLogger = {
  create: async () => "test-run",
  state: async () => {},
};

import type { ChessEngine } from "../src/lib/stockfish";
import {
  JEV_MODEL,
  type DecisionPlayer,
  type JevDecision,
} from "../src/lib/jev";
import { parseEngineRequest } from "../src/lib/native-stockfish";

class ControlledEngine implements ChessEngine {
  initialized = 0;
  disposed = false;
  positions: string[] = [];
  requests: {
    resolve: (move: string) => void;
    reject: (error: Error) => void;
  }[] = [];
  async init() {
    this.initialized++;
  }
  bestMove(position: string): Promise<string> {
    this.positions.push(position);
    return new Promise((resolve, reject) =>
      this.requests.push({ resolve, reject }),
    );
  }
  reply(move: string) {
    this.requests.shift()!.resolve(move);
  }
  dispose() {
    this.disposed = true;
  }
}
class ControlledJev implements DecisionPlayer {
  disposed = false;
  positions: string[] = [];
  requests: {
    position: string;
    resolve: (move: JevDecision) => void;
    reject: (error: Error) => void;
  }[] = [];
  async init() {}
  choose(position: string): Promise<JevDecision> {
    this.positions.push(position);
    return new Promise((resolve, reject) =>
      this.requests.push({ position, resolve, reject }),
    );
  }
  reply(move: string, patch: Partial<JevDecision> = {}) {
    const request = this.requests.shift()!;
    const chess = parseEngineRequest({
      position: request.position,
      difficulty: "club",
    }).chess;
    request.resolve({
      move,
      fen: chess.fen(),
      model: JEV_MODEL,
      choices: chess.moves({ verbose: true }).map((move) => move.lan),
      latencyMs: 10,
      ...patch,
    });
  }
  dispose() {
    this.disposed = true;
  }
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test("lookahead mode persists through retry and ignores progress after pause/reset", async () => {
  const modes: (boolean | undefined)[] = [];
  const callbacks: ((
    stage: import("../src/lib/lookahead").DecisionStage,
  ) => void)[] = [];
  const players: ControlledJev[] = [];
  const session = new ChessSession(
    () => new ControlledEngine(),
    (_model, _run, onStage) => {
      callbacks.push(onStage!);
      const player = new ControlledJev();
      players.push(player);
      return player;
    },
    {
      create: async (_model, _fen, enabled) => {
        modes.push(enabled);
        if (modes.length === 1) throw new Error("Disk unavailable");
        return "assisted-run";
      },
      state: async () => {},
    },
  );
  await session.start({ lookahead: true });
  assert.equal(session.getSnapshot().phase, "error");
  await session.retry();
  assert.deepEqual(modes, [true, true]);
  assert.equal(session.getSnapshot().lookahead, true);
  assert.match(session.pgn(), /StockfishLookahead "On"/);
  callbacks[0]("choosing");
  assert.equal(session.getSnapshot().decisionStage, "choosing");
  session.pause();
  callbacks[0]("lookahead");
  assert.equal(session.getSnapshot().decisionStage, null);
  assert.equal(players[0].disposed, true);
  await session.resume();
  assert.equal(session.getSnapshot().lookahead, true);
  session.reset();
  callbacks[1]("choosing");
  assert.equal(session.getSnapshot().decisionStage, null);
  assert.equal(session.getSnapshot().phase, "idle");
  await assert.rejects(
    session.start({ model: "glm", lookahead: true }),
    /Jev only/,
  );
});
function setup() {
  const engines: ControlledEngine[] = [];
  const players: ControlledJev[] = [];
  const session = new ChessSession(
    () => {
      const e = new ControlledEngine();
      engines.push(e);
      return e;
    },
    () => {
      const j = new ControlledJev();
      players.push(j);
      return j;
    },
    memoryLogs,
  );
  return { session, engines, players };
}

test("Start runs one sequential Jev → Stockfish → Jev loop with updated full history", async () => {
  const { session, engines, players } = setup();
  assert.equal(session.move("e2", "e4"), false);
  assert.equal(players.length, 0);
  await session.start();
  assert.equal(engines[0].requests.length, 0);
  assert.equal(players[0].requests.length, 1);
  assert.equal(session.move("e2", "e4"), false);
  players[0].reply("e2e4");
  await flush();
  assert.equal(players[0].requests.length, 0);
  assert.equal(engines[0].requests.length, 1);
  assert.match(engines[0].positions[0], /moves e2e4$/);
  engines[0].reply("e7e5");
  await flush();
  assert.equal(players[0].requests.length, 1);
  assert.match(players[0].positions[1], /moves e2e4 e7e5$/);
  assert.deepEqual(
    session.getSnapshot().history.map((move) => move.san),
    ["e4", "e5"],
  );
  assert.equal(session.getSnapshot().decisions.length, 1);
  assert.equal(session.getSnapshot().decisions[0].confidence, undefined);
  assert.match(session.pgn(), /\[White "Jev 1.13"\]/);
  assert.match(session.pgn(), /\[Black "Stockfish 19"\]/);
  session.dispose();
});

test("pause cancels Jev, ignores its late reply, and Resume asks again from the same position", async () => {
  const { session, players } = setup();
  await session.start();
  session.pause();
  assert.equal(players[0].disposed, true);
  players[0].reply("e2e4");
  await flush();
  assert.equal(session.getSnapshot().phase, "paused");
  assert.equal(session.getSnapshot().fen, DEFAULT_POSITION);
  await session.resume();
  await session.resume();
  assert.equal(players.length, 2);
  assert.equal(players[1].positions[0], players[0].positions[0]);
  session.dispose();
});

test("pause during Black's reply preserves White's move and resumes Black only", async () => {
  const { session, players, engines } = setup();
  await session.start();
  players[0].reply("e2e4");
  await flush();
  session.pause();
  engines[0].reply("e7e5");
  await flush();
  assert.equal(session.getSnapshot().history.length, 1);
  await session.resume();
  assert.equal(players[1].positions.length, 0);
  assert.match(engines[1].positions[0], /moves e2e4$/);
  session.dispose();
});

test("reset and starting a new game invalidate an older decision", async () => {
  const { session, players } = setup();
  await session.start();
  session.reset();
  await session.start();
  players[0].reply("e2e4");
  await flush();
  assert.equal(session.getSnapshot().fen, DEFAULT_POSITION);
  assert.equal(session.getSnapshot().decisions.length, 0);
  assert.equal(players[1].requests.length, 1);
  session.dispose();
});

test("undo cancels the next decision, removes both plies, and stays paused", async () => {
  const { session, players, engines } = setup();
  await session.start();
  players[0].reply("e2e4");
  await flush();
  engines[0].reply("e7e5");
  await flush();
  assert.equal(session.undo(), true);
  players[0].reply("g1f3");
  await flush();
  assert.equal(session.getSnapshot().fen, DEFAULT_POSITION);
  assert.equal(session.getSnapshot().phase, "paused");
  assert.equal(session.getSnapshot().decisions.length, 0);
  assert.equal(session.undo(), false);
});

test("illegal and wrong-position decisions pause without changing the game", async () => {
  for (const patch of [{ move: "e2e5" }, { fen: "stale" }]) {
    const { session, players, engines } = setup();
    await session.start();
    players[0].reply("e2e4", patch);
    await flush();
    assert.equal(session.getSnapshot().phase, "error");
    assert.equal(session.getSnapshot().fen, DEFAULT_POSITION);
    assert.equal(engines[0].positions.length, 0);
    assert.equal(players[0].disposed, true);
  }
});

test("provider failure can be retried without switching players or losing position", async () => {
  const { session, players } = setup();
  await session.start();
  players[0].requests.shift()!.reject(new Error("Rate limit"));
  await flush();
  assert.equal(session.getSnapshot().error, "Rate limit");
  await session.retry();
  assert.equal(players[1].positions[0], players[0].positions[0]);
  session.dispose();
});

test("Black's illegal response does not advance to Jev", async () => {
  const { session, players, engines } = setup();
  await session.start();
  players[0].reply("e2e4");
  await flush();
  engines[0].reply("e7e4");
  await flush();
  assert.equal(session.getSnapshot().phase, "error");
  assert.equal(session.getSnapshot().history.length, 1);
  assert.equal(players[0].positions.length, 1);
});

test("Jev can castle, capture en passant, and choose an underpromotion", async () => {
  for (const example of [
    {
      fen: "r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1",
      move: "e1g1",
      check: (c: Chess) => {
        assert.equal(c.get("f1")?.type, "r");
        assert.equal(c.get("h1"), undefined);
      },
    },
    {
      fen: "4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1",
      move: "e5d6",
      check: (c: Chess) => {
        assert.equal(c.get("d5"), undefined);
        assert.equal(c.get("d6")?.type, "p");
      },
    },
    {
      fen: "7k/P7/8/8/8/8/8/7K w - - 0 1",
      move: "a7a8n",
      check: (c: Chess) => assert.equal(c.get("a8")?.type, "n"),
    },
  ]) {
    const { session, players } = setup();
    await session.start({ fen: example.fen });
    players[0].reply(example.move);
    await flush();
    example.check(new Chess(session.getSnapshot().fen));
    session.dispose();
  }
});

test("checkmate stops before a Black request and records Jev's win", async () => {
  const { session, players, engines } = setup();
  await session.start({ fen: "7k/5Q2/6K1/8/8/8/8/8 w - - 0 1" });
  players[0].reply("f7g7");
  await flush();
  assert.equal(session.getSnapshot().result, "Checkmate. Jev wins!");
  assert.equal(session.getSnapshot().phase, "finished");
  assert.equal(engines[0].positions.length, 0);
  assert.match(session.pgn(), /\[Result "1-0"\]/);
});

test("terminal starting positions need neither player", async () => {
  const { session, players, engines } = setup();
  await session.start({ fen: "7k/5Q2/6K1/8/8/8/8/8 b - - 0 1" });
  assert.equal(session.getSnapshot().result, "Draw by stalemate.");
  assert.equal(players.length + engines.length, 0);
});

test("full history stops threefold repetition before another paid choice", async () => {
  const { session, players, engines } = setup();
  await session.start();
  for (let i = 0; i < 2; i++) {
    players[0].reply("g1f3");
    await flush();
    engines[0].reply("g8f6");
    await flush();
    players[0].reply("f3g1");
    await flush();
    engines[0].reply("f6g8");
    await flush();
  }
  assert.equal(session.getSnapshot().result, "Draw by threefold repetition.");
  assert.equal(players[0].positions.length, 4);
  assert.match(
    engines[0].positions.at(-1)!,
    /moves g1f3 g8f6 f3g1 f6g8 g1f3 g8f6 f3g1$/,
  );
});

test("pausing initialization prevents engine startup and paid choices", async () => {
  let ready!: () => void;
  const jev = new ControlledJev();
  jev.init = () =>
    new Promise<void>((resolve) => {
      ready = resolve;
    });
  const engine = new ControlledEngine();
  const session = new ChessSession(
    () => engine,
    () => jev,
    memoryLogs,
  );
  const starting = session.start();
  await flush();
  session.pause();
  ready();
  await starting;
  assert.equal(engine.initialized, 0);
  assert.equal(jev.positions.length, 0);
  assert.equal(session.getSnapshot().phase, "paused");
});

test("missing configuration fails before Stockfish starts; invalid FEN preserves the current game", async () => {
  const engine = new ControlledEngine();
  const jev = new ControlledJev();
  jev.init = async () => {
    throw new Error("Add key");
  };
  const session = new ChessSession(
    () => engine,
    () => jev,
    memoryLogs,
  );
  await session.start();
  assert.equal(session.getSnapshot().error, "Add key");
  assert.equal(engine.initialized, 0);
  await assert.rejects(session.start({ fen: "invalid" }));
  assert.equal(session.getSnapshot().fen, DEFAULT_POSITION);
});

test("console moves are legal only while paused and resume uses the edited history", async () => {
  const { session, players, engines } = setup();
  await session.start();
  session.pause();
  assert.equal(session.move("e2", "e5"), false);
  assert.equal(session.move("e2", "e4"), true);
  players[0].reply("d2d4");
  await flush();
  await session.resume();
  assert.match(engines[1].positions[0], /moves e2e4$/);
  assert.match(session.pgn(), /edited position/);
  session.dispose();
});

test("Astra selection is bound to the run, player factory and PGN", async () => {
  const engine = new ControlledEngine();
  const player = new ControlledJev();
  const choices: string[] = [];
  const session = new ChessSession(
    () => engine,
    (model, runId) => {
      choices.push(model, runId);
      return player;
    },
    {
      create: async (model) => {
        assert.equal(model, "astra");
        return "astra-run";
      },
      state: async () => {},
    },
  );
  await session.start({ model: "astra" });
  assert.deepEqual(choices, ["astra", "astra-run"]);
  assert.equal(session.getSnapshot().model, "astra");
  assert.match(session.pgn(), /GPT-6 Astra/);
  session.dispose();
});

test("pause during evaluation prevents a paid choice and discards a late score", async () => {
  const engine = new ControlledEngine();
  const player = new ControlledJev();
  let resolve!: (value: import("../src/lib/evaluation").Evaluation) => void;
  const analyzer = Object.assign(engine, {
    evaluate: () =>
      new Promise<import("../src/lib/evaluation").Evaluation>((r) => {
        resolve = r;
      }),
  });
  const session = new ChessSession(
    () => analyzer,
    () => player,
    memoryLogs,
  );
  await session.start();
  assert.equal(session.getSnapshot().analyzing, true);
  session.pause();
  resolve({
    fen: DEFAULT_POSITION,
    cp: 45,
    mate: null,
    depth: 12,
    terminal: false,
    winner: null,
  });
  await flush();
  assert.equal(session.getSnapshot().evaluation, null);
  assert.equal(player.positions.length, 0);
});

test("failure to create a run blocks inference; retry creates a log before playing", async () => {
  const engine = new ControlledEngine();
  const player = new ControlledJev();
  let attempts = 0;
  const session = new ChessSession(
    () => engine,
    () => player,
    {
      create: async () => {
        if (!attempts++) throw new Error("Disk unavailable");
        return "retried-run";
      },
      state: async () => {},
    },
  );
  await session.start();
  assert.equal(session.getSnapshot().phase, "error");
  assert.equal(player.positions.length, 0);
  await session.retry();
  assert.equal(attempts, 2);
  assert.equal(session.getSnapshot().runId, "retried-run");
  assert.equal(player.positions.length, 1);
  session.dispose();
});

test("failure to persist an applied move pauses before the next player", async () => {
  const engine = new ControlledEngine();
  const player = new ControlledJev();
  const session = new ChessSession(
    () => engine,
    () => player,
    {
      create: async () => "run",
      state: async (_id, state) => {
        if (state.reason === "move") throw new Error("Disk full");
      },
    },
  );
  await session.start();
  player.reply("e2e4");
  await flush();
  assert.equal(session.getSnapshot().phase, "error");
  assert.equal(session.getSnapshot().history.length, 1);
  assert.equal(engine.positions.length, 0);
});

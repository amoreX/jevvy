import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Chess } from "chess.js";
import { MODELS, type PlayerId } from "../src/lib/models";
import { readRun, summarizeRun } from "../src/lib/run-store";
import type { RunState } from "../src/lib/run-types";
import type { createAstraRequest } from "../src/lib/server-astra";
import type { createGlmRequest } from "../src/lib/server-glm";
import type { createDecisionRequest } from "../src/lib/server-jev";

// Audits saved game histories and provider decisions before producing the comparison.
async function main() {
  if (!process.argv[2]) throw new Error("Pass a benchmark results.json path");
  const path = resolve(process.argv[2]);
  const batch = JSON.parse(await readFile(path, "utf8")) as {
    startedAt: string;
    finishedAt?: string;
    jobs: {
      model: PlayerId;
      game: number;
      runId?: string;
      status: string;
      plies: number;
      result: string | null;
    }[];
    configuration: Record<string, unknown>;
  };
  const labels = batch.configuration.white as Partial<
    Record<PlayerId, { label: string }>
  >;
  const label = (model: PlayerId) =>
    labels?.[model]?.label ?? MODELS[model].label;
  const rows: {
    model: PlayerId;
    game: number;
    runId: string;
    status: string;
    result: string;
    reason: string;
    plies: number;
    whiteMoves: number;
    requests: number;
    decisions: number;
    errors: number;
    knownCostUsd: number | null;
    unpricedRequests: number;
    pendingRequests: number;
    averageDecisionMs: number | null;
    reportedUsd: number;
    calculatedUsd: number;
  }[] = [];
  const pgns: string[] = [];
  const ids = new Set<string>();
  for (const job of batch.jobs) {
    if (!job.runId) continue;
    assert(!ids.has(job.runId), "Duplicate game run ID");
    ids.add(job.runId);
    const run = await readRun(job.runId);
    assert.equal(run.model, job.model);
    assert.equal(run.modelId, MODELS[job.model].id);
    assert.equal(run.provider, MODELS[job.model].provider);
    assert.deepEqual(run.opponent, {
      name: "Stockfish 19",
      skill: 6,
      depth: 9,
      timeMs: 650,
    });
    const summary = summarizeRun(run);
    const states = run.events.filter((event) => event.type === "state");
    const final = states.at(-1)?.data as RunState | undefined;
    if (!final) continue;
    const replay = new Chess(run.initialFen);
    const results = run.events.filter(
      (event) => event.type === "decision_result",
    );
    let whiteMoves = 0;
    for (const event of states) {
      const state = event.data as RunState;
      if (state.move) {
        if (replay.turn() === "w") {
          assert(
            results.some(
              (decision) =>
                decision.data.fen === replay.fen() &&
                decision.data.move === state.move?.uci,
            ),
            "White move missing its provider receipt",
          );
          whiteMoves++;
        }
        const played = replay.move({
          from: state.move.uci.slice(0, 2),
          to: state.move.uci.slice(2, 4),
          promotion: state.move.uci[4],
        });
        assert.equal(played.san, state.move.san);
        assert.equal(played.color, state.move.color);
      }
      assert.equal(
        replay.fen(),
        state.fen,
        "Move log has a discontinuous position",
      );
      assert.equal(replay.history().length, state.plies);
    }
    const board = new Chess();
    board.loadPgn(final.pgn);
    assert.equal(board.fen(), final.fen);
    assert.equal(board.history().length, final.plies);
    assert.equal(summary.result, job.result);
    if (job.status === "finished") {
      assert(board.isGameOver(), "Finished game is not terminal");
      const result = board.isCheckmate()
        ? board.turn() === "w"
          ? "0-1"
          : "1-0"
        : "1/2-1/2";
      assert.equal(
        job.result,
        result,
        "Reported result disagrees with chess rules",
      );
      assert.equal(board.getHeaders().Result, result);
    } else {
      assert.equal(job.result, null, "Unfinished game was counted as a result");
    }
    const requests = run.events.filter(
      (event) => event.type === "decision_request",
    );
    for (const event of results) {
      const request = requests.find(
        (request) => request.data.requestId === event.data.requestId,
      );
      assert(request, "Decision missing request");
      const position = new Chess(String(event.data.fen));
      assert.equal(position.turn(), "w");
      const legal = position
        .moves({ verbose: true })
        .map((move) => move.lan)
        .sort();
      assert.deepEqual(
        [...(event.data.choices as string[])].sort(),
        legal,
        "Provider was not offered every legal move",
      );
      assert(legal.includes(String(event.data.move)));
      if (job.model === "astra") {
        const payload = request.data.request as ReturnType<
          typeof createAstraRequest
        >;
        assert.equal(payload.model, MODELS.astra.id);
        assert.equal(payload.reasoning.effort, "medium");
        const input = JSON.parse(payload.input[1].content);
        assert.equal(input.state.fen, position.fen());
        assert.deepEqual(Object.keys(input.legal_moves).sort(), legal);
        assert.deepEqual(
          [...payload.text.format.schema.properties.move.enum].sort(),
          legal,
        );
      } else if (job.model === "glm") {
        const payload = request.data.request as ReturnType<
          typeof createGlmRequest
        >;
        assert.equal(payload.model, MODELS.glm.id);
        assert.equal(payload.reasoning.effort, run.reasoning);
        assert.equal(payload.max_tokens, 16384);
        const input = JSON.parse(payload.messages[1].content);
        assert.equal(input.state.fen, position.fen());
        assert.deepEqual(Object.keys(input.legal_moves).sort(), legal);
        assert.deepEqual(
          [
            ...payload.response_format.json_schema.schema.properties.move.enum,
          ].sort(),
          legal,
        );
      } else {
        const payload = request.data.request as ReturnType<
          typeof createDecisionRequest
        >;
        assert.equal(payload.model, MODELS.jev.id);
        assert.equal(payload.state.fen, position.fen());
        assert.deepEqual(
          Object.keys(payload.questions.move.criteria).sort(),
          legal,
        );
      }
    }
    pgns.push(final.pgn);
    rows.push({
      model: job.model,
      game: job.game,
      runId: run.id,
      status: job.status,
      result: summary.result ?? "*",
      reason: final.reason,
      plies: final.plies,
      whiteMoves,
      requests: summary.requests,
      decisions: summary.decisions,
      errors: run.events.filter((event) => event.type === "decision_error")
        .length,
      knownCostUsd: summary.cost,
      unpricedRequests: summary.billing.unpricedRequests,
      pendingRequests: summary.billing.pendingRequests,
      averageDecisionMs: summary.avgLatencyMs,
      reportedUsd: summary.billing.reportedUsd,
      calculatedUsd: summary.billing.calculatedUsd,
    });
  }
  const aggregates = [...new Set(batch.jobs.map((job) => job.model))].map(
    (model) => {
      const games = rows.filter((row) => row.model === model);
      const wins = games.filter((row) => row.result === "1-0").length;
      const draws = games.filter((row) => row.result === "1/2-1/2").length;
      const losses = games.filter((row) => row.result === "0-1").length;
      const completed = wins + draws + losses;
      const decisions = games.reduce((n, row) => n + row.decisions, 0);
      return {
        model,
        completed,
        wins,
        draws,
        losses,
        points: wins + draws / 2,
        scorePercent: completed ? ((wins + draws / 2) / completed) * 100 : null,
        unfinished:
          batch.jobs.filter((job) => job.model === model).length - completed,
        knownCostUsd: games.reduce((n, row) => n + (row.knownCostUsd ?? 0), 0),
        errors: games.reduce((n, row) => n + row.errors, 0),
        unpricedRequests: games.reduce((n, row) => n + row.unpricedRequests, 0),
        pendingRequests: games.reduce((n, row) => n + row.pendingRequests, 0),
        requests: games.reduce((n, row) => n + row.requests, 0),
        decisions,
        averageDecisionSeconds: decisions
          ? games.reduce(
              (n, row) => n + (row.averageDecisionMs ?? 0) * row.decisions,
              0,
            ) /
            decisions /
            1000
          : null,
        averagePlies: games.length
          ? games.reduce((n, row) => n + row.plies, 0) / games.length
          : null,
      };
    },
  );
  const lines = [
    `# ${aggregates.map((row) => label(row.model)).join(" / ")}: chess benchmark`,
    "",
    `Started: ${batch.startedAt}. ${batch.finishedAt ? `Finished: ${batch.finishedAt}.` : batch.configuration.stopReason ? `Stopped: ${batch.configuration.stopReason}` : "Still in progress."}`,
    "",
    "| Model | Completed | Wins | Draws | Losses | Points | Score | Known cost (USD) | Avg decision |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...aggregates.map(
      (row) =>
        `| ${label(row.model)} | ${row.completed}/${batch.jobs.filter((job) => job.model === row.model).length} | ${row.wins} | ${row.draws} | ${row.losses} | ${row.points} | ${row.scorePercent?.toFixed(1) ?? "—"}% | $${row.knownCostUsd.toFixed(6)} | ${row.averageDecisionSeconds?.toFixed(2) ?? "—"}s |`,
    ),
    "",
    "Models play White from the standard starting position against Stockfish 19 at the site's Club settings: skill 6, depth 9, maximum 650 ms, one thread, 16 MB hash. Astra uses the direct OpenAI API with medium reasoning; Jev 1.13 uses OpenRouter Decisions. GLM 5.3 uses OpenRouter Chat Completions with the reasoning setting saved in this batch, a 16,384-token output cap and a 300-second request deadline. The models do not share an identical reasoning budget. Each receives the current board, full move history and every legal move, with no engine evaluation or move rankings. Concurrency changes are saved in the manifest; provider latency is descriptive, not a controlled speed benchmark. Stockfish's weakened play is stochastic; games use the same settings, not identical opponent move sequences.",
    "",
    "Score = (wins + 0.5 × draws) / completed games. Games stop at rule-based checkmate or draw; there is no evaluation-based resignation. A 400-ply safety cap is reported as unfinished, never a draw. Each execution pass retries a failed move at most twice; all attempts, including resumed passes, remain in the logs. Display-only analysis is skipped during play. This measures performance against this particular opponent setting, not chess Elo or general model quality.",
    "",
    "Jev and GLM costs are reported by OpenRouter. Astra cost is calculated from returned token usage and the per-request saved pricing snapshot. Failed requests without a provider receipt can have unknown charges; known totals do not treat them as free.",
    "",
    ...(batch.jobs.some((job) => job.model === "astra")
      ? [
          "Earlier Astra runs increased concurrency and deadlines; game 32 used an 8,192-token cap after exhausting 4,096, and game 14 recovered from a log read failure. See the original Jev/Astra report for the complete recovery notes.",
        ]
      : []),
    "",
    ...aggregates.map(
      (row) =>
        `- ${label(row.model)}: ${row.requests} requests, ${row.decisions} successful decisions, ${row.errors} request errors, ${row.unpricedRequests} unpriced attempts, ${row.pendingRequests} pending attempts, ${row.unfinished} unfinished games.`,
    ),
    "",
    "Validation: replayed every saved move; matched every White move to a provider decision; verified all legal moves were offered; checked PGNs, positions, terminal results, player/provider identity and identical Stockfish settings. Full requests, responses, costs and states are in the site's run logs.",
    "",
    "Files: `results.json` (resumable manifest), `audited-results.json`, `games.csv`, `all-games.pgn`, and individual PGNs.",
    "",
  ];
  const root = dirname(path);
  const headers = Object.keys(rows[0] ?? {});
  const csvValue = (value: unknown) =>
    `"${String(value ?? "").replaceAll('"', '""')}"`;
  await writeFile(
    resolve(root, "games.csv"),
    [
      headers.join(","),
      ...rows.map((row) => Object.values(row).map(csvValue).join(",")),
    ].join("\n") + "\n",
  );
  await writeFile(resolve(root, "all-games.pgn"), pgns.join("\n\n") + "\n");
  await writeFile(resolve(root, "report.md"), lines.join("\n"));
  await writeFile(
    resolve(root, "audited-results.json"),
    JSON.stringify(
      {
        auditedAt: new Date().toISOString(),
        configuration: batch.configuration,
        aggregates,
        games: rows,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(JSON.stringify(aggregates, null, 2));
  console.log(
    `Audited ${rows.length} games. Report: ${resolve(root, "report.md")}`,
  );
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Report failed");
  process.exitCode = 1;
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_POSITION } from "chess.js";
import { readUsage, priceAstraUsage, formatUsd } from "../src/lib/costs";
import { withRunCosts, summarizeCosts } from "../src/lib/run-costs";
import { createRun, readRun, appendRunEvent } from "../src/lib/run-store";
import { loggedDecision } from "../src/lib/logged-decision";
import { GET } from "../src/app/api/runs/[id]/route";
import type { RunLog } from "../src/lib/run-types";

test("OpenAI prices disjoint cache reads, writes and ordinary input; reasoning is already in output", () => {
  const usage = readUsage(
    {
      input_tokens: 2000,
      input_tokens_details: { cached_tokens: 1000, cache_write_tokens: 500 },
      output_tokens: 200,
      output_tokens_details: { reasoning_tokens: 120 },
    },
    "openai",
    "gpt-6-astra",
    "default",
  )!;
  assert.deepEqual(usage.costBreakdown, {
    input: 0.005,
    cachedInput: 0.001,
    cacheWrite: 0.00625,
    output: 0.01,
  });
  assert.equal(usage.cost, 0.02225);
  assert.equal(usage.costSource, "calculated");
  assert.equal(usage.pricing?.verifiedAt, "2026-09-18");
  assert.equal(usage.reasoningTokens, 120);
  assert.equal(
    readUsage({ input_tokens: 828, output_tokens: 17 }, "openai", "gpt-6-astra")
      ?.cost,
    0.00913,
  );
});

test("OpenAI long-context rates apply to the entire request only above 272K", () => {
  const base = {
    serviceTier: "default",
    outputTokens: 100,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
  };
  assert.equal(
    priceAstraUsage({ ...base, inputTokens: 272000 }, "gpt-6-astra").cost,
    2.725,
  );
  const long = priceAstraUsage({ ...base, inputTokens: 272001 }, "gpt-6-astra");
  assert.equal(long.cost, 5.44752);
  assert.equal(long.pricing?.inputMultiplier, 2);
  assert.equal(long.pricing?.outputMultiplier, 1.5);
});

test("unknown prices, missing cache details and malformed usage never invent a free charge", () => {
  for (const usage of [
    { inputTokens: 2000, outputTokens: 20 },
    {
      inputTokens: 2000,
      outputTokens: 20,
      cachedInputTokens: 1500,
      cacheWriteTokens: 600,
    },
    { inputTokens: -1, outputTokens: 20 },
    { inputTokens: 20, outputTokens: Number.NaN },
  ])
    assert.equal(
      priceAstraUsage({ ...usage, serviceTier: "default" }, "gpt-6-astra").cost,
      undefined,
    );
  assert.equal(
    readUsage({ input_tokens: 20, output_tokens: 20 }, "openai", "unknown")
      ?.cost,
    undefined,
  );
  assert.equal(
    readUsage(
      { input_tokens: 20, output_tokens: 20 },
      "openai",
      "gpt-6-astra",
      "priority",
    )?.cost,
    undefined,
  );
  assert.equal(readUsage(undefined, "openai", "gpt-6-astra"), undefined);
});

test("OpenRouter keeps its actual charge, including zero or a charge without token counts", () => {
  assert.deepEqual(
    readUsage({ cost: 0.000051828 }, "openrouter", "typesafe/jev-1.13"),
    { cost: 0.000051828, costSource: "provider" },
  );
  assert.equal(
    readUsage({ cost: 0 }, "openrouter", "typesafe/jev-1.13")?.cost,
    0,
  );
  assert.equal(
    readUsage({ cost: -1 }, "openrouter", "typesafe/jev-1.13")?.cost,
    undefined,
  );
  assert.equal(formatUsd(0.000051828), "$0.000052");
  assert.equal(formatUsd(0.000000042), "<$0.000001");
});

function fixture(): RunLog {
  return {
    id: "test",
    version: 1,
    model: "astra",
    modelId: "gpt-6-astra",
    provider: "openai",
    reasoning: "medium",
    startedAt: "2026-09-18",
    initialFen: DEFAULT_POSITION,
    opponent: { name: "Stockfish 19", skill: 6, depth: 9, timeMs: 650 },
    evaluation: { depth: 16, timeMs: 600, perspective: "white" },
    events: [],
  };
}
test("totals include paid failures, preserve known spend with unknown requests and do not count an attempt twice", () => {
  const log = fixture();
  const add = (type: string, requestId: string, usage?: object) =>
    log.events.push({
      id: String(log.events.length),
      at: "now",
      type,
      data: { requestId, usage },
    });
  for (const id of ["one", "two", "three", "four"]) add("decision_request", id);
  add("decision_result", "one", { cost: 0.00913, costSource: "calculated" });
  add("decision_error", "one");
  add("decision_error", "two", { cost: 0.002, costSource: "calculated" });
  add("decision_error", "three");
  const total = summarizeCosts(log);
  assert.equal(total.totalUsd, 0.01113);
  assert.equal(total.pricedRequests, 2);
  assert.equal(total.unpricedRequests, 1);
  assert.equal(total.pendingRequests, 1);
  assert.equal(total.complete, false);
  assert.equal(total.estimated, true);
});

test("legacy costs can be backfilled without repricing recorded charges", () => {
  const log = fixture();
  log.events = [
    {
      id: "old",
      at: "now",
      type: "decision_result",
      data: { usage: { inputTokens: 828, outputTokens: 17 } },
    },
  ];
  const priced = withRunCosts(log);
  assert.equal(priced.billing?.totalUsd, 0.00913);
  assert.equal(withRunCosts(priced).billing?.totalUsd, 0.00913);
  log.provider = "openrouter";
  log.events[0].data.usage = { cost: 0.0123456789 };
  assert.equal(withRunCosts(log).billing?.reportedUsd, 0.0123456789);
});

test("billable incomplete OpenAI and invalid OpenRouter decisions persist receipts and run totals", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "chess-costs-"));
  process.env.CHESS_RUNS_DIR = dir;
  process.env.OPENAI_API_KEY = "openai-test-not-live";
  process.env.OPENROUTER_API_KEY = "router-test-not-live";
  t.after(async () => {
    delete process.env.CHESS_RUNS_DIR;
    await rm(dir, { recursive: true });
  });
  t.mock.method(globalThis, "fetch", async (url: string) =>
    url.includes("openai.com")
      ? Response.json({
          id: "resp-test",
          model: "gpt-6-astra",
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
          usage: {
            input_tokens: 100,
            input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
            output_tokens: 1000,
            output_tokens_details: { reasoning_tokens: 1000 },
          },
        })
      : Response.json({
          id: "decision-test",
          model: "typesafe/jev-1.13",
          answers: { move: { type: "choice", choice: "illegal" } },
          usage: { cost: 0.000051828 },
        }),
  );
  for (const model of ["astra", "jev"] as const) {
    const run = await createRun(model, DEFAULT_POSITION);
    await assert.rejects(
      loggedDecision(
        model,
        { runId: run.id, position: `position fen ${DEFAULT_POSITION}` },
        new AbortController().signal,
      ),
    );
    const saved = await readRun(run.id);
    const expected = model === "astra" ? 0.051 : 0.000051828;
    assert.equal(saved.billing?.totalUsd, expected);
    assert.equal(saved.billing?.complete, true);
    assert.equal(saved.events[1].type, "decision_error");
    assert.equal(
      JSON.parse(await readFile(join(dir, `${run.id}.json`), "utf8")).billing
        .totalUsd,
      expected,
    );
    const response = await GET(
      new Request(`http://localhost/api/runs/${run.id}?format=summary`),
      { params: Promise.resolve({ id: run.id }) },
    );
    assert.equal((await response.json()).billing.totalUsd, expected);
    await appendRunEvent(run.id, "state", { phase: "stopped" });
    assert.equal((await readRun(run.id)).billing?.totalUsd, expected);
    assert.ok(!JSON.stringify(saved).includes("test-not-live"));
  }
});

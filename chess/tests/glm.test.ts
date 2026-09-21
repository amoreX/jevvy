import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_POSITION } from "chess.js";
import { createGlmRequest, chooseGlmMove } from "../src/lib/server-glm";
import { createDecisionRequest } from "../src/lib/server-jev";
import { createRun, readRun, summarizeRun } from "../src/lib/run-store";
import { loggedDecision } from "../src/lib/logged-decision";
import { ProviderError } from "../src/lib/provider-error";
import { GET, POST } from "../src/app/api/glm/route";
import { modelLabel } from "../src/lib/models";
import { JevPlayer } from "../src/lib/jev";

const position = `position fen ${DEFAULT_POSITION}`;
const signal = () => new AbortController().signal;
process.env.OPENROUTER_API_KEY = "glm-test-key-never-live";

function response(
  content = '{"move":"e2e4"}',
  finish_reason = "stop",
  model = "z-ai/glm-5.3",
) {
  return Response.json({
    id: "glm-receipt",
    model,
    choices: [{ finish_reason, message: { content } }],
    usage: {
      prompt_tokens: 800,
      completion_tokens: 400,
      completion_tokens_details: { reasoning_tokens: 385 },
      cost: 0.001234,
    },
  });
}

test("GLM receives identical full state and legal choices with its documented reasoning setting", () => {
  const payload = createGlmRequest({ position });
  const context = createDecisionRequest({ position });
  assert.equal(payload.model, "z-ai/glm-5.3");
  assert.deepEqual(payload.reasoning, { effort: "low", exclude: true });
  assert.deepEqual(JSON.parse(payload.messages[1].content), {
    state: context.state,
    legal_moves: context.questions.move.criteria,
  });
  assert.deepEqual(
    payload.response_format.json_schema.schema.properties.move.enum,
    Object.keys(context.questions.move.criteria),
  );
  assert.equal(payload.provider.require_parameters, true);
});

test("GLM selects a legal move through OpenRouter and preserves actual billed usage", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    async (url: string, options: RequestInit) => {
      assert.equal(url, "https://openrouter.ai/api/v1/chat/completions");
      assert.equal(
        new Headers(options.headers).get("authorization"),
        "Bearer glm-test-key-never-live",
      );
      assert.equal(JSON.parse(String(options.body)).model, "z-ai/glm-5.3");
      return response();
    },
  );
  const decision = await chooseGlmMove({ position }, signal());
  assert.equal(decision.move, "e2e4");
  assert.equal(decision.usage?.cost, 0.001234);
  assert.equal(decision.usage?.reasoningTokens, 385);
  assert.equal(decision.usage?.costSource, "provider");
  assert.equal(decision.responseId, "glm-receipt");
});

test("invalid, truncated and wrong-model responses retain billable receipts but never play moves", async (t) => {
  const cases = [
    ['{"move":"e2e5"}', "stop", "z-ai/glm-5.3"],
    ['{"move":"e2e4"}', "length", "z-ai/glm-5.3"],
    ["invalid", "stop", "z-ai/glm-5.3"],
    ['{"move":"e2e4"}', "stop", "z-ai/glm-5.3-flash"],
  ];
  for (const [content, finish, model] of cases) {
    const mock = t.mock.method(globalThis, "fetch", async () =>
      response(content, finish, model),
    );
    await assert.rejects(
      chooseGlmMove({ position }, signal()),
      (error) =>
        error instanceof ProviderError &&
        error.receipt.usage?.cost === 0.001234,
    );
    mock.mock.restore();
  }
});

test("GLM logs exact inputs before charging and bills failed attempts without exposing credentials", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "chess-glm-test-"));
  process.env.CHESS_RUNS_DIR = dir;
  t.after(async () => {
    delete process.env.CHESS_RUNS_DIR;
    await rm(dir, { recursive: true });
  });
  const run = await createRun("glm", DEFAULT_POSITION);
  let valid = true;
  t.mock.method(globalThis, "fetch", async () => {
    assert.equal(
      (await readRun(run.id)).events.at(-1)?.type,
      "decision_request",
    );
    return response(valid ? '{"move":"e2e4"}' : '{"move":"a1a8"}');
  });
  await loggedDecision("glm", { position, runId: run.id }, signal());
  valid = false;
  await assert.rejects(
    loggedDecision("glm", { position, runId: run.id }, signal()),
    /legal move/,
  );
  const saved = await readRun(run.id);
  assert.equal(saved.provider, "openrouter");
  assert.equal(saved.reasoning, "low");
  assert.equal(summarizeRun(saved).cost, 0.002468);
  assert.equal(summarizeRun(saved).billing.pricedRequests, 2);
  assert.equal(JSON.stringify(saved).includes("glm-test-key"), false);
  await assert.rejects(
    loggedDecision("jev", { position, runId: run.id }, signal()),
    /different model/,
  );
});

test("GLM config is free and cross-origin requests are rejected before inference", async (t) => {
  const mock = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("Unexpected network call");
  });
  assert.deepEqual(await (await GET()).json(), {
    model: "z-ai/glm-5.3",
    provider: "openrouter",
    reasoning: "low",
    configured: true,
  });
  const denied = await POST(
    new Request("http://localhost/api/glm", {
      method: "POST",
      headers: { origin: "https://untrusted.example" },
      body: JSON.stringify({ position }),
    }),
  );
  assert.equal(denied.status, 403);
  assert.equal(mock.mock.callCount(), 0);
});

test("browser GLM transport stays on the local route and binds the run", async (t) => {
  const player = new JevPlayer("glm", "run-test");
  t.mock.method(
    globalThis,
    "fetch",
    async (url: string, options: RequestInit) => {
      assert.equal(url, "/api/glm");
      if (options.method === "GET") return Response.json({ configured: true });
      assert.deepEqual(JSON.parse(String(options.body)), {
        position,
        runId: "run-test",
      });
      return Response.json({
        move: "e2e4",
        fen: DEFAULT_POSITION,
        model: "z-ai/glm-5.3",
        choices: ["e2e4"],
        latencyMs: 1,
      });
    },
  );
  await player.init();
  assert.equal((await player.choose(position)).move, "e2e4");
  player.dispose();
});

test("historical GLM reasoning labels are preserved after changing the default", () => {
  assert.equal(modelLabel("glm", "max"), "GLM 5.3 · Max");
  assert.equal(modelLabel("glm", "low"), "GLM 5.3 · Low");
});

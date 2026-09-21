import assert from "node:assert/strict";
import { test } from "node:test";
import { decide, interview, readBody } from "../src/lib/server";
import { brief, jevResponse } from "./fixtures";

test("Sonnet receives typed structured output and conversation; Jev receives the reviewed brief", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      assert.equal(
        (init?.headers as Record<string, string>).Authorization,
        "Bearer test-only",
      );
      if (String(url).includes("chat/completions")) {
        assert.equal(body.model, "anthropic/claude-sonnet-5");
        assert.equal(body.response_format.json_schema.strict, true);
        assert.equal(
          JSON.parse(body.messages[1].content).answers[0].answer,
          "Three hours",
        );
        return Response.json({
          model: body.model,
          choices: [
            {
              finish_reason: "stop",
              message: { content: JSON.stringify({ question: null, brief }) },
            },
          ],
          usage: { cost: 0.02 },
        });
      }
      assert.equal(String(url), "https://openrouter.ai/api/alpha/decisions");
      assert.deepEqual(body.state, brief);
      return Response.json(jevResponse());
    },
  );
  const previous = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "test-only";
  try {
    const result = await interview(
      {
        goal: "Learn",
        answers: [{ question: "Time?", answer: "Three hours" }],
        prepare: true,
      },
      new AbortController().signal,
    );
    assert.deepEqual(result.brief, brief);
    assert.equal(result.receipt.cost, 0.02);
    const choice = await decide(brief, new AbortController().signal);
    assert.equal(choice.choice, "web");
    assert.equal(choice.receipt.cost, 0.00009);
  } finally {
    if (previous === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previous;
  }
});
test("provider failures never disclose response bodies, and missing config makes no call", async (t) => {
  const previous = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "test-only";
  const fetch = t.mock.method(
    globalThis,
    "fetch",
    async () => new Response("PRIVATE_PROVIDER_DETAILS", { status: 401 }),
  );
  try {
    await assert.rejects(
      decide(brief, new AbortController().signal),
      (e) =>
        e instanceof Error &&
        e.message.includes("rejected") &&
        !e.message.includes("PRIVATE"),
    );
    delete process.env.OPENROUTER_API_KEY;
    await assert.rejects(
      decide(brief, new AbortController().signal),
      /Add OPENROUTER_API_KEY/,
    );
    assert.equal(fetch.mock.callCount(), 1);
  } finally {
    if (previous === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previous;
  }
});
test("aborted work never calls the provider and malformed Sonnet output cannot become a brief", async (t) => {
  const previous = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "test-only";
  const fetch = t.mock.method(globalThis, "fetch", async () =>
    Response.json({
      choices: [
        {
          finish_reason: "length",
          message: { content: "PRIVATE_INVALID_OUTPUT" },
        },
      ],
    }),
  );
  try {
    const abort = new AbortController();
    abort.abort();
    await assert.rejects(decide(brief, abort.signal), /cancelled/);
    assert.equal(fetch.mock.callCount(), 0);
    await assert.rejects(
      interview(
        { goal: "Learn", answers: [], prepare: false },
        new AbortController().signal,
      ),
      /incomplete interview/,
    );
  } finally {
    if (previous === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previous;
  }
});
test("HTTP boundary blocks cross-origin, non-local, malformed and oversized requests", async () => {
  const request = (
    body: string,
    origin = "http://localhost:3001",
    host = "http://localhost:3001",
  ) =>
    new Request(`${host}/api/decide`, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body,
    });
  assert.deepEqual(await readBody(request('{"ok":true}')), { ok: true });
  assert.deepEqual(
    await readBody(
      new Request("http://localhost:3010/api/interview", {
        method: "POST",
        headers: {
          host: "127.0.0.1:3010",
          origin: "http://127.0.0.1:3010",
          "content-type": "application/json",
        },
        body: "{}",
      }),
    ),
    {},
  );
  await assert.rejects(
    readBody(request("{}", "https://other.example")),
    /localhost/,
  );
  await assert.rejects(
    readBody(request("{}", "https://example.com", "https://example.com")),
    /localhost/,
  );
  await assert.rejects(readBody(request("not-json")), /Invalid JSON/);
  await assert.rejects(
    readBody(request(JSON.stringify({ text: "a".repeat(66000) }))),
    /too long/,
  );
});

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildDecisionRequest,
  parseBrief,
  parseDecision,
  parseInterview,
  parseInterviewInput,
} from "../src/lib/decision";
import { brief, jevResponse } from "./fixtures";

test("builds an independent choice and complete score matrix, excluding ineligible options", () => {
  const request = buildDecisionRequest(parseBrief(brief));
  assert.equal(Object.keys(request.questions).length, 5);
  const pick = request.questions.pick as { criteria: Record<string, unknown> };
  assert.deepEqual(Object.keys(pick.criteria), ["web", "drawing"]);
  assert.equal(request.state.options[2].eligible, false);
  assert.deepEqual(
    (request.questions.score__web__time as { criteria: string[] }).criteria,
    brief.criteria[0].levels,
  );
  assert.deepEqual(
    (request.questions.score__drawing__time as { criteria: string[] }).criteria,
    brief.criteria[0].levels,
  );
});
test("requires two eligible options and unique, safe identifiers", () => {
  const invalid = structuredClone(brief);
  invalid.options[1].eligible = false;
  assert.throws(() => buildDecisionRequest(invalid), /at least two/);
  invalid.options[1].id = "web";
  assert.throws(() => parseBrief(invalid), /unique/);
  invalid.options[1].id = "constructor";
  assert.throws(() => parseBrief(invalid), /Invalid ID/);
  invalid.options[1].id = "web__time";
  assert.throws(() => parseBrief(invalid), /Invalid ID/);
});
test("enforces five concrete scale levels, bounded input and interview length", () => {
  const invalid = structuredClone(brief);
  invalid.criteria[0].levels.pop();
  assert.throws(() => parseBrief(invalid), /Score levels/);
  assert.throws(
    () =>
      parseInterviewInput({
        goal: "x".repeat(2001),
        answers: [],
        prepare: false,
      }),
    /2000/,
  );
  assert.throws(
    () =>
      parseInterviewInput({
        goal: "Learn",
        answers: Array(6).fill({ question: "Why?", answer: "Because" }),
        prepare: false,
      }),
    /Answers/,
  );
});
test("ends questions when preparing or after five answers and rejects ambiguous responses", () => {
  const question = {
    text: "What matters most?",
    context: "This helps compare options.",
    suggestions: ["Time", "Interest"],
  };
  const input = { goal: "Learn a skill", answers: [], prepare: true };
  assert.throws(
    () => parseInterview({ question, brief: null }, input),
    /did not prepare/,
  );
  assert.throws(
    () => parseInterview({ question, brief }, { ...input, prepare: false }),
    /question or a brief/,
  );
  assert.equal(
    parseInterview({ question: null, brief }, input).brief?.options.length,
    3,
  );
});
test("retains real scores and handles optional confidence and probabilities without inventing values", () => {
  const result = parseDecision(jevResponse(), brief);
  assert.equal(result.choice, "web");
  assert.equal(result.scores.web.time.score, 3.4);
  assert.equal(result.scores.web.interest.confidence, undefined);
  const response = jevResponse();
  Reflect.deleteProperty(response.answers.pick, "confidence");
  Reflect.deleteProperty(response.answers.pick, "probabilities");
  const optional = parseDecision(response, brief);
  assert.equal(optional.confidence, undefined);
  assert.equal(optional.probabilities, undefined);
});
test("rejects an excluded choice, missing ratings, invalid distributions and out-of-range scores", () => {
  const excluded = jevResponse();
  excluded.answers.pick.choice = "course";
  assert.throws(() => parseDecision(excluded, brief), /eligible/);
  const missing = jevResponse();
  Reflect.deleteProperty(missing.answers, "score__web__time");
  assert.throws(() => parseDecision(missing, brief));
  const range = jevResponse();
  range.answers.score__web__time.score = 9;
  assert.throws(() => parseDecision(range, brief), /invalid scorecard/);
  const distribution = jevResponse();
  distribution.answers.pick.probabilities.web = 0.1;
  assert.throws(() => parseDecision(distribution, brief), /sum to one/);
});

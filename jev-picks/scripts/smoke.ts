// Explicitly opt-in: at most two Sonnet requests and one Jev request, using synthetic data.
import { mkdir, writeFile } from "node:fs/promises";
import type {
  Brief,
  Decision,
  Interview,
  InterviewInput,
  Receipt,
} from "../src/lib/decision";

async function main() {
  if (!process.argv.includes("--live"))
    throw new Error(
      "This makes paid provider requests. Run with --live to opt in.",
    );
  const origin = "http://127.0.0.1:3010";
  async function post<T>(path: string, body: unknown): Promise<T> {
    const response = await fetch(`${origin}/api/${path}`, {
      method: "POST",
      headers: { origin, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(110000),
    });
    const result = await response.json();
    if (!response.ok)
      throw new Error(`${path}: ${result.error || response.status}`);
    return result;
  }
  const input: InterviewInput = {
    goal: "Help me decide how to spend three free hours this Sunday. I want a restful solo activity at home, already own sketching materials and a novel, do not want to spend money, and prefer being away from screens.",
    answers: [],
    prepare: false,
  };
  const receipts: Receipt[] = [];
  let response = await post<Interview & { receipt: Receipt }>(
    "interview",
    input,
  );
  receipts.push(response.receipt);
  console.log(
    JSON.stringify({
      stage: "interview",
      model: response.receipt.model,
      outcome: response.question ? "question" : "brief",
      reportedCost: response.receipt.cost,
    }),
  );
  if (response.question) {
    input.answers.push({
      question: response.question.text,
      answer:
        "I feel mentally tired and want a calm, low-effort activity. Reading my novel sounds appealing; sketching or gentle stretching are alternatives. I want no screens, spending, travel, or other people involved.",
    });
    input.prepare = true;
    response = await post<Interview & { receipt: Receipt }>("interview", input);
    receipts.push(response.receipt);
  }
  if (!response.brief)
    throw new Error("No brief returned within the bounded smoke.");
  const brief: Brief = response.brief;
  const result = await post<Decision>("decide", brief);
  receipts.push(result.receipt);
  await mkdir("data", { recursive: true });
  await writeFile(
    "data/live-smoke.json",
    JSON.stringify(
      { synthetic: true, input, brief, result, receipts },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      stage: "complete",
      chosenOption: brief.options.find((o) => o.id === result.choice)?.title,
      options: brief.options.filter((o) => o.eligible).length,
      criteria: brief.criteria.length,
      scoreCount: Object.values(result.scores).reduce(
        (sum, scores) => sum + Object.keys(scores).length,
        0,
      ),
      confidenceReturned: result.confidence !== undefined,
      probabilitiesReturned: result.probabilities !== undefined,
      models: receipts.map((r) => r.model),
      reportedCost: receipts.every((r) => r.cost !== null)
        ? receipts.reduce((sum, r) => sum + (r.cost ?? 0), 0)
        : null,
    }),
  );
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Smoke failed");
  process.exitCode = 1;
});

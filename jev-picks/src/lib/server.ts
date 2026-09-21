import {
  buildDecisionRequest,
  InputError,
  JEV_MODEL,
  parseDecision,
  parseInterview,
  record,
  SONNET_MODEL,
  type Brief,
  type InterviewInput,
  type Receipt,
} from "./decision";
import { INTERVIEW_PROMPT, interviewSchema } from "./interview-schema";

let activeRequests = 0;
export function configured() {
  return Boolean(process.env.OPENROUTER_API_KEY?.trim());
}

async function upstream(
  endpoint: "chat/completions" | "decisions",
  payload: unknown,
  signal: AbortSignal,
) {
  const key = process.env.OPENROUTER_API_KEY?.trim();
  if (!key)
    throw new InputError(
      "Add OPENROUTER_API_KEY to jev-picks/.env.local, then restart the app.",
      503,
    );
  if (signal.aborted) throw new InputError("Request cancelled.", 499);
  if (activeRequests >= 2)
    throw new InputError(
      "Two requests are already running. Please try again in a moment.",
      429,
    );
  activeRequests++;
  const started = Date.now();
  const timeout = AbortSignal.timeout(endpoint === "decisions" ? 45000 : 90000);
  try {
    const response = await fetch(
      endpoint === "decisions"
        ? "https://openrouter.ai/api/alpha/decisions"
        : "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",
        cache: "no-store",
        signal: AbortSignal.any([signal, timeout]),
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          "X-Title": "Jev Picks",
        },
        body: JSON.stringify(payload),
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      const messages: Record<number, string> = {
        401: "OpenRouter rejected the API key. Check jev-picks/.env.local and restart.",
        402: "Your OpenRouter account needs credits to continue.",
        403: "Your OpenRouter account cannot access this model.",
        429: "The model is busy. Wait a moment, then retry.",
      };
      throw new InputError(
        messages[response.status] ??
          `The model provider could not complete this request (HTTP ${response.status}). Please retry.`,
        response.status === 429 ? 429 : 502,
      );
    }
    const data = record(await response.json());
    const usage =
      data.usage && typeof data.usage === "object" ? record(data.usage) : {};
    const receipt: Receipt = {
      model:
        typeof data.model === "string"
          ? data.model
          : endpoint === "decisions"
            ? JEV_MODEL
            : SONNET_MODEL,
      latencyMs: Date.now() - started,
      cost:
        typeof usage.cost === "number" &&
        Number.isFinite(usage.cost) &&
        usage.cost >= 0
          ? usage.cost
          : null,
    };
    return { data, receipt };
  } catch (error) {
    if (signal.aborted) throw new InputError("Request cancelled.", 499);
    if (timeout.aborted)
      throw new InputError(
        "The model took too long. Your answers are still here; you can retry.",
        504,
      );
    if (error instanceof InputError) throw error;
    throw new InputError(
      "Could not reach the model provider. Please retry.",
      502,
    );
  } finally {
    activeRequests--;
  }
}

export async function interview(input: InterviewInput, signal: AbortSignal) {
  const { data, receipt } = await upstream(
    "chat/completions",
    {
      model: SONNET_MODEL,
      max_tokens: 6000,
      provider: { require_parameters: true },
      messages: [
        { role: "system", content: INTERVIEW_PROMPT },
        { role: "user", content: JSON.stringify(input) },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "decision_interview",
          strict: true,
          schema: interviewSchema,
        },
      },
    },
    signal,
  );
  try {
    const choices = data.choices;
    if (!Array.isArray(choices) || !choices.length)
      throw new Error("No choice");
    const choice = record(choices[0]);
    const message = record(choice.message);
    if (choice.finish_reason !== "stop" || typeof message.content !== "string")
      throw new Error("Incomplete answer");
    return { ...parseInterview(JSON.parse(message.content), input), receipt };
  } catch {
    throw new InputError(
      "Sonnet returned an incomplete interview response. Please retry; your answers are preserved.",
      502,
    );
  }
}

export async function decide(brief: Brief, signal: AbortSignal) {
  const payload = buildDecisionRequest(brief);
  const { data, receipt } = await upstream("decisions", payload, signal);
  try {
    return { ...parseDecision(data, brief), receipt };
  } catch {
    throw new InputError(
      "Jev returned an incomplete or invalid scorecard. Your brief is preserved; please retry.",
      502,
    );
  }
}

export async function readBody(request: Request): Promise<unknown> {
  const url = new URL(request.url);
  // Next may normalize request.url to localhost even when the browser used 127.0.0.1.
  // Validate the actual Host header and browser Origin, never forwarded host headers.
  const host = request.headers.get("host") ?? url.host;
  let hostUrl: URL;
  try {
    hostUrl = new URL(`${url.protocol}//${host}`);
  } catch {
    throw new InputError("Invalid request host.", 403);
  }
  if (!["localhost", "127.0.0.1", "[::1]"].includes(hostUrl.hostname))
    throw new InputError(
      "This experiment is available on localhost only.",
      403,
    );
  if (request.headers.get("origin") !== hostUrl.origin)
    throw new InputError("Open this app on localhost to make a request.", 403);
  if (!request.headers.get("content-type")?.includes("application/json"))
    throw new InputError("Expected JSON.", 415);
  const reader = request.body?.getReader();
  if (!reader) throw new InputError("A request body is required.");
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 65536) {
        await reader.cancel();
        throw new InputError(
          "This decision is too long. Shorten the answers or options.",
          413,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new InputError("Invalid JSON request.");
  }
}
export function failure(error: unknown) {
  return Response.json(
    {
      error:
        error instanceof InputError
          ? error.message
          : "Something went wrong. Please retry.",
    },
    {
      status: error instanceof InputError ? error.status : 500,
      headers: { "Cache-Control": "no-store" },
    },
  );
}

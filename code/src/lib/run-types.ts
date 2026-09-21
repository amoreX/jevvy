import type { PlayerId, ProviderId } from "./models";
import type { Evaluation } from "./evaluation";
import type { RunCost } from "./costs";
import type { LookaheadSettings } from "./lookahead";
export type RunState = {
  phase: string;
  fen: string;
  pgn: string;
  plies: number;
  result: string | null;
  reason: string;
  error: string | null;
  evaluation: Evaluation | null;
  move?: { uci: string; san: string; color: string };
};
export type RunEvent = {
  id: string;
  at: string;
  type: string;
  data: Record<string, unknown>;
};
export type RunLog = {
  lookahead?: LookaheadSettings | null;
  id: string;
  version: 1;
  model: PlayerId;
  modelId: string;
  provider?: ProviderId;
  reasoning: string | null;
  startedAt: string;
  initialFen: string;
  opponent: { name: string; skill: number; depth: number; timeMs: number };
  evaluation: { depth: number; timeMs: number; perspective: "white" };
  events: RunEvent[];
  billing?: RunCost;
};
export type RunSummary = {
  lookahead?: LookaheadSettings | null;
  reasoning?: string | null;
  id: string;
  model: PlayerId;
  provider: ProviderId;
  startedAt: string;
  phase: string;
  plies: number;
  result: string | null;
  requests: number;
  decisions: number;
  cost: number | null;
  billing: RunCost;
  avgLatencyMs: number | null;
  evaluation: Evaluation | null;
};
/** Runs created before the direct OpenAI integration used OpenRouter. */
export function runProvider(log: Pick<RunLog, "provider">): ProviderId {
  return log.provider ?? "openrouter";
}
export interface RunLogger {
  create(
    model: PlayerId,
    initialFen: string,
    lookahead?: boolean,
  ): Promise<string>;
  state(id: string, state: RunState): Promise<void>;
}

/** Serial persistence is independent of turn cancellation, including final pause/reset events. */
export class HttpRunLogger implements RunLogger {
  private queue: Promise<unknown> = Promise.resolve();
  async create(model: PlayerId, initialFen: string, lookahead = false) {
    const response = await fetch("/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, initialFen, lookahead }),
      signal: AbortSignal.timeout(15000),
    });
    const data = await response.json();
    if (!response.ok)
      throw new Error(data.error || "Could not create the run log.");
    return data.id as string;
  }
  state(id: string, state: RunState): Promise<void> {
    const eventId = crypto.randomUUID();
    const body = JSON.stringify({ eventId, state });
    const save = async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        let response: Response | undefined;
        try {
          response = await fetch(`/api/runs/${id}`, {
            method: "POST",
            keepalive: true,
            headers: { "Content-Type": "application/json" },
            body,
            signal: AbortSignal.timeout(15000),
          });
        } catch {
          // Lost replies may have committed. Reuse eventId for server deduplication.
        }
        if (response?.ok) return;
        const retryable =
          !response ||
          response.status >= 500 ||
          [408, 429].includes(response.status);
        await response?.body?.cancel().catch(() => undefined);
        if (!retryable || attempt === 2)
          throw new Error(
            "Could not save the run log. Check the server and retry.",
          );
        await new Promise((resolve) =>
          setTimeout(resolve, [250, 750][attempt]),
        );
      }
    };
    const next = this.queue.catch(() => undefined).then(save);
    this.queue = next;
    return next;
  }
}

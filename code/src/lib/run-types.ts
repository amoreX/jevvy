import type { PlayerId, ProviderId } from "./models";
import type { Evaluation } from "./evaluation";
import type { RunCost } from "./costs";
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
  create(model: PlayerId, initialFen: string): Promise<string>;
  state(id: string, state: RunState): Promise<void>;
}

/** Serial persistence is independent of turn cancellation, including final pause/reset events. */
export class HttpRunLogger implements RunLogger {
  private queue: Promise<unknown> = Promise.resolve();
  async create(model: PlayerId, initialFen: string) {
    const response = await fetch("/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, initialFen }),
      signal: AbortSignal.timeout(15000),
    });
    const data = await response.json();
    if (!response.ok)
      throw new Error(data.error || "Could not create the run log.");
    return data.id as string;
  }
  state(id: string, state: RunState): Promise<void> {
    const eventId = crypto.randomUUID();
    const save = async () => {
      const response = await fetch(`/api/runs/${id}`, {
        method: "POST",
        keepalive: true,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ eventId, state }),
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok)
        throw new Error(
          "Could not save the run log. Check the server and retry.",
        );
    };
    const next = this.queue.catch(() => undefined).then(save);
    this.queue = next;
    return next;
  }
}

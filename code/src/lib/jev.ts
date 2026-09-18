import { MODELS, type PlayerId } from "./models";
import type { ModelUsage } from "./costs";
export const JEV_MODEL = "typesafe/jev-1.13";

export type JevDecision = {
  move: string;
  fen: string;
  model: string;
  choices: string[];
  latencyMs: number;
  confidence?: number;
  reasoning?: "medium" | "max" | "low";
  responseId?: string;
  usage?: ModelUsage;
};

export interface DecisionPlayer {
  init(): Promise<void>;
  choose(position: string): Promise<JevDecision>;
  dispose(): void;
}

/** Browser transport only. Credentials and provider requests stay on the server. */
export class JevPlayer implements DecisionPlayer {
  private controller = new AbortController();
  constructor(
    private model: PlayerId = "jev",
    private runId?: string,
  ) {}

  private async request(position?: string) {
    const response = await fetch(`/api/${this.model}`, {
      method: position ? "POST" : "GET",
      cache: "no-store",
      headers: position ? { "Content-Type": "application/json" } : undefined,
      body: position
        ? JSON.stringify({
            position,
            ...(this.runId ? { runId: this.runId } : {}),
          })
        : undefined,
      signal: AbortSignal.any([
        this.controller.signal,
        AbortSignal.timeout(
          this.model === "glm"
            ? 305000
            : this.model === "astra"
              ? 95000
              : 35000,
        ),
      ]),
    });
    const data = await response.json();
    if (!response.ok)
      throw new Error(
        data.error ||
          `${MODELS[this.model].name} is unavailable. Retry to continue.`,
      );
    return data;
  }

  async init() {
    const data = await this.request();
    if (!data.configured) {
      throw new Error(
        `Add ${MODELS[this.model].keyName} to code/.env.local and restart the server, then retry.`,
      );
    }
  }

  async choose(position: string): Promise<JevDecision> {
    const data = await this.request(position);
    if (
      typeof data.move !== "string" ||
      typeof data.fen !== "string" ||
      typeof data.model !== "string" ||
      !Array.isArray(data.choices) ||
      !data.choices.every((choice: unknown) => typeof choice === "string")
    ) {
      throw new Error(
        `${MODELS[this.model].name} returned an invalid decision. Retry to continue.`,
      );
    }
    return data;
  }

  dispose() {
    this.controller.abort();
  }
}

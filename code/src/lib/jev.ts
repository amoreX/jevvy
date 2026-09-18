import { MODELS, type PlayerId } from "./models";
import type { ModelUsage } from "./costs";
import type { DecisionStage } from "./lookahead";
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
    private onStage?: (stage: DecisionStage) => void,
  ) {}

  private async request(position?: string) {
    const response = await fetch(`/api/${this.model}`, {
      method: position ? "POST" : "GET",
      cache: "no-store",
      headers: position
        ? {
            "Content-Type": "application/json",
            ...(this.model === "jev" ? { Accept: "application/x-ndjson" } : {}),
          }
        : undefined,
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
              : 45000,
        ),
      ]),
    });
    const data = response.headers
      .get("content-type")
      ?.includes("application/x-ndjson")
      ? await this.readStream(response)
      : await response.json();
    if (!response.ok)
      throw new Error(
        data.error ||
          `${MODELS[this.model].name} is unavailable. Retry to continue.`,
      );
    return data;
  }

  private async readStream(response: Response) {
    if (!response.body) throw new Error("Jev returned an empty response.");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let decision: JevDecision | undefined;
    try {
      while (true) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (!line.trim()) continue;
          const event = JSON.parse(line);
          if (event.error) throw new Error(event.error);
          if (event.stage === "lookahead" || event.stage === "choosing")
            this.onStage?.(event.stage);
          if (event.decision) decision = event.decision;
        }
        if (done) break;
      }
      if (!decision || buffer.trim())
        throw new Error("Jev's response was incomplete. Retry to continue.");
      return decision;
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
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

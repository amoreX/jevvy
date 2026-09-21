import { EngineError } from "./native-stockfish";
import type { ModelUsage } from "./costs";

export type ProviderReceipt = {
  usage?: ModelUsage;
  model?: string;
  responseId?: string;
};
/** A failed chess decision can still have billable token usage. */
export class ProviderError extends EngineError {
  constructor(
    message: string,
    status: number,
    readonly receipt: ProviderReceipt,
  ) {
    super(message, status);
  }
}

import {
  finiteCost,
  priceAstraUsage,
  roundUsd,
  type ModelUsage,
  type RunCost,
} from "./costs";
import { runProvider, type RunLog } from "./run-types";

/** Preserve stored prices; enrich legacy usage only when enough evidence remains. */
export function withRunCosts(log: RunLog): RunLog {
  const events = log.events.map((event) => {
    if (event.type !== "decision_result" && event.type !== "decision_error")
      return event;
    const previous = event.data.usage as ModelUsage | undefined;
    if (!previous) return event;
    let usage = previous;
    if (
      finiteCost(usage.cost) &&
      !usage.costSource &&
      runProvider(log) === "openrouter"
    )
      usage = { ...usage, costSource: "provider" };
    if (!finiteCost(usage.cost) && runProvider(log) === "openai") {
      usage = priceAstraUsage(
        { ...usage, serviceTier: usage.serviceTier ?? "default" },
        String(event.data.model ?? log.modelId),
      );
      if (finiteCost(usage.cost) && !previous.serviceTier)
        usage = {
          ...usage,
          costNote:
            "Reconstructed from saved tokens at Standard rates; original cache/tier details were not retained.",
        };
    }
    return { ...event, data: { ...event.data, usage } };
  });
  return { ...log, events, billing: summarizeCosts({ ...log, events }) };
}

export function summarizeCosts(log: RunLog): RunCost {
  const requests = new Set<string>();
  const outcomes = new Map<string, ModelUsage | undefined>();
  for (const event of log.events) {
    const id =
      typeof event.data.requestId === "string"
        ? event.data.requestId
        : event.id;
    if (event.type === "decision_request") requests.add(id);
    if (event.type === "decision_result" || event.type === "decision_error") {
      const usage = event.data.usage as ModelUsage | undefined;
      // A response and a later log error for the same attempt must not double-charge it.
      if (!finiteCost(outcomes.get(id)?.cost)) outcomes.set(id, usage);
    }
  }
  let reportedUsd = 0,
    calculatedUsd = 0,
    pricedRequests = 0,
    unpricedRequests = 0;
  for (const usage of outcomes.values()) {
    if (!finiteCost(usage?.cost)) {
      unpricedRequests++;
      continue;
    }
    pricedRequests++;
    if (usage?.costSource === "calculated") calculatedUsd += usage.cost;
    else reportedUsd += usage.cost;
  }
  const pendingRequests = [...requests].filter(
    (id) => !outcomes.has(id),
  ).length;
  return {
    currency: "USD",
    totalUsd:
      pricedRequests || (!requests.size && !outcomes.size)
        ? roundUsd(reportedUsd + calculatedUsd)
        : null,
    reportedUsd: roundUsd(reportedUsd),
    calculatedUsd: roundUsd(calculatedUsd),
    pricedRequests,
    unpricedRequests,
    pendingRequests,
    estimated: [...outcomes.values()].some(
      (usage) => usage?.costSource === "calculated",
    ),
    complete: unpricedRequests === 0 && pendingRequests === 0,
  };
}

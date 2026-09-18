"use client";
import { useEffect, useState } from "react";
import type { RunSummary } from "@/lib/run-types";
import { costDescription, formatUsd } from "@/lib/costs";

export function RunCost({
  runId,
  revision,
}: {
  runId: string;
  revision: number;
}) {
  const [run, setRun] = useState<RunSummary | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    let busy = false;
    async function refresh() {
      if (busy) return;
      busy = true;
      try {
        const response = await fetch(`/api/runs/${runId}?format=summary`, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("Cost unavailable");
        const data: RunSummary = await response.json();
        if (!controller.signal.aborted) {
          setRun(data);
          setError(false);
        }
      } catch {
        if (!controller.signal.aborted) setError(true);
      } finally {
        busy = false;
      }
    }
    void refresh();
    const timer = setInterval(() => void refresh(), 2000);
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, [runId, revision]);
  return (
    <section
      className="run-cost"
      aria-label="Current run cost"
      title={run ? costDescription(run.billing) : undefined}
    >
      <span>Cost</span>
      <strong>
        {run ? formatUsd(run.billing.totalUsd) : "—"}
        {run && !run.billing.complete ? " +" : ""}
      </strong>
      <p className="evaluation-caption">
        {error
          ? "Refresh failed"
          : run
            ? `${run.billing.estimated ? "estimated" : "reported"}${!run.billing.complete ? " · incomplete" : ""}`
            : "Loading…"}
      </p>
    </section>
  );
}

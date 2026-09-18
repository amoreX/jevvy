"use client";
import { useEffect, useState } from "react";
import { MODELS, PROVIDERS, modelLabel } from "@/lib/models";
import type { RunLog, RunSummary } from "@/lib/run-types";
import { runProvider } from "@/lib/run-types";
import { evaluationScore } from "@/lib/evaluation";
import { costDescription, formatUsd, type ModelUsage } from "@/lib/costs";

const seconds = (ms: number | null) =>
  ms === null ? "—" : `${(ms / 1000).toFixed(1)}s`;
export function RunHistory({ refreshKey }: { refreshKey: string }) {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [log, setLog] = useState<RunLog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  async function loadRuns(signal?: AbortSignal): Promise<RunSummary[]> {
    const response = await fetch("/api/runs", { cache: "no-store", signal });
    if (!response.ok) throw new Error("Could not load saved runs.");
    return response.json();
  }
  function refresh() {
    setLoading(true);
    void loadRuns()
      .then((data) => {
        setRuns(data);
        setError(null);
      })
      .catch(() => setError("Could not load saved runs."))
      .finally(() => setLoading(false));
  }
  useEffect(() => {
    const controller = new AbortController();
    let busy = false;
    function poll() {
      if (busy) return;
      busy = true;
      void loadRuns(controller.signal)
        .then((data) => {
          if (!controller.signal.aborted) {
            setRuns(data);
            setError(null);
            setLoading(false);
          }
        })
        .catch(() => {
          if (!controller.signal.aborted) {
            setError("Could not load saved runs.");
            setLoading(false);
          }
        })
        .finally(() => {
          busy = false;
        });
    }
    poll();
    const timer = setInterval(poll, 3000);
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, [refreshKey]);
  const openId = log?.id;
  useEffect(() => {
    if (!openId) return;
    const controller = new AbortController();
    let busy = false;
    const timer = setInterval(async () => {
      if (busy) return;
      busy = true;
      try {
        const response = await fetch(`/api/runs/${openId}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) return;
        const data = await response.json();
        if (!controller.signal.aborted) setLog(data);
      } catch {
        /* The next poll retries without discarding the last saved log. */
      } finally {
        busy = false;
      }
    }, 3000);
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, [openId]);
  async function openRun(id: string) {
    try {
      const response = await fetch(`/api/runs/${id}`, { cache: "no-store" });
      if (!response.ok) throw new Error("Could not load this run.");
      setLog(await response.json());
      setError(null);
    } catch {
      setError("Could not load this run. Refresh and retry.");
    }
  }
  return (
    <section className="run-history" aria-label="Saved game runs">
      <div className="run-history-heading">
        <span>
          {runs.length} {runs.length === 1 ? "run" : "runs"}
        </span>
        <button className="text-button" onClick={refresh} disabled={loading}>
          {loading ? "Loading…" : "Refresh logs"}
        </button>
      </div>
      {error && (
        <p className="engine-error" role="alert">
          {error}
        </p>
      )}
      {!runs.length && !loading ? (
        <p className="evaluation-caption">No runs yet.</p>
      ) : (
        <div className="run-table-scroll">
          <table className="run-table">
            <thead>
              <tr>
                <th>Started</th>
                <th>White player</th>
                <th>Result / status</th>
                <th>Plies</th>
                <th>Eval</th>
                <th>Avg. decision</th>
                <th>Run cost · USD</th>
                <th>Logs</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.id}>
                  <td>
                    {new Date(run.startedAt).toLocaleString(undefined, {
                      month: "short",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </td>
                  <td>
                    {modelLabel(run.model, run.reasoning)}
                    <br />
                    <small>{PROVIDERS[run.provider]}</small>
                  </td>
                  <td>
                    {run.result ??
                      {
                        playing: "In progress",
                        loading: "Connecting",
                        stopped: "Stopped",
                        created: "Created",
                        paused: "Paused",
                        error: "Error",
                        finished: "Finished",
                      }[run.phase] ??
                      run.phase}
                  </td>
                  <td>{run.plies}</td>
                  <td>{evaluationScore(run.evaluation)}</td>
                  <td>{seconds(run.avgLatencyMs)}</td>
                  <td title={costDescription(run.billing)}>
                    {formatUsd(run.cost)}
                    {!run.billing.complete ? " +" : ""}
                    <br />
                    <small>
                      {run.billing.estimated ? "Calculated" : "Reported"}
                      {!run.billing.complete ? " · Incomplete" : ""}
                    </small>
                  </td>
                  <td>
                    <button
                      className="text-button"
                      onClick={() => void openRun(run.id)}
                      aria-label={`View ${MODELS[run.model].name} run ${run.id}`}
                    >
                      View
                    </button>
                    <a href={`/api/runs/${run.id}?format=json`} download>
                      JSON
                    </a>
                    <a href={`/api/runs/${run.id}?format=pgn`} download>
                      PGN
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {log && (
        <div className="run-detail">
          <div className="run-detail-heading">
            <h3>
              {modelLabel(log.model, log.reasoning)} · {log.id.slice(0, 8)}
            </h3>
            <button className="text-button" onClick={() => setLog(null)}>
              Close log
            </button>
          </div>
          <p className="evaluation-caption">
            {PROVIDERS[runProvider(log)]} · Stockfish 19 · Club ·{" "}
            {log.events.length} recorded events.
          </p>
          {log.billing && (
            <p className="run-cost-total">
              Run cost:{" "}
              <strong>
                {formatUsd(log.billing.totalUsd)}
                {!log.billing.complete ? " +" : ""}
              </strong>{" "}
              · {costDescription(log.billing)} · {log.billing.pricedRequests}{" "}
              priced requests
            </p>
          )}
          <div className="run-events">
            {log.events.map((event) => (
              <details key={event.id}>
                <summary>
                  <time>{new Date(event.at).toLocaleTimeString()}</time>
                  <span>{event.type.replaceAll("_", " ")}</span>
                  <strong>
                    {event.type === "decision_result"
                      ? String(event.data.move)
                      : event.type === "state"
                        ? String(event.data.reason ?? event.data.phase)
                        : event.type === "decision_error"
                          ? String(event.data.message)
                          : event.type === "cost_accounting_updated"
                            ? "Cost accounting saved"
                            : "Input & legal moves"}
                    {(event.type === "decision_result" ||
                      event.type === "decision_error") && (
                      <>
                        {" "}
                        ·{" "}
                        {formatUsd(
                          (event.data.usage as ModelUsage | undefined)?.cost ??
                            null,
                        )}
                      </>
                    )}
                  </strong>
                </summary>
                <pre>{JSON.stringify(event.data, null, 2)}</pre>
              </details>
            ))}
          </div>
        </div>
      )}
      {runs.length > 0 && (
        <details className="cost-help">
          <summary>Cost details</summary>
          <p className="evaluation-caption">
            OpenRouter costs are provider reported. OpenAI costs are calculated
            from saved token usage and published rates. “+” marks pending or
            unpriced requests; their charges are not included yet.
          </p>
        </details>
      )}
    </section>
  );
}

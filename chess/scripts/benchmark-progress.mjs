import {
  copyFile,
  readFile,
  readdir,
  rename,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

async function readJson(path) {
  for (let attempt = 0; ; attempt++) {
    try {
      return JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      if (!(error instanceof SyntaxError) || attempt >= 3) throw error;
      await sleep([50, 150, 500][attempt]);
    }
  }
}

const file = resolve(process.argv[2]);
const batch = await readJson(file);
const models = [...new Set(batch.jobs.map((job) => job.model))];
const original = JSON.stringify(batch, null, 2) + "\n";
const recoveries = [];
for (const directory of await readdir(dirname(file))) {
  if (!directory.startsWith("recovery-")) continue;
  const recovery = await readJson(
    resolve(dirname(file), directory, "results.json"),
  );
  recoveries.push({ directory, ...recovery });
  for (const job of recovery.jobs) {
    const index = batch.jobs.findIndex(
      (original) => original.runId === job.runId,
    );
    if (index === -1) throw new Error("Recovery does not belong to this batch");
    batch.jobs[index] = job;
  }
}
if (process.argv.includes("--finalize")) {
  if (
    !batch.jobs.length ||
    batch.jobs.some((job) => job.status !== "finished" || !job.result)
  )
    throw new Error("All games must finish before finalizing");
  for (const model of models)
    if (
      batch.jobs.filter((job) => job.model === model).length !==
      batch.configuration.gamesPerModel
    )
      throw new Error("Unexpected game count for model");
  // Call after all runner processes exit; preserve the original manifest for the audit trail.
  await writeFile(
    resolve(dirname(file), "results.before-recovery-merge.json"),
    original,
    { flag: "wx", mode: 0o600 },
  ).catch((error) => {
    if (error.code !== "EEXIST") throw error;
  });
  for (const recovery of recoveries)
    for (const job of recovery.jobs) {
      const pgn = `${job.model}-${String(job.game).padStart(2, "0")}.pgn`;
      await copyFile(
        resolve(dirname(file), recovery.directory, pgn),
        resolve(dirname(file), pgn),
      );
    }
  batch.finishedAt ??= [
    batch.updatedAt,
    ...recoveries.map((recovery) => recovery.updatedAt),
  ]
    .sort()
    .at(-1);
  batch.finalizedAt = new Date().toISOString();
  batch.configuration.initialConcurrencyPerModel ??=
    batch.configuration.concurrencyPerModel;
  delete batch.configuration.concurrencyPerModel;
  batch.configuration.recoveries = recoveries.map((recovery) => ({
    manifest: `${recovery.directory}/results.json`,
    reason: recovery.configuration.recoveryReason,
    games: recovery.jobs.map((job) => job.game),
  }));
  batch.totals = models.map((model) => {
    const jobs = batch.jobs.filter((job) => job.model === model);
    const wins = jobs.filter((job) => job.result === "1-0").length;
    const draws = jobs.filter((job) => job.result === "1/2-1/2").length;
    const losses = jobs.filter((job) => job.result === "0-1").length;
    const decisions = jobs.reduce((sum, job) => sum + job.summary.decisions, 0);
    return {
      model,
      completed: jobs.length,
      wins,
      draws,
      losses,
      points: wins + draws / 2,
      scorePercent: (100 * (wins + draws / 2)) / jobs.length,
      unfinished: 0,
      knownCostUsd: jobs.reduce((sum, job) => sum + (job.summary.cost ?? 0), 0),
      unpricedRequests: jobs.reduce(
        (sum, job) => sum + job.summary.billing.unpricedRequests,
        0,
      ),
      pendingRequests: jobs.reduce(
        (sum, job) => sum + job.summary.billing.pendingRequests,
        0,
      ),
      requests: jobs.reduce((sum, job) => sum + job.summary.requests, 0),
      decisions,
      averageDecisionMs:
        jobs.reduce(
          (sum, job) =>
            sum + (job.summary.avgLatencyMs ?? 0) * job.summary.decisions,
          0,
        ) / decisions,
    };
  });
  await writeFile(`${file}.tmp`, JSON.stringify(batch, null, 2) + "\n", {
    mode: 0o600,
  });
  await rename(`${file}.tmp`, file);
}
console.log(
  JSON.stringify(
    {
      at: new Date().toISOString(),
      models: models.map((model) => {
        const jobs = batch.jobs.filter((job) => job.model === model);
        return {
          model,
          wins: jobs.filter((job) => job.result === "1-0").length,
          draws: jobs.filter((job) => job.result === "1/2-1/2").length,
          losses: jobs.filter((job) => job.result === "0-1").length,
          unfinished: jobs
            .filter((job) => job.status !== "finished")
            .map(({ game, status, plies, reason }) => ({
              game,
              status,
              plies,
              ...(status === "error" ? { reason } : {}),
            })),
          knownCostUsd: jobs.reduce(
            (sum, job) => sum + (job.summary?.cost ?? 0),
            0,
          ),
          unpricedRequests: jobs.reduce(
            (sum, job) => sum + (job.summary?.billing.unpricedRequests ?? 0),
            0,
          ),
          pendingRequests: jobs.reduce(
            (sum, job) => sum + (job.summary?.billing.pendingRequests ?? 0),
            0,
          ),
        };
      }),
    },
    null,
    2,
  ),
);

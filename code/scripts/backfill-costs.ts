import { listRuns, appendRunEvent } from "../src/lib/run-store";

// Run with the server stopped to avoid writers in separate Node processes.
async function main() {
  for (const run of await listRuns()) {
    await appendRunEvent(run.id, "cost_accounting_updated", {
      reason: "Added persisted cost totals and pricing provenance to existing usage.",
    }, "cost-accounting-v1");
    console.log(`${run.id}: cost accounting saved`);
  }
}
void main();

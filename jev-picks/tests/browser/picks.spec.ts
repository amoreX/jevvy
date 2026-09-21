import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { brief, jevResponse } from "../fixtures";
import { parseDecision } from "../../src/lib/decision";

const browserErrors = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => {
  const errors: string[] = [];
  browserErrors.set(page, errors);
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      /hydration|hydrated/i.test(message.text())
    )
      errors.push(message.text());
  });
});
test.afterEach(({ page }) => {
  expect(browserErrors.get(page)).toEqual([]);
});

async function openHome(page: Page) {
  const ready = page.waitForResponse("**/api/config");
  await page.goto("/");
  await ready; // The mount effect has run; screenshots cannot mutate pre-hydration DOM.
}

const receipt = {
  model: "anthropic/claude-sonnet-5",
  latencyMs: 300,
  cost: 0.01,
};
async function mockModels(page: Page) {
  await page.route("**/api/config", (route) =>
    route.fulfill({ json: { configured: true } }),
  );
  await page.route("**/api/interview", (route) => {
    const input = route.request().postDataJSON();
    if (input.prepare || input.answers.length >= 2)
      return route.fulfill({ json: { question: null, brief, receipt } });
    return route.fulfill({
      json: {
        brief: null,
        receipt,
        question:
          input.answers.length === 0
            ? {
                text: "How much time can you give this each week?",
                context: "A sustainable pace matters.",
                suggestions: ["Three hours", "A full day"],
              }
            : {
                text: "What would you like this skill to give you?",
                context: "Let’s focus on your priorities.",
                suggestions: ["A creative outlet", "Career growth"],
              },
      },
    });
  });
  await page.route("**/api/decide", (route) => {
    const reviewed = route.request().postDataJSON();
    return route.fulfill({
      json: {
        ...parseDecision(jevResponse(), reviewed),
        receipt: { model: "typesafe/jev-1.13", latencyMs: 125, cost: 0.00009 },
      },
    });
  });
}
async function reachReview(page: Page) {
  await openHome(page);
  await page
    .getByLabel("Help me with…")
    .fill("Help me decide what to learn next.");
  await page.getByRole("button", { name: "Let’s figure it out" }).click();
  await page.getByRole("button", { name: "Three hours", exact: true }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page
    .getByLabel("Your answer", { exact: true })
    .fill("I want a creative outlet, using free resources.");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Does this feel like you?" }),
  ).toBeVisible();
}
test("adaptive interview, editable brief, scoring, export and result invalidation", async ({
  page,
}) => {
  await mockModels(page);
  await openHome(page);
  await page.screenshot({
    path: "data/screenshots/home-desktop.png",
    fullPage: true,
  });
  await reachReview(page);
  await expect(
    page.getByText("Violates the no-paid-courses constraint.", {
      exact: false,
    }),
  ).toBeVisible();
  await page.getByLabel("Priority for Time fit").selectOption("low");
  await page.getByText("Edit the brief", { exact: true }).click();
  await page
    .getByRole("textbox", { name: "Your decision", exact: true })
    .fill("Choose a creative skill for three hours each week.");
  let sent: typeof brief | undefined;
  page.on("request", (request) => {
    if (request.url().endsWith("/api/decide")) sent = request.postDataJSON();
  });
  await page.getByRole("button", { name: "Let Jev choose" }).click();
  await expect(
    page.getByRole("heading", { name: "Here’s your next step." }),
  ).toBeVisible();
  expect(sent?.objective).toBe(
    "Choose a creative skill for three hours each week.",
  );
  expect(sent?.criteria[0].importance).toBe("low");
  await expect(
    page.getByRole("heading", { name: "Build a small website", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("cell", { name: "3.4 / 4" })).toBeVisible();
  await expect(
    page.getByRole("rowheader", { name: "Join a paid bootcamp" }),
  ).toHaveCount(0);
  await page
    .getByText("Explore the scales & score confidence", { exact: true })
    .click();
  await expect(
    page.getByText("Score 2.50 · Confidence not returned", { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "data/screenshots/result-desktop.png",
    fullPage: true,
  });
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save decision" }).click();
  const download = await downloadPromise;
  const exported = JSON.parse(await readFile((await download.path())!, "utf8"));
  expect(exported.decision.choice).toBe("web");
  expect(exported.brief.criteria[0].importance).toBe("low");
  await page.getByRole("button", { name: "Revisit your options" }).click();
  await expect(
    page.getByRole("heading", { name: "Here’s your next step." }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Does this feel like you?" }),
  ).toBeVisible();
});
test("retry preserves the request, edits rebuild later answers, and reset clears the session", async ({
  page,
}) => {
  await mockModels(page);
  let calls = 0;
  await page.route("**/api/interview", (route) => {
    if (++calls === 1)
      return route.fulfill({
        status: 503,
        json: { error: "Temporary model failure" },
      });
    return route.fallback();
  });
  await openHome(page);
  await page.getByLabel("Help me with…").fill("Learn something creative");
  await page.getByRole("button", { name: "Let’s figure it out" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "Temporary model failure" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Retry request" }).click();
  await page.getByRole("button", { name: "Three hours", exact: true }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.locator("aside summary").first().click();
  await page.getByRole("button", { name: "Edit answer" }).click();
  await expect(page.getByLabel("Your answer", { exact: true })).toHaveValue(
    "Three hours",
  );
  await expect(page.getByText("0 of up to 5 answers")).toBeVisible();
  await page.getByRole("button", { name: "New decision", exact: true }).click();
  await page.getByRole("button", { name: "Start fresh" }).click();
  await expect(page.getByLabel("Help me with…")).toHaveValue("");
});
test("mobile layout contains the review and results and keeps scores scrollable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockModels(page);
  await openHome(page);
  await page.screenshot({
    path: "data/screenshots/home-mobile.png",
    fullPage: true,
  });
  await reachReview(page);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBeTruthy();
  await page.getByRole("button", { name: "Let Jev choose" }).click();
  await expect(
    page.getByRole("heading", { name: "Here’s your next step." }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBeTruthy();
  await expect(
    page.getByRole("region", { name: "Option score comparison" }),
  ).toBeVisible();
  await page.screenshot({
    path: "data/screenshots/result-mobile.png",
    fullPage: true,
  });
});
test("missing configuration is actionable and makes no inference request", async ({
  page,
}) => {
  await page.route("**/api/config", (route) =>
    route.fulfill({ json: { configured: false } }),
  );
  let inference = false;
  page.on("request", (r) => {
    if (r.url().endsWith("/api/interview")) inference = true;
  });
  await openHome(page);
  await page.getByLabel("Help me with…").fill("Choose a hobby");
  await expect(
    page.getByRole("button", { name: "Let’s figure it out" }),
  ).toBeDisabled();
  await expect(page.getByRole("status")).toContainText("OPENROUTER_API_KEY");
  expect(inference).toBe(false);
});

test("editing a failed decision clears its stale retry payload", async ({
  page,
}) => {
  await mockModels(page);
  let attempts = 0;
  let latestObjective = "";
  await page.route("**/api/decide", (route) => {
    latestObjective = route.request().postDataJSON().objective;
    if (++attempts === 1)
      return route.fulfill({
        status: 503,
        json: { error: "Try again shortly" },
      });
    return route.fallback();
  });
  await reachReview(page);
  await page.getByRole("button", { name: "Let Jev choose" }).click();
  await expect(
    page.getByRole("button", { name: "Retry request" }),
  ).toBeVisible();
  await page.getByText("Edit the brief", { exact: true }).click();
  await page
    .getByRole("textbox", { name: "Your decision", exact: true })
    .fill("A revised decision");
  await expect(page.getByRole("button", { name: "Retry request" })).toHaveCount(
    0,
  );
  await page.getByRole("button", { name: "Let Jev choose" }).click();
  await expect(
    page.getByRole("heading", { name: "Here’s your next step." }),
  ).toBeVisible();
  expect(latestObjective).toBe("A revised decision");
});

test("cancelling a request and starting over ignores its late response", async ({
  page,
}) => {
  await mockModels(page);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let completed!: () => void;
  const handled = new Promise<void>((resolve) => {
    completed = resolve;
  });
  await page.route("**/api/interview", async (route) => {
    await gate;
    try {
      await route.fulfill({ json: { question: null, brief, receipt } });
    } catch {
      /* The user cancelled this request. */
    } finally {
      completed();
    }
  });
  await openHome(page);
  await page.getByLabel("Help me with…").fill("Choose a skill");
  await page.getByRole("button", { name: "Let’s figure it out" }).click();
  await page.getByRole("button", { name: "Stop request" }).click();
  await page.getByRole("button", { name: "New decision", exact: true }).click();
  await page.getByRole("button", { name: "Start fresh" }).click();
  release();
  await handled;
  await expect(page.getByLabel("Help me with…")).toHaveValue("");
  await expect(
    page.getByRole("heading", { name: "Does this feel like you?" }),
  ).toHaveCount(0);
});

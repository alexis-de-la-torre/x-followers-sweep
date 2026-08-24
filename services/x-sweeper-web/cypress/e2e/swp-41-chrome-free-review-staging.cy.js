/// <reference types="cypress" />

// SWP-41 is an opt-in, no-mock staging journey. It queries the real GKE
// namespace, starts one paid three-account Dry run, and restores its durable
// result after all browser-local state is removed. It never confirms an action.
const OUTCOME_ENGINE_URL =
  Cypress.env("OUTCOME_ENGINE_URL") || "https://outcome-engine.s26.staging.adlt.dev";
const SWEEPER_AGENT_URL =
  Cypress.env("SWEEPER_AGENT_URL") || "https://sweeper-agent.s26.staging.adlt.dev";
const STAGING_RELEASE = String(Cypress.env("STAGING_RELEASE") || "");
const EXISTING_SWEEP_ID = String(Cypress.env("EXISTING_SWEEP_ID") || "");
const RUN = [true, "true"].includes(Cypress.env("RUN_SWP_41"));
const describeStaging = RUN ? describe : describe.skip;
const RUNS_URL = `${OUTCOME_ENGINE_URL}/api/v1/outcome-deliveries?outcomeName=sweep-run`;
const UNFOLLOWS_URL = `${OUTCOME_ENGINE_URL}/api/v1/outcome-deliveries?outcomeName=sweep-unfollow`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FAILURE_STATUSES = new Set(["COMPLETED_WITH_TASK_FAILURE", "FAILED", "CANCELLED"]);

function contextOf(delivery) {
  if (typeof delivery?.context === "object") return delivery.context || {};
  try { return JSON.parse(delivery?.context || "{}"); } catch { return {}; }
}

function waitForSweep(id, predicate, description, deadline) {
  const url = `${OUTCOME_ENGINE_URL}/api/v1/outcome-deliveries/by-source/x-sweep-run/${id}`;
  return cy.request({ url, failOnStatusCode: false }).then(({ status, body }) => {
    const state = status === 200 ? body : null;
    if (state && FAILURE_STATUSES.has(state.status)) {
      throw new Error(
        `Sweep ${id} reached ${state.status} while waiting for ${description}: ${JSON.stringify(state)}`,
      );
    }
    if (state && predicate(state)) return state;
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for ${description} on sweep ${id}; ` +
        `last response ${status}: ${JSON.stringify(body)}`,
      );
    }
    return cy.wait(1000).then(() => waitForSweep(id, predicate, description, deadline));
  });
}

function assertChromeFreeSnapshot(snapshot) {
  expect(snapshot.runtime, "Chrome workloads, pods, and services").to.deep.eq([]);
  expect(snapshot.agentConfig, "agent config").not.to.have.property("BROWSER_WS");
  expect(snapshot.profile, "preserved rollback profile").to.deep.include({
    name: "chrome-vnc-pvc",
    phase: "Bound",
  });
}

function assertRenderedReview(sweepId, reviews) {
  cy.get(`[data-sweep-id="${sweepId}"] [aria-label="View run steps"]`, { timeout: 15000 }).click();
  cy.get('[role="dialog"]').within(() => {
    cy.contains("3 candidates").should("be.visible");
    cy.contains("3 reviewed").should("be.visible");
    reviews.forEach((review) => {
      cy.contains(review.handle).should("be.visible");
      cy.contains(review.decision).should("be.visible");
      cy.contains(review.reason).should("be.visible");
    });
  });
}

describeStaging("SWP-41 Chrome-free three-account review", () => {
  it("reviews and restores three real X accounts with no Chrome runtime or relationship action", () => {
    let sweepId = EXISTING_SWEEP_ID;
    let deliveryId;
    let reviews;
    let xApiEvidence;
    let startRequests = 0;
    let actionRequests = 0;

    expect(STAGING_RELEASE, "deployed staging release supplied as evidence").not.to.be.empty;
    if (sweepId) expect(sweepId, "existing sweep identity").to.match(UUID);

    cy.task("stagingChromeFreeSnapshot").then(assertChromeFreeSnapshot);

    cy.request(`${SWEEPER_AGENT_URL}/health`).then(({ status, body }) => {
      expect(status, "agent health status").to.eq(200);
      expect(body.service, "agent is serving requests").to.eq("ok");
      expect(body.xApi?.configured, "official X path selected").to.eq(true);
      expect(body.xApi?.writeConfigured, "official X writes selected").to.eq(true);
      expect(body.xApi?.account, "authorized source account").to.eq("@dlt_alx");
      expect(body.xApi?.error, "X authorization startup error").to.eq(null);
      expect(body, "health has no browser readiness").not.to.have.property("chrome");
    });

    cy.intercept("POST", "**/api/v1/sweeps/*/unfollows", () => { actionRequests += 1; });

    if (sweepId) {
      cy.visit("/");
    } else {
      cy.intercept("POST", `${SWEEPER_AGENT_URL}/api/v1/sweeps`, (request) => {
        startRequests += 1;
        expect(request.body.id, "caller-owned sweep identity").to.match(UUID);
        expect(request.body.mode, "non-destructive review mode").to.eq("dry-run");
        expect(request.body.count, "bounded review count").to.eq(3);
      }).as("startSweep");

      cy.clearLocalStorage();
      cy.visit("/config");
      cy.get('[data-testid="settings-page"]').should("have.attr", "data-settings-ready", "true");
      cy.get('[data-testid="auto-unfollow"]').then(($switch) => {
        if ($switch.is(":checked")) cy.wrap($switch).uncheck({ force: true });
      });
      cy.get('[data-testid="auto-unfollow"]').should("not.be.checked");
      cy.get('[data-testid="sweep-count"]').click();
      cy.get('[role="option"]').contains("3 accounts").click();
      cy.get('[data-testid="sweep-count"]').should("have.value", "3 accounts");
      cy.get('[aria-label="Runs"]').click();

      cy.get('[data-testid="new-sweep"]').first().should("be.enabled").click();
      cy.wait("@startSweep", { requestTimeout: 10000, responseTimeout: 120000 })
        .then(({ request, response }) => {
          expect(response?.statusCode, "sweep accepted").to.eq(202);
          sweepId = request.body.id;
          return waitForSweep(
            sweepId,
            (state) => state.status === "RUNNING",
            "durable running sweep",
            Date.now() + 15000,
          );
        })
        .then((state) => { deliveryId = state.deliveryId; });
    }

    cy.then(() => waitForSweep(
      sweepId,
      (state) => state.status === "ALL_TASKS_COMPLETED",
      "terminal three-account review",
      Date.now() + 300000,
    )).then((state) => {
      deliveryId = deliveryId || state.deliveryId;
      expect(state.deliveryId, "one durable delivery").to.eq(deliveryId);
      expect(state.steps.map((step) => step.taskName), "two-step review flow").to.deep.eq([
        "generate-candidates",
        "review-handles",
      ]);
      expect(state.steps.every((step) => step.result === "SUCCESS"), "successful flow").to.eq(true);
      return cy.request(`${OUTCOME_ENGINE_URL}/api/v1/outcome-deliveries/${deliveryId}/context`);
    }).then(({ status, body: context }) => {
      expect(status, "durable context status").to.eq(200);
      expect(context.params, "persisted request").to.deep.include({ mode: "dry-run", count: 3 });
      expect(context.candidates, "three candidates").to.have.length(3);
      expect(context.candidateEvidence, "three evidence records").to.have.length(3);
      reviews = context.reviews;
      expect(reviews, "three decisions").to.have.length(3);
      reviews.forEach((review) => {
        expect(String(review.xUserId), `${review.handle} stable X ID`).to.match(/^\d{1,19}$/);
        expect(review.decision, `${review.handle} decision`).to.be.oneOf(["KEEP", "UNFOLLOW"]);
        expect(review.reason, `${review.handle} reason`).to.be.a("string").and.not.be.empty;
      });
      xApiEvidence = context.xApi;
      expect(xApiEvidence?.source?.username, "persisted source").to.eq("dlt_alx");
      expect(xApiEvidence?.returnedResources, "paid resources").to.eq(3);
      expect(xApiEvidence?.upstreamRequests, "bounded X requests").to.be.greaterThan(0);
    });

    cy.request(UNFOLLOWS_URL).then(({ status, body }) => {
      expect(status, "action delivery list status").to.eq(200);
      const attributable = body.filter((delivery) => contextOf(delivery).params?.sweepId === sweepId);
      expect(attributable, "relationship actions for this review").to.have.length(0);
    });
    cy.then(() => {
      expect(startRequests, "one new sweep request").to.eq(EXISTING_SWEEP_ID ? 0 : 1);
      expect(actionRequests, "no action request").to.eq(0);
      assertRenderedReview(sweepId, reviews);
      cy.screenshot("swp-41-chrome-free-three-account-review", { capture: "viewport" });
    });

    cy.get("body").type("{esc}");
    cy.window().then((win) => {
      win.localStorage.clear();
      win.sessionStorage.clear();
      expect(win.localStorage.length, "cleared local storage").to.eq(0);
      expect(win.sessionStorage.length, "cleared session storage").to.eq(0);
    });
    cy.intercept("GET", RUNS_URL).as("runsAfterClear");
    cy.reload(true);
    cy.wait("@runsAfterClear", { responseTimeout: 30000 }).then(({ response }) => {
      expect(response?.statusCode, "reloaded runs status").to.eq(200);
      const matches = response.body.filter((delivery) => delivery.sourceId === sweepId);
      expect(matches, "one restored delivery").to.have.length(1);
      expect(matches[0].deliveryId, "same restored delivery").to.eq(deliveryId);
      expect(matches[0].status, "terminal restored status").to.eq("ALL_TASKS_COMPLETED");
    });
    cy.then(() => {
      assertRenderedReview(sweepId, reviews);
      cy.screenshot("swp-41-chrome-free-review-restored", { capture: "viewport" });
    });
    cy.get("body").type("{esc}");

    cy.get('[aria-label="Agent information"]').click();
    cy.get('[role="dialog"]').within(() => {
      cy.contains("X API").should("be.visible");
      cy.contains("X account").should("be.visible");
      cy.contains("@dlt_alx").should("be.visible");
      cy.contains("Chrome").should("not.exist");
    });
    cy.get("body").type("{esc}");

    cy.task("stagingChromeFreeSnapshot").then(assertChromeFreeSnapshot);
    cy.then(() => cy.task("log", JSON.stringify({
      stagingRelease: STAGING_RELEASE,
      sweepId,
      deliveryId,
      source: xApiEvidence.source,
      returnedResources: xApiEvidence.returnedResources,
      upstreamRequests: xApiEvidence.upstreamRequests,
      decisions: reviews.map(({ handle, xUserId, decision }) => ({ handle, xUserId, decision })),
    })));
  });
});

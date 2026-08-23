/// <reference types="cypress" />

// SWP-34 is explicitly opt-in because it spends real X API resources and
// model work. It never stubs a response. EXISTING_SWEEP_ID enables a read-only
// terminal/recovery replay without paying for a second 500-account review.
const REVIEW_COUNT = 500;
const OUTCOME_ENGINE_URL =
  Cypress.env("OUTCOME_ENGINE_URL") || "https://outcome-engine.s26.staging.adlt.dev";
const SWEEPER_AGENT_URL =
  Cypress.env("SWEEPER_AGENT_URL") || "https://sweeper-agent.s26.staging.adlt.dev";
const STAGING_RELEASE = String(Cypress.env("STAGING_RELEASE") || "");
const EXISTING_SWEEP_ID = String(Cypress.env("EXISTING_SWEEP_ID") || "");
const RUN = [true, "true"].includes(Cypress.env("RUN_SWP_34"));
const describeStaging = RUN ? describe : describe.skip;
const RUNS_URL = `${OUTCOME_ENGINE_URL}/api/v1/outcome-deliveries?outcomeName=sweep-run`;
const UNFOLLOWS_URL = `${OUTCOME_ENGINE_URL}/api/v1/outcome-deliveries?outcomeName=sweep-unfollow`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FAILURE_STATUSES = new Set(["COMPLETED_WITH_TASK_FAILURE", "FAILED", "CANCELLED"]);

function contextOf(delivery) {
  if (typeof delivery?.context === "object") return delivery.context || {};
  try { return JSON.parse(delivery?.context || "{}"); } catch { return {}; }
}

function waitForSweepState(id, predicate, description, deadline) {
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
    return cy.wait(2000).then(() => waitForSweepState(id, predicate, description, deadline));
  });
}

function deliveryFromListResponse(response, sweepId, expectedStatus) {
  expect(response?.statusCode, "Outcome Engine browser reload status").to.eq(200);
  expect(response?.body, "Outcome Engine browser reload body").to.be.an("array");
  const matches = response.body.filter((delivery) => delivery.sourceId === sweepId);
  expect(matches, `one browser-visible delivery for sweep ${sweepId}`).to.have.length(1);
  if (expectedStatus) expect(matches[0].status, "reloaded delivery status").to.eq(expectedStatus);
  return matches[0];
}

function assertRenderedReviews(reviews) {
  const keep = reviews.filter((review) => review.decision === "KEEP").length;
  const unfollow = reviews.filter((review) => review.decision === "UNFOLLOW").length;

  cy.get('[data-testid="sweep-results"]').within(() => {
    cy.contains(`${REVIEW_COUNT} candidates`).should("be.visible");
    cy.contains(`${REVIEW_COUNT} reviewed`).should("be.visible");
    cy.contains(`${keep} KEEP`).should("be.visible");
    cy.contains(`${unfollow} UNFOLLOW`).should("be.visible");
    cy.get('[data-testid^="review-"]').should("have.length", REVIEW_COUNT).then(($cards) => {
      const byTestId = new Map(
        [...$cards].map((card) => [card.getAttribute("data-testid"), card]),
      );
      expect(byTestId.size, "unique rendered review cards").to.eq(REVIEW_COUNT);

      // Keep this synchronous so the one-second run-list refresh cannot replace
      // the modal tree halfway through the 500-card accessibility audit.
      reviews.forEach((review) => {
        const testId = `review-${review.handle.replace(/^@/, "")}`;
        const card = byTestId.get(testId);
        expect(card, `${review.handle} result card`).to.exist;
        card.scrollIntoView({ block: "center", inline: "nearest" });
        const rect = card.getBoundingClientRect();
        const viewportHeight = card.ownerDocument.defaultView.innerHeight;
        expect(rect.top, `${review.handle} viewport top`).to.be.at.least(0);
        expect(rect.bottom, `${review.handle} viewport bottom`).to.be.at.most(viewportHeight);
        expect(card.innerText, `${review.handle} rendered result`).to.include(review.handle)
          .and.include(review.decision)
          .and.include(review.reason);
      });
    });
  });
}

describeStaging("SWP-34 staging 500-account review", () => {
  it("starts one advertised-ceiling review and restores all 500 persisted results", () => {
    let sweepId;
    let deliveryId;
    let deliveryStartedAt;
    let terminalDelivery;
    let candidates;
    let reviews;
    let xApiEvidence;
    let startRequests = 0;
    let unfollowRequests = 0;

    expect(STAGING_RELEASE, "deployed staging release supplied as evidence").not.to.be.empty;

    cy.request(`${SWEEPER_AGENT_URL}/health`).then(({ status, body }) => {
      expect(status, "agent health status").to.eq(200);
      expect(body.service, "agent is serving requests").to.eq("ok");
      expect(body.xApi?.configured, "official X read path selected").to.eq(true);
      expect(body.xApi?.account, "authorized source account").to.eq("@dlt_alx");
      expect(body.xApi?.error, "X authorization error").to.eq(null);
      expect(body.openrouter, "review model configured").to.eq("configured");
      expect(body.outcomeEngine?.started, "durable task subscriber started").to.eq(true);
      expect(body.outcomeEngine?.error, "durable task subscriber error").to.eq(null);
    });

    cy.intercept("POST", "**/api/v1/sweeps/*/unfollows", () => { unfollowRequests += 1; });

    if (EXISTING_SWEEP_ID) {
      expect(EXISTING_SWEEP_ID, "existing sweep identity").to.match(UUID);
      sweepId = EXISTING_SWEEP_ID;
      cy.visit("/");
      cy.then(() => waitForSweepState(
        sweepId,
        (state) => state.status === "ALL_TASKS_COMPLETED",
        "existing terminal 500-account review",
        Date.now() + 10000,
      )).then((state) => {
        deliveryId = state.deliveryId;
        deliveryStartedAt = state.createdAt;
      });
    } else {
      cy.intercept("POST", `${SWEEPER_AGENT_URL}/api/v1/sweeps`, (request) => {
        startRequests += 1;
        expect(request.body.id, "caller-owned sweep identity").to.match(UUID);
        expect(request.body.mode, "relationship-safe mode").to.eq("dry-run");
        expect(request.body.count, "advertised review ceiling").to.eq(REVIEW_COUNT);
      }).as("startSweep");

      cy.clearLocalStorage();
      cy.visit("/config");
      cy.get('[data-testid="settings-page"]').should("have.attr", "data-settings-ready", "true");
      cy.get('[data-testid="auto-unfollow"]').then(($switch) => {
        if ($switch.is(":checked")) cy.wrap($switch).uncheck({ force: true });
      });
      cy.get('[data-testid="auto-unfollow"]').should("not.be.checked");
      cy.get('[data-testid="sweep-count"]').click();
      cy.get('[role="option"]').contains(`${REVIEW_COUNT} accounts`).scrollIntoView().click();
      cy.get('[data-testid="sweep-count"]').should("have.value", `${REVIEW_COUNT} accounts`);
      cy.get('[aria-label="Runs"]').click();
      cy.get('[data-testid="runs-heading"]').should("have.text", "Runs");

      cy.get('[data-testid="new-sweep"]').first().should("be.enabled").click();
      cy.wait("@startSweep", { requestTimeout: 10000, responseTimeout: 120000 })
        .then(({ request, response }) => {
          expect(response?.statusCode, "sweep accepted").to.eq(202);
          expect(response?.body.id, "accepted source identity").to.eq(request.body.id);
          sweepId = request.body.id;
          return waitForSweepState(
            sweepId,
            (state) => state.status === "RUNNING",
            "durable in-progress sweep",
            Date.now() + 30000,
          );
        })
        .then((state) => {
          deliveryId = state.deliveryId;
          deliveryStartedAt = state.createdAt;
        });

      cy.intercept("GET", RUNS_URL).as("runsAfterInProgressReload");
      cy.reload(true);
      cy.wait("@runsAfterInProgressReload", { responseTimeout: 120000 }).then(({ response }) => {
        deliveryFromListResponse(response, sweepId, "RUNNING");
      });
      cy.then(() => {
        expect(startRequests, "one browser request from one click").to.eq(1);
        cy.get(`[data-sweep-id="${sweepId}"]`, { timeout: 120000 }).should("be.visible");
      });
    }

    cy.then(() => waitForSweepState(
      sweepId,
      (state) => state.status === "ALL_TASKS_COMPLETED",
      "terminal 500-account review",
      Date.now() + 2700000,
    )).then((state) => {
      terminalDelivery = state;
      expect(state.deliveryId, "same durable delivery").to.eq(deliveryId);
      return cy.request({
        url: `${OUTCOME_ENGINE_URL}/api/v1/outcome-deliveries/${deliveryId}/context`,
        timeout: 120000,
      });
    }).then(({ status, body: context }) => {
      expect(status, "terminal context status").to.eq(200);
      candidates = context.candidates;
      reviews = context.reviews;
      xApiEvidence = context.xApi;

      expect(context.params, "persisted request")
        .to.deep.include({ mode: "dry-run", count: REVIEW_COUNT });
      expect(terminalDelivery.steps, "dry-run flow steps").to.have.length(2);
      expect(terminalDelivery.steps.map((step) => step.taskName)).to.deep.eq([
        "generate-candidates",
        "review-handles",
      ]);
      terminalDelivery.steps.forEach((step) => {
        expect(step.result, `${step.taskName} result`).to.eq("SUCCESS");
      });
      expect(context.unfollows || [], "persisted automatic unfollows").to.have.length(0);

      expect(candidates, "persisted candidates").to.have.length(REVIEW_COUNT);
      expect(
        new Set(candidates.map((handle) => handle.toLowerCase())).size,
        "unique handles",
      ).to.eq(REVIEW_COUNT);
      expect(context.candidateEvidence, "persisted candidate evidence").to.have.length(REVIEW_COUNT);
      expect(context.candidateEvidence.map((item) => item.handle), "candidate evidence order")
        .to.deep.eq(candidates);
      const evidenceIds = context.candidateEvidence.map((item) => String(item.xUserId));
      expect(evidenceIds.every((id) => /^\d{1,19}$/.test(id)), "numeric stable X IDs").to.eq(true);
      expect(new Set(evidenceIds).size, "unique stable X IDs").to.eq(REVIEW_COUNT);

      expect(reviews, "persisted reviews").to.have.length(REVIEW_COUNT);
      expect(reviews.map((review) => review.handle), "one ordered review per candidate")
        .to.deep.eq(candidates);
      reviews.forEach((review, index) => {
        expect(String(review.xUserId), `${review.handle} stable action identity`).to.eq(evidenceIds[index]);
        expect(review.decision, `${review.handle} decision`).to.be.oneOf(["KEEP", "UNFOLLOW"]);
        expect(review.reason, `${review.handle} reason`).to.be.a("string").and.not.be.empty;
      });

      expect(xApiEvidence?.source?.username, "persisted X source").to.eq("dlt_alx");
      expect(xApiEvidence?.returnedResources, "returned X resources").to.eq(REVIEW_COUNT);
      expect(xApiEvidence?.upstreamRequests, "upstream X requests")
        .to.be.a("number").and.be.greaterThan(0);
    });

    cy.request({ url: RUNS_URL, timeout: 120000 }).then(({ status, body }) => {
      expect(status, "Outcome Engine final run-list status").to.eq(200);
      const matches = body.filter((delivery) => delivery.sourceId === sweepId);
      expect(matches, "one final durable sweep").to.have.length(1);
      expect(matches[0].deliveryId, "final delivery identity").to.eq(deliveryId);
    });
    cy.request({ url: UNFOLLOWS_URL, timeout: 120000 }).then(({ status, body }) => {
      expect(status, "Outcome Engine unfollow-list status").to.eq(200);
      const attributable = body.filter((delivery) => contextOf(delivery).params?.sweepId === sweepId);
      expect(attributable, "unfollow deliveries for this sweep").to.have.length(0);
    });
    cy.then(() => {
      expect(startRequests, "new sweep requests").to.eq(EXISTING_SWEEP_ID ? 0 : 1);
      expect(unfollowRequests, "browser unfollow requests").to.eq(0);
    });

    cy.then(() => {
      cy.get(`[data-sweep-id="${sweepId}"] [aria-label="View run steps"]`, { timeout: 120000 }).click();
      cy.screenshot("swp-34-500-account-review-top", { capture: "viewport" });
      assertRenderedReviews(reviews);
      cy.screenshot("swp-34-500-account-review-last", { capture: "viewport" });
    });

    cy.get("body").type("{esc}");
    cy.window().then((win) => {
      win.localStorage.clear();
      win.sessionStorage.clear();
      expect(win.localStorage.length, "cleared local storage").to.eq(0);
      expect(win.sessionStorage.length, "cleared session storage").to.eq(0);
    });
    cy.intercept("GET", RUNS_URL).as("runsAfterStorageClear");
    cy.reload(true);
    cy.wait("@runsAfterStorageClear", { responseTimeout: 120000 }).then(({ response }) => {
      deliveryFromListResponse(response, sweepId, "ALL_TASKS_COMPLETED");
    });
    cy.then(() => {
      cy.get(`[data-sweep-id="${sweepId}"] [aria-label="View run steps"]`, { timeout: 120000 }).click();
      cy.screenshot("swp-34-500-account-restored-top", { capture: "viewport" });
      assertRenderedReviews(reviews);
      cy.screenshot("swp-34-500-account-restored-last", { capture: "viewport" });
    });

    cy.then(() => cy.task("log", JSON.stringify({
      stagingRelease: STAGING_RELEASE,
      sweepId,
      deliveryId,
      status: terminalDelivery.status,
      createdAt: deliveryStartedAt,
      completedAt: terminalDelivery.updatedAt,
      tasks: terminalDelivery.steps.map((step) => ({
        name: step.taskName,
        result: step.result,
        dispatchedAt: step.dispatchedAt,
        completedAt: step.completedAt,
      })),
      source: xApiEvidence.source,
      returnedResources: xApiEvidence.returnedResources,
      upstreamRequests: xApiEvidence.upstreamRequests,
      candidates: candidates.length,
      reviews: reviews.length,
      keep: reviews.filter((review) => review.decision === "KEEP").length,
      unfollow: reviews.filter((review) => review.decision === "UNFOLLOW").length,
    })));
  });
});

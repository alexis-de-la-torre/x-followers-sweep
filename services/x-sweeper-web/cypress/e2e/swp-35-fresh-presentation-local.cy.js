/// <reference types="cypress" />

// One small, real review-only run proving fresh defaults or the modern empty
// state. No selection or relationship action is permitted in this journey.
const OUTCOME_ENGINE_URL = Cypress.env("OUTCOME_ENGINE_URL") || "http://127.0.0.1:8090";
const SWEEPER_AGENT_URL = Cypress.env("SWEEPER_AGENT_URL") || "http://127.0.0.1:8020";
const SWEEP_COUNT = Number(Cypress.env("SWEEP_COUNT") || 3);
const EXISTING_SWEEP_ID = String(Cypress.env("EXISTING_SWEEP_ID") || "");
const RUNS_URL = `${OUTCOME_ENGINE_URL}/api/v1/outcome-deliveries?outcomeName=sweep-run&limit=500`;
const SELECTIONS_URL = `${OUTCOME_ENGINE_URL}/api/v1/outcome-deliveries?outcomeName=sweep-selection&limit=500`;
const ACTIONS_URL = `${OUTCOME_ENGINE_URL}/api/v1/outcome-deliveries?outcomeName=sweep-unfollow&limit=500`;

function contextOf(delivery) {
  if (typeof delivery?.context === "object") return delivery.context || {};
  try { return JSON.parse(delivery?.context || "{}"); } catch { return {}; }
}

function waitForReviewedRun(sourceId, deadline = Date.now() + 900000) {
  return cy.request({ url: RUNS_URL, failOnStatusCode: false }).then((response) => {
    const delivery = Array.isArray(response.body)
      ? response.body.find((candidate) => candidate.sourceId === sourceId)
      : null;
    const context = contextOf(delivery);
    if (
      response.status === 200
      && delivery?.status === "ALL_TASKS_COMPLETED"
      && Array.isArray(context.reviews)
      && context.reviews.length === SWEEP_COUNT
    ) return delivery;
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for fresh reviewed run ${sourceId}: ${JSON.stringify(delivery)}`);
    }
    return cy.wait(500).then(() => waitForReviewedRun(sourceId, deadline));
  });
}

describe("SWP-35 fresh reviewed Auto-unfollow presentation", () => {
  it(`${EXISTING_SWEEP_ID ? "resumes an unselected review" : "starts once"} and presents fresh recommendations selected or an honest empty state`, () => {
    let sweepId = EXISTING_SWEEP_ID || undefined;
    let sweepPosts = 0;
    let selectionPosts = 0;
    let actionPosts = 0;
    let outcomeEngineUiGets = 0;
    let durableContext;

    cy.intercept("GET", "**/api/v1/outcome-deliveries*", (request) => {
      expect(new URL(request.url).origin, "browser Outcome Engine origin")
        .to.eq(new URL(OUTCOME_ENGINE_URL).origin);
      outcomeEngineUiGets += 1;
    });
    cy.intercept("POST", "**/api/v1/sweeps", (request) => {
      expect(new URL(request.url).origin, "browser sweeper-agent origin")
        .to.eq(new URL(SWEEPER_AGENT_URL).origin);
      sweepPosts += 1;
      if (EXISTING_SWEEP_ID) {
        request.destroy();
        return;
      }
      sweepId = request.body.id;
      expect(request.body).to.deep.eq({
        id: sweepId,
        mode: "reviewed-auto-unfollow",
        count: SWEEP_COUNT,
      });
    }).as("freshReviewedSweep");
    cy.intercept("POST", "**/api/v1/sweeps/*/selections", (request) => {
      expect(new URL(request.url).origin, "selection sweeper-agent origin")
        .to.eq(new URL(SWEEPER_AGENT_URL).origin);
      selectionPosts += 1;
      request.destroy();
    });
    cy.intercept("POST", "**/api/v1/sweeps/*/unfollows", (request) => {
      expect(new URL(request.url).origin, "action sweeper-agent origin")
        .to.eq(new URL(SWEEPER_AGENT_URL).origin);
      actionPosts += 1;
      request.destroy();
    });

    cy.request(`${SWEEPER_AGENT_URL}/health`).its("body").then((health) => {
      expect(health.service).to.eq("ok");
      expect(health.xApi?.configured).to.eq(true);
      expect(health.xApi?.account).to.match(/^@/);
    });

    cy.visit("/config");
    cy.get('[data-testid="settings-page"][data-settings-ready="true"]');
    cy.get('[data-testid="auto-unfollow"]').then(($switch) => {
      if (!$switch.is(":checked")) cy.wrap($switch).check({ force: true });
    });
    cy.get('[data-testid="sweep-count"]').click();
    cy.get('[role="option"]').contains(`${SWEEP_COUNT} accounts`).click();
    cy.get('[aria-label="Runs"]').click({ force: true });
    if (!EXISTING_SWEEP_ID) {
      cy.get('[data-testid="new-sweep"]').first().click();
      cy.wait("@freshReviewedSweep", { requestTimeout: 10000, responseTimeout: 30000 })
        .its("response.statusCode").should("eq", 202);
    }
    cy.then(() => {
      expect(sweepPosts, EXISTING_SWEEP_ID
        ? "resuming does not start another sweep"
        : "exactly one fresh sweep request").to.eq(EXISTING_SWEEP_ID ? 0 : 1);
      expect(sweepId).to.match(/^[0-9a-f-]{36}$/i);
    });

    cy.then(() => waitForReviewedRun(sweepId)).then((delivery) => {
      durableContext = contextOf(delivery);
      expect(delivery.steps.map((step) => step.taskName)).to.deep.eq([
        "generate-candidates",
        "review-handles",
      ]);
      expect(durableContext.params).to.deep.eq({ mode: "auto-unfollow", count: SWEEP_COUNT });
      expect(durableContext.candidates).to.have.length(SWEEP_COUNT);
      expect(durableContext.candidateEvidence).to.have.length(SWEEP_COUNT);
      expect(durableContext.xApi?.source?.id).to.match(/^\d{1,19}$/);
      durableContext.reviews.forEach((review, index) => {
        expect(review.handle).to.eq(durableContext.candidates[index]);
        expect(String(review.xUserId)).to.eq(String(durableContext.candidateEvidence[index].xUserId));
      });
    });
    cy.request(RUNS_URL).then(({ body }) => {
      const matchingRuns = body.filter((delivery) => delivery.sourceId === sweepId);
      expect(matchingRuns, "exactly one durable run identity").to.have.length(1);
    });

    cy.then(() => cy.get(
      `[data-sweep-id="${sweepId}"] [aria-label="View run steps"]`,
      { timeout: 15000 },
    ).click());
    cy.get('[role="dialog"]').should("be.visible");
    cy.then(() => {
      const recommended = durableContext.reviews.filter((review) => review.decision === "UNFOLLOW");
      if (!recommended.length) {
        cy.get('[data-testid="empty-recommendation-set"]')
          .should("contain.text", "no accounts recommended for Auto-unfollow");
        cy.get('[data-testid="kept-account-count"]').should("contain.text", String(SWEEP_COUNT));
        cy.get('[data-testid="review-approved-set"]').should("not.exist");
        cy.screenshot("08-fresh-modern-empty-auto-unfollow", { capture: "viewport" });
      } else {
        cy.get("[data-recommendation-id]").then(($cards) => {
          expect([...$cards].map((card) => card.getAttribute("data-recommendation-id")))
            .to.deep.eq(recommended.map((review) => String(review.xUserId)));
        });
        recommended.forEach((review) => {
          cy.get(`[data-testid="recommendation-select-${review.xUserId}"]`)
            .should("be.checked");
        });
        cy.get("[data-recommendation-id]").first()
          .scrollIntoView({ offset: { top: -120, left: 0 } })
          .should("be.visible");
        cy.get(`[data-recommendation-id="${recommended[0].xUserId}"]`).within(() => {
          cy.contains(recommended[0].handle).should("be.visible");
          cy.contains(String(recommended[0].xUserId)).should("be.visible");
          cy.contains(recommended[0].reason).should("be.visible");
        });
        cy.get('[data-testid="approved-count"]')
          .should("be.visible")
          .and("contain.text", String(recommended.length));
        cy.screenshot("08-fresh-recommendations-default-selected", { capture: "viewport" });
      }
    });

    cy.request(ACTIONS_URL).then(({ body }) => {
      const actions = body.filter((delivery) => contextOf(delivery).params?.sweepId === sweepId);
      expect(actions, "fresh presentation creates no X action").to.deep.eq([]);
    });
    cy.request(SELECTIONS_URL).then(({ body }) => {
      const selections = body.filter((delivery) => contextOf(delivery).params?.sweepId === sweepId);
      expect(selections, "fresh presentation has no durable selection yet").to.deep.eq([]);
    });
    cy.then(() => {
      expect(selectionPosts, "presentation creates no saved selection").to.eq(0);
      expect(actionPosts, "browser issues no action request").to.eq(0);
      expect(sweepPosts, "browser never starts an extra run").to.eq(EXISTING_SWEEP_ID ? 0 : 1);
      expect(outcomeEngineUiGets, "browser reads the local Outcome Engine").to.be.greaterThan(0);
    });
  });
});

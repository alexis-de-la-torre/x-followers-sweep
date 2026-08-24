/// <reference types="cypress" />

// Read-only compatibility evidence against real persisted Outcome Engine
// history. No response is stubbed and every sweep mutation is fail-closed.
const OUTCOME_ENGINE_URL = Cypress.env("OUTCOME_ENGINE_URL") || "http://127.0.0.1:8090";
const RUNS_URL = `${OUTCOME_ENGINE_URL}/api/v1/outcome-deliveries?outcomeName=sweep-run&limit=500`;
const LEGACY_APPLIED_SWEEP_ID = "9a5c1d17-fbe1-400f-a7c1-98764b41a398";
const LEGACY_EMPTY_SWEEP_ID = "f08c6e42-70fc-4e0c-9383-1f813a6b1644";

function contextOf(delivery) {
  if (typeof delivery?.context === "object") return delivery.context || {};
  try { return JSON.parse(delivery?.context || "{}"); } catch { return {}; }
}

function persistedRun(sourceId) {
  return cy.request(RUNS_URL).then(({ status, body }) => {
    expect(status).to.eq(200);
    const delivery = body.find((candidate) => candidate.sourceId === sourceId);
    expect(delivery, `persisted run ${sourceId}`).to.exist;
    return { delivery, context: contextOf(delivery) };
  });
}

function guardSweepWrites(counter) {
  cy.intercept("POST", "**/api/v1/sweeps**", (request) => {
    counter.count += 1;
    request.destroy();
  });
}

function openRun(sourceId) {
  cy.visit("/");
  cy.get(`[data-sweep-id="${sourceId}"] [aria-label="View run steps"]`, {
    timeout: 15000,
  }).click();
}

describe("SWP-35 persisted Auto-unfollow history", () => {
  it("keeps a previously applied automatic run terminal and read-only", () => {
    const writes = { count: 0 };
    guardSweepWrites(writes);

    persistedRun(LEGACY_APPLIED_SWEEP_ID).then(({ delivery, context }) => {
      expect(delivery.status).to.eq("ALL_TASKS_COMPLETED");
      expect(context.params?.mode).to.eq("auto-unfollow");
      expect(delivery.steps.map((step) => step.taskName)).to.deep.eq([
        "generate-candidates",
        "review-handles",
        "apply-unfollows",
      ]);
      expect(context.reviews).to.have.length(3);
      expect(context.unfollows).to.deep.include({
        handle: "@mythweaver7",
        status: "APPLIED",
        appliedAt: "2026-08-23T03:00:43.243199+00:00",
      });
    });

    openRun(LEGACY_APPLIED_SWEEP_ID);
    cy.get('[data-testid="legacy-auto-unfollow-history"]')
      .should("contain.text", "earlier Auto-unfollow run is read-only")
      .and("contain.text", "saved results are shown by handle");
    cy.get('[data-testid="review-mythweaver7"]')
      .should("contain.text", "@mythweaver7")
      .and("contain.text", "UNFOLLOW")
      .and("contain.text", "Low-value content")
      .and("contain.text", "@mythweaver7 unfollowed");
    cy.get('[data-testid="kept-account-count"]').should("contain.text", "2");
    cy.get('[data-testid="auto-unfollow-recommendations"]').should("not.exist");
    cy.get('[data-testid="review-approved-set"]').should("not.exist");
    cy.get('[data-testid^="recommendation-select-"]').should("not.exist");
    cy.contains("button", /^Unfollow$/).should("not.exist");
    cy.then(() => expect(writes.count, "history view issued no sweep mutation").to.eq(0));
  });

  it("restores a legacy all-KEEP run as an empty read-only result", () => {
    const writes = { count: 0 };
    guardSweepWrites(writes);

    persistedRun(LEGACY_EMPTY_SWEEP_ID).then(({ delivery, context }) => {
      expect(delivery.status).to.eq("ALL_TASKS_COMPLETED");
      expect(context.params?.mode).to.eq("auto-unfollow");
      expect(context.reviews).to.have.length(3);
      expect(context.reviews.every((review) => review.decision === "KEEP")).to.eq(true);
      expect(context.unfollows).to.deep.eq([]);
    });

    openRun(LEGACY_EMPTY_SWEEP_ID);
    cy.get('[data-testid="legacy-auto-unfollow-history"]')
      .should("contain.text", "No accounts were recommended for unfollow.");
    cy.get('[data-testid="kept-account-count"]').should("contain.text", "3");
    cy.get('[data-testid="kept-accounts"] summary').click();
    ["UTB_01", "lightreelai", "mythweaver7"].forEach((handle) => {
      cy.get(`[data-testid="review-${handle}"]`)
        .should("contain.text", `@${handle}`)
        .and("contain.text", "KEEP");
    });
    cy.get('[data-testid="review-approved-set"]').should("not.exist");
    cy.get('[data-testid^="recommendation-select-"]').should("not.exist");
    cy.then(() => expect(writes.count, "empty history view issued no sweep mutation").to.eq(0));
  });
});

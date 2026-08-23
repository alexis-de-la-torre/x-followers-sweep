/// <reference types="cypress" />

// This is an intentionally opt-in destructive staging journey. It never stubs
// a response and will only touch the exact handle supplied by the operator.
const OUTCOME_ENGINE_URL =
  Cypress.env("OUTCOME_ENGINE_URL") || "https://outcome-engine.s26.staging.adlt.dev";
const AUTHORIZED_HANDLE = String(Cypress.env("AUTHORIZED_UNFOLLOW_HANDLE") || "");
const RUN = [true, "true"].includes(Cypress.env("RUN_SWP_30")) && AUTHORIZED_HANDLE.startsWith("@");
const describeAuthorized = RUN ? describe : describe.skip;

function contextOf(delivery) {
  if (typeof delivery?.context === "object") return delivery.context || {};
  try { return JSON.parse(delivery?.context || "{}"); } catch { return {}; }
}

function reviewedSweep() {
  const url = `${OUTCOME_ENGINE_URL}/api/v1/outcome-deliveries?outcomeName=sweep-run`;
  return cy.request(url).then(({ status, body }) => {
    expect(status).to.eq(200);
    const delivery = body.find((candidate) => {
      const review = contextOf(candidate).reviews?.find((item) => item.handle === AUTHORIZED_HANDLE);
      return review?.decision === "UNFOLLOW";
    });
    expect(delivery, `${AUTHORIZED_HANDLE} has a persisted UNFOLLOW review`).to.exist;
    return delivery;
  });
}

function waitForApplied(id, deadline = Date.now() + 120000) {
  const url = `${OUTCOME_ENGINE_URL}/api/v1/outcome-deliveries?outcomeName=sweep-unfollow`;
  return cy.request({ url, failOnStatusCode: false }).then(({ status, body }) => {
    const delivery = Array.isArray(body) ? body.find((candidate) => candidate.sourceId === id) : null;
    const applied = contextOf(delivery).unfollow;
    if (status === 200 && delivery?.status === "COMPLETED" && applied?.status === "APPLIED") {
      return delivery;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for applied unfollow ${id}: ${JSON.stringify(delivery || body)}`);
    }
    return cy.wait(500).then(() => waitForApplied(id, deadline));
  });
}

describeAuthorized("SWP-30 apply one reviewed unfollow", () => {
  it("changes and restores the terminal result for the explicitly authorized handle", () => {
    let sweep;
    let unfollowId;

    reviewedSweep().then((delivery) => { sweep = delivery; });

    cy.intercept("POST", "**/api/v1/sweeps/*/unfollows", (request) => {
      expect(request.body.handle).to.eq(AUTHORIZED_HANDLE);
      unfollowId = request.body.id;
    }).as("applyUnfollow");

    cy.visit("/");
    cy.then(() => {
      cy.get(`[data-sweep-id="${sweep.sourceId}"] [aria-label="View run steps"]`).click();
    });
    cy.get(`[data-testid="apply-${AUTHORIZED_HANDLE.slice(1)}"]`).click();
    cy.get('[role="dialog"]').last().within(() => {
      cy.contains(AUTHORIZED_HANDLE).should("be.visible");
      cy.contains("button", "Unfollow").click();
    });

    cy.wait("@applyUnfollow", { requestTimeout: 10000, responseTimeout: 30000 })
      .its("response.statusCode")
      .should("eq", 202);
    cy.then(() => waitForApplied(unfollowId));

    cy.contains(`${AUTHORIZED_HANDLE} unfollowed`, { timeout: 15000 }).should("be.visible");
    cy.window().then((win) => {
      win.localStorage.clear();
      win.sessionStorage.clear();
    });
    cy.reload();
    cy.get(`[data-sweep-id="${sweep.sourceId}"] [aria-label="View run steps"]`, { timeout: 15000 }).click();
    cy.contains(`${AUTHORIZED_HANDLE} unfollowed`).should("be.visible");
  });
});

/// <reference types="cypress" />

// Read-only evidence for a previously authorized SWP-35 action. This spec
// validates the durable X evidence and restored UI without issuing a second
// selection or relationship mutation.
const OUTCOME_ENGINE_URL = Cypress.env("OUTCOME_ENGINE_URL") || "http://127.0.0.1:8090";
const SWEEPER_AGENT_URL = Cypress.env("SWEEPER_AGENT_URL") || "http://127.0.0.1:8020";
const X_API_ADAPTER_URL = Cypress.env("X_API_ADAPTER_URL")
  || "https://x-api-adapter.s26.staging.adlt.dev";
const SWEEP_ID = Cypress.env("EXISTING_SWEEP_ID")
  || "e2cd4ad8-224e-471a-b868-53027101b6b1";
const ACTION_ID = Cypress.env("EXISTING_ACTION_ID")
  || "51aaed79-b890-593c-acc2-6d885fd29033";
const RUNS_URL = `${OUTCOME_ENGINE_URL}/api/v1/outcome-deliveries?outcomeName=sweep-run&limit=500`;
const SELECTIONS_URL = `${OUTCOME_ENGINE_URL}/api/v1/outcome-deliveries?outcomeName=sweep-selection&limit=500`;
const ACTIONS_URL = `${OUTCOME_ENGINE_URL}/api/v1/outcome-deliveries?outcomeName=sweep-unfollow&limit=500`;
const EXPECTED_TARGETS = [
  { handle: "@silhouette_ex", xUserId: "1851165576707600384" },
  { handle: "@nativemarkets", xUserId: "1963713874965762048" },
];

function contextOf(delivery) {
  if (typeof delivery?.context === "object") return delivery.context || {};
  try { return JSON.parse(delivery?.context || "{}"); } catch { return {}; }
}

function deliveryBySource(url, sourceId, description) {
  return cy.request(url).then(({ status, body }) => {
    expect(status, `${description} list`).to.eq(200);
    const matching = body.filter((delivery) => delivery.sourceId === sourceId);
    expect(matching, `one ${description}`).to.have.length(1);
    return matching[0];
  });
}

function resultsOf(context) {
  return Object.values(context.unfollowResults || {})
    .sort((left, right) => Number(left.sequence) - Number(right.sequence));
}

function relationship(xUserId) {
  return cy.request(`${X_API_ADAPTER_URL}/api/v1/account/following/${xUserId}`)
    .then(({ status, body }) => {
      expect(status, `relationship read for ${xUserId}`).to.eq(200);
      expect(String(body.target?.id), "stable target identity").to.eq(xUserId);
      return body;
    });
}

describe("SWP-35 completed approved-set restoration", () => {
  it("restores the exact sequential X results without issuing another write", () => {
    let actionContext;
    let selectionId;
    let excludedCount;
    let recommendedReviews;
    let outcomeEngineUiGets = 0;
    let agentHealthUiGets = 0;
    let browserWrites = 0;
    let browserDeletes = 0;

    cy.intercept("GET", "**/api/v1/outcome-deliveries*", (request) => {
      expect(new URL(request.url).origin, "browser Outcome Engine origin")
        .to.eq(new URL(OUTCOME_ENGINE_URL).origin);
      outcomeEngineUiGets += 1;
    });
    cy.intercept("GET", "**/health", (request) => {
      expect(new URL(request.url).origin, "browser sweeper-agent origin")
        .to.eq(new URL(SWEEPER_AGENT_URL).origin);
      agentHealthUiGets += 1;
    });
    cy.intercept("POST", "**/api/v1/sweeps**", (request) => {
      browserWrites += 1;
      request.destroy();
    });
    cy.intercept("DELETE", "**", (request) => {
      browserDeletes += 1;
      request.destroy();
    });

    cy.request(`${SWEEPER_AGENT_URL}/health`).then(({ status, body }) => {
      expect(status, "local agent health").to.eq(200);
      expect(body.service).to.eq("ok");
      expect(body.xApi?.account).to.eq("@dlt_alx");
      expect(body.xApi?.writeConfigured).to.eq(true);
    });

    deliveryBySource(ACTIONS_URL, ACTION_ID, "durable approved action")
      .then((delivery) => {
        expect(delivery.status).to.eq("ALL_TASKS_COMPLETED");
        expect(String(delivery.deliveryId)).to.eq("26052");
        expect(delivery.outcomeName).to.eq("sweep-unfollow");
        actionContext = contextOf(delivery);
        selectionId = String(actionContext.params?.selectionId);
        expect(actionContext.params).to.include({
          sweepId: SWEEP_ID,
          sweepDeliveryId: "26036",
          sourceXUserId: "1478416609",
        });
        expect(actionContext.params.targets).to.deep.eq(EXPECTED_TARGETS);
        expect(delivery.steps.map((step) => step.taskName)).to.deep.eq([
          "apply-unfollow-0001",
          "apply-unfollow-0002",
        ]);
        delivery.steps.forEach((step, index) => {
          expect(step.result, `step ${index + 1} result`).to.eq("SUCCESS");
          expect(step.detail).to.eq(null);
          if (index > 0) {
            expect(new Date(step.dispatchedAt).getTime(), "strict task adjacency")
              .to.be.at.least(new Date(delivery.steps[index - 1].completedAt).getTime());
          }
        });

        const results = resultsOf(actionContext);
        expect(Object.keys(actionContext.unfollowResults)).to.deep.eq(
          EXPECTED_TARGETS.map(({ xUserId }) => xUserId),
        );
        expect(results.map(({ xUserId }) => String(xUserId)))
          .to.deep.eq(EXPECTED_TARGETS.map(({ xUserId }) => xUserId));
        results.forEach((result, index) => {
          expect(result).to.include({
            handle: EXPECTED_TARGETS[index].handle,
            xUserId: EXPECTED_TARGETS[index].xUserId,
            status: "APPLIED",
            transport: "X_API",
            sequence: index + 1,
          });
          expect(result.before?.following).to.eq(true);
          expect(String(result.before?.source?.id)).to.eq("1478416609");
          expect(String(result.before?.target?.id)).to.eq(EXPECTED_TARGETS[index].xUserId);
          expect(result.mutation?.following).to.eq(false);
          expect(String(result.mutation?.source?.id)).to.eq("1478416609");
          expect(String(result.mutation?.targetId)).to.eq(EXPECTED_TARGETS[index].xUserId);
          expect(result.after?.following).to.eq(false);
          expect(String(result.after?.source?.id)).to.eq("1478416609");
          expect(String(result.after?.target?.id)).to.eq(EXPECTED_TARGETS[index].xUserId);
          expect(result.after?.connectionStatus).not.to.include("following");
          expect(result.startedAt).to.match(/^\d{4}-\d{2}-\d{2}T/);
          expect(result.appliedAt).to.match(/^\d{4}-\d{2}-\d{2}T/);
          expect(result.completedAt).to.match(/^\d{4}-\d{2}-\d{2}T/);
          expect(new Date(result.appliedAt).getTime()).to.be.at.least(
            new Date(result.startedAt).getTime(),
          );
          expect(new Date(result.completedAt).getTime()).to.be.at.least(
            new Date(result.appliedAt).getTime(),
          );
          expect(new Date(result.startedAt).getTime()).to.be.at.least(
            new Date(delivery.steps[index].dispatchedAt).getTime(),
          );
          expect(new Date(delivery.steps[index].completedAt).getTime()).to.be.at.least(
            new Date(result.completedAt).getTime(),
          );
        });
      });

    cy.request(ACTIONS_URL).then(({ body }) => {
      const matching = body.filter((delivery) => {
        const context = contextOf(delivery);
        return context.params?.sweepId === SWEEP_ID
          && String(context.params?.sweepDeliveryId) === "26036";
      });
      expect(matching, "one action for the reviewed sweep delivery").to.have.length(1);
      expect(matching[0].sourceId).to.eq(ACTION_ID);
    });

    cy.then(() => deliveryBySource(
      SELECTIONS_URL,
      selectionId,
      "action-bound reviewed selection",
    )).then((delivery) => {
      const context = contextOf(delivery);
      expect(delivery.status).to.eq("ALL_TASKS_COMPLETED");
      expect(String(delivery.deliveryId)).to.eq("26051");
      expect(delivery.outcomeName).to.eq("sweep-selection");
      expect(context.selection?.status).to.eq("SAVED");
      expect(context.params?.targets).to.deep.eq(EXPECTED_TARGETS);
      expect(context.selection?.targets).to.deep.eq(EXPECTED_TARGETS);
      expect(String(delivery.deliveryId)).to.eq(String(actionContext.params.selectionDeliveryId));
    });
    cy.then(() => cy.request(SELECTIONS_URL)).then(({ body }) => {
      const saved = body.filter((delivery) => {
        const context = contextOf(delivery);
        return context.params?.sweepId === SWEEP_ID
          && String(context.params?.sweepDeliveryId) === "26036"
          && context.selection?.status === "SAVED";
      }).sort((left, right) => Number(right.deliveryId) - Number(left.deliveryId));
      expect(saved[0]?.sourceId, "action uses the newest saved selection").to.eq(selectionId);
    });

    deliveryBySource(RUNS_URL, SWEEP_ID, "reviewed sweep").then((delivery) => {
      const context = contextOf(delivery);
      const recommended = context.reviews.filter((review) => review.decision === "UNFOLLOW");
      recommendedReviews = recommended;
      expect(delivery.status).to.eq("ALL_TASKS_COMPLETED");
      expect(String(delivery.deliveryId)).to.eq("26036");
      expect(delivery.outcomeName).to.eq("sweep-run");
      EXPECTED_TARGETS.forEach((target) => {
        expect(recommended.map((review) => String(review.xUserId))).to.include(target.xUserId);
      });
      excludedCount = recommended.length - EXPECTED_TARGETS.length;
      expect(excludedCount).to.be.greaterThan(0);
    });

    EXPECTED_TARGETS.forEach(({ xUserId, handle }) => {
      relationship(xUserId).then((state) => {
        expect(state.following, `${handle} remains unfollowed`).to.eq(false);
      });
    });

    cy.visit("/");
    cy.get(`[data-sweep-id="${SWEEP_ID}"] [aria-label="View run steps"]`, {
      timeout: 15000,
    }).click();
    cy.get('[role="dialog"]').should("be.visible");
    cy.get('[data-testid="confirmed-action-id"]').should("contain.text", ACTION_ID);
    cy.then(() => cy.get("[data-recommendation-id]").then(($cards) => {
      expect([...$cards].map((card) => card.getAttribute("data-recommendation-id")))
        .to.deep.eq(recommendedReviews.map((review) => String(review.xUserId)));
    }));
    EXPECTED_TARGETS.forEach(({ xUserId, handle }) => {
      cy.get(`[data-testid="recommendation-${xUserId}"]`)
        .scrollIntoView({ offset: { top: -120, left: 0 } })
        .should("be.visible")
        .and("contain.text", handle)
        .and("contain.text", xUserId);
      cy.get(`[data-testid="recommendation-select-${xUserId}"]`)
        .should("be.checked")
        .and("be.disabled");
      cy.get(`[data-testid="approved-unfollow-result-${xUserId}"]`)
        .should("be.visible")
        .and("contain.text", `${handle} unfollowed through X`);
    });
    cy.then(() => {
      const approvedIds = new Set(EXPECTED_TARGETS.map(({ xUserId }) => xUserId));
      recommendedReviews
        .filter((review) => !approvedIds.has(String(review.xUserId)))
        .forEach((review) => {
          const id = String(review.xUserId);
          cy.get(`[data-testid="recommendation-${id}"]`)
            .should("contain.text", "EXCLUDED");
          cy.get(`[data-testid="recommendation-select-${id}"]`)
            .should("not.be.checked")
            .and("be.disabled");
          cy.get(`[data-testid="approved-unfollow-result-${id}"]`).should("not.exist");
        });
    });
    cy.then(() => cy.get('[data-testid="action-result-summary"]')
      .should("contain.text", "2/2 complete")
      .and("contain.text", "2 applied")
      .and("contain.text", "0 already unfollowed")
      .and("contain.text", "0 failed")
      .and("contain.text", `${excludedCount} excluded`));
    cy.get('[data-testid="review-approved-set"]').should("not.exist");
    cy.get('[data-testid="confirm-approved-set"]').should("not.exist");
    cy.get('[data-testid="select-all-recommendations"]').should("not.exist");
    cy.get('[data-testid="saved-selection-id"]').should("not.exist");
    cy.get(`[data-testid="recommendation-${EXPECTED_TARGETS[0].xUserId}"]`)
      .scrollIntoView({ offset: { top: -120, left: 0 } });
    cy.screenshot("06-sequential-x-results", { capture: "viewport" });

    cy.window().then((win) => {
      win.localStorage.clear();
      win.sessionStorage.clear();
    });
    cy.reload();
    cy.get(`[data-sweep-id="${SWEEP_ID}"] [aria-label="View run steps"]`, {
      timeout: 15000,
    }).click();
    cy.get('[role="dialog"]').should("be.visible");
    cy.get('[data-testid="confirmed-action-id"]').should("contain.text", ACTION_ID);
    cy.get(`[data-testid="recommendation-${EXPECTED_TARGETS[0].xUserId}"]`)
      .scrollIntoView({ offset: { top: -120, left: 0 } });
    cy.get('[role="dialog"]')
      .should("be.visible")
      .screenshot("07-results-restored-after-cleared-state", { overwrite: true });
    EXPECTED_TARGETS.forEach(({ xUserId, handle }) => {
      cy.get(`[data-testid="approved-unfollow-result-${xUserId}"]`)
        .should("contain.text", `${handle} unfollowed through X`);
      cy.get(`[data-testid="recommendation-select-${xUserId}"]`)
        .should("be.checked")
        .and("be.disabled");
    });
    cy.then(() => cy.get('[data-testid="action-result-summary"]')
      .should("contain.text", "2/2 complete")
      .and("contain.text", `${excludedCount} excluded`));

    cy.wait(1500).then(() => {
      expect(browserWrites, "restoration issued no selection or action write").to.eq(0);
      expect(browserDeletes, "restoration issued no relationship DELETE").to.eq(0);
      expect(outcomeEngineUiGets, "browser read the local Outcome Engine").to.be.greaterThan(0);
      expect(agentHealthUiGets, "browser read the local agent health").to.be.greaterThan(0);
    });
    cy.request(ACTIONS_URL).then(({ body }) => {
      const matching = body.filter((delivery) => delivery.sourceId === ACTION_ID);
      expect(matching, "restoration did not create a second action").to.have.length(1);
    });
    cy.then(() => cy.task("log", JSON.stringify({
      sweepId: SWEEP_ID,
      actionId: ACTION_ID,
      selectionId,
      targets: EXPECTED_TARGETS,
      excludedCount,
      writesDuringRestore: browserWrites,
    })));
  });
});

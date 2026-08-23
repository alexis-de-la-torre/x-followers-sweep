/// <reference types="cypress" />

// SWP-6 runs against the real local web + agent + Pub/Sub emulator + Outcome
// Engine stack. Intercepts below are passive spies and never stub a response.
const OUTCOME_ENGINE_URL = Cypress.env("OUTCOME_ENGINE_URL") || "http://127.0.0.1:8090";
const SWEEPER_AGENT_URL = Cypress.env("SWEEPER_AGENT_URL") || "http://127.0.0.1:8020";
const RUN = [true, "true"].includes(Cypress.env("RUN_SWP_6"));
const describeLocal = RUN ? describe : describe.skip;

function contextOf(delivery) {
  if (typeof delivery?.context === "object") return delivery.context || {};
  try { return JSON.parse(delivery?.context || "{}"); } catch { return {}; }
}

function waitForSweep(id, predicate, description, deadline) {
  // The list representation carries the persisted context patches; the
  // by-source representation intentionally does not expose that field.
  const url = `${OUTCOME_ENGINE_URL}/api/v1/outcome-deliveries?outcomeName=sweep-run`;
  return cy.request({ url, failOnStatusCode: false }).then((response) => {
    const delivery = Array.isArray(response.body)
      ? response.body.find((candidate) => candidate.sourceId === id)
      : null;
    if (response.status === 200 && delivery && predicate(delivery)) return delivery;
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for ${description} on sweep ${id}; ` +
        `last response ${response.status}: ${JSON.stringify(delivery || response.body)}`,
      );
    }
    return cy.wait(500).then(() => waitForSweep(id, predicate, description, deadline));
  });
}

describeLocal("SWP-6 complete bounded dry run", () => {
  it("generates, reviews, presents, and reloads exactly three candidates", () => {
    let sweepId;
    let candidates;
    let reviews;

    cy.intercept("POST", `${SWEEPER_AGENT_URL}/api/v1/sweeps`, (request) => {
      expect(request.body.mode, "safe sweep mode").to.eq("dry-run");
      expect(request.body.count, "bounded demo candidate count").to.eq(3);
    }).as("startSweep");
    cy.intercept("GET", `${OUTCOME_ENGINE_URL}/api/v1/outcome-deliveries*`).as("deliveries");

    cy.visit("/");
    cy.contains("Sweep Runs").should("be.visible");
    cy.wait("@deliveries", { requestTimeout: 10000, responseTimeout: 30000 })
      .its("response.statusCode")
      .should("eq", 200);
    cy.contains("Agent online", { timeout: 30000 }).should("be.visible");
    cy.get('[data-testid="new-sweep"]').should("be.enabled");
    cy.screenshot("01-sweep-ready", { capture: "viewport" });

    cy.get('[data-testid="new-sweep"]').click();
    cy.wait("@startSweep", { requestTimeout: 10000, responseTimeout: 30000 })
      .then(({ request, response }) => {
        expect(response?.statusCode, "sweep accepted").to.eq(202);
        sweepId = request.body.id;
        return waitForSweep(
          sweepId,
          (delivery) => delivery.outcomeName === "sweep-run",
          "durable acceptance",
          Date.now() + 5000,
        );
      });

    cy.then(() => {
      cy.get(`[data-sweep-id="${sweepId}"]`, { timeout: 10000 }).should("be.visible");
      cy.screenshot("02-sweep-accepted", { capture: "viewport" });
      return waitForSweep(
        sweepId,
        (delivery) => {
          const context = contextOf(delivery);
          return Array.isArray(context.candidates) && context.candidates.length === 3;
        },
        "three persisted candidates",
        Date.now() + 180000,
      );
    }).then((delivery) => {
      candidates = contextOf(delivery).candidates;
      expect(new Set(candidates.map((handle) => handle.toLowerCase())).size, "unique candidates").to.eq(3);
      expect(delivery.steps.filter((step) => step.taskName === "generate-candidates"), "one generation step")
        .to.have.length(1);
      expect(delivery.steps.find((step) => step.taskName === "generate-candidates")?.result)
        .to.eq("SUCCESS");
      expect(delivery.status, "generation success alone is non-terminal").to.eq("RUNNING");
      expect(delivery.steps.find((step) => step.taskName === "review-handles")?.result ?? null,
        "review still pending").to.eq(null);
    });

    cy.then(() => {
      cy.get(`[data-sweep-id="${sweepId}"] [aria-label="View run steps"]`, { timeout: 10000 }).click();
      cy.get('[role="dialog"]').within(() => {
        cy.contains("3 candidates", { timeout: 10000 }).should("be.visible");
      });
      cy.screenshot("03-candidates-persisted", { capture: "viewport" });

      return waitForSweep(
        sweepId,
        (delivery) => {
          const context = contextOf(delivery);
          const steps = delivery.steps || [];
          return Array.isArray(context.reviews) && context.reviews.length === 3 &&
            steps.length === 2 && steps.every((step) => step.result === "SUCCESS");
        },
        "terminal review results",
        Date.now() + 300000,
      );
    }).then((delivery) => {
      const context = contextOf(delivery);
      reviews = context.reviews;
      expect(delivery.steps.filter((step) => step.taskName === "review-handles"), "one review step")
        .to.have.length(1);
      expect(reviews.map((review) => review.handle), "review consumes generated candidates once")
        .to.deep.eq(candidates);
      reviews.forEach((review) => {
        expect(review.decision).to.be.oneOf(["KEEP", "UNFOLLOW"]);
        expect(review.reason).to.be.a("string").and.not.be.empty;
      });
    });

    cy.get('[role="dialog"]', { timeout: 15000 }).within(() => {
      cy.contains("3 reviewed").should("be.visible");
      reviews.forEach((review) => {
        cy.contains(review.handle).should("be.visible");
        cy.contains(review.reason).should("be.visible");
        cy.contains(review.decision).should("be.visible");
      });
    });
    cy.screenshot("04-sweep-complete", { capture: "viewport" });

    cy.get("body").type("{esc}");
    cy.window().then((win) => {
      win.localStorage.clear();
      win.sessionStorage.clear();
    });
    cy.reload();
    cy.then(() => {
      cy.get(`[data-sweep-id="${sweepId}"] [aria-label="View run steps"]`, { timeout: 15000 }).click();
      cy.get('[role="dialog"]').within(() => {
        cy.contains("3 candidates").should("be.visible");
        cy.contains("3 reviewed").should("be.visible");
        reviews.forEach((review) => cy.contains(review.handle).should("be.visible"));
      });
    });
    cy.screenshot("05-sweep-restored-after-reload", { capture: "viewport" });
  });
});

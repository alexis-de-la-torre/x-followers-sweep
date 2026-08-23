/// <reference types="cypress" />

// SWP-31 runs only against the real staging web, Outcome Engine, sweeper-agent,
// and X API. Intercepts below are passive observers and never stub a response.
const OUTCOME_ENGINE_URL =
  Cypress.env("OUTCOME_ENGINE_URL") || "https://outcome-engine.s26.staging.adlt.dev";
const SWEEPER_AGENT_URL =
  Cypress.env("SWEEPER_AGENT_URL") || "https://sweeper-agent.s26.staging.adlt.dev";
const RUN = [true, "true"].includes(Cypress.env("RUN_SWP_31"));
const describeStaging = RUN ? describe : describe.skip;
const RUNS_URL = `${OUTCOME_ENGINE_URL}/api/v1/outcome-deliveries?outcomeName=sweep-run`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function contextOf(delivery) {
  if (typeof delivery?.context === "object") return delivery.context || {};
  try { return JSON.parse(delivery?.context || "{}"); } catch { return {}; }
}

function waitForSweep(id, predicate, description, deadline) {
  return cy.request({ url: RUNS_URL, failOnStatusCode: false }).then((response) => {
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

describeStaging("SWP-31 X API three-account review", () => {
  it("persists and reloads three real reviews while the browser worker is unavailable", () => {
    let sweepId;
    let deliveryId;
    let candidates;
    let reviews;
    let xApiEvidence;

    cy.request(`${SWEEPER_AGENT_URL}/health`).then(({ status, body }) => {
      expect(status, "agent health status").to.eq(200);
      expect(body.service, "agent is serving requests").to.eq("ok");
      expect(body.xApi?.configured, "official X API path selected").to.eq(true);
      expect(body.xApi?.account, "authorized source account").to.eq("@dlt_alx");
      expect(body.xApi?.error, "X authorization startup error").to.eq(null);
      expect(body, "health does not report the Chrome read path").not.to.have.property("chrome");
    });

    cy.intercept("POST", `${SWEEPER_AGENT_URL}/api/v1/sweeps`, (request) => {
      expect(request.body.id, "caller-owned sweep identity").to.match(UUID);
      expect(request.body.mode, "review-only mode").to.eq("dry-run");
      expect(request.body.count, "bounded recommendation MVP").to.eq(3);
    }).as("startSweep");

    cy.visit("/", {
      onBeforeLoad(win) {
        win.localStorage.setItem(
          "x-sweeper.settings",
          JSON.stringify({ autoUnfollow: false, sweepCount: 3 }),
        );
      },
    });
    cy.get('[data-testid="runs-heading"]').should("have.text", "Runs");
    cy.get('[data-testid="new-sweep"]').first().should("be.enabled").click();

    cy.wait("@startSweep", { requestTimeout: 10000, responseTimeout: 120000 })
      .then(({ request, response }) => {
        expect(response?.statusCode, "sweep accepted").to.eq(202);
        sweepId = request.body.id;
        return waitForSweep(
          sweepId,
          (delivery) => delivery.outcomeName === "sweep-run" && delivery.status === "RUNNING",
          "durable in-progress sweep",
          Date.now() + 10000,
        );
      })
      .then((delivery) => {
        deliveryId = delivery.deliveryId;
        expect(deliveryId, "Outcome Engine delivery identity").to.exist;
      });

    // Reconstruct the active row from Outcome Engine while work is still in flight.
    cy.reload();
    cy.then(() => {
      cy.get(`[data-sweep-id="${sweepId}"]`, { timeout: 15000 }).should("be.visible");
      return waitForSweep(
        sweepId,
        (delivery) => {
          const context = contextOf(delivery);
          return Array.isArray(context.candidates) && context.candidates.length === 3 &&
            Array.isArray(context.candidateEvidence) && context.candidateEvidence.length === 3;
        },
        "three API candidates and their evidence",
        Date.now() + 120000,
      );
    }).then((delivery) => {
      const context = contextOf(delivery);
      candidates = context.candidates;
      xApiEvidence = context.xApi;
      expect(new Set(candidates.map((handle) => handle.toLowerCase())).size, "unique handles").to.eq(3);
      expect(context.candidateEvidence.map((item) => item.handle), "evidence order")
        .to.deep.eq(candidates);
      context.candidateEvidence.forEach((item) => {
        expect(item.xUserId, `${item.handle} stable X identity`).to.match(/^\d+$/);
        expect(item.publicMetrics, `${item.handle} public metrics`).to.be.an("object");
        expect(item, `${item.handle} latest-post field`).to.have.property("latestPost");
      });
      expect(xApiEvidence?.source?.username, "source identity").to.eq("dlt_alx");
      expect(xApiEvidence?.returnedResources, "paid returned resources").to.eq(3);
      expect(xApiEvidence?.upstreamRequests, "bounded upstream requests").to.be.a("number").and.be.greaterThan(0);
    });

    cy.then(() => waitForSweep(
      sweepId,
      (delivery) => {
        const context = contextOf(delivery);
        return delivery.status === "ALL_TASKS_COMPLETED" &&
          Array.isArray(context.reviews) && context.reviews.length === 3 &&
          (delivery.steps || []).length === 2 &&
          delivery.steps.every((step) => step.result === "SUCCESS");
      },
      "three terminal review decisions",
      Date.now() + 300000,
    )).then((delivery) => {
      reviews = contextOf(delivery).reviews;
      expect(reviews.map((review) => review.handle), "reviewed candidates once")
        .to.deep.eq(candidates);
      reviews.forEach((review) => {
        expect(review.xUserId, `${review.handle} durable action identity`).to.match(/^\d+$/);
        expect(review.decision).to.be.oneOf(["KEEP", "UNFOLLOW"]);
        expect(review.reason).to.be.a("string").and.not.be.empty;
      });
    });

    cy.then(() => {
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
      cy.screenshot("swp-31-three-x-api-reviews", { capture: "viewport" });
    });

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
        reviews.forEach((review) => {
          cy.contains(review.handle).should("be.visible");
          cy.contains(review.reason).should("be.visible");
        });
      });
    });
    cy.screenshot("swp-31-restored-after-reload", { capture: "viewport" });

    cy.then(() => cy.task("log", JSON.stringify({
      sweepId,
      deliveryId,
      candidates,
      returnedResources: xApiEvidence.returnedResources,
      upstreamRequests: xApiEvidence.upstreamRequests,
    })));
  });
});

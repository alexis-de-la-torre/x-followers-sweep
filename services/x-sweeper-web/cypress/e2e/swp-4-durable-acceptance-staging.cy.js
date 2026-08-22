/// <reference types="cypress" />

// SWP-4 against the deployed staging stack. Intercepts in this spec are
// passive spies: they never reply, alter, delay, or otherwise stub a request.
const OUTCOME_ENGINE_URL =
  Cypress.env("OUTCOME_ENGINE_URL") || "https://outcome-engine.s26.staging.adlt.dev";
const SWEEPER_AGENT_URL =
  Cypress.env("SWEEPER_AGENT_URL") || "https://sweeper-agent.s26.staging.adlt.dev";
const RUN = [true, "true"].includes(Cypress.env("RUN_SWP_4_STAGING"));
const describeStaging = RUN ? describe : describe.skip;

const LIST_URL = `${OUTCOME_ENGINE_URL}/api/v1/outcome-deliveries?outcomeName=sweep-run`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function listRuns() {
  return cy.request(LIST_URL).then((response) => {
    expect(response.status, "sweep-run list status").to.eq(200);
    expect(response.body, "sweep-run list body").to.be.an("array");
    return response.body;
  });
}

function waitForAcceptedSweep(id, deadline = Date.now() + 5000) {
  const url = `${OUTCOME_ENGINE_URL}/api/v1/outcome-deliveries/by-source/x-sweep-run/${id}`;

  return cy.request({ url, failOnStatusCode: false }).then((response) => {
    if (response.status === 200 && response.body?.sourceId === id) {
      return response.body;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Outcome Engine did not expose accepted sweep ${id} within 5 seconds; ` +
        `last response was ${response.status}: ${JSON.stringify(response.body)}`,
      );
    }
    return cy.wait(250).then(() => waitForAcceptedSweep(id, deadline));
  });
}

describeStaging("SWP-4 durable sweep acceptance on staging", () => {
  it("keeps one accepted sweep visible after a full browser reload", () => {
    let baselineCount;
    let id;

    listRuns().then((runs) => {
      baselineCount = runs.length;
    });

    // Observation only. The deployed web, agent, and Outcome Engine remain
    // the respondents for every request in this journey.
    cy.intercept("GET", `${OUTCOME_ENGINE_URL}/api/v1/outcome-deliveries*`).as("deliveries");
    cy.intercept("POST", `${SWEEPER_AGENT_URL}/**`, (request) => {
      expect(new URL(request.url).pathname, "sweep acceptance endpoint").to.eq("/api/v1/sweeps");
      expect(request.body?.mode, "run mode").to.eq("dry-run");
      expect(request.body?.id, "caller-generated sweep id").to.match(UUID);
    }).as("acceptedSweep");

    cy.visit("/");
    cy.wait("@deliveries", { timeout: 30000 }).then(({ response }) => {
      expect(response?.statusCode, "initial delivery list response").to.eq(200);
    });

    cy.contains("button", "New Run").should("be.enabled").click();
    cy.wait("@acceptedSweep", { requestTimeout: 10000, responseTimeout: 120000 })
      .then(({ request, response }) => {
        expect(response?.statusCode, "sweep-acceptance response").to.eq(202);
        id = request.body.id;
        return waitForAcceptedSweep(id);
      })
      .then((delivery) => {
        expect(delivery.sourceId).to.eq(id);
        expect(delivery.status, "accepted delivery is non-terminal").to.eq("RUNNING");
        return listRuns();
      })
      .then((runs) => {
        expect(runs.length, "one click adds one durable delivery").to.eq(baselineCount + 1);
        expect(runs.filter((run) => run.sourceId === id), "one delivery for the sweep id").to.have.length(1);
      });

    cy.then(() => {
      expect(id, "accepted sweep id available to the UI assertion").to.match(UUID);
      cy.contains(id, { timeout: 10000 }).should("be.visible");
    });

    // Remove every browser-owned state candidate before reconstructing the
    // page. The row must return from Outcome Engine, not from this client.
    cy.window().then((win) => {
      win.localStorage.clear();
      win.sessionStorage.clear();
    });
    cy.reload();
    cy.wait("@deliveries", { timeout: 30000 }).then(({ response }) => {
      expect(response?.statusCode, "post-reload delivery list response").to.eq(200);
    });
    cy.then(() => {
      cy.contains(id, { timeout: 10000 }).should("be.visible");
    });
    cy.get('[aria-label="View run steps"]').should("have.length.at.least", 1);

    cy.screenshot("swp-4-durable-acceptance-staging", { capture: "viewport" });
  });
});

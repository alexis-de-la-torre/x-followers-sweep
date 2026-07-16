// Cypress e2e tests for X Sweeper web frontend.
// Run against staging: npm run test:e2e
// or locally: npx cypress open

describe("X Sweeper Web", () => {
  beforeEach(() => {
    cy.visit("/");
  });

  it("loads the runs page", () => {
    cy.contains("Sweep Runs").should("be.visible");
    cy.get("nav, footer, [role=navigation]").should("exist");
  });

  it("shows the agent status bar", () => {
    cy.contains(/Agent online|Agent unreachable|Checking agent/).should("be.visible");
  });

  it("has a working Status tab", () => {
    cy.get('[aria-label="Status"]').should("exist");
    cy.visit("/status");
    cy.url().should("include", "/status");
    cy.contains("Agent Status").should("be.visible");
  });

  it("shows the New Run button", () => {
    cy.contains("New Run").should("be.visible");
  });

  it("shows runs list when deliveries exist", () => {
    cy.get("body").then(($body) => {
      if ($body.find('[aria-label="View run steps"]').length > 0) {
        cy.get('[aria-label="View run steps"]').should("be.visible");
      } else {
        cy.contains("Sweep Runs").should("be.visible");
      }
    });
  });

  it("opens the steps modal on click", () => {
    cy.get("body").then(($body) => {
      const hasRuns = $body.find('[aria-label="View run steps"]').length > 0;
      if (hasRuns) {
        cy.get('[aria-label="View run steps"]').first().click();
        cy.get('[role="dialog"]').should("be.visible");
        cy.contains("Generate Candidates").should("be.visible");
      }
    });
  });
});

describe("Agent Status Page", () => {
  it("shows service status cards", () => {
    cy.visit("/status");
    cy.contains("Sweeper Agent").should("be.visible");
    cy.contains("Chrome CDP").should("be.visible");
    cy.contains("Model").should("be.visible");
    cy.contains("OpenRouter").should("be.visible");
  });

  it("shows OK/DOWN badge", () => {
    cy.visit("/status");
    cy.contains("OK").should("be.visible");
  });

  it("auto-refreshes status", () => {
    cy.visit("/status");
    cy.wait(12000);
    cy.contains("OK").should("be.visible");
  });
});

describe("API Health", () => {
  it("returns 200 from /api/health", () => {
    cy.request("/api/health").then((resp) => {
      expect(resp.status).to.eq(200);
      expect(resp.body).to.have.property("status", "ok");
    });
  });
});
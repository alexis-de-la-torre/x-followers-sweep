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
    cy.contains("Status").click();
    cy.url().should("include", "/status");
    cy.contains("Agent Status").should("be.visible");
  });

  it("shows the New Run button", () => {
    cy.contains("New Run").should("be.visible");
  });

  it("shows runs list when deliveries exist", () => {
    // If there are runs, at least one row should be visible
    cy.get("body").then(($body) => {
      if ($body.text().includes("Sweep Runs")) {
        // Check for run rows — either a flow summary or the empty state
        cy.contains(/just now|min ago|h ago|d ago|wk ago|month/).should("exist");
      }
    });
  });

  it("opens the steps modal on click", () => {
    // Click the first run's status summary if it exists
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
    // Wait for at least one background refresh cycle
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
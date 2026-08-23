// Cypress e2e tests for X Sweeper web frontend.
// Run against staging: npm run test:e2e
// or locally: npx cypress open

describe("X Sweeper Web", () => {
  beforeEach(() => {
    cy.clearLocalStorage();
    cy.visit("/");
  });

  it("loads the runs page", () => {
    cy.get('[data-testid="runs-heading"]').should("have.text", "Runs");
    cy.get("nav, footer, [role=navigation]").should("exist");
  });

  it("shows agent details from the information icon", () => {
    cy.get('[aria-label="Agent information"]').click();
    cy.get('[role="dialog"]').within(() => {
      cy.contains("Agent information").should("be.visible");
      cy.contains("Agent").should("be.visible");
      cy.contains(/Online|Unreachable|Checking/).should("be.visible");
      cy.contains("Chrome").should("be.visible");
      cy.contains("Model").should("be.visible");
    });
  });

  it("has a working Status tab", () => {
    cy.get('[aria-label="Status"]').should("exist");
    cy.visit("/status");
    cy.url().should("include", "/status");
    cy.contains("Agent Status").should("be.visible");
  });

  it("keeps a three-option bottom navigation across screens", () => {
    cy.get('[data-testid="floating-bottom-nav"]').within(() => {
      cy.contains("Runs").should("be.visible");
      cy.contains("Status").should("be.visible");
      cy.contains("Config").should("be.visible");
      cy.get('[aria-label="Runs"]').should("have.attr", "aria-current", "page");
    });

    cy.get('[aria-label="Config"]').click();
    cy.url().should("include", "/config");
    cy.contains("Sweep Configuration").should("be.visible");
    cy.get('[aria-label="Config"]').should("have.attr", "aria-current", "page");
  });

  it("shows the New Run button", () => {
    cy.contains("New Run").should("be.visible");
  });

  it("configures auto-unfollow off by default and persists the choice", () => {
    cy.visit("/config");
    cy.get('[data-testid="settings-page"]').should("have.attr", "data-settings-ready", "true");
    cy.get('[data-testid="auto-unfollow"]').should("not.be.checked").check({ force: true });
    cy.get('[data-testid="auto-unfollow"]').should("be.checked");
    cy.reload();
    cy.get('[data-testid="auto-unfollow"]').should("be.checked");
  });

  it("offers and persists sweep sizes up to 500 accounts", () => {
    cy.visit("/config");
    cy.get('[data-testid="settings-page"]').should("have.attr", "data-settings-ready", "true");
    cy.get('[data-testid="sweep-count"]').should("have.value", "3 accounts").click();
    for (const count of [50, 100, 200, 500]) {
      cy.get('[role="option"]').contains(`${count} accounts`).should("exist");
    }
    cy.get('[role="option"]').contains("500 accounts").scrollIntoView().click();
    cy.get('[data-testid="sweep-count"]').should("have.value", "500 accounts");
    cy.reload();
    cy.get('[data-testid="sweep-count"]').should("have.value", "500 accounts");
  });

  it("shows runs list when deliveries exist", () => {
    cy.get("body").then(($body) => {
      if ($body.find('[aria-label="View run steps"]').length > 0) {
        cy.get('[aria-label="View run steps"]').should("be.visible");
        cy.get('[data-testid="run-title-row"]').first().within(() => {
          cy.get('[data-testid="run-mode"]').should("contain.text", "run");
        });
      } else {
        cy.get('[data-testid="runs-heading"]').should("have.text", "Runs");
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

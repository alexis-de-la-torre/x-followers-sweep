/// <reference types="cypress" />

// Real-stack SWP-35 journey. The web and sweeper-agent run locally; Outcome
// Engine, Pub/Sub, the native adapter, the model, and X remain real. Intended
// requests are observed without response fixtures. Review-only mode also has a
// fail-closed guard that destroys any unintended action POST before it reaches
// the agent. Execution additionally requires exact stable-ID opt-in.
const OUTCOME_ENGINE_URL = Cypress.env("OUTCOME_ENGINE_URL") || "http://127.0.0.1:8090";
const SWEEPER_AGENT_URL = Cypress.env("SWEEPER_AGENT_URL") || "http://127.0.0.1:8020";
const X_API_ADAPTER_URL = Cypress.env("X_API_ADAPTER_URL") || "https://x-api-adapter.s26.staging.adlt.dev";
const SWEEP_COUNT = Number(Cypress.env("SWEEP_COUNT") || 3);
const REVIEW_ONLY = [true, "true"].includes(Cypress.env("RUN_SWP_35_REVIEW_ONLY"));
const EXECUTE = [true, "true"].includes(Cypress.env("RUN_SWP_35"));
const RUN = REVIEW_ONLY || EXECUTE;
const EXISTING_SWEEP_ID = String(Cypress.env("EXISTING_SWEEP_ID") || "");
const describeAuthorized = RUN ? describe : describe.skip;

// Prefix large X IDs with `id:` on the command line. This prevents Cypress from
// parsing a 19-digit identifier as an unsafe JavaScript number before the spec
// can retain it as a string.
const AUTHORIZED_X_USER_IDS = String(Cypress.env("AUTHORIZED_APPROVED_X_USER_IDS") || "")
  // Cypress normalizes a pipe-delimited CLI value to commas in its resolved
  // environment, so accept both forms while retaining every ID as a string.
  .split(/[|,]/)
  .map((value) => value.trim().replace(/^id:/, ""))
  .filter(Boolean);

const RUNS_URL = `${OUTCOME_ENGINE_URL}/api/v1/outcome-deliveries?outcomeName=sweep-run`;
const SELECTIONS_URL = `${OUTCOME_ENGINE_URL}/api/v1/outcome-deliveries?outcomeName=sweep-selection`;
const ACTIONS_URL = `${OUTCOME_ENGINE_URL}/api/v1/outcome-deliveries?outcomeName=sweep-unfollow`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function contextOf(delivery) {
  if (typeof delivery?.context === "object") return delivery.context || {};
  try { return JSON.parse(delivery?.context || "{}"); } catch { return {}; }
}

function waitForDelivery(url, sourceId, predicate, description, deadline = Date.now() + 900000) {
  return cy.request({ url, failOnStatusCode: false }).then((response) => {
    const delivery = Array.isArray(response.body)
      ? response.body.find((candidate) => candidate.sourceId === sourceId)
      : null;
    if (response.status === 200 && delivery && predicate(delivery)) return delivery;
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for ${description} ${sourceId}; ` +
        `last response ${response.status}: ${JSON.stringify(delivery || response.body)}`,
      );
    }
    return cy.wait(500).then(() =>
      waitForDelivery(url, sourceId, predicate, description, deadline));
  });
}

function reviewIsComplete(delivery) {
  const context = contextOf(delivery);
  const reviews = Array.isArray(context.reviews) ? context.reviews : [];
  return delivery.status === "ALL_TASKS_COMPLETED" && reviews.length === SWEEP_COUNT;
}

function actionIsComplete(delivery) {
  const context = contextOf(delivery);
  const targets = Array.isArray(context.params?.targets) ? context.params.targets : [];
  const results = unfollowResultsOf(context);
  return delivery.status === "ALL_TASKS_COMPLETED" && targets.length > 0 && results.length === targets.length;
}

function unfollowResultsOf(context) {
  if (context.unfollowResults && typeof context.unfollowResults === "object") {
    const results = Object.values(context.unfollowResults)
      .filter((result) => result?.handle && result?.xUserId)
      .sort((left, right) => Number(left.sequence || 0) - Number(right.sequence || 0));
    if (results.length) return results;
  }
  return Array.isArray(context.unfollows) ? context.unfollows : [];
}

function selectionIsComplete(delivery) {
  const context = contextOf(delivery);
  const targets = Array.isArray(context.params?.targets) ? context.params.targets : [];
  return delivery.status === "ALL_TASKS_COMPLETED"
    && context.selection?.status === "SAVED"
    && targets.length > 0;
}

function relationship(xUserId) {
  return cy.request(`${X_API_ADAPTER_URL}/api/v1/account/following/${xUserId}`)
    .then(({ status, body }) => {
      expect(status, `relationship read for ${xUserId}`).to.eq(200);
      expect(String(body.target?.id), "stable target identity").to.eq(xUserId);
      return body;
    });
}

describeAuthorized("SWP-35 reviewed Auto-unfollow", () => {
  it(`${EXECUTE ? "reviews, selects, confirms once, applies sequentially through X, and restores every result" : "reviews, selects, and previews one exact confirmation without changing X"}`, () => {
    expect(REVIEW_ONLY && EXECUTE, "review-only and execution flags are mutually exclusive")
      .to.eq(false);
    if (EXECUTE) {
      expect(AUTHORIZED_X_USER_IDS, "operator-authorized stable X IDs")
        .to.have.length.greaterThan(1);
      AUTHORIZED_X_USER_IDS.forEach((id) => expect(id).to.match(/^\d{1,19}$/));
    }
    expect(SWEEP_COUNT, "bounded reviewed account count").to.be.within(3, 500);

    let sweepId = EXISTING_SWEEP_ID || undefined;
    let sweepDeliveryId;
    let selectionId;
    let selectionDeliveryId;
    let actionId;
    let actionDeliveryId;
    let reviewedSourceId;
    let durableReviews;
    let recommended;
    let approved;
    let excluded;
    let actionDelivery;
    let actionResults;
    let actionPosts = 0;
    let selectionPosts = 0;
    let outcomeEngineUiGets = 0;
    let reviewedSourceUsername;

    cy.intercept("GET", "**/api/v1/outcome-deliveries*", (request) => {
      expect(new URL(request.url).origin, "browser Outcome Engine origin")
        .to.eq(new URL(OUTCOME_ENGINE_URL).origin);
      outcomeEngineUiGets += 1;
    });

    if (REVIEW_ONLY) {
      // This is a fail-closed safety circuit, not a response fixture: every
      // intended request still reaches the real stack, while an accidental X
      // action request is destroyed before it can reach the local agent.
      cy.intercept("POST", "**/api/v1/sweeps/*/unfollows", (request) => {
        expect(new URL(request.url).origin, "action sweeper-agent origin")
          .to.eq(new URL(SWEEPER_AGENT_URL).origin);
        actionPosts += 1;
        request.destroy();
      }).as("forbiddenReviewOnlyAction");
    }

    cy.request(`${SWEEPER_AGENT_URL}/health`).then(({ status, body }) => {
      expect(status, "local agent health").to.eq(200);
      expect(body.service).to.eq("ok");
      expect(body.xApi?.configured, "official X boundary selected").to.eq(true);
      expect(body.xApi?.writeConfigured, "official X writes selected").to.eq(true);
      expect(body.xApi?.account, "connected source account").to.match(/^@/);
      expect(body.xApi?.error).to.eq(null);
    });

    // 1. Keep Auto-unfollow as a visible, clearly described capability.
    cy.visit("/config");
    cy.get('[data-testid="settings-page"][data-settings-ready="true"]');
    cy.get('[data-testid="auto-unfollow"]').then(($switch) => {
      if (!$switch.is(":checked")) {
        cy.wrap($switch).check({ force: true });
      }
    });
    cy.get('[data-testid="sweep-count"]').click();
    cy.get('[role="option"]').contains(`${SWEEP_COUNT} accounts`).click();
    cy.get('[data-testid="auto-unfollow-description"]')
      .should("contain.text", "Review")
      .and("contain.text", "deselect")
      .and("contain.text", "confirm")
      .and("contain.text", "X API");
    cy.screenshot("01-auto-unfollow-configured", { capture: "viewport" });

    if (!EXISTING_SWEEP_ID) {
      cy.intercept("POST", "**/api/v1/sweeps", (request) => {
        expect(new URL(request.url).origin, "browser sweeper-agent origin")
          .to.eq(new URL(SWEEPER_AGENT_URL).origin);
        expect(request.body.mode, "reviewed Auto-unfollow wire mode")
          .to.eq("reviewed-auto-unfollow");
        expect(request.body.count).to.eq(SWEEP_COUNT);
        sweepId = request.body.id;
      }).as("startAutoSweep");
    }

    cy.get('[aria-label="Runs"]').click({ force: true });
    if (!EXISTING_SWEEP_ID) {
      cy.get('[data-testid="new-sweep"]').first().click();
      cy.wait("@startAutoSweep", { requestTimeout: 10000, responseTimeout: 30000 })
        .then(({ response }) => {
          expect(response?.statusCode, "one Auto-unfollow sweep accepted").to.eq(202);
          expect(response?.body.id).to.eq(sweepId);
          expect(sweepId).to.match(UUID);
        });
    } else {
      expect(sweepId, "persisted Auto-unfollow sweep to resume").to.match(UUID);
    }
    cy.then(() => cy.get(`[data-sweep-id="${sweepId}"]`, { timeout: 15000 })
      .should(EXISTING_SWEEP_ID ? "exist" : "have.attr", ...(EXISTING_SWEEP_ID
        ? []
        : ["data-active-sweep", "true"]))
      .within(() => cy.get('[data-testid="run-mode"]')
        .should("contain.text", "auto-unfollow")));
    cy.screenshot("02-auto-run-accepted", { capture: "viewport" });

    // 2. Generate and review recommendations, stopping before any relationship action.
    cy.then(() => waitForDelivery(RUNS_URL, sweepId, reviewIsComplete, "completed review"))
      .then((delivery) => {
        sweepDeliveryId = delivery.deliveryId;
        const context = contextOf(delivery);
        durableReviews = context.reviews;
        const candidateEvidence = context.candidateEvidence;
        reviewedSourceId = String(context.xApi?.source?.id || "");
        reviewedSourceUsername = String(context.xApi?.source?.username || "");
        expect(reviewedSourceId, "reviewed X source identity").to.match(/^\d{1,19}$/);
        expect(reviewedSourceUsername, "reviewed X source username")
          .to.match(/^[A-Za-z0-9_]{1,15}$/);
        expect(context.params.mode).to.eq("auto-unfollow");
        expect(context.candidates).to.have.length(SWEEP_COUNT);
        expect(context.xApi?.returnedResources).to.eq(SWEEP_COUNT);
        expect(candidateEvidence, "real official-X candidate evidence")
          .to.have.length(SWEEP_COUNT);
        expect(durableReviews).to.have.length(SWEEP_COUNT);
        durableReviews.forEach((review, index) => {
          expect(review.handle).to.match(/^@[A-Za-z0-9_]{1,15}$/);
          expect(String(review.xUserId)).to.match(/^\d{1,19}$/);
          expect(review.decision).to.be.oneOf(["KEEP", "UNFOLLOW"]);
          expect(review.reason).to.be.a("string").and.not.be.empty;
          expect(candidateEvidence[index].handle).to.eq(context.candidates[index]);
          expect(candidateEvidence[index].handle).to.eq(review.handle);
          expect(String(candidateEvidence[index].xUserId)).to.eq(String(review.xUserId));
        });
        expect(delivery.steps.map((step) => step.taskName)).to.deep.eq([
          "generate-candidates",
          "review-handles",
        ]);
      });
    cy.then(() => cy.request(RUNS_URL).then(({ body }) => {
      const matchingRuns = body.filter((delivery) => delivery.sourceId === sweepId);
      expect(matchingRuns, "one durable sweep identity").to.have.length(1);
      expect(matchingRuns[0].deliveryId).to.eq(sweepDeliveryId);
    }));
    cy.request(ACTIONS_URL).then(({ body }) => {
      const premature = body.filter((delivery) => contextOf(delivery).params?.sweepId === sweepId);
      expect(premature, "no action exists before visible confirmation").to.deep.eq([]);
    });

    // 3. Display the exact stable-ID recommendation set.
    cy.then(() => cy.get(
      `[data-sweep-id="${sweepId}"] [aria-label="View run steps"]`,
    ).click());
    cy.get('[data-testid="auto-unfollow-recommendations"]').should("be.visible");
    cy.then(() => cy.get('[data-testid="auto-unfollow-recommendations"]')
      .should("contain.text", `Connected as @${reviewedSourceUsername}`));
    cy.then(() => {
      recommended = durableReviews.filter((review) => review.decision === "UNFOLLOW");
      expect(recommended, "actionable recommendations").to.have.length.greaterThan(1);
      recommended.forEach((review) => {
        const id = String(review.xUserId);
        cy.get(`[data-testid="recommendation-${id}"]`)
          .should("contain.text", review.handle)
          .and("contain.text", id)
          .and("contain.text", "UNFOLLOW")
          .and("contain.text", review.reason);
      });
      cy.get('[data-testid="recommendation-count"]')
        .should("contain.text", String(recommended.length));
      cy.get("[data-recommendation-id]").then(($cards) => {
        expect(
          [...$cards].map((card) => card.getAttribute("data-recommendation-id")),
          "visible cards are exactly the durable UNFOLLOW decisions in order",
        ).to.deep.eq(recommended.map((review) => String(review.xUserId)));
      });
      durableReviews.filter((review) => review.decision === "KEEP").forEach((review) => {
        cy.get(`[data-testid="recommendation-select-${review.xUserId}"]`).should("not.exist");
      });
      if (!EXISTING_SWEEP_ID) {
        recommended.forEach((review) => {
          cy.get(`[data-testid="recommendation-select-${review.xUserId}"]`).should("be.checked");
        });
        cy.get('[data-testid="approved-count"]')
          .should("contain.text", String(recommended.length));
      }
    });
    cy.screenshot("03-exact-recommendations", { capture: "viewport" });

    // Leaving this surface and using browser back/forward must restore the same
    // backend-owned review without creating an action.
    cy.get('[aria-label="Config"]').click({ force: true });
    cy.location("pathname").should("eq", "/config");
    cy.go("back");
    cy.location("pathname").should("eq", "/");
    cy.then(() => cy.get(
      `[data-sweep-id="${sweepId}"] [aria-label="View run steps"]`,
      { timeout: 15000 },
    ).click());
    cy.get("[data-recommendation-id]").then(($cards) => {
      expect([...$cards].map((card) => card.getAttribute("data-recommendation-id")))
        .to.deep.eq(recommended.map((review) => String(review.xUserId)));
    });
    cy.go("forward");
    cy.location("pathname").should("eq", "/config");
    cy.go("back");
    cy.location("pathname").should("eq", "/");
    cy.then(() => cy.get(
      `[data-sweep-id="${sweepId}"] [aria-label="View run steps"]`,
      { timeout: 15000 },
    ).click());
    cy.request(ACTIONS_URL).then(({ body }) => {
      const actions = body.filter((delivery) => contextOf(delivery).params?.sweepId === sweepId);
      expect(actions, "leave and back/forward create no X action").to.deep.eq([]);
    });

    cy.then(() => {
      cy.intercept("POST", `**/api/v1/sweeps/${sweepId}/selections`, (request) => {
        expect(new URL(request.url).origin, "selection sweeper-agent origin")
          .to.eq(new URL(SWEEPER_AGENT_URL).origin);
        selectionPosts += 1;
        selectionId = request.body.id;
        expect(request.body.targets).to.deep.eq(approved.map((review) => ({
          handle: review.handle,
          xUserId: String(review.xUserId),
        })));
      }).as("saveReviewedSelection");
    });

    // 4. Start with all recommendations, then remove accounts from the visible
    // set. Execution mode keeps only operator-authorized stable IDs. Safe review
    // mode keeps two for the confirmation preview and never submits them.
    cy.get('[data-testid="select-all-recommendations"]').click();
    cy.then(() => {
      recommended.forEach((review) => {
        cy.get(`[data-testid="recommendation-select-${review.xUserId}"]`).should("be.checked");
      });
      recommended.forEach((review) => {
        cy.get(`[data-testid="recommendation-select-${review.xUserId}"]`).click();
      });
      cy.get('[data-testid="approved-count"]').should("contain.text", "0 approved");
      cy.get('[data-testid="review-approved-set"]').should("be.disabled");
      cy.then(() => expect(selectionPosts, "an empty set creates no selection delivery").to.eq(0));
      cy.get('[data-testid="select-all-recommendations"]').click();
      recommended.forEach((review) => {
        cy.get(`[data-testid="recommendation-select-${review.xUserId}"]`).should("be.checked");
      });
      const probe = recommended.at(-1);
      cy.get(`[data-testid="recommendation-select-${probe.xUserId}"]`).click();
      cy.get(`[data-testid="recommendation-select-${probe.xUserId}"]`).should("not.be.checked");
      cy.get(`[data-testid="recommendation-${probe.xUserId}"]`).should("contain.text", "EXCLUDED");
      cy.get('[data-testid="approved-count"]')
        .should("contain.text", String(recommended.length - 1));
      recommended.slice(0, -1).forEach((review) => {
        cy.get(`[data-testid="recommendation-select-${review.xUserId}"]`).should("be.checked");
      });
      cy.get(`[data-testid="recommendation-select-${probe.xUserId}"]`).click();
      cy.get(`[data-testid="recommendation-select-${probe.xUserId}"]`).should("be.checked");
      cy.get('[data-testid="approved-count"]').should("contain.text", String(recommended.length));

      approved = EXECUTE
        ? recommended.filter((review) =>
            AUTHORIZED_X_USER_IDS.includes(String(review.xUserId)))
        : recommended.slice(0, 2);
      excluded = EXECUTE
        ? recommended.filter((review) =>
            !AUTHORIZED_X_USER_IDS.includes(String(review.xUserId)))
        : recommended.slice(2);
      const approvedExpectation = expect(approved, EXECUTE
        ? "authorized recommendations present in this real review"
        : "recommendations available for the safe confirmation preview");
      if (EXECUTE) approvedExpectation.to.have.length.greaterThan(1);
      else approvedExpectation.to.have.length(2);
      expect(excluded, "at least one real recommendation is deliberately deselected")
        .to.have.length.greaterThan(0);
      excluded.forEach((review) => {
        cy.get(`[data-testid="recommendation-select-${review.xUserId}"]`).click();
      });
      cy.get('[data-testid="approved-count"]').should("contain.text", String(approved.length));
      approved.forEach((review) => {
        cy.get(`[data-testid="recommendation-select-${review.xUserId}"]`).should("be.checked");
      });
      excluded.forEach((review) => {
        cy.get(`[data-testid="recommendation-select-${review.xUserId}"]`).should("not.be.checked");
      });
    });
    cy.screenshot("04-approved-set-after-deselection", { capture: "viewport" });

    // 5. Confirm the complete visible, durably selected set once.
    cy.get('[data-testid="review-approved-set"]').click();
    cy.wait("@saveReviewedSelection", { requestTimeout: 10000, responseTimeout: 30000 })
      .then(({ response }) => {
        expect(response?.statusCode, "one reviewed selection accepted").to.eq(202);
        expect(response?.body.id).to.eq(selectionId);
        expect(selectionId).to.match(UUID);
        expect(selectionPosts).to.eq(1);
      });
    cy.then(() => waitForDelivery(
      SELECTIONS_URL,
      selectionId,
      selectionIsComplete,
      "durable reviewed selection",
    )).then((delivery) => {
      selectionDeliveryId = delivery.deliveryId;
      const context = contextOf(delivery);
      expect(context.params.sweepId).to.eq(sweepId);
      expect(context.params.sweepDeliveryId).to.eq(sweepDeliveryId);
      expect(context.params.sourceXUserId).to.eq(reviewedSourceId);
      expect(context.params.targets).to.deep.eq(approved.map((review) => ({
        handle: review.handle,
        xUserId: String(review.xUserId),
      })));
      expect(context.selection?.targets).to.deep.eq(context.params.targets);
      expect(context.unfollows, "saving a selection performs no X action").to.eq(undefined);
      expect(context.unfollowResults, "saving a selection has no per-target X results")
        .to.eq(undefined);
      expect(delivery.steps.map((step) => step.taskName)).to.deep.eq(["save-selection"]);
    });
    cy.get('[role="dialog"]').last().within(() => {
      cy.contains("Confirm Auto-unfollow").should("be.visible");
      cy.contains("automatically and sequentially through the X API").should("be.visible");
      cy.contains(`Connected as @${reviewedSourceUsername}`).should("be.visible");
      cy.get('[data-testid="saved-selection-id"]')
        .should("contain.text", selectionId)
        .and("contain.text", "Saved");
      cy.get('[data-testid="confirm-approved-set"]').should("not.be.disabled");
      cy.then(() => {
        approved.forEach((review) => {
          cy.get(`[data-testid="confirm-target-${review.xUserId}"]`)
            .should("contain.text", review.handle)
            .and("contain.text", String(review.xUserId));
        });
        excluded.forEach((review) => {
          cy.get(`[data-testid="confirm-target-${review.xUserId}"]`).should("not.exist");
        });
      });
    });
    cy.screenshot("05-one-visible-set-confirmation", { capture: "viewport" });

    if (!EXECUTE) {
      let firstSelectionId;
      let firstSelectionDeliveryId;
      let replacementSelectionId;
      let replacementSelectionDeliveryId;

      // A newer durable version invalidates an already-open confirmation. This
      // stays non-destructive: it creates selection history only, never an X action.
      cy.window().then((win) => {
        replacementSelectionId = win.crypto.randomUUID();
      });
      cy.then(() => cy.request({
        method: "POST",
        url: `${SWEEPER_AGENT_URL}/api/v1/sweeps/${sweepId}/selections`,
        body: {
          id: replacementSelectionId,
          targets: approved.map((review) => ({
            handle: review.handle,
            xUserId: String(review.xUserId),
          })),
        },
      })).its("status").should("eq", 202);
      cy.then(() => waitForDelivery(
        SELECTIONS_URL,
        replacementSelectionId,
        selectionIsComplete,
        "newer reviewed selection",
      )).then((delivery) => {
        replacementSelectionDeliveryId = delivery.deliveryId;
      });
      cy.get('[data-testid="selection-superseded"]', { timeout: 15000 })
        .should("contain.text", "replaced")
        .and("contain.text", "review the visible set again");
      cy.get('[role="dialog"]').last().within(() => {
        cy.get('[data-testid="confirm-approved-set"]')
          .should("be.disabled")
          .and("not.have.attr", "data-loading", "true");
        cy.contains("Cancel").click();
      });
      cy.request(ACTIONS_URL).then(({ body }) => {
        const actions = body.filter((delivery) => contextOf(delivery).params?.sweepId === sweepId);
        expect(actions, "superseding an open confirmation creates no X action").to.deep.eq([]);
      });
      cy.then(() => {
        selectionId = replacementSelectionId;
        selectionDeliveryId = replacementSelectionDeliveryId;
        firstSelectionId = replacementSelectionId;
        firstSelectionDeliveryId = replacementSelectionDeliveryId;
      });
      cy.request(ACTIONS_URL).then(({ body }) => {
        const actions = body.filter((delivery) => contextOf(delivery).params?.sweepId === sweepId);
        expect(actions, "safe review mode creates no X action").to.deep.eq([]);
      });
      cy.window().then((win) => {
        win.localStorage.clear();
        win.sessionStorage.clear();
      });
      cy.reload();
      cy.then(() => cy.get(
        `[data-sweep-id="${sweepId}"] [aria-label="View run steps"]`,
        { timeout: 15000 },
      ).click());
      cy.then(() => {
        cy.get(`[data-sweep-id="${sweepId}"] [data-testid="run-mode"]`)
          .should("contain.text", "auto-unfollow");
        cy.get("[data-recommendation-id]").then(($cards) => {
          expect([...$cards].map((card) => card.getAttribute("data-recommendation-id")))
            .to.deep.eq(recommended.map((review) => String(review.xUserId)));
        });
        approved.forEach((review) => {
          cy.get(`[data-testid="recommendation-${review.xUserId}"]`)
            .should("contain.text", review.reason);
          cy.get(`[data-testid="recommendation-select-${review.xUserId}"]`)
            .should("be.checked");
        });
        excluded.forEach((review) => {
          cy.get(`[data-testid="recommendation-${review.xUserId}"]`)
            .should("contain.text", review.reason)
            .and("contain.text", "EXCLUDED");
          cy.get(`[data-testid="recommendation-select-${review.xUserId}"]`)
            .should("not.be.checked");
        });
        const kept = durableReviews.filter((review) => review.decision === "KEEP");
        cy.get('[data-testid="kept-account-count"]').should("contain.text", String(kept.length));
        cy.get('[data-testid="kept-accounts"] summary').click();
        [kept[0], kept.at(-1)].filter(Boolean).forEach((review) => {
          cy.get(`[data-testid="kept-account-${review.xUserId}"]`)
            .should("contain.text", review.handle)
            .and("contain.text", String(review.xUserId))
            .and("contain.text", "KEEP")
            .and("contain.text", review.reason);
          cy.get(`[data-testid="recommendation-select-${review.xUserId}"]`).should("not.exist");
        });
      });
      cy.then(() => cy.get('[data-testid="saved-selection-id"]')
        .should("contain.text", selectionId));
      cy.request(ACTIONS_URL).then(({ body }) => {
        const actions = body.filter((delivery) => contextOf(delivery).params?.sweepId === sweepId);
        expect(actions, "cancel and reload still create no X action").to.deep.eq([]);
      });

      // Changing the restored set creates a new immutable selection and a new
      // confirmation opportunity; the earlier visible set cannot be confirmed.
      cy.then(() => {
        const added = excluded[0];
        const nextIds = new Set([...approved, added].map((review) => String(review.xUserId)));
        approved = recommended.filter((review) => nextIds.has(String(review.xUserId)));
        excluded = recommended.filter((review) => !nextIds.has(String(review.xUserId)));
        cy.get(`[data-testid="recommendation-select-${added.xUserId}"]`).click();
      });
      cy.get('[data-testid="approved-count"]').should("contain.text", "3 approved");
      cy.get('[data-testid="selection-draft-changed"]')
        .should("be.visible")
        .and("contain.text", "Unsaved changes");
      cy.get('[data-testid="saved-selection-id"]').should("not.exist");
      cy.get('[data-testid="review-approved-set"]').click();
      cy.wait("@saveReviewedSelection", { requestTimeout: 10000, responseTimeout: 30000 })
        .then(({ response }) => {
          expect(response?.statusCode, "changed selection accepted as a new version").to.eq(202);
          expect(response?.body.id).to.eq(selectionId);
          expect(selectionId).to.match(UUID).and.not.eq(firstSelectionId);
          expect(selectionPosts).to.eq(2);
        });
      cy.then(() => waitForDelivery(
        SELECTIONS_URL,
        selectionId,
        selectionIsComplete,
        "replacement reviewed selection",
      )).then((delivery) => {
        selectionDeliveryId = delivery.deliveryId;
        expect(delivery.deliveryId).not.to.eq(firstSelectionDeliveryId);
        const context = contextOf(delivery);
        expect(context.params.targets).to.deep.eq(approved.map((review) => ({
          handle: review.handle,
          xUserId: String(review.xUserId),
        })));
      });
      cy.get('[role="dialog"]').last().within(() => {
        cy.get('[data-testid="saved-selection-id"]')
          .should("contain.text", selectionId)
          .and("contain.text", "Saved");
        cy.get('[data-testid="confirm-approved-set"]').should("not.be.disabled");
        cy.contains("Cancel").click();
      });
      cy.window().then((win) => {
        win.localStorage.clear();
        win.sessionStorage.clear();
      });
      cy.reload();
      cy.then(() => cy.get(
        `[data-sweep-id="${sweepId}"] [aria-label="View run steps"]`,
        { timeout: 15000 },
      ).click());
      cy.then(() => {
        approved.forEach((review) => {
          cy.get(`[data-testid="recommendation-select-${review.xUserId}"]`).should("be.checked");
        });
        excluded.forEach((review) => {
          cy.get(`[data-testid="recommendation-select-${review.xUserId}"]`).should("not.be.checked");
        });
        cy.get('[data-testid="saved-selection-id"]').should("contain.text", selectionId);
      });
      cy.request(ACTIONS_URL).then(({ body }) => {
        const actions = body.filter((delivery) => contextOf(delivery).params?.sweepId === sweepId);
        expect(actions, "changing, cancelling, and restoring creates no X action").to.deep.eq([]);
      });
      cy.then(() => cy.task("log", JSON.stringify({
        sweepId,
        sweepDeliveryId,
        supersededSelectionId: firstSelectionId,
        selectionId,
        selectionDeliveryId,
        confirmationPreview: approved.map(({ handle, xUserId }) => ({ handle, xUserId })),
        excluded: excluded.map(({ handle, xUserId }) => ({ handle, xUserId })),
      })));
      cy.then(() => expect(actionPosts, "review-only browser issued no action request").to.eq(0));
      return;
    }

    cy.then(() => {
      cy.intercept("POST", `**/api/v1/sweeps/${sweepId}/unfollows`, (request) => {
        expect(new URL(request.url).origin, "action sweeper-agent origin")
          .to.eq(new URL(SWEEPER_AGENT_URL).origin);
        actionPosts += 1;
        expect(request.body.selectionId).to.eq(selectionId);
        expect(request.body.id).to.eq(undefined);
        expect(request.body.targets).to.eq(undefined);
      }).as("confirmApprovedSet");
    });
    // Exercise a real double activation; the synchronous UI guard must still
    // produce one accepted action and therefore one ordered X sequence.
    cy.get('[role="dialog"]').last().find('[data-testid="confirm-approved-set"]')
      .should("not.be.disabled")
      .dblclick();
    cy.wait("@confirmApprovedSet", { requestTimeout: 10000, responseTimeout: 30000 })
      .then(({ response }) => {
        expect(response?.statusCode, "one approved set accepted").to.eq(202);
        actionId = response?.body.id;
        expect(response?.body.id).to.eq(actionId);
        expect(actionId).to.match(UUID);
        expect(actionPosts).to.eq(1);
      });

    // Acceptance closes both confirmation entry points and exposes the exact
    // durable action identity before any target has to reach a terminal state.
    cy.get('[data-testid="confirm-approved-set"]', { timeout: 5000 }).should("not.exist");
    cy.get('[data-testid="review-approved-set"]', { timeout: 5000 }).should("not.exist");
    cy.then(() => cy.get('[data-testid="confirmed-action-id"]', { timeout: 5000 })
      .should("contain.text", actionId));

    // Reload immediately, while OE may still be materializing the accepted
    // delivery. The accepted identity must remain locked and attributable.
    cy.reload();
    cy.then(() => cy.get(
      `[data-sweep-id="${sweepId}"] [aria-label="View run steps"]`,
      { timeout: 15000 },
    ).click());
    cy.then(() => cy.get('[data-testid="confirmed-action-id"]', { timeout: 5000 })
      .should("contain.text", actionId));
    cy.get('[data-testid="review-approved-set"]').should("not.exist");

    // 6. Execute only the approved targets, in order, through the official X API.
    cy.then(() => waitForDelivery(ACTIONS_URL, actionId, actionIsComplete, "approved X action"))
      .then((delivery) => {
        actionDelivery = delivery;
        actionDeliveryId = delivery.deliveryId;
        const context = contextOf(delivery);
        const expectedTargets = approved.map((review) => ({
          handle: review.handle,
          xUserId: String(review.xUserId),
        }));
        expect(context.params.sweepId).to.eq(sweepId);
        expect(context.params.sweepDeliveryId).to.eq(sweepDeliveryId);
        expect(context.params.selectionId).to.eq(selectionId);
        expect(context.params.selectionDeliveryId).to.eq(selectionDeliveryId);
        expect(context.params.sourceXUserId).to.eq(reviewedSourceId);
        expect(context.params.targets).to.deep.eq(expectedTargets);
        const results = unfollowResultsOf(context);
        actionResults = results;
        expect(results.map(({ xUserId }) => String(xUserId)))
          .to.deep.eq(expectedTargets.map(({ xUserId }) => xUserId));
        results.forEach((result, index) => {
          expect(result.reviewedHandle || result.handle, "review-time identity provenance")
            .to.eq(expectedTargets[index].handle);
          expect(result.handle, "current X handle").to.match(/^@[A-Za-z0-9_]{1,15}$/);
          expect(result.sequence, `persisted sequence for ${result.handle}`).to.eq(index + 1);
          expect(result.startedAt, `persisted start time for ${result.handle}`)
            .to.match(/^\d{4}-\d{2}-\d{2}T/);
          expect(result.completedAt, `persisted completion time for ${result.handle}`)
            .to.match(/^\d{4}-\d{2}-\d{2}T/);
          expect(result.status).to.be.oneOf(["APPLIED", "ALREADY_UNFOLLOWED"]);
          if (result.status === "APPLIED") {
            expect(result.transport).to.eq("X_API");
            expect(result.before?.following).to.eq(true);
            expect(result.mutation?.following).to.eq(false);
            expect(result.after?.following).to.eq(false);
          }
        });
        expect(delivery.steps.map((step) => step.taskName)).to.deep.eq(
          expectedTargets.map((_, index) => `apply-unfollow-${String(index + 1).padStart(4, "0")}`),
        );
        delivery.steps.forEach((step, index) => {
          expect(step.result, `step ${index + 1} terminal result`).to.eq("SUCCESS");
          if (index > 0) {
            expect(new Date(step.dispatchedAt).getTime())
              .to.be.at.least(new Date(delivery.steps[index - 1].completedAt).getTime());
          }
        });
      });

    cy.then(() => {
      approved.forEach((review) => {
        relationship(String(review.xUserId)).then((state) => {
          expect(state.following, `${review.handle} is no longer followed`).to.eq(false);
        });
      });
      excluded.forEach((review) => {
        relationship(String(review.xUserId)).then((state) => {
          expect(state.following, `${review.handle} was excluded and remains followed`).to.eq(true);
        });
      });
    });

    cy.then(() => {
      approved.forEach((review) => {
        cy.get(`[data-testid="approved-unfollow-result-${review.xUserId}"]`)
          .should("be.visible");
      });
    });
    cy.then(() => cy.get('[data-testid="action-result-summary"]')
      .should("contain.text", `${approved.length}/${approved.length} complete`)
      .and("contain.text", `${excluded.length} excluded`)
      .then(($summary) => {
        const counts = actionResults.reduce((current, result) => ({
          ...current,
          [result.status]: (current[result.status] || 0) + 1,
        }), {});
        expect($summary.text()).to.contain(`${counts.APPLIED || 0} applied`);
        expect($summary.text()).to.contain(`${counts.ALREADY_UNFOLLOWED || 0} already unfollowed`);
        expect($summary.text()).to.contain(`${counts.FAILED || 0} failed`);
      }));
    cy.screenshot("06-sequential-x-results", { capture: "viewport" });

    // 7. Restore the exact selection, action identity, order, and terminal results
    // from durable data after the initiating browser state is gone.
    cy.window().then((win) => {
      win.localStorage.clear();
      win.sessionStorage.clear();
    });
    cy.reload();
    cy.then(() => cy.get(
      `[data-sweep-id="${sweepId}"] [aria-label="View run steps"]`,
      { timeout: 15000 },
    ).click());
    cy.then(() => {
      approved.forEach((review) => {
        cy.get(`[data-testid="approved-unfollow-result-${review.xUserId}"]`)
          .should("contain.text", review.handle);
        cy.get(`[data-testid="recommendation-select-${review.xUserId}"]`).should("be.checked");
      });
      excluded.forEach((review) => {
        cy.get(`[data-testid="recommendation-select-${review.xUserId}"]`).should("not.be.checked");
      });
    });
    cy.then(() => cy.get('[data-testid="confirmed-action-id"]')
      .should("contain.text", actionId));
    cy.get('[data-testid="confirm-approved-set"]').should("not.exist");
    cy.wait(1500).then(() => expect(actionPosts, "reload dispatches no second action").to.eq(1));
    cy.request(ACTIONS_URL).then(({ body }) => {
      const actions = body.filter((delivery) => contextOf(delivery).params?.sweepId === sweepId);
      expect(actions, "exactly one durable action after reload").to.have.length(1);
      expect(actions[0].sourceId).to.eq(actionId);
    });
    cy.screenshot("07-results-restored-after-cleared-state", { capture: "viewport" });

    cy.then(() => cy.task("log", JSON.stringify({
      sweepId,
      sweepDeliveryId,
      selectionId,
      selectionDeliveryId,
      actionId,
      actionDeliveryId,
      approved: approved.map(({ handle, xUserId }) => ({ handle, xUserId })),
      excluded: excluded.map(({ handle, xUserId }) => ({ handle, xUserId })),
      results: unfollowResultsOf(contextOf(actionDelivery)),
    })));
    cy.then(() => expect(
      outcomeEngineUiGets,
      "browser reads the local Outcome Engine",
    ).to.be.greaterThan(0));
  });
});

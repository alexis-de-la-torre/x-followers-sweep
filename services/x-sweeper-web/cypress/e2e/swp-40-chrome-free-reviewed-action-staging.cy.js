/// <reference types="cypress" />

// SWP-40 is an intentionally opt-in destructive staging journey. It will only
// confirm the one reviewed target identified by the exact sweep, handle, and
// stable X ID supplied by the operator. It never generates or broadens a set.
const OUTCOME_ENGINE_URL =
  Cypress.env("OUTCOME_ENGINE_URL") || "https://outcome-engine.s26.staging.adlt.dev";
const SWEEPER_AGENT_URL =
  Cypress.env("SWEEPER_AGENT_URL") || "https://sweeper-agent.s26.staging.adlt.dev";
const X_API_ADAPTER_URL =
  Cypress.env("X_API_ADAPTER_URL") || "https://x-api-adapter.s26.staging.adlt.dev";
const STAGING_RELEASE = String(Cypress.env("STAGING_RELEASE") || "");
const SWEEP_ID = String(Cypress.env("EXISTING_SWEEP_ID") || "");
const AUTHORIZED_HANDLE = String(Cypress.env("AUTHORIZED_UNFOLLOW_HANDLE") || "");
const AUTHORIZED_X_USER_ID = String(Cypress.env("AUTHORIZED_UNFOLLOW_X_USER_ID") || "")
  .replace(/^id:/, "");
const ACTION_ID = String(Cypress.env("EXISTING_ACTION_ID") || "");
const EXACT_SCOPE = Boolean(STAGING_RELEASE)
  && /^[0-9a-f-]{36}$/i.test(SWEEP_ID)
  && /^@[A-Za-z0-9_]{1,15}$/.test(AUTHORIZED_HANDLE)
  && /^\d{1,19}$/.test(AUTHORIZED_X_USER_ID);
const RUN = [true, "true"].includes(Cypress.env("RUN_SWP_40")) && EXACT_SCOPE;
const RESTORE = [true, "true"].includes(Cypress.env("RUN_SWP_40_RESTORE"))
  && EXACT_SCOPE
  && /^[0-9a-f-]{36}$/i.test(ACTION_ID);
const describeAuthorized = RUN ? describe : describe.skip;
const describeRestoration = RESTORE ? describe : describe.skip;
const RUNS_URL = `${OUTCOME_ENGINE_URL}/api/v1/outcome-deliveries?outcomeName=sweep-run`;
const SELECTIONS_URL =
  `${OUTCOME_ENGINE_URL}/api/v1/outcome-deliveries?outcomeName=sweep-selection`;
const ACTIONS_URL = `${OUTCOME_ENGINE_URL}/api/v1/outcome-deliveries?outcomeName=sweep-unfollow`;

function contextOf(delivery) {
  if (typeof delivery?.context === "object") return delivery.context || {};
  try { return JSON.parse(delivery?.context || "{}"); } catch { return {}; }
}

function waitForDelivery(url, sourceId, predicate, description, deadline = Date.now() + 300000) {
  return cy.request({ url, failOnStatusCode: false }).then((response) => {
    const delivery = Array.isArray(response.body)
      ? response.body.find((candidate) => candidate.sourceId === sourceId)
      : null;
    if (response.status === 200 && delivery && predicate(delivery)) return delivery;
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for ${description} ${sourceId}: ${JSON.stringify(delivery || response.body)}`,
      );
    }
    return cy.wait(500).then(() =>
      waitForDelivery(url, sourceId, predicate, description, deadline));
  });
}

function resultsOf(context) {
  return Object.values(context.unfollowResults || {})
    .sort((left, right) => Number(left.sequence) - Number(right.sequence));
}

function relationship() {
  return cy.request(`${X_API_ADAPTER_URL}/api/v1/account/following/${AUTHORIZED_X_USER_ID}`)
    .then(({ status, body }) => {
      expect(status, "relationship read status").to.eq(200);
      expect(String(body.target?.id), "stable target identity").to.eq(AUTHORIZED_X_USER_ID);
      expect(`@${body.target?.username}`, "current target handle").to.eq(AUTHORIZED_HANDLE);
      return body;
    });
}

function assertChromeFree(snapshot) {
  expect(snapshot.runtime, "Chrome workloads, pods, and services").to.deep.eq([]);
  expect(snapshot.agentConfig, "agent config").not.to.have.property("BROWSER_WS");
  expect(snapshot.profile, "preserved rollback profile").to.deep.include({
    name: "chrome-vnc-pvc",
    phase: "Bound",
  });
}

describeAuthorized("SWP-40 Chrome-free reviewed Auto-unfollow", () => {
  it("executes the one authorized X target and restores it after an agent restart", () => {
    let sweepDeliveryId;
    let selectionId;
    let selectionDeliveryId;
    let actionId;
    let actionDeliveryId;
    let review;
    let restartEvidence;
    let actionPosts = 0;
    let restoreWrites = 0;

    expect(STAGING_RELEASE, "deployed staging release").not.to.be.empty;
    cy.task("stagingChromeFreeSnapshot").then(assertChromeFree);
    cy.request(`${SWEEPER_AGENT_URL}/health`).then(({ status, body }) => {
      expect(status).to.eq(200);
      expect(body.service).to.eq("ok");
      expect(body.xApi).to.deep.include({
        configured: true,
        writeConfigured: true,
        account: "@dlt_alx",
        error: null,
      });
      expect(body).not.to.have.property("chrome");
    });

    cy.request(RUNS_URL).then(({ status, body }) => {
      expect(status).to.eq(200);
      const matches = body.filter((delivery) => delivery.sourceId === SWEEP_ID);
      expect(matches, "one reviewed sweep").to.have.length(1);
      expect(matches[0].status).to.eq("ALL_TASKS_COMPLETED");
      sweepDeliveryId = String(matches[0].deliveryId);
      const context = contextOf(matches[0]);
      expect(context.params).to.deep.include({ mode: "auto-unfollow", count: 30 });
      const recommendations = context.reviews.filter(({ decision }) => decision === "UNFOLLOW");
      expect(recommendations, "one exact visible recommendation").to.have.length(1);
      review = recommendations[0];
      expect(review).to.deep.include({
        handle: AUTHORIZED_HANDLE,
        xUserId: AUTHORIZED_X_USER_ID,
        decision: "UNFOLLOW",
      });
      expect(review.reason).to.be.a("string").and.not.be.empty;
      expect(String(context.xApi?.source?.id), "reviewed source identity").to.eq("1478416609");
    });
    cy.request(ACTIONS_URL).then(({ body }) => {
      const attributable = body.filter((delivery) =>
        contextOf(delivery).params?.sweepId === SWEEP_ID);
      expect(attributable, "no action before confirmation").to.deep.eq([]);
    });
    relationship().its("following").should("eq", true);

    cy.intercept("POST", `**/api/v1/sweeps/${SWEEP_ID}/selections`, (request) => {
      selectionId = request.body.id;
      expect(request.body.targets).to.deep.eq([{
        handle: AUTHORIZED_HANDLE,
        xUserId: AUTHORIZED_X_USER_ID,
      }]);
    }).as("saveAuthorizedSelection");
    cy.visit("/");
    cy.get(`[data-sweep-id="${SWEEP_ID}"] [aria-label="View run steps"]`, {
      timeout: 15000,
    }).click();
    cy.get('[data-testid="auto-unfollow-recommendations"]').should("be.visible");
    cy.get("[data-recommendation-id]").should("have.length", 1);
    cy.then(() => cy.get(`[data-testid="recommendation-${AUTHORIZED_X_USER_ID}"]`)
      .should("contain.text", AUTHORIZED_HANDLE)
      .and("contain.text", AUTHORIZED_X_USER_ID)
      .and("contain.text", review.reason));
    cy.get(`[data-testid="recommendation-select-${AUTHORIZED_X_USER_ID}"]`)
      .should("be.checked");
    cy.get('[data-testid="approved-count"]').should("contain.text", "1 approved");
    cy.screenshot("swp-40-exact-authorized-selection", { capture: "viewport" });

    cy.get('[data-testid="review-approved-set"]').click();
    cy.wait("@saveAuthorizedSelection", { requestTimeout: 10000, responseTimeout: 30000 })
      .then(({ response }) => {
        expect(response?.statusCode).to.eq(202);
        expect(response?.body.id).to.eq(selectionId);
      });
    cy.then(() => waitForDelivery(
      SELECTIONS_URL,
      selectionId,
      (delivery) => {
        const context = contextOf(delivery);
        return delivery.status === "ALL_TASKS_COMPLETED"
          && context.selection?.status === "SAVED";
      },
      "saved reviewed selection",
    )).then((delivery) => {
      selectionDeliveryId = String(delivery.deliveryId);
      expect(contextOf(delivery).params.targets).to.deep.eq([{
        handle: AUTHORIZED_HANDLE,
        xUserId: AUTHORIZED_X_USER_ID,
      }]);
    });
    cy.get('[role="dialog"]').last().within(() => {
      cy.contains("Confirm Auto-unfollow").should("be.visible");
      cy.get(`[data-testid="confirm-target-${AUTHORIZED_X_USER_ID}"]`)
        .should("contain.text", AUTHORIZED_HANDLE)
        .and("contain.text", AUTHORIZED_X_USER_ID);
      cy.get('[data-testid="saved-selection-id"]').should("contain.text", selectionId);
    });
    cy.screenshot("swp-40-one-confirmation", { capture: "viewport" });

    cy.intercept("POST", `**/api/v1/sweeps/${SWEEP_ID}/unfollows`, (request) => {
      actionPosts += 1;
      expect(request.body).to.deep.eq({ selectionId });
    }).as("confirmAuthorizedSelection");
    cy.get('[role="dialog"]').last().find('[data-testid="confirm-approved-set"]')
      .should("be.enabled")
      .click();
    cy.wait("@confirmAuthorizedSelection", { requestTimeout: 10000, responseTimeout: 30000 })
      .then(({ response }) => {
        expect(response?.statusCode).to.eq(202);
        actionId = response?.body.id;
        expect(actionId).to.match(/^[0-9a-f-]{36}$/i);
        expect(actionPosts, "one confirmation request").to.eq(1);
      });

    cy.then(() => waitForDelivery(
      ACTIONS_URL,
      actionId,
      (delivery) => {
        const context = contextOf(delivery);
        return delivery.status === "ALL_TASKS_COMPLETED" && resultsOf(context).length === 1;
      },
      "terminal authorized action",
    )).then((delivery) => {
      actionDeliveryId = String(delivery.deliveryId);
      const context = contextOf(delivery);
      expect(context.params).to.deep.include({
        sweepId: SWEEP_ID,
        sweepDeliveryId,
        selectionId,
        selectionDeliveryId,
        sourceXUserId: "1478416609",
      });
      expect(context.params.targets).to.deep.eq([{
        handle: AUTHORIZED_HANDLE,
        xUserId: AUTHORIZED_X_USER_ID,
      }]);
      expect(delivery.steps.map(({ taskName, result }) => ({ taskName, result }))).to.deep.eq([{
        taskName: "apply-unfollow-0001",
        result: "SUCCESS",
      }]);
      const result = resultsOf(context)[0];
      expect(result).to.deep.include({
        handle: AUTHORIZED_HANDLE,
        xUserId: AUTHORIZED_X_USER_ID,
        sequence: 1,
        status: "APPLIED",
        transport: "X_API",
      });
      expect(result.before?.following).to.eq(true);
      expect(result.mutation?.following).to.eq(false);
      expect(result.after?.following).to.eq(false);
    });
    relationship().its("following").should("eq", false);
    cy.get(`[data-testid="approved-unfollow-result-${AUTHORIZED_X_USER_ID}"]`, {
      timeout: 15000,
    }).should("contain.text", `${AUTHORIZED_HANDLE} unfollowed through X`);
    cy.get('[data-testid="action-result-summary"]')
      .should("contain.text", "1/1 complete")
      .and("contain.text", "1 applied")
      .and("contain.text", "0 failed");
    cy.screenshot("swp-40-x-result", { capture: "viewport" });

    cy.task("stagingRestartSweeperAgent").then((evidence) => {
      restartEvidence = evidence;
      const beforeUids = new Set(evidence.before.map(({ uid }) => uid));
      const activeAfter = evidence.after.filter(({ deleting }) => !deleting);
      expect(activeAfter, "one active replacement pod").to.have.length(1);
      expect(beforeUids.has(activeAfter[0].uid), "replacement pod identity").to.eq(false);
      expect(activeAfter[0]).to.deep.include({ phase: "Running", ready: true });
    });
    cy.request({ url: `${SWEEPER_AGENT_URL}/health`, retryOnStatusCodeFailure: true })
      .then(({ status, body }) => {
        expect(status).to.eq(200);
        expect(body.xApi?.account).to.eq("@dlt_alx");
        expect(body.xApi?.error).to.eq(null);
        expect(body).not.to.have.property("chrome");
      });
    cy.task("stagingChromeFreeSnapshot").then(assertChromeFree);

    cy.intercept("POST", "**/api/v1/sweeps**", (request) => {
      restoreWrites += 1;
      request.destroy();
    });
    cy.window().then((win) => {
      win.localStorage.clear();
      win.sessionStorage.clear();
    });
    cy.reload(true);
    cy.get(`[data-sweep-id="${SWEEP_ID}"] [aria-label="View run steps"]`, {
      timeout: 15000,
    }).click();
    cy.get('[data-testid="confirmed-action-id"]').should("contain.text", actionId);
    cy.get(`[data-testid="approved-unfollow-result-${AUTHORIZED_X_USER_ID}"]`)
      .should("contain.text", `${AUTHORIZED_HANDLE} unfollowed through X`);
    cy.get(`[data-testid="recommendation-select-${AUTHORIZED_X_USER_ID}"]`)
      .should("be.checked")
      .and("be.disabled");
    cy.get('[data-testid="action-result-summary"]')
      .should("contain.text", "1/1 complete")
      .and("contain.text", "1 applied");
    cy.wait(1000).then(() => expect(restoreWrites, "reload issues no write").to.eq(0));
    cy.request(ACTIONS_URL).then(({ body }) => {
      const attributable = body.filter((delivery) =>
        contextOf(delivery).params?.sweepId === SWEEP_ID);
      expect(attributable, "one durable action after restart and reload").to.have.length(1);
      expect(attributable[0].sourceId).to.eq(actionId);
    });
    relationship().its("following").should("eq", false);
    cy.screenshot("swp-40-restored-after-agent-restart", { capture: "viewport" });

    cy.then(() => cy.task("log", JSON.stringify({
      stagingRelease: STAGING_RELEASE,
      sweepId: SWEEP_ID,
      sweepDeliveryId,
      selectionId,
      selectionDeliveryId,
      actionId,
      actionDeliveryId,
      target: { handle: AUTHORIZED_HANDLE, xUserId: AUTHORIZED_X_USER_ID },
      restartEvidence,
      restoreWrites,
    })));
  });
});

describeRestoration("SWP-40 completed action restoration", () => {
  it("restores the authorized result after agent replacement without another write", () => {
    let actionDeliveryId;
    let selectionId;
    let selectionDeliveryId;
    let actionCompletedAt;
    let replacementPod;
    let browserWrites = 0;

    cy.intercept("POST", "**/api/v1/sweeps**", (request) => {
      browserWrites += 1;
      request.destroy();
    });
    cy.task("stagingChromeFreeSnapshot").then((snapshot) => {
      assertChromeFree(snapshot);
      const active = snapshot.agentPods.filter(({ deleting }) => !deleting);
      expect(active, "one active agent pod").to.have.length(1);
      expect(active[0]).to.deep.include({ phase: "Running", ready: true });
      replacementPod = active[0];
    });
    cy.request(`${SWEEPER_AGENT_URL}/health`).then(({ status, body }) => {
      expect(status).to.eq(200);
      expect(body.xApi).to.deep.include({
        configured: true,
        writeConfigured: true,
        account: "@dlt_alx",
        error: null,
      });
      expect(body).not.to.have.property("chrome");
    });
    cy.request(ACTIONS_URL).then(({ status, body }) => {
      expect(status).to.eq(200);
      const attributable = body.filter((delivery) =>
        contextOf(delivery).params?.sweepId === SWEEP_ID);
      expect(attributable, "one action for the reviewed sweep").to.have.length(1);
      expect(attributable[0].sourceId).to.eq(ACTION_ID);
      expect(attributable[0].status).to.eq("ALL_TASKS_COMPLETED");
      actionDeliveryId = String(attributable[0].deliveryId);
      const context = contextOf(attributable[0]);
      selectionId = context.params.selectionId;
      selectionDeliveryId = String(context.params.selectionDeliveryId);
      expect(context.params).to.deep.include({
        sweepId: SWEEP_ID,
        sweepDeliveryId: "26056",
        sourceXUserId: "1478416609",
      });
      expect(context.params.targets).to.deep.eq([{
        handle: AUTHORIZED_HANDLE,
        xUserId: AUTHORIZED_X_USER_ID,
      }]);
      expect(attributable[0].steps.map(({ taskName, result }) => ({ taskName, result })))
        .to.deep.eq([{ taskName: "apply-unfollow-0001", result: "SUCCESS" }]);
      const result = resultsOf(context)[0];
      expect(result).to.deep.include({
        handle: AUTHORIZED_HANDLE,
        xUserId: AUTHORIZED_X_USER_ID,
        sequence: 1,
        status: "APPLIED",
        transport: "X_API",
      });
      expect(result.before?.following).to.eq(true);
      expect(result.mutation?.following).to.eq(false);
      expect(result.after?.following).to.eq(false);
      actionCompletedAt = result.completedAt;
    });
    cy.then(() => {
      expect(
        new Date(replacementPod.createdAt).getTime(),
        "active agent pod was created after the action completed",
      ).to.be.greaterThan(new Date(actionCompletedAt).getTime());
    });
    relationship().its("following").should("eq", false);

    cy.visit("/");
    cy.get(`[data-sweep-id="${SWEEP_ID}"] [aria-label="View run steps"]`, {
      timeout: 15000,
    }).click();
    cy.get('[data-testid="confirmed-action-id"]').should("contain.text", ACTION_ID);
    cy.get(`[data-testid="recommendation-${AUTHORIZED_X_USER_ID}"]`)
      .should("contain.text", AUTHORIZED_HANDLE)
      .and("contain.text", AUTHORIZED_X_USER_ID);
    cy.get(`[data-testid="recommendation-select-${AUTHORIZED_X_USER_ID}"]`)
      .should("be.checked")
      .and("be.disabled");
    cy.get(`[data-testid="approved-unfollow-result-${AUTHORIZED_X_USER_ID}"]`)
      .should("contain.text", `${AUTHORIZED_HANDLE} unfollowed through X`);
    cy.get('[data-testid="action-result-summary"]')
      .should("contain.text", "1/1 complete")
      .and("contain.text", "1 applied")
      .and("contain.text", "0 failed");

    cy.window().then((win) => {
      win.localStorage.clear();
      win.sessionStorage.clear();
    });
    cy.reload(true);
    cy.get(`[data-sweep-id="${SWEEP_ID}"] [aria-label="View run steps"]`, {
      timeout: 15000,
    }).click();
    cy.get('[data-testid="confirmed-action-id"]').should("contain.text", ACTION_ID);
    cy.get(`[data-testid="approved-unfollow-result-${AUTHORIZED_X_USER_ID}"]`)
      .should("contain.text", `${AUTHORIZED_HANDLE} unfollowed through X`);
    cy.get('[data-testid="action-result-summary"]')
      .should("contain.text", "1/1 complete")
      .and("contain.text", "1 applied");
    cy.wait(1000).then(() => expect(browserWrites, "restoration issues no write").to.eq(0));
    cy.request(ACTIONS_URL).then(({ body }) => {
      const attributable = body.filter((delivery) =>
        contextOf(delivery).params?.sweepId === SWEEP_ID);
      expect(attributable, "reload does not repeat the X action").to.have.length(1);
      expect(attributable[0].sourceId).to.eq(ACTION_ID);
    });
    relationship().its("following").should("eq", false);
    cy.screenshot("swp-40-restored-after-agent-restart", { capture: "viewport" });

    cy.then(() => cy.task("log", JSON.stringify({
      stagingRelease: STAGING_RELEASE,
      sweepId: SWEEP_ID,
      actionId: ACTION_ID,
      actionDeliveryId,
      selectionId,
      selectionDeliveryId,
      target: { handle: AUTHORIZED_HANDLE, xUserId: AUTHORIZED_X_USER_ID },
      replacementPod,
      restoreWrites: browserWrites,
    })));
  });
});

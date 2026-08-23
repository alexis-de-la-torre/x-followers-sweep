/// <reference types="cypress" />

// Destructive, explicitly opt-in SWP-38 journey. The web and agent are local;
// Outcome Engine, Pub/Sub, the native adapter, and X remain real. Intercepts
// observe requests and never supply a response.
const OUTCOME_ENGINE_URL = Cypress.env("OUTCOME_ENGINE_URL") || "http://127.0.0.1:8090";
const SWEEPER_AGENT_URL = Cypress.env("SWEEPER_AGENT_URL") || "http://127.0.0.1:8020";
const X_API_ADAPTER_URL = Cypress.env("X_API_ADAPTER_URL") || "http://127.0.0.1:8030";
const AUTHORIZED_HANDLE = String(Cypress.env("AUTHORIZED_UNFOLLOW_HANDLE") || "");
// Prefix IDs passed on the command line with `id:` so Cypress does not parse
// 19-digit X IDs as unsafe JavaScript numbers before the test can stringify them.
const AUTHORIZED_X_USER_ID = String(Cypress.env("AUTHORIZED_UNFOLLOW_X_USER_ID") || "")
  .replace(/^id:/, "");
const EXISTING_UNFOLLOW_ID = String(Cypress.env("EXISTING_UNFOLLOW_ID") || "");
const RUN = [true, "true"].includes(Cypress.env("RUN_SWP_38"));
const describeAuthorized = RUN ? describe : describe.skip;

function contextOf(delivery) {
  if (typeof delivery?.context === "object") return delivery.context || {};
  try { return JSON.parse(delivery?.context || "{}"); } catch { return {}; }
}

function reviewedSweep(sourceId) {
  const url = `${OUTCOME_ENGINE_URL}/api/v1/outcome-deliveries?outcomeName=sweep-run`;
  return cy.request(url).then(({ status, body }) => {
    expect(status, "Outcome Engine list status").to.eq(200);
    const delivery = body.find((candidate) => {
      if (sourceId && candidate.sourceId !== sourceId) return false;
      const review = contextOf(candidate).reviews?.find((item) =>
        item.handle?.toLowerCase() === AUTHORIZED_HANDLE.toLowerCase() &&
        String(item.xUserId) === AUTHORIZED_X_USER_ID,
      );
      return review?.decision === "UNFOLLOW";
    });
    expect(
      delivery,
      `${AUTHORIZED_HANDLE} (${AUTHORIZED_X_USER_ID}) has a persisted UNFOLLOW review`,
    ).to.exist;
    return delivery;
  });
}

function followingSnapshot(limit) {
  return cy.request(`${X_API_ADAPTER_URL}/api/v1/account/following?limit=${limit}`).then(
    ({ status, body }) => {
      expect(status, "native Following lookup status").to.eq(200);
      expect(body.source?.username, "authorized source account").to.eq("dlt_alx");
      expect(body.accounts, "stable Following resources").to.be.an("array");
      return new Map(body.accounts.map((account) => [String(account.id), account]));
    },
  );
}

function waitForApplied(id, deadline = Date.now() + 120000) {
  const url = `${OUTCOME_ENGINE_URL}/api/v1/outcome-deliveries?outcomeName=sweep-unfollow`;
  return cy.request({ url, failOnStatusCode: false }).then(({ status, body }) => {
    const delivery = Array.isArray(body) ? body.find((candidate) => candidate.sourceId === id) : null;
    const applied = contextOf(delivery).unfollow;
    if (
      status === 200 &&
      delivery?.status === "ALL_TASKS_COMPLETED" &&
      applied?.status === "APPLIED"
    ) {
      return delivery;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for applied unfollow ${id}: ${JSON.stringify(delivery || body)}`);
    }
    return cy.wait(500).then(() => waitForApplied(id, deadline));
  });
}

describeAuthorized("SWP-38 confirmed X API unfollow", () => {
  it("changes only the confirmed stable X identity and restores the durable result", () => {
    expect(AUTHORIZED_HANDLE, "operator-authorized handle").to.match(/^@[A-Za-z0-9_]{1,15}$/);
    expect(AUTHORIZED_X_USER_ID, "operator-authorized stable X ID").to.match(/^\d{1,19}$/);

    let sweep;
    let selectedReview;
    let unchangedReviews;
    let unfollowId;
    let unfollowDeliveryId;
    let followingBefore;
    let appliedDelivery;
    const reviewSelector = `[data-testid="review-${AUTHORIZED_HANDLE.slice(1)}"]`;

    cy.request(`${SWEEPER_AGENT_URL}/health`).then(({ status, body }) => {
      expect(status, "local agent health status").to.eq(200);
      expect(body.service).to.eq("ok");
      expect(body.xApi?.configured, "official X boundary selected").to.eq(true);
      expect(body.xApi?.writeConfigured, "official X relationship writes selected").to.eq(true);
      expect(body.xApi?.account, "authorized source account").to.eq("@dlt_alx");
      expect(body.xApi?.error).to.eq(null);
      expect(body, "Chrome is not part of the action path").not.to.have.property("chrome");
    });

    if (EXISTING_UNFOLLOW_ID) {
      cy.then(() => waitForApplied(EXISTING_UNFOLLOW_ID, Date.now() + 10000)).then((delivery) => {
        appliedDelivery = delivery;
        unfollowId = delivery.sourceId;
        unfollowDeliveryId = delivery.deliveryId;
      });
    }

    cy.then(() => reviewedSweep(
      appliedDelivery ? contextOf(appliedDelivery).params?.sweepId : undefined,
    )).then((delivery) => {
      sweep = delivery;
      const reviews = contextOf(delivery).reviews;
      const selectedIndex = reviews.findIndex((review) =>
        review.handle.toLowerCase() === AUTHORIZED_HANDLE.toLowerCase(),
      );
      selectedReview = reviews[selectedIndex];
      unchangedReviews = reviews.filter((_, index) => index !== selectedIndex);
      expect(selectedReview.xUserId).to.eq(AUTHORIZED_X_USER_ID);
      expect(selectedReview.decision).to.eq("UNFOLLOW");
      expect(selectedReview.reason).to.be.a("string").and.not.be.empty;
      expect(unchangedReviews, "other reviewed relationships used as controls")
        .to.have.length.greaterThan(0);
      unchangedReviews.forEach((review) => expect(review.xUserId).to.match(/^\d{1,19}$/));
    });

    if (!EXISTING_UNFOLLOW_ID) {
      cy.then(() => followingSnapshot(unchangedReviews.length + 11)).then((snapshot) => {
        followingBefore = snapshot;
        expect(snapshot.has(AUTHORIZED_X_USER_ID),
          "fresh native X read includes the reviewed target before confirmation").to.eq(true);
        unchangedReviews.forEach((review) => {
          expect(snapshot.has(review.xUserId), `${review.handle} is followed before confirmation`)
            .to.eq(true);
        });
      });

      cy.intercept("POST", "**/api/v1/sweeps/*/unfollows", (request) => {
        expect(request.body.handle).to.eq(AUTHORIZED_HANDLE);
        expect(request.body.xUserId, "action carries the reviewed stable identity")
          .to.eq(AUTHORIZED_X_USER_ID);
        unfollowId = request.body.id;
      }).as("applyUnfollow");

      cy.visit("/");
      cy.then(() => {
        cy.get(`[data-sweep-id="${sweep.sourceId}"] [aria-label="View run steps"]`).click();
      });
      cy.get(reviewSelector).then(($review) => {
        $review[0].scrollIntoView({ block: "center", inline: "nearest" });
      });
      cy.get(reviewSelector).within(() => {
        cy.contains(AUTHORIZED_HANDLE).should("be.visible");
        cy.contains("UNFOLLOW").should("be.visible");
        cy.contains(selectedReview.reason).should("be.visible");
      });
      cy.screenshot("01-reviewed-target-ready", { capture: "viewport" });

      cy.get(`[data-testid="apply-${AUTHORIZED_HANDLE.slice(1)}"]`).click();
      cy.get('[role="dialog"]').last().within(() => {
        cy.contains(AUTHORIZED_HANDLE).should("be.visible");
        cy.contains("button", "Unfollow").should("be.enabled");
      });
      cy.screenshot("02-explicit-confirmation", { capture: "viewport" });
      cy.get('[role="dialog"]').last().contains("button", "Unfollow").click();

      cy.wait("@applyUnfollow", { requestTimeout: 10000, responseTimeout: 30000 })
        .then(({ response }) => {
          expect(response?.statusCode, "one action accepted").to.eq(202);
          expect(response?.body.id).to.eq(unfollowId);
        });
      cy.then(() => waitForApplied(unfollowId)).then((delivery) => {
        appliedDelivery = delivery;
        unfollowDeliveryId = delivery.deliveryId;
      });
    } else {
      cy.visit("/");
      cy.then(() => {
        cy.get(`[data-sweep-id="${sweep.sourceId}"] [aria-label="View run steps"]`).click();
      });
    }

    cy.then(() => {
      expect(appliedDelivery, "durable applied delivery").to.exist;
      return appliedDelivery;
    }).then((delivery) => {
      const context = contextOf(delivery);
      expect(context.params.sweepId).to.eq(sweep.sourceId);
      expect(context.params.sweepDeliveryId).to.eq(sweep.deliveryId);
      expect(context.params.xUserId).to.eq(AUTHORIZED_X_USER_ID);
      expect(context.unfollow.handle).to.eq(AUTHORIZED_HANDLE);
      expect(context.unfollow.xUserId).to.eq(AUTHORIZED_X_USER_ID);
      expect(context.unfollow.transport).to.eq("X_API");
      expect(context.unfollow.before.following).to.eq(true);
      expect(context.unfollow.after.following).to.eq(false);
      expect(delivery.steps).to.have.length(1);
      expect(delivery.steps[0].taskName).to.eq("apply-unfollow");
      expect(delivery.steps[0].result).to.eq("SUCCESS");
    });

    cy.contains(`${AUTHORIZED_HANDLE} unfollowed`, { timeout: 15000 }).then(($result) => {
      $result[0].scrollIntoView({ block: "center", inline: "nearest" });
    });
    cy.contains(`${AUTHORIZED_HANDLE} unfollowed`).should("be.visible");
    cy.screenshot("03-official-x-unfollow-applied", { capture: "viewport" });

    cy.then(() => followingSnapshot(unchangedReviews.length + 11)).then((snapshot) => {
      expect(snapshot.has(AUTHORIZED_X_USER_ID),
        "fresh native X read proves target is absent from Following").to.eq(false);
      unchangedReviews.forEach((review) => {
        if (followingBefore) {
          expect(followingBefore.has(review.xUserId), `${review.handle} was followed before`).to.eq(true);
        }
        expect(snapshot.has(review.xUserId), `${review.handle} relationship is unchanged`).to.eq(true);
      });
    });

    cy.window().then((win) => {
      win.localStorage.clear();
      win.sessionStorage.clear();
    });
    cy.reload();
    cy.then(() => {
      cy.get(`[data-sweep-id="${sweep.sourceId}"] [aria-label="View run steps"]`, {
        timeout: 15000,
      }).click();
      cy.contains(`${AUTHORIZED_HANDLE} unfollowed`).then(($result) => {
        $result[0].scrollIntoView({ block: "center", inline: "nearest" });
      });
      cy.contains(`${AUTHORIZED_HANDLE} unfollowed`).should("be.visible");
    });
    cy.screenshot("04-applied-result-restored-after-reload", { capture: "viewport" });

    cy.then(() => cy.task("log", JSON.stringify({
      sweepId: sweep.sourceId,
      sweepDeliveryId: sweep.deliveryId,
      unfollowId,
      unfollowDeliveryId,
      xUserId: AUTHORIZED_X_USER_ID,
      handle: AUTHORIZED_HANDLE,
      unchangedXUserIds: unchangedReviews.map((review) => review.xUserId),
    })));
  });
});

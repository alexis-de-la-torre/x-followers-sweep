import assert from "node:assert/strict";
import test from "node:test";

import {
  toSelection,
  toUnfollow,
  withApprovedUnfollowAction,
} from "../src/lib/engine.js";

const targets = [
  { handle: "@first", xUserId: "42" },
  { handle: "@second", xUserId: "43" },
];

function actionDelivery({ context = {}, status = "IN_PROGRESS", steps = [] } = {}) {
  return {
    sourceId: "action-1",
    deliveryId: "200",
    status,
    createdAt: "2026-08-24T10:00:00Z",
    context: {
      params: {
        sweepId: "sweep-1",
        sweepDeliveryId: "100",
        selectionId: "selection-1",
        targets,
      },
      ...context,
    },
    steps,
  };
}

test("projects one persisted result while the next ordered target is still waiting", () => {
  const delivery = actionDelivery({
    context: {
      unfollowResults: {
        42: {
          handle: "@first",
          xUserId: "42",
          sequence: 1,
          status: "APPLIED",
          transport: "X_API",
          completedAt: "2026-08-24T10:00:02Z",
        },
      },
    },
    steps: [
      {
        taskName: "apply-unfollow-0001",
        dispatchedAt: "2026-08-24T10:00:01Z",
        completedAt: "2026-08-24T10:00:02Z",
        result: "SUCCESS",
      },
      { taskName: "apply-unfollow-0002" },
    ],
  });
  delivery.context = JSON.stringify(delivery.context);
  const action = toUnfollow(delivery);

  assert.equal(action.actionStatus, "IN_PROGRESS");
  assert.deepEqual(action.results.map((result) => result.xUserId), ["42"]);

  const projected = withApprovedUnfollowAction({
    sourceId: "sweep-1",
    reviews: targets.map((target) => ({ ...target, decision: "UNFOLLOW" })),
  }, action);
  assert.equal(projected.reviews[0].application.status, "APPLIED");
  assert.equal(projected.reviews[1].application.status, "APPLYING");
});

test("sorts accumulated results by persisted execution sequence", () => {
  const action = toUnfollow(actionDelivery({
    status: "ALL_TASKS_COMPLETED",
    context: {
      unfollowResults: {
        43: { handle: "@second", xUserId: "43", sequence: 2, status: "FAILED" },
        42: { handle: "@first", xUserId: "42", sequence: 1, status: "APPLIED" },
      },
    },
    steps: [
      { taskName: "apply-unfollow-0001", result: "SUCCESS" },
      { taskName: "apply-unfollow-0002", result: "SUCCESS" },
    ],
  }));

  assert.equal(action.actionStatus, "DONE");
  assert.deepEqual(action.results.map((result) => [result.xUserId, result.status]), [
    ["42", "APPLIED"],
    ["43", "FAILED"],
  ]);
});

test("does not claim an unrecorded tail target failed when the workflow stops", () => {
  const action = toUnfollow(actionDelivery({
    context: {
      unfollowResults: {
        42: { handle: "@first", xUserId: "42", sequence: 1, status: "APPLIED" },
      },
    },
    steps: [
      { taskName: "apply-unfollow-0001", result: "SUCCESS" },
      {
        taskName: "apply-unfollow-0002",
        result: "FAILURE",
        detail: "worker stopped before a result was saved",
      },
    ],
  }));
  const projected = withApprovedUnfollowAction({
    sourceId: "sweep-1",
    reviews: targets.map((target) => ({ ...target, decision: "UNFOLLOW" })),
  }, action);

  assert.equal(action.actionStatus, "FAILED");
  assert.equal(projected.reviews[0].application.status, "APPLIED");
  assert.equal(projected.reviews[1].application.status, "NOT_COMPLETED");
  assert.match(projected.reviews[1].application.detail, /worker stopped/);
});

test("projects an asynchronous selection failure as terminal and explainable", () => {
  const selection = toSelection({
    sourceId: "selection-2",
    deliveryId: "201",
    createdAt: "2026-08-24T10:00:00Z",
    context: {
      params: {
        sweepId: "sweep-1",
        sweepDeliveryId: "100",
        sourceXUserId: "1478416609",
        targets,
      },
    },
    steps: [{
      taskName: "save-selection",
      result: "FAILURE",
      detail: "selection persistence failed",
    }],
  });

  assert.equal(selection.selectionStatus, "FAILED");
  assert.equal(selection.detail, "selection persistence failed");
  assert.deepEqual(selection.targets, targets);
});

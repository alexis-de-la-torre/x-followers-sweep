// Data layer for the x-sweeper web frontend.
// Talks to the outcome-engine for run deliveries and to the sweeper-agent for live status.

export const OUTCOME_ENGINE_ADDR =
  process.env.NEXT_PUBLIC_OUTCOME_ENGINE_ADDR || "https://outcome-engine.s26.staging.adlt.dev";

export const SWEEPER_AGENT_ADDR =
  process.env.NEXT_PUBLIC_SWEEPER_AGENT_ADDR || "https://sweeper-agent.s26.staging.adlt.dev";

// The sweep-run pipeline steps (mirrors what the sweeper-agent publishes as outcomes).
export const PIPELINE = ["generate-candidates", "review-handles"];
export const STEP_LABEL = {
  "generate-candidates": "Generate Candidates",
  "review-handles": "Review Handles",
  "apply-unfollows": "Apply Unfollows",
};

export function stepStatus(step) {
  if (!step) return "PENDING";
  if (step.result === "SUCCESS") return "DONE";
  if (step.result) return "FAILED";
  if (step.dispatchedAt) return "IN_PROGRESS";
  return "PENDING";
}

// Delivery → run mapping (mirrors short-form-gen's toFlow).
export function toRun(d) {
  let ctx = {};
  try { ctx = typeof d.context === "string" ? JSON.parse(d.context || "{}") : d.context || {}; } catch {}
  const params = ctx.params || {};
  const candidates = Array.isArray(ctx.candidates)
    ? [...new Set(ctx.candidates.filter((handle) => typeof handle === "string"))]
    : [];
  const reviews = Array.isArray(ctx.reviews)
    ? ctx.reviews.filter((review) => review && typeof review.handle === "string")
    : [];
  const unfollows = Array.isArray(ctx.unfollows)
    ? ctx.unfollows.filter((result) => result && typeof result.handle === "string")
    : [];
  const xAccount = ctx.xApi?.source && typeof ctx.xApi.source === "object"
    ? ctx.xApi.source
    : null;
  const engineSteps = d.steps || [];
  const present = new Set(engineSteps.map((s) => s.taskName));
  const orderedKeys = [...engineSteps.map((s) => s.taskName), ...PIPELINE.filter((k) => !present.has(k))];
  const byName = Object.fromEntries(engineSteps.map((s) => [s.taskName, s]));
  const steps = orderedKeys.map((key) => {
    const s = byName[key];
    return {
      key,
      label: STEP_LABEL[key] || key,
      status: stepStatus(s),
      at: s?.completedAt ?? null,
      startedAt: s?.dispatchedAt ?? null,
      detail: s?.detail ?? null,
    };
  });
  const failed = steps.find((s) => s.status === "FAILED");
  return {
    id: d.deliveryId,
    sourceId: d.sourceId,
    title: params.label || params.handle || d.sourceId || `Sweep ${d.deliveryId}`,
    handle: params.handle || null,
    mode: params.mode || "dry-run",
    engineStatus: d.status,
    createdAt: d.createdAt,
    lastActivityAt: d.updatedAt || d.createdAt,
    errorDetail: failed?.detail ?? null,
    candidates,
    reviews,
    unfollows,
    xAccount,
    summary: {
      candidates: candidates.length,
      reviewed: reviews.length,
      keep: reviews.filter((review) => review.decision === "KEEP").length,
      unfollow: reviews.filter((review) => review.decision === "UNFOLLOW").length,
    },
    steps,
  };
}

export function toUnfollow(d) {
  let ctx = {};
  try { ctx = typeof d.context === "string" ? JSON.parse(d.context || "{}") : d.context || {}; } catch {}
  const params = ctx.params || {};
  const deliverySteps = d.steps || [];
  const step = deliverySteps.find((candidate) => candidate.taskName === "apply-unfollow");
  const setStep = deliverySteps.find((candidate) => candidate.taskName === "apply-unfollows");
  const orderedSteps = deliverySteps
    .filter((candidate) => candidate.taskName?.startsWith("apply-unfollow-"))
    .sort((left, right) => left.taskName.localeCompare(right.taskName));
  const result = ctx.unfollow || {};
  const targets = Array.isArray(params.targets)
    ? params.targets.filter((target) => target?.handle && target?.xUserId)
    : [];
  const orderedResults = ctx.unfollowResults && typeof ctx.unfollowResults === "object"
    && !Array.isArray(ctx.unfollowResults)
    ? Object.values(ctx.unfollowResults)
      .filter((item) => item?.handle && item?.xUserId)
      .sort((left, right) => Number(left.sequence || 0) - Number(right.sequence || 0))
    : [];
  const legacyResults = Array.isArray(ctx.unfollows)
    ? ctx.unfollows.filter((item) => item?.handle && item?.xUserId)
    : [];
  const results = orderedResults.length ? orderedResults : legacyResults;
  const failedSetStep = orderedSteps.find(
    (candidate) => candidate.result && candidate.result !== "SUCCESS",
  );
  const allOrderedStepsDone = targets.length > 0
    && orderedSteps.length === targets.length
    && orderedSteps.every((candidate) => candidate.result === "SUCCESS");
  const orderedActionStatus = failedSetStep
    ? "FAILED"
    : allOrderedStepsDone || (d.status === "ALL_TASKS_COMPLETED" && results.length === targets.length)
      ? "DONE"
      : orderedSteps.some((candidate) => candidate.dispatchedAt) || results.length
        ? "IN_PROGRESS"
        : "PENDING";
  const persistedStatus = ["APPLIED", "ALREADY_UNFOLLOWED", "FAILED"].includes(result.status)
    ? result.status
    : null;
  return {
    id: d.sourceId,
    deliveryId: d.deliveryId,
    sweepId: params.sweepId || ctx.sweepId,
    sweepDeliveryId: params.sweepDeliveryId ? String(params.sweepDeliveryId) : null,
    selectionId: params.selectionId ? String(params.selectionId) : null,
    selectionDeliveryId: params.selectionDeliveryId ? String(params.selectionDeliveryId) : null,
    handle: result.handle || params.handle || ctx.handle,
    xUserId: result.xUserId || params.xUserId || ctx.xUserId,
    status: persistedStatus || (step?.result && step.result !== "SUCCESS" ? "FAILED" : "APPLYING"),
    appliedAt: result.appliedAt || null,
    targets,
    results,
    actionStatus: orderedSteps.length || orderedResults.length
      ? orderedActionStatus
      : setStep?.result === "SUCCESS"
        ? "DONE"
        : setStep?.result
          ? "FAILED"
          : setStep?.dispatchedAt
            ? "IN_PROGRESS"
            : "PENDING",
    detail: result.detail || failedSetStep?.detail || setStep?.detail || step?.detail || null,
    createdAt: d.createdAt,
  };
}

export function toSelection(d) {
  let ctx = {};
  try { ctx = typeof d.context === "string" ? JSON.parse(d.context || "{}") : d.context || {}; } catch {}
  const params = ctx.params || {};
  const step = (d.steps || []).find((candidate) => candidate.taskName === "save-selection");
  const targets = Array.isArray(params.targets)
    ? params.targets
      .filter((target) => target?.handle && target?.xUserId)
      .map((target) => ({ handle: String(target.handle), xUserId: String(target.xUserId) }))
    : [];
  return {
    id: d.sourceId,
    deliveryId: d.deliveryId,
    sweepId: params.sweepId ? String(params.sweepId) : null,
    sweepDeliveryId: params.sweepDeliveryId ? String(params.sweepDeliveryId) : null,
    sourceXUserId: params.sourceXUserId ? String(params.sourceXUserId) : null,
    targets,
    selectionStatus: step?.result === "SUCCESS"
      ? "SAVED"
      : step?.result
        ? "FAILED"
        : step?.dispatchedAt
          ? "SAVING"
          : "PENDING",
    detail: step?.detail || null,
    createdAt: d.createdAt,
  };
}

// Before reviewed-set confirmation was introduced, Auto-unfollow stored its
// apply-unfollows step and results on the sweep delivery itself. Project that
// history into the new read model so a completed legacy run remains terminal
// and can never look like a fresh selectable recommendation set.
export function legacyUnfollowAction(run) {
  const legacyStep = run.steps.find((step) => step.key === "apply-unfollows");
  if (!legacyStep && !run.unfollows.length) return null;

  const targets = run.reviews
    .filter((review) => review.decision === "UNFOLLOW")
    .map((review) => ({
      handle: review.handle,
      ...(review.xUserId ? { xUserId: String(review.xUserId) } : {}),
    }));
  const results = run.unfollows.map((result) => ({
    ...result,
    ...(result.xUserId ? { xUserId: String(result.xUserId) } : {}),
  }));
  const actionStatus = legacyStep?.status === "DONE"
    ? "DONE"
    : legacyStep?.status === "FAILED"
      ? "FAILED"
      : legacyStep?.status === "IN_PROGRESS"
        ? "IN_PROGRESS"
        : run.unfollows.length
          ? "DONE"
          : "PENDING";

  return {
    id: `legacy:${run.id}`,
    deliveryId: run.id,
    sweepId: run.sourceId,
    targets,
    results,
    actionStatus,
    detail: legacyStep?.detail || null,
    createdAt: run.createdAt,
    legacy: true,
  };
}

// Attach one approved-set action to a run. Stable IDs are authoritative for
// current X API actions; handle matching keeps older embedded browser results
// readable without inventing IDs they never persisted.
export function withApprovedUnfollowAction(run, approvedAction) {
  if (!approvedAction) {
    return { ...run, unfollowAction: null, approvedTargets: [] };
  }

  const resultsById = new Map(
    (approvedAction.results || [])
      .filter((result) => result.xUserId)
      .map((result) => [String(result.xUserId), result]),
  );
  const resultsByHandle = new Map(
    (approvedAction.results || [])
      .filter((result) => result.handle)
      .map((result) => [String(result.handle).toLowerCase(), result]),
  );
  const handleOnlyResults = new Map(
    (approvedAction.results || [])
      .filter((result) => result.handle && !result.xUserId)
      .map((result) => [String(result.handle).toLowerCase(), result]),
  );
  const approvedIds = new Set(
    (approvedAction.targets || [])
      .filter((target) => target.xUserId)
      .map((target) => String(target.xUserId)),
  );
  const approvedHandles = new Set(
    (approvedAction.targets || [])
      .filter((target) => target.handle)
      .map((target) => String(target.handle).toLowerCase()),
  );
  const handleOnlyTargets = new Set(
    (approvedAction.targets || [])
      .filter((target) => target.handle && !target.xUserId)
      .map((target) => String(target.handle).toLowerCase()),
  );

  return {
    ...run,
    unfollowAction: approvedAction,
    approvedTargets: approvedAction.targets || [],
    reviews: run.reviews.map((review) => {
      const xUserId = review.xUserId ? String(review.xUserId) : null;
      const handle = String(review.handle).toLowerCase();
      const isApproved = xUserId
        ? approvedIds.has(xUserId) || handleOnlyTargets.has(handle)
        : approvedHandles.has(handle);
      if (!isApproved) return review;

      const approvedResult = xUserId
        ? resultsById.get(xUserId) || handleOnlyResults.get(handle)
        : resultsByHandle.get(handle);
      const approvedApplication = approvedResult
        ? { ...approvedResult, status: approvedResult.status || "APPLIED" }
        : ["PENDING", "IN_PROGRESS"].includes(approvedAction.actionStatus)
          ? { status: "APPLYING", detail: null }
          : approvedAction.actionStatus === "FAILED"
            ? {
                status: "NOT_COMPLETED",
                detail: approvedAction.detail || "Action stopped before a result was saved",
              }
            : approvedAction.actionStatus === "DONE"
              ? {
                  status: "FAILED",
                  detail: "No persisted result was found",
                }
              : null;
      return {
        ...review,
        // The result from the confirmed set is the relevant result for this
        // view, even if an older one-account action also exists.
        application: approvedApplication || review.application,
      };
    }),
  };
}

export function overallStatus(run) {
  if (run.steps.some((s) => s.status === "FAILED")) return "FAILED";
  if (run.steps.every((s) => s.status === "DONE")) return "DONE";
  return "IN_PROGRESS";
}

export function furthestStep(run) {
  const blocked = run.steps.find((s) => s.status === "IN_PROGRESS" || s.status === "FAILED");
  if (blocked) return blocked;
  const done = run.steps.filter((s) => s.status === "DONE");
  return done.length ? done[done.length - 1] : run.steps[0];
}

// Fetch runs from the outcome-engine.
export async function fetchRuns() {
  const [runsResponse, selectionsResponse, unfollowsResponse] = await Promise.all([
    fetch(`${OUTCOME_ENGINE_ADDR}/api/v1/outcome-deliveries?outcomeName=sweep-run`),
    fetch(`${OUTCOME_ENGINE_ADDR}/api/v1/outcome-deliveries?outcomeName=sweep-selection`),
    fetch(`${OUTCOME_ENGINE_ADDR}/api/v1/outcome-deliveries?outcomeName=sweep-unfollow`),
  ]);
  if (!runsResponse.ok) throw new Error(`HTTP ${runsResponse.status}`);
  if (!selectionsResponse.ok) throw new Error(`HTTP ${selectionsResponse.status}`);
  if (!unfollowsResponse.ok) throw new Error(`HTTP ${unfollowsResponse.status}`);
  const [runData, selectionData, unfollowData] = await Promise.all([
    runsResponse.json(),
    selectionsResponse.json(),
    unfollowsResponse.json(),
  ]);
  const selections = (Array.isArray(selectionData) ? selectionData : [])
    .map(toSelection)
    .filter((selection) => selection.targets.length)
    .sort((left, right) => {
      const byCreatedAt = new Date(right.createdAt || 0) - new Date(left.createdAt || 0);
      if (byCreatedAt) return byCreatedAt;
      return Number(right.deliveryId || 0) - Number(left.deliveryId || 0);
    });
  const selectionById = new Map(selections.map((selection) => [selection.id, selection]));
  const latestSelectionByDelivery = new Map();
  const latestSelectionBySweep = new Map();
  for (const selection of selections) {
    if (selection.sweepDeliveryId && !latestSelectionByDelivery.has(selection.sweepDeliveryId)) {
      latestSelectionByDelivery.set(selection.sweepDeliveryId, selection);
    }
    if (!selection.sweepDeliveryId && selection.sweepId
        && !latestSelectionBySweep.has(selection.sweepId)) {
      latestSelectionBySweep.set(selection.sweepId, selection);
    }
  }
  const applications = (Array.isArray(unfollowData) ? unfollowData : [])
    .map(toUnfollow)
    .sort((left, right) => {
      const byCreatedAt = new Date(right.createdAt || 0) - new Date(left.createdAt || 0);
      if (byCreatedAt) return byCreatedAt;
      return Number(right.deliveryId || 0) - Number(left.deliveryId || 0);
    });
  const latestByDecision = new Map();
  const latestSetBySweep = new Map();
  const latestSetByDelivery = new Map();
  for (const application of applications) {
    if (application.targets.length) {
      if (application.sweepDeliveryId && !latestSetByDelivery.has(application.sweepDeliveryId)) {
        latestSetByDelivery.set(application.sweepDeliveryId, application);
      }
      if (!application.sweepDeliveryId && !latestSetBySweep.has(application.sweepId)) {
        latestSetBySweep.set(application.sweepId, application);
      }
      continue;
    }
    const key = `${application.sweepId}:${String(application.handle).toLowerCase()}`;
    if (!latestByDecision.has(key)) latestByDecision.set(key, application);
  }
  return (Array.isArray(runData) ? runData : []).map(toRun)
    .map((run) => {
      const approvedAction = latestSetByDelivery.get(String(run.id))
        || latestSetBySweep.get(run.sourceId)
        || legacyUnfollowAction(run);
      const reviewedSelection = (approvedAction?.selectionId
        ? selectionById.get(approvedAction.selectionId)
        : null)
        || latestSelectionByDelivery.get(String(run.id))
        || latestSelectionBySweep.get(run.sourceId)
        || null;
      const runWithIndividualApplications = {
        ...run,
        reviewedSelection,
        reviews: run.reviews.map((review) => {
          const separatelyApplied = latestByDecision.get(
            `${run.sourceId}:${review.handle.toLowerCase()}`,
          );
          return {
            ...review,
            application: separatelyApplied || null,
          };
        }),
      };
      return withApprovedUnfollowAction(runWithIndividualApplications, approvedAction);
    })
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

// Fetch the sweeper-agent's live health status.
export async function fetchAgentStatus() {
  try {
    const r = await fetch(`${SWEEPER_AGENT_ADDR}/health`);
    if (!r.ok) return { service: "unreachable" };
    const text = await r.text();
    // Try to parse as JSON, fall back to plain text
    try { return JSON.parse(text); } catch { return { service: text, chrome: "ok" }; }
  } catch {
    return { service: "unreachable" };
  }
}

// Ask the agent to durably accept a sweep. The browser owns the
// source identity so an uncertain response can later be retried with the same
// id instead of creating unrelated work.
export async function triggerRun({ id = crypto.randomUUID(), mode = "dry-run", count = 3 } = {}) {
  const r = await fetch(`${SWEEPER_AGENT_ADDR}/api/v1/sweeps`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, mode, count }),
  });
  if (r.status !== 202) {
    let detail = `HTTP ${r.status}`;
    try {
      const body = await r.json();
      if (body?.detail) detail = body.detail;
    } catch {}
    throw new Error(detail);
  }
  return await r.json();
}

export async function triggerUnfollow({ sweepId, handle, xUserId, id = crypto.randomUUID() }) {
  const r = await fetch(`${SWEEPER_AGENT_ADDR}/api/v1/sweeps/${sweepId}/unfollows`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, handle, xUserId }),
  });
  if (r.status !== 202) {
    let detail = `HTTP ${r.status}`;
    try {
      const body = await r.json();
      if (body?.detail) detail = body.detail;
    } catch {}
    throw new Error(detail);
  }
  return await r.json();
}

export async function triggerSelection({ sweepId, targets, id = crypto.randomUUID() }) {
  const r = await fetch(`${SWEEPER_AGENT_ADDR}/api/v1/sweeps/${sweepId}/selections`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, targets }),
  });
  if (r.status !== 202) {
    let detail = `HTTP ${r.status}`;
    try {
      const body = await r.json();
      if (body?.detail) detail = body.detail;
    } catch {}
    throw new Error(detail);
  }
  return await r.json();
}

export async function triggerUnfollowSet({ sweepId, selectionId }) {
  const r = await fetch(`${SWEEPER_AGENT_ADDR}/api/v1/sweeps/${sweepId}/unfollows`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ selectionId }),
  });
  if (r.status !== 202) {
    let detail = `HTTP ${r.status}`;
    try {
      const body = await r.json();
      if (body?.detail) detail = body.detail;
    } catch {}
    throw new Error(detail);
  }
  return await r.json();
}

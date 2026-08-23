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
  const step = (d.steps || []).find((candidate) => candidate.taskName === "apply-unfollow");
  const result = ctx.unfollow || {};
  return {
    id: d.sourceId,
    sweepId: ctx.sweepId,
    handle: result.handle || ctx.handle,
    status: result.status === "APPLIED" ? "APPLIED" : step?.result && step.result !== "SUCCESS" ? "FAILED" : "APPLYING",
    appliedAt: result.appliedAt || null,
    detail: step?.detail || null,
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
  const [runsResponse, unfollowsResponse] = await Promise.all([
    fetch(`${OUTCOME_ENGINE_ADDR}/api/v1/outcome-deliveries?outcomeName=sweep-run`),
    fetch(`${OUTCOME_ENGINE_ADDR}/api/v1/outcome-deliveries?outcomeName=sweep-unfollow`),
  ]);
  if (!runsResponse.ok) throw new Error(`HTTP ${runsResponse.status}`);
  if (!unfollowsResponse.ok) throw new Error(`HTTP ${unfollowsResponse.status}`);
  const [runData, unfollowData] = await Promise.all([runsResponse.json(), unfollowsResponse.json()]);
  const applications = (Array.isArray(unfollowData) ? unfollowData : []).map(toUnfollow);
  const latestByDecision = new Map();
  for (const application of applications) {
    const key = `${application.sweepId}:${String(application.handle).toLowerCase()}`;
    if (!latestByDecision.has(key)) latestByDecision.set(key, application);
  }
  return (Array.isArray(runData) ? runData : []).map(toRun)
    .map((run) => ({
      ...run,
      reviews: run.reviews.map((review) => ({
        ...review,
        application: latestByDecision.get(`${run.sourceId}:${review.handle.toLowerCase()}`) || null,
      })),
    }))
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

export async function triggerUnfollow({ sweepId, handle, id = crypto.randomUUID() }) {
  const r = await fetch(`${SWEEPER_AGENT_ADDR}/api/v1/sweeps/${sweepId}/unfollows`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, handle }),
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

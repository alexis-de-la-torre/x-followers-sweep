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
  try { ctx = JSON.parse(d.context || "{}"); } catch {}
  const params = ctx.params || {};
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
    steps,
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
  const r = await fetch(`${OUTCOME_ENGINE_ADDR}/api/v1/outcome-deliveries?outcomeName=sweep-run`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const data = await r.json();
  return (Array.isArray(data) ? data : []).map(toRun)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

// Fetch the sweeper-agent's live health status.
export async function fetchAgentStatus() {
  try {
    const r = await fetch(`${SWEEPER_AGENT_ADDR}/health`);
    if (!r.ok) return { service: "unreachable" };
    return await r.json();
  } catch {
    return { service: "unreachable" };
  }
}

// Trigger a new sweep run: generate candidates then review handles.
export async function triggerRun({ mode, handles } = {}) {
  if (handles && handles.length > 0) {
    // Review specific handles
    const r = await fetch(`${SWEEPER_AGENT_ADDR}/review-handles`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ handles, mode: mode || "dry-run" }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } else {
    // Generate candidates first
    const r = await fetch(`${SWEEPER_AGENT_ADDR}/generate-candidates`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ count: 30 }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  }
}
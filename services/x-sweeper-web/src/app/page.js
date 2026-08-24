"use client";

// Sweep Runs — the outcome-engine-backed run list (data layer in src/lib/engine.js).
import { useEffect, useRef, useState } from "react";
import { ActionIcon, Alert, Box, Button, Checkbox, Container, Divider, Group, Modal, Stack, Text, UnstyledButton, Card, Skeleton, Badge } from "@mantine/core";
import { IconAlertTriangle, IconBrandTwitterFilled, IconCheck, IconChecks, IconCircleDashed, IconClock, IconInfoCircle, IconLoader2, IconPlayerPlay, IconX } from "@tabler/icons-react";
import { fetchRuns, fetchAgentStatus, triggerRun, triggerSelection, triggerUnfollow, triggerUnfollowSet, withApprovedUnfollowAction, overallStatus, furthestStep } from "@/lib/engine";
import { fmtMs, fmtDateTime, fmtTime, fmtStamp, relativeTime } from "@/lib/format";
import { useSweepSettings } from "@/components/SweepSettingsProvider";

const PENDING_APPROVED_ACTIONS_KEY = "x-sweeper.pending-approved-actions";

function loadPendingApprovedActions() {
  if (typeof window === "undefined") return {};
  try {
    const parsed = JSON.parse(window.localStorage.getItem(PENDING_APPROVED_ACTIONS_KEY) || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).flatMap(([sweepId, action]) => {
      if (!action?.id || !Array.isArray(action.targets) || !action.targets.length) return [];
      const targets = action.targets.filter((target) => target?.handle && target?.xUserId)
        .map((target) => ({
          handle: String(target.handle),
          xUserId: String(target.xUserId),
        }));
      if (!targets.length) return [];
      return [[sweepId, {
        id: String(action.id),
        sweepId,
        sweepDeliveryId: action.sweepDeliveryId ? String(action.sweepDeliveryId) : null,
        selectionId: action.selectionId ? String(action.selectionId) : null,
        targets,
        results: [],
        actionStatus: "PENDING",
        createdAt: action.createdAt || null,
        optimistic: true,
      }]];
    }));
  } catch {
    return {};
  }
}

function persistPendingApprovedActions(actions) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(PENDING_APPROVED_ACTIONS_KEY, JSON.stringify(actions));
  } catch {}
}

function reconcilePendingApprovedActions(runs, pendingActions) {
  const remaining = { ...pendingActions };
  let changed = false;
  const visibleRuns = runs.map((run) => {
    const pending = pendingActions[run.sourceId];
    if (!pending) return run;
    if (pending.sweepDeliveryId && String(run.id) !== pending.sweepDeliveryId) return run;
    if (run.unfollowAction?.id === pending.id) {
      delete remaining[run.sourceId];
      changed = true;
      return run;
    }
    // A durable action always wins. The local projection exists only for the
    // short interval between the accepted response and Outcome Engine catch-up.
    if (run.unfollowAction) return run;
    return withApprovedUnfollowAction(run, pending);
  });
  return { visibleRuns, remaining, changed };
}

// ─── Status glyphs ───

const STEP_ICON = { DONE: IconCheck, IN_PROGRESS: IconLoader2, FAILED: IconX, PENDING: IconCircleDashed };
function stepGlyph(status, size = 12, { double = false, spin = false } = {}) {
  const Icon = double && status === "DONE" ? IconChecks : STEP_ICON[status] || IconCircleDashed;
  return <Icon size={size} className={spin && status === "IN_PROGRESS" ? "flow-spin" : undefined} />;
}

// ─── One step as a muted icon + label ───

function StatItem({ status, label, time, sub, double, spin, icon: IconOverride }) {
  const subColor = status === "FAILED" ? "red.6" : "gray.6";
  const meta = time ? (sub ? `${time} · ${sub}` : time) : sub || null;
  return (
    <Stack gap={0} c={status === "FAILED" ? "red.7" : "gray.7"}>
      <Group gap={4} wrap="nowrap" align="center">
        <span style={{ display: "inline-flex", flexShrink: 0, marginTop: -1.5 }}>
          {IconOverride ? <IconOverride size={8} /> : stepGlyph(status, 8, { double, spin })}
        </span>
        <Text fz={9} lh={1.3}>{label}</Text>
      </Group>
      {meta && <Text fz={9} lh={1.3} ff="monospace" c={subColor}>{meta}</Text>}
    </Stack>
  );
}

// ─── Collapsed run status row ───

function RunStatusSummary({ run, onOpen }) {
  const first = run.steps[0];
  const last = furthestStep(run);
  const done = overallStatus(run) === "DONE";
  const inFlight = last.status === "IN_PROGRESS";
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!inFlight) return undefined;
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [inFlight]);
  const lastStamp = last.at ?? last.startedAt;
  const elapsed = !inFlight && run.createdAt && lastStamp
    ? fmtMs(new Date(lastStamp).getTime() - new Date(run.createdAt).getTime())
    : inFlight && last.startedAt
      ? fmtMs(now - new Date(last.startedAt).getTime())
      : null;
  return (
    <Group gap="md" wrap="nowrap" align="center" mt="sm" style={{ maxWidth: "100%" }}>
      <UnstyledButton onClick={onOpen} aria-label="View run steps"
        style={{ display: "inline-flex", alignItems: "center", cursor: "pointer", maxWidth: "100%" }}>
        <Group gap="xl" wrap="nowrap" align="center">
          <StatItem status={first.status} label={first.label}
                    time={first.status === "DONE" ? fmtTime(first.at) : null} />
          {last !== first && (
            <StatItem status={last.status} double={done} spin
                      label={inFlight ? `${last.label}…` : last.label}
                      time={fmtStamp(lastStamp, first.at ?? run.createdAt)} />
          )}
          {elapsed && <StatItem icon={IconClock} label="Elapsed" time={elapsed} />}
        </Group>
      </UnstyledButton>
    </Group>
  );
}

// ─── Full per-step timeline in the modal ───

function RunSteps({ run }) {
  const currentRef = useRef(null);
  useEffect(() => {
    currentRef.current?.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
  }, []);
  const current = furthestStep(run);
  const n = run.steps.length;
  return (
    <Box style={{ overflowX: "auto" }} pb="xs">
      <Box style={{ display: "flex", minWidth: "max-content" }} py={4}>
        {run.steps.map((s, i) => {
          const done = s.status === "DONE";
          const failed = s.status === "FAILED";
          const inFlight = s.status === "IN_PROGRESS";
          const inLine = i > 0 && run.steps[i - 1].status === "DONE"
            ? "2px solid var(--mantine-color-teal-6)" : "2px dashed var(--mantine-color-gray-4)";
          const outLine = done
            ? "2px solid var(--mantine-color-teal-6)" : "2px dashed var(--mantine-color-gray-4)";
          return (
            <Box key={s.key} ref={s.key === current.key ? currentRef : undefined}
                 style={{ width: 160, flexShrink: 0, position: "relative", textAlign: "center" }}>
              {i > 0 && <Box style={{ position: "absolute", top: 15, left: 0, width: "calc(50% - 19px)", borderTop: inLine }} />}
              {i < n - 1 && <Box style={{ position: "absolute", top: 15, right: 0, width: "calc(50% - 19px)", borderTop: outLine }} />}
              <Box aria-current={inFlight ? "step" : undefined}
                   style={{
                     width: 30, height: 30, borderRadius: "50%",
                     background: done ? "var(--mantine-color-teal-6)" : failed ? "var(--mantine-color-red-6)" : "var(--mantine-color-gray-2)",
                     color: done || failed ? "white" : "var(--mantine-color-gray-6)",
                     display: "inline-flex", alignItems: "center", justifyContent: "center",
                   }}>
                {stepGlyph(s.status, 18, { double: done && i === n - 1, spin: true })}
              </Box>
              <Text fw={600} size="sm" c={failed ? "red" : s.status === "PENDING" ? "dimmed" : undefined}>
                {inFlight ? `${s.label}…` : s.label}
              </Text>
              <Text size="xs" c="dimmed">{fmtStamp(s.at ?? s.startedAt, run.createdAt)}</Text>
              {s.at && s.startedAt && (
                <Text size="xs" c="dimmed" ff="monospace">
                  {fmtMs(new Date(s.at).getTime() - new Date(s.startedAt).getTime())}
                </Text>
              )}
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}

// ─── Persisted candidates and review decisions ───

function ReviewDecisionCard({
  review,
  onRequestUnfollow,
  allowIndividualAction = false,
  showPersistedApplication = false,
}) {
  const showApplication = review.decision === "UNFOLLOW"
    && (allowIndividualAction || showPersistedApplication);
  return (
    <Card key={review.handle} withBorder radius="md" padding="sm"
          style={{ flexShrink: 0 }}
          data-testid={`review-${review.handle.replace(/^@/, "")}`}>
      <Group justify="space-between" gap="xs" wrap="nowrap" align="flex-start">
        <Box style={{ minWidth: 0 }}>
          <Text fw={600} size="sm">{review.handle}</Text>
          {review.xUserId && <Text size="xs" c="dimmed" ff="monospace">{review.xUserId}</Text>}
        </Box>
        <Badge color={review.decision === "KEEP" ? "teal" : "orange"} variant="light">
          {review.decision}
        </Badge>
      </Group>
      <Text size="xs" c="dimmed" mt={4}>{review.reason}</Text>
      {showApplication && (
        <Box mt="xs">
          {review.application?.status === "APPLIED" ? (
            <Text size="xs" c="teal.7" fw={600}>{review.handle} unfollowed</Text>
          ) : review.application?.status === "ALREADY_UNFOLLOWED" ? (
            <Text size="xs" c="gray.7" fw={600}>{review.handle} was already not followed</Text>
          ) : review.application?.status === "APPLYING" ? (
            <Button size="compact-xs" variant="light" color="orange" loading disabled>
              Applying unfollow
            </Button>
          ) : review.application?.status === "FAILED" ? (
            <>
              <Text size="xs" c="red.7" mb={allowIndividualAction ? 4 : 0}>
                {review.application.detail || "Unfollow failed"}
              </Text>
              {allowIndividualAction && (
                <Button size="compact-xs" variant="light" color="orange"
                        onClick={() => onRequestUnfollow(review)}
                        data-testid={`apply-${review.handle.replace(/^@/, "")}`}>
                  Unfollow
                </Button>
              )}
            </>
          ) : allowIndividualAction ? (
            <Button size="compact-xs" variant="light" color="orange"
                    onClick={() => onRequestUnfollow(review)}
                    data-testid={`apply-${review.handle.replace(/^@/, "")}`}>
              Unfollow
            </Button>
          ) : (
            <Text size="xs" c="dimmed">No saved result</Text>
          )}
        </Box>
      )}
    </Card>
  );
}

function LegacyAutoUnfollowHistory({ run }) {
  const attempted = run.reviews.filter((review) => review.decision === "UNFOLLOW");
  return (
    <Stack gap="sm" data-testid="legacy-auto-unfollow-history">
      <Alert color="gray" variant="light">
        This earlier Auto-unfollow run is read-only. Its saved results are shown by handle.
      </Alert>
      {attempted.length ? (
        <Stack gap="xs" mah="48dvh" style={{ overflowY: "auto" }} pr={4}>
          {attempted.map((review) => (
            <ReviewDecisionCard key={review.handle} review={review}
                                showPersistedApplication />
          ))}
        </Stack>
      ) : (
        <Alert color="gray" variant="light">No accounts were recommended for unfollow.</Alert>
      )}
    </Stack>
  );
}

function KeptAccounts({ reviews }) {
  const kept = reviews.filter((review) => review.decision === "KEEP");
  if (!kept.length) return null;

  return (
    <Box component="details" data-testid="kept-accounts">
      <Box component="summary" style={{ cursor: "pointer" }}>
        <Text span size="xs" c="dimmed" data-testid="kept-account-count">
          {kept.length} {kept.length === 1 ? "account" : "accounts"} kept after review
        </Text>
      </Box>
      <Stack gap="xs" mt="xs" mah="48dvh" style={{ overflowY: "auto" }} pr={4}>
        {kept.map((review) => (
          <Box key={review.xUserId || review.handle}
               style={{ flexShrink: 0 }}
               data-testid={`kept-account-${review.xUserId || review.handle.replace(/^@/, "")}`}>
            <ReviewDecisionCard review={review} />
          </Box>
        ))}
      </Stack>
    </Box>
  );
}

function AutoUnfollowRecommendations({
  run,
  onReviewApprovedSet,
  savingSelection,
  selectionError,
}) {
  const recommended = run.reviews.filter((review) =>
    review.decision === "UNFOLLOW" && review.xUserId);
  const recommendedIds = recommended.map((review) => String(review.xUserId));
  const action = run.unfollowAction;
  const durableSelection = run.reviewedSelection;
  const storageKey = `x-sweeper.approved-set.${run.sourceId}`;
  const [draftSelectedIds, setDraftSelectedIds] = useState(() => {
    if (durableSelection?.targets?.length) {
      return durableSelection.targets
        .map((target) => String(target.xUserId))
        .filter((id) => recommendedIds.includes(id));
    }
    try {
      const stored = window.localStorage.getItem(storageKey);
      if (stored === null) return recommendedIds;
      const parsed = JSON.parse(stored);
      if (Array.isArray(parsed)) {
        return parsed.map(String).filter((id) => recommendedIds.includes(id));
      }
    } catch {}
    return recommendedIds;
  });
  const selectedIds = action?.targets?.length
    ? action.targets.map((target) => String(target.xUserId))
    : draftSelectedIds;

  const updateSelection = (ids) => {
    if (action) return;
    setDraftSelectedIds(ids);
    try { window.localStorage.setItem(storageKey, JSON.stringify(ids)); } catch {}
  };
  const selected = new Set(selectedIds);
  const approved = recommended.filter((review) => selected.has(String(review.xUserId)));
  const durableTargetIds = (durableSelection?.targets || [])
    .map((target) => String(target.xUserId));
  const approvedIds = approved.map((review) => String(review.xUserId));
  const draftMatchesDurableSelection = !!durableSelection
    && durableTargetIds.length === approvedIds.length
    && durableTargetIds.every((id, index) => id === approvedIds[index]);
  const approvedOrder = new Map(
    (action?.targets || []).map((target, index) => [String(target.xUserId), index + 1]),
  );
  const terminalResults = action?.results || [];
  const resultCounts = terminalResults.reduce((counts, result) => ({
    ...counts,
    [result.status]: (counts[result.status] || 0) + 1,
  }), {});

  if (!recommended.length) {
    return (
      <Alert color="gray" variant="light" data-testid="empty-recommendation-set">
        This review has no accounts recommended for Auto-unfollow.
      </Alert>
    );
  }

  return (
    <Stack gap="sm" data-testid="auto-unfollow-recommendations">
      <Group justify="space-between" gap="xs">
        <Box>
          <Text fw={700} size="sm">Auto-unfollow recommendations</Text>
          <Text size="xs" c="dimmed">
            {run.xAccount?.username ? `Connected as @${run.xAccount.username}. ` : ""}
            Review the exact accounts before anything changes.
          </Text>
        </Box>
        <Badge variant="light" color="orange" data-testid="recommendation-count">
          {recommended.length} recommended
        </Badge>
      </Group>

      <Stack gap="xs" mah="48dvh" style={{ overflowY: "auto" }} pr={4}>
        {recommended.map((review) => {
          const id = String(review.xUserId);
          const application = review.application;
          const resultHandle = application?.handle || review.handle;
          const isApproved = selected.has(id);
          const displayedStatus = isApproved
            ? application?.status || "APPLYING"
            : "EXCLUDED";
          const sequence = approvedOrder.get(id);
          return (
            <Card key={id} withBorder radius="md" padding="sm"
                  style={{ flexShrink: 0 }}
                  data-testid={`recommendation-${id}`}
                  data-recommendation-id={id}>
              <Group align="flex-start" wrap="nowrap" gap="sm">
                <Checkbox
                  mt={2}
                  checked={selected.has(id)}
                  disabled={!!action}
                  onChange={(event) => updateSelection(
                    event.currentTarget.checked
                      ? [...selectedIds, id]
                      : selectedIds.filter((candidate) => candidate !== id),
                  )}
                  aria-label={`Approve ${review.handle}`}
                  data-testid={`recommendation-select-${id}`}
                />
                <Box style={{ flex: 1, minWidth: 0 }}>
                  <Group justify="space-between" align="flex-start" wrap="nowrap" gap="xs">
                    <Box style={{ minWidth: 0 }}>
                      <Text fw={650} size="sm">{review.handle}</Text>
                      <Text size="xs" ff="monospace" c="dimmed">{id}</Text>
                    </Box>
                    <Group gap={4} justify="flex-end">
                      <Badge size="xs" variant="light" color="orange">UNFOLLOW</Badge>
                      {!isApproved && (
                        <Badge size="xs" variant="light" color="gray">EXCLUDED</Badge>
                      )}
                      {action && isApproved && (
                        <Badge size="xs" variant="light" color={
                          displayedStatus === "FAILED" ? "red" :
                          displayedStatus === "APPLYING" ? "yellow" : "gray"
                        }>
                          {sequence ? `${sequence} · ${displayedStatus}` : displayedStatus}
                        </Badge>
                      )}
                    </Group>
                  </Group>
                  <Text size="xs" c="dimmed" mt={4}>{review.reason}</Text>
                  {action && isApproved && (
                    <Box mt="xs" data-testid={`approved-unfollow-result-${id}`}>
                      {application?.status === "APPLIED" && (
                        <Text size="xs" fw={650}>{resultHandle} unfollowed through X</Text>
                      )}
                      {application?.status === "ALREADY_UNFOLLOWED" && (
                        <Text size="xs" fw={650}>{resultHandle} was already not followed</Text>
                      )}
                      {application?.status === "FAILED" && (
                        <Text size="xs" fw={650}>{resultHandle} failed · {application.detail}</Text>
                      )}
                      {application?.status === "NOT_COMPLETED" && (
                        <Text size="xs" fw={650}>
                          {resultHandle} not completed · {application.detail}
                        </Text>
                      )}
                      {(!application || application.status === "APPLYING") && (
                        <Text size="xs" fw={650}>Waiting for its turn…</Text>
                      )}
                      {application?.reviewedHandle && (
                        <Text size="xs" c="dimmed">Reviewed as {application.reviewedHandle}</Text>
                      )}
                    </Box>
                  )}
                </Box>
              </Group>
            </Card>
          );
        })}
      </Stack>

      <Box pos="sticky" bottom={0} bg="white" pt="xs" style={{ zIndex: 2 }}>
        {action ? (
          <Stack gap={4}>
            <Group justify="space-between" gap="xs">
              <Badge variant="light" color="gray">{approved.length} approved</Badge>
              <Text size="xs" c="dimmed" ff="monospace" data-testid="confirmed-action-id">
                {action.id}
              </Text>
            </Group>
            {["PENDING", "IN_PROGRESS"].includes(action.actionStatus) && (
              <Button fullWidth color="orange" variant="light" loading disabled>
                Applying approved accounts in order
              </Button>
            )}
            {action.actionStatus === "DONE" && (
              <Text size="xs" c="dimmed" data-testid="action-result-summary">
                {terminalResults.length}/{action.targets.length} complete
                {` · ${resultCounts.APPLIED || 0} applied`}
                {` · ${resultCounts.ALREADY_UNFOLLOWED || 0} already unfollowed`}
                {` · ${resultCounts.FAILED || 0} failed`}
                {` · ${recommended.length - approved.length} excluded`}
              </Text>
            )}
            {action.actionStatus === "FAILED" && (
              <Alert color="gray" variant="light" data-testid="action-failed">
                Action stopped · {action.detail || "An approved account could not be processed"}
              </Alert>
            )}
          </Stack>
        ) : (
          <Stack gap="xs">
            {durableSelection && draftMatchesDurableSelection && (
              <Text size="xs" c="dimmed" ff="monospace" data-testid="saved-selection-id">
                {durableSelection.selectionStatus === "FAILED"
                  ? "Selection failed"
                  : durableSelection.selectionStatus === "SAVED"
                    ? "Saved selection"
                    : "Saving selection"}
                {` ${durableSelection.id}`}
              </Text>
            )}
            {durableSelection && !draftMatchesDurableSelection && (
              <Text size="xs" c="dimmed" data-testid="selection-draft-changed">
                Unsaved changes · review this visible set to save a new selection
              </Text>
            )}
            <Group justify="space-between" gap="xs">
              <Button size="xs" variant="default" data-testid="select-all-recommendations"
                      onClick={() => updateSelection(recommendedIds)}>
                Accept all
              </Button>
              <Text size="sm" fw={650} data-testid="approved-count">
                {approved.length} approved
              </Text>
            </Group>
            {selectionError && <Alert color="red" variant="light">{selectionError}</Alert>}
            <Button fullWidth color="orange" disabled={!approved.length}
                    loading={savingSelection}
                    data-testid="review-approved-set"
                    onClick={() => onReviewApprovedSet({ run, targets: approved.map((review) => ({
                      handle: review.handle,
                      xUserId: String(review.xUserId),
                    })) })}>
              Review {approved.length} approved {approved.length === 1 ? "account" : "accounts"}
            </Button>
          </Stack>
        )}
      </Box>
    </Stack>
  );
}

function SweepResults({
  run,
  onRequestUnfollow,
  onReviewApprovedSet,
  savingSelection,
  selectionError,
}) {
  if (!run.candidates.length) return null;

  const reviewPending = run.reviews.length === 0 && overallStatus(run) === "IN_PROGRESS";
  return (
    <Stack gap="sm" mt="md" data-testid="sweep-results">
      <Divider />
      <Group gap="xs">
        <Badge variant="light" color="blue">{run.summary.candidates} candidates</Badge>
        {reviewPending ? (
          <Badge variant="light" color="yellow">Review pending</Badge>
        ) : (
          <>
            <Badge variant="light" color="gray">{run.summary.reviewed} reviewed</Badge>
            <Badge variant="light" color="teal">{run.summary.keep} KEEP</Badge>
            <Badge variant="light" color="orange">{run.summary.unfollow} UNFOLLOW</Badge>
          </>
        )}
      </Group>

      {run.reviews.length ? run.mode === "auto-unfollow" ? (
        <>
          {run.unfollowAction?.legacy ? (
            <LegacyAutoUnfollowHistory run={run} />
          ) : (
            <AutoUnfollowRecommendations
              key={`${run.sourceId}:${run.reviewedSelection?.id || "new"}`}
              run={run}
              onReviewApprovedSet={onReviewApprovedSet}
              savingSelection={savingSelection}
              selectionError={selectionError}
            />
          )}
          <KeptAccounts reviews={run.reviews} />
        </>
      ) : run.reviews.map((review) => (
        <ReviewDecisionCard key={review.handle} review={review}
                            allowIndividualAction onRequestUnfollow={onRequestUnfollow} />
      )) : (
        <Stack gap={4}>
          {run.candidates.map((handle) => (
            <Text key={handle} size="sm" ff="monospace">{handle}</Text>
          ))}
        </Stack>
      )}
    </Stack>
  );
}

// ─── Agent information ───

function AgentInfoButton() {
  const [status, setStatus] = useState(null);
  const [opened, setOpened] = useState(false);
  useEffect(() => {
    fetchAgentStatus().then(setStatus);
    const iv = setInterval(() => fetchAgentStatus().then(setStatus), 15000);
    return () => clearInterval(iv);
  }, []);
  return (
    <>
      <ActionIcon variant="subtle" color="gray" size="sm" aria-label="Agent information"
                  onClick={() => setOpened(true)}>
        <IconInfoCircle size={18} />
      </ActionIcon>
      <Modal opened={opened} onClose={() => setOpened(false)} centered size="xs" title="Agent information">
        <Stack gap="sm">
          <AgentInfoRow
            label="Agent"
            value={status?.service === "ok" ? "Online" : status ? "Unreachable" : "Checking…"}
          />
          <AgentInfoRow
            label="X API"
            value={status?.xApi?.configured && !status?.xApi?.error
              ? "Connected"
              : status ? "Unavailable" : "Checking…"}
          />
          <AgentInfoRow label="X account" value={status?.xApi?.account || "—"} />
          <AgentInfoRow label="Model" value={status?.model || "—"} />
          <AgentInfoRow
            label="OpenRouter"
            value={status?.openrouter === "configured" ? "Configured" : status ? "Unavailable" : "Checking…"}
          />
        </Stack>
      </Modal>
    </>
  );
}

function AgentInfoRow({ label, value }) {
  return (
    <Group justify="space-between" gap="md" wrap="nowrap">
      <Text size="sm" c="dimmed">{label}</Text>
      <Text size="sm" fw={600} ta="right">{value}</Text>
    </Group>
  );
}

// ─── The page: every sweep run from the outcome engine ───

export default function RunsPage() {
  const [stepsRun, setStepsRun] = useState(null);
  const [runs, setRuns] = useState(null);
  const [error, setError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [triggering, setTriggering] = useState(false);
  const [triggerError, setTriggerError] = useState(null);
  const [activeSweepId, setActiveSweepId] = useState(null);
  const [confirmUnfollow, setConfirmUnfollow] = useState(null);
  const [applyingUnfollow, setApplyingUnfollow] = useState(false);
  const [unfollowError, setUnfollowError] = useState(null);
  const [confirmApprovedSet, setConfirmApprovedSet] = useState(null);
  const [savingSelection, setSavingSelection] = useState(false);
  const [selectionError, setSelectionError] = useState(null);
  const [applyingApprovedSet, setApplyingApprovedSet] = useState(false);
  const [approvedSetError, setApprovedSetError] = useState(null);
  const approvedSetRequestRef = useRef(false);
  const selectionRequestRef = useRef(false);
  const pendingApprovedActionsRef = useRef(loadPendingApprovedActions());
  const { autoUnfollow, sweepCount, ready: settingsReady } = useSweepSettings();

  useEffect(() => {
    let active = true;
    const refresh = () => fetchRuns()
      .then((mapped) => {
        if (!active) return;
        const reconciled = reconcilePendingApprovedActions(
          mapped,
          pendingApprovedActionsRef.current,
        );
        if (reconciled.changed) {
          pendingApprovedActionsRef.current = reconciled.remaining;
          persistPendingApprovedActions(reconciled.remaining);
        }
        setError(false);
        setRuns(reconciled.visibleRuns);
        setStepsRun((opened) => opened
          ? reconciled.visibleRuns.find((run) => run.id === opened.id) || opened
          : opened);
        setConfirmApprovedSet((confirmation) => {
          if (!confirmation) return confirmation;
          const liveRun = reconciled.visibleRuns.find(
            (run) => run.sourceId === confirmation.run.sourceId,
          );
          if (!liveRun?.reviewedSelection) {
            return confirmation;
          }
          if (liveRun.reviewedSelection.id !== confirmation.selectionId) {
            if (confirmation.run.reviewedSelection?.optimistic) return confirmation;
            return { ...confirmation, run: liveRun, superseded: true };
          }
          return {
            ...confirmation,
            run: liveRun,
            targets: liveRun.reviewedSelection.targets,
            superseded: false,
          };
        });
      })
      .catch((e) => {
        console.error("Error fetching runs:", e);
        if (active) setError(true);
      });
    refresh();
    const interval = setInterval(refresh, 1000);
    return () => { active = false; clearInterval(interval); };
  }, [reloadKey]);

  const retry = () => { setRuns(null); setError(false); setReloadKey((k) => k + 1); };

  const failedCount = runs ? runs.filter((r) => overallStatus(r) === "FAILED").length : 0;
  const inProgress = runs ? runs.filter((r) => overallStatus(r) === "IN_PROGRESS").length : 0;

  const handleTrigger = async () => {
    setTriggering(true);
    setTriggerError(null);
    try {
      const accepted = await triggerRun({
        mode: autoUnfollow ? "reviewed-auto-unfollow" : "dry-run",
        count: sweepCount,
      });
      setActiveSweepId(accepted.id);
      setTriggering(false);
      setReloadKey((key) => key + 1);
    } catch (e) {
      console.error("Could not start sweep:", e);
      setTriggerError(e instanceof Error ? e.message : "Could not start sweep");
      setTriggering(false);
    }
  };

  const handleUnfollow = async () => {
    if (!confirmUnfollow || applyingUnfollow) return;
    setApplyingUnfollow(true);
    setUnfollowError(null);
    try {
      await triggerUnfollow({
        sweepId: stepsRun.sourceId,
        handle: confirmUnfollow.handle,
        xUserId: confirmUnfollow.xUserId,
      });
      setConfirmUnfollow(null);
      setReloadKey((key) => key + 1);
    } catch (e) {
      setUnfollowError(e instanceof Error ? e.message : "Could not apply unfollow");
    } finally {
      setApplyingUnfollow(false);
    }
  };

  const handleReviewApprovedSet = async ({ run, targets }) => {
    if (savingSelection || selectionRequestRef.current) return;
    selectionRequestRef.current = true;
    setSavingSelection(true);
    setSelectionError(null);
    try {
      const normalizedTargets = targets.map((target) => ({
        handle: String(target.handle),
        xUserId: String(target.xUserId),
      }));
      const accepted = await triggerSelection({
        sweepId: run.sourceId,
        targets: normalizedTargets,
      });
      const reviewedSelection = {
        id: String(accepted.id),
        deliveryId: null,
        sweepId: run.sourceId,
        sweepDeliveryId: String(run.id),
        sourceXUserId: run.xAccount?.id ? String(run.xAccount.id) : null,
        targets: normalizedTargets,
        selectionStatus: "SAVING",
        createdAt: new Date().toISOString(),
        optimistic: true,
      };
      const projectSelection = (candidate) => candidate?.sourceId === run.sourceId
        ? { ...candidate, reviewedSelection }
        : candidate;
      setRuns((current) => current?.map(projectSelection) || current);
      setStepsRun((current) => projectSelection(current));
      setConfirmApprovedSet({
        run: { ...run, reviewedSelection },
        targets: normalizedTargets,
        selectionId: reviewedSelection.id,
        superseded: false,
      });
    } catch (e) {
      setSelectionError(e instanceof Error ? e.message : "Could not save reviewed selection");
    } finally {
      selectionRequestRef.current = false;
      setSavingSelection(false);
    }
  };

  const handleApprovedSet = async () => {
    if (!confirmApprovedSet || applyingApprovedSet || approvedSetRequestRef.current) return;
    if (
      confirmApprovedSet.run.reviewedSelection?.id !== confirmApprovedSet.selectionId
      || confirmApprovedSet.run.reviewedSelection?.selectionStatus !== "SAVED"
    ) return;
    approvedSetRequestRef.current = true;
    setApplyingApprovedSet(true);
    setApprovedSetError(null);
    try {
      const sweepId = confirmApprovedSet.run.sourceId;
      const targets = confirmApprovedSet.targets.map((target) => ({
        handle: String(target.handle),
        xUserId: String(target.xUserId),
      }));
      const accepted = await triggerUnfollowSet({
        sweepId,
        selectionId: confirmApprovedSet.selectionId,
      });
      const pendingAction = {
        id: String(accepted.id),
        sweepId,
        sweepDeliveryId: String(confirmApprovedSet.run.id),
        selectionId: String(confirmApprovedSet.selectionId),
        targets,
        results: [],
        actionStatus: "PENDING",
        createdAt: new Date().toISOString(),
        optimistic: true,
      };
      const pendingActions = {
        ...pendingApprovedActionsRef.current,
        [sweepId]: pendingAction,
      };
      pendingApprovedActionsRef.current = pendingActions;
      persistPendingApprovedActions(pendingActions);

      const projectAcceptedAction = (run) => run?.sourceId === sweepId && !run.unfollowAction
        ? withApprovedUnfollowAction(run, pendingAction)
        : run;
      setRuns((current) => current?.map(projectAcceptedAction) || current);
      setStepsRun(projectAcceptedAction);
      try {
        window.localStorage.removeItem(
          `x-sweeper.approved-set.${sweepId}`,
        );
      } catch {}
      setConfirmApprovedSet(null);
      setReloadKey((key) => key + 1);
    } catch (e) {
      setApprovedSetError(e instanceof Error ? e.message : "Could not apply approved accounts");
    } finally {
      approvedSetRequestRef.current = false;
      setApplyingApprovedSet(false);
    }
  };

  const confirmedSelection = confirmApprovedSet?.run.reviewedSelection;
  const confirmedSelectionSuperseded = confirmApprovedSet?.superseded === true
    || (!!confirmedSelection?.id
      && confirmedSelection.id !== confirmApprovedSet?.selectionId
      && !confirmedSelection.optimistic);
  const confirmedSelectionSaved = !confirmedSelectionSuperseded
    && confirmedSelection?.id === confirmApprovedSet?.selectionId
    && confirmedSelection?.selectionStatus === "SAVED";
  const confirmedSelectionFailed = !confirmedSelectionSuperseded
    && confirmedSelection?.id === confirmApprovedSet?.selectionId
    && confirmedSelection?.selectionStatus === "FAILED";

  return (
    <Box bg="gray.2" mih="calc(100dvh - var(--app-shell-header-height, 46px) - var(--app-shell-footer-height, 74px))">
      <Container size="sm" bg="white" mih="calc(100dvh - var(--app-shell-header-height, 46px) - var(--app-shell-footer-height, 74px))" pb="xl">
        <Box pos="sticky" bg="white" mx="calc(-1 * var(--mantine-spacing-md))" px="md"
             style={{ top: "var(--app-shell-header-height, 46px)", zIndex: 5 }}>
          <Group justify="space-between" py="xs">
            <Text fw="bold" data-testid="runs-heading">Runs</Text>
            <Group gap="xs" wrap="nowrap">
              {runs && (
                <Text size="xs" c="dimmed">
                  {runs.length}
                  {inProgress > 0 && <Text span inherit> · {inProgress} active</Text>}
                  {failedCount > 0 && <Text span inherit> · {failedCount} failed</Text>}
                </Text>
              )}
              <AgentInfoButton />
              <Button size="xs" variant="light" leftSection={<IconPlayerPlay size={14} />}
                      loading={triggering} disabled={!settingsReady} onClick={handleTrigger} data-testid="new-sweep">
                New Run
              </Button>
            </Group>
          </Group>
          <Divider mx="calc(-1 * var(--mantine-spacing-md))" />
        </Box>

        {triggerError && (
          <Alert mt="sm" color="red" icon={<IconAlertTriangle size={16} />} title="Could not start sweep"
                 withCloseButton onClose={() => setTriggerError(null)}>
            {triggerError}
          </Alert>
        )}

        {error ? (
          <Stack align="center" gap="xs" py="md">
            <Text size="sm" c="red">Could not load sweep runs.</Text>
            <Button variant="light" size="xs" onClick={retry}>Retry</Button>
          </Stack>
        ) : runs === null ? (
          <Stack mt="md">
            {Array.from({ length: 3 }, (_, i) => (
              <Card key={i} withBorder>
                <Stack gap={4}>
                  <Skeleton h={14} w={180} />
                  <Skeleton h={12} w={260} />
                  <Skeleton h={12} w={220} />
                </Stack>
              </Card>
            ))}
          </Stack>
        ) : runs.length > 0 ? (
          <Stack gap={0}>
            {runs.map((r, i) => (
              <Box key={r.id} data-sweep-id={r.sourceId}
                   data-active-sweep={r.sourceId === activeSweepId ? "true" : undefined}>
                {i > 0 && <Divider mx="calc(-1 * var(--mantine-spacing-md))" />}
                <Box py="md">
                  <Group gap={8} wrap="nowrap" align="center" data-testid="run-title-row">
                    <Box component="span" c={overallStatus(r) === "FAILED" ? "red.6" : "dark.6"}
                         style={{ display: "inline-flex", flexShrink: 0 }}>
                      {stepGlyph(overallStatus(r), 16, { double: overallStatus(r) === "DONE" })}
                    </Box>
                    <Text fw={600} size="sm" truncate style={{ minWidth: 0 }}>{r.title}</Text>
                    <Badge variant="light" color="gray" size="xs" radius="sm"
                           data-testid="run-mode" style={{ flexShrink: 0 }}>
                      {r.mode}
                    </Badge>
                    <Text span size="xs" c="dimmed" style={{ flexShrink: 0, whiteSpace: "nowrap" }}>
                      {"· "}
                      <span title={fmtDateTime(r.lastActivityAt)}
                            style={{ cursor: "help", textDecoration: "underline dotted", textDecorationColor: "var(--mantine-color-gray-4)" }}>
                        {relativeTime(r.lastActivityAt)}
                      </span>
                    </Text>
                  </Group>
                  {r.handle && (
                    <Group gap={6} mt={4} wrap="nowrap">
                      <Text size="xs" c="dimmed" truncate style={{ minWidth: 0 }}>{r.handle}</Text>
                    </Group>
                  )}
                  <RunStatusSummary run={r} onOpen={() => setStepsRun(r)} />
                  {r.reviews.length > 0 && (
                    <Text size="xs" c="dimmed" mt={6}>
                      {r.summary.reviewed} reviewed · {r.summary.keep} KEEP · {r.summary.unfollow} UNFOLLOW
                    </Text>
                  )}
                </Box>
              </Box>
            ))}
          </Stack>
        ) : (
          <Stack align="center" gap="xs" py="xl">
            <IconBrandTwitterFilled size={32} color="var(--mantine-color-gray-3)" />
            <Text size="sm" c="dimmed">No sweep runs yet.</Text>
            <Text size="xs" c="dimmed">Trigger a new run to get started.</Text>
            <Button size="xs" variant="light" mt="sm" leftSection={<IconPlayerPlay size={14} />}
                    disabled={!settingsReady} onClick={handleTrigger} data-testid="new-sweep">
              New Run
            </Button>
          </Stack>
        )}

        <Modal opened={!!stepsRun} onClose={() => setStepsRun(null)} centered size="sm" radius="md" padding="lg"
               title={stepsRun && (
                 <Group gap={6} wrap="nowrap">
                   <IconBrandTwitterFilled size={18} color="var(--mantine-color-gray-6)" />
                   <Text fw={600} size="sm">{stepsRun.title}</Text>
                 </Group>
               )}>
          {stepsRun && <RunSteps run={stepsRun} />}
          {stepsRun?.errorDetail && (
            <Alert color="red" variant="light" p="xs" mt="sm" icon={<IconAlertTriangle size={16} />}
                   styles={{ wrapper: { alignItems: "flex-start" }, message: { fontSize: "var(--mantine-font-size-xs)" } }}>
              {stepsRun.errorDetail}
            </Alert>
          )}
          {stepsRun && (
            <SweepResults
              run={stepsRun}
              onRequestUnfollow={setConfirmUnfollow}
              onReviewApprovedSet={(selection) => {
                setApprovedSetError(null);
                handleReviewApprovedSet(selection);
              }}
              savingSelection={savingSelection}
              selectionError={selectionError}
            />
          )}
        </Modal>

        <Modal
          opened={!!confirmApprovedSet}
          onClose={() => !applyingApprovedSet && setConfirmApprovedSet(null)}
          closeOnClickOutside={!applyingApprovedSet}
          closeOnEscape={!applyingApprovedSet}
          centered
          size="sm"
          radius="md"
          title="Confirm Auto-unfollow"
        >
          <Stack gap="sm">
            <Box>
              <Text size="sm" fw={650}>Confirm this exact approved set once</Text>
              <Text size="xs" c="dimmed" mt={2}>
                {confirmApprovedSet?.run.xAccount?.username
                  ? `Connected as @${confirmApprovedSet.run.xAccount.username}. `
                  : ""}
                The accounts below will be unfollowed automatically and sequentially through the X API.
              </Text>
              {confirmApprovedSet?.selectionId && (
                <Text size="xs" c="dimmed" ff="monospace" mt={4}
                  data-testid="saved-selection-id">
                  {confirmedSelectionSuperseded
                    ? "Replaced selection"
                    : confirmedSelectionFailed
                      ? "Failed selection"
                    : confirmedSelectionSaved
                      ? "Saved selection"
                      : "Saving selection"}
                  {` ${confirmApprovedSet.selectionId}`}
                </Text>
              )}
            </Box>

            <Stack gap="xs" mah="48dvh" style={{ overflowY: "auto" }} pr={4}>
              {confirmApprovedSet?.targets.map((target, index) => (
                <Card key={target.xUserId} withBorder radius="md" padding="sm"
                      style={{ flexShrink: 0 }}
                      data-testid={`confirm-target-${target.xUserId}`}>
                  <Group wrap="nowrap" gap="sm" align="flex-start">
                    <Badge variant="light" color="gray" circle>{index + 1}</Badge>
                    <Box style={{ minWidth: 0 }}>
                      <Text size="sm" fw={650}>{target.handle}</Text>
                      <Text size="xs" c="dimmed" ff="monospace">{target.xUserId}</Text>
                    </Box>
                  </Group>
                </Card>
              ))}
            </Stack>

            {confirmedSelectionSuperseded && (
              <Alert color="orange" variant="light" data-testid="selection-superseded">
                This selection was replaced. Close this confirmation and review the visible set again.
              </Alert>
            )}
            {confirmedSelectionFailed && (
              <Alert color="gray" variant="light" data-testid="selection-failed">
                The reviewed set could not be saved
                {confirmedSelection?.detail ? ` · ${confirmedSelection.detail}` : "."}
                {" "}Close this confirmation and review the visible set again.
              </Alert>
            )}
            {approvedSetError && <Alert color="red">{approvedSetError}</Alert>}

            <Group justify="flex-end" pos="sticky" bottom={0} bg="white" pt="xs">
              <Button variant="default" size="xs" disabled={applyingApprovedSet}
                      onClick={() => setConfirmApprovedSet(null)}>
                Cancel
              </Button>
              <Button color="orange" size="xs"
                      disabled={!confirmedSelectionSaved}
                      loading={applyingApprovedSet || (
                        !!confirmApprovedSet
                        && !confirmedSelectionSaved
                        && !confirmedSelectionSuperseded
                        && !confirmedSelectionFailed
                      )}
                      data-testid="confirm-approved-set" onClick={handleApprovedSet}>
                Confirm and unfollow {confirmApprovedSet?.targets.length || 0}
              </Button>
            </Group>
          </Stack>
        </Modal>

        <Modal opened={!!confirmUnfollow} onClose={() => !applyingUnfollow && setConfirmUnfollow(null)}
               centered size="xs" radius="md" title="Confirm unfollow">
          <Stack gap="sm">
            <Text size="sm">
              Unfollow <Text span fw={700}>{confirmUnfollow?.handle}</Text> from this reviewed sweep?
            </Text>
            {unfollowError && <Alert color="red">{unfollowError}</Alert>}
            <Group justify="flex-end">
              <Button variant="default" size="xs" disabled={applyingUnfollow}
                      onClick={() => setConfirmUnfollow(null)}>Cancel</Button>
              <Button color="orange" size="xs" loading={applyingUnfollow} onClick={handleUnfollow}>
                Unfollow
              </Button>
            </Group>
          </Stack>
        </Modal>
      </Container>
    </Box>
  );
}

"use client";

// Sweep Runs — the outcome-engine-backed run list (data layer in src/lib/engine.js).
import { useEffect, useRef, useState } from "react";
import { Alert, Box, Button, Container, Divider, Group, Modal, Stack, Text, UnstyledButton, Card, Skeleton, Badge } from "@mantine/core";
import { IconAlertTriangle, IconBrandTwitterFilled, IconCheck, IconChecks, IconCircleDashed, IconClock, IconLoader2, IconPlayerPlay, IconX } from "@tabler/icons-react";
import { fetchRuns, fetchAgentStatus, triggerRun, overallStatus, furthestStep, PIPELINE, STEP_LABEL } from "@/lib/engine";
import { fmtMs, fmtDateTime, fmtTime, fmtStamp, relativeTime } from "@/lib/format";

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
  const lastStamp = last.at ?? last.startedAt;
  const elapsed = !inFlight && run.createdAt && lastStamp
    ? fmtMs(new Date(lastStamp).getTime() - new Date(run.createdAt).getTime())
    : inFlight && last.startedAt
      ? fmtMs(Date.now() - new Date(last.startedAt).getTime())
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

// ─── Agent status bar ───

function AgentStatusBar() {
  const [status, setStatus] = useState(null);
  useEffect(() => {
    fetchAgentStatus().then(setStatus);
    const iv = setInterval(() => fetchAgentStatus().then(setStatus), 15000);
    return () => clearInterval(iv);
  }, []);
  return (
    <Group gap={6} mb="xs" wrap="nowrap" align="center">
      <Box w={8} h={8} style={{
        borderRadius: "50%",
        background: status?.service === "ok" ? "var(--mantine-color-teal-6)"
                  : status ? "var(--mantine-color-red-6)"
                  : "var(--mantine-color-gray-4)",
      }} />
      <Text size="xs" c="dimmed">
        {status?.service === "ok" ? "Agent online"
         : status ? "Agent unreachable"
         : "Checking agent…"}
      </Text>
      {status?.chrome === "ok" && (
        <Text size="xs" c="dimmed">· Chrome OK</Text>
      )}
      {status?.model && (
        <Text size="xs" c="dimmed">· {status.model}</Text>
      )}
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

  useEffect(() => {
    let active = true;
    setRuns(null);
    setError(false);
    fetchRuns()
      .then((mapped) => { if (active) setRuns(mapped); })
      .catch((e) => {
        console.error("Error fetching runs:", e);
        if (active) setError(true);
      });
    return () => { active = false; };
  }, [reloadKey]);

  const retry = () => { setRuns(null); setError(false); setReloadKey((k) => k + 1); };

  const failedCount = runs ? runs.filter((r) => overallStatus(r) === "FAILED").length : 0;
  const inProgress = runs ? runs.filter((r) => overallStatus(r) === "IN_PROGRESS").length : 0;

  const handleTrigger = async () => {
    setTriggering(true);
    try {
      await triggerRun({ mode: "dry-run" });
      // Refresh after a moment
      setTimeout(() => { retry(); setTriggering(false); }, 2000);
    } catch {
      setTriggering(false);
    }
  };

  return (
    <Box bg="gray.2" mih="calc(100dvh - var(--app-shell-header-height, 46px) - var(--app-shell-footer-height, 56px))">
      <Container size="sm" bg="white" mih="calc(100dvh - var(--app-shell-header-height, 46px) - var(--app-shell-footer-height, 56px))" pb="xl">
        <Box pos="sticky" bg="white" mx="calc(-1 * var(--mantine-spacing-md))" px="md"
             style={{ top: "var(--app-shell-header-height, 46px)", zIndex: 5 }}>
          <Group justify="space-between" py="xs">
            <Group gap={6} wrap="nowrap">
              <IconBrandTwitterFilled size={18} color="var(--mantine-color-gray-6)" />
              <Text fw="bold">Sweep Runs</Text>
            </Group>
            <Group gap="xs" wrap="nowrap">
              {runs && (
                <Text size="xs" c="dimmed">
                  {runs.length}
                  {inProgress > 0 && <Text span inherit c="teal.7"> · {inProgress} active</Text>}
                  {failedCount > 0 && <Text span inherit c="red.7"> · {failedCount} failed</Text>}
                </Text>
              )}
              <Button size="xs" variant="light" leftSection={<IconPlayerPlay size={14} />}
                      loading={triggering} onClick={handleTrigger}>
                New Run
              </Button>
            </Group>
          </Group>
          <AgentStatusBar />
          <Divider mx="calc(-1 * var(--mantine-spacing-md))" />
        </Box>

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
              <Box key={r.id}>
                {i > 0 && <Divider mx="calc(-1 * var(--mantine-spacing-md))" />}
                <Box py="md">
                  <Group gap={8} wrap="nowrap" align="center">
                    <Box component="span" c={overallStatus(r) === "FAILED" ? "red.6" : "dark.6"}
                         style={{ display: "inline-flex", flexShrink: 0 }}>
                      {stepGlyph(overallStatus(r), 16, { double: overallStatus(r) === "DONE" })}
                    </Box>
                    <Text fw={600} size="sm" truncate style={{ minWidth: 0 }}>{r.title}</Text>
                    <Text span size="xs" c="dimmed" style={{ flexShrink: 0, whiteSpace: "nowrap" }}>
                      {"· "}
                      <span title={fmtDateTime(r.lastActivityAt)}
                            style={{ cursor: "help", textDecoration: "underline dotted", textDecorationColor: "var(--mantine-color-gray-4)" }}>
                        {relativeTime(r.lastActivityAt)}
                      </span>
                    </Text>
                  </Group>
                  <Group gap={6} mt={4} wrap="nowrap">
                    <Badge variant="light" color="gray" size="xs" radius="sm" style={{ flexShrink: 0 }}>
                      {r.mode}
                    </Badge>
                    {r.handle && (
                      <Text size="xs" c="dimmed" truncate style={{ minWidth: 0 }}>{r.handle}</Text>
                    )}
                  </Group>
                  <RunStatusSummary run={r} onOpen={() => setStepsRun(r)} />
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
                    onClick={handleTrigger}>
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
        </Modal>
      </Container>
    </Box>
  );
}
"use client";

import { useEffect, useState } from "react";
import { Box, Container, Group, Stack, Text, Card, Skeleton, Divider, Badge } from "@mantine/core";
import { IconBrandTwitterFilled, IconHealthRecognition, IconBrowser, IconCpu, IconPlugConnected } from "@tabler/icons-react";
import { fetchAgentStatus } from "@/lib/engine";

export default function StatusPage() {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    const load = async () => {
      const s = await fetchAgentStatus();
      if (active) { setStatus(s); setLoading(false); }
    };
    load();
    const iv = setInterval(load, 10000);
    return () => { active = false; clearInterval(iv); };
  }, []);

  const ok = status?.service === "ok";

  return (
    <Box bg="gray.2" mih="calc(100dvh - var(--app-shell-header-height, 46px) - var(--app-shell-footer-height, 56px))">
      <Container size="sm" bg="white" mih="calc(100dvh - var(--app-shell-header-height, 46px) - var(--app-shell-footer-height, 56px))" pb="xl">
        <Box pos="sticky" bg="white" mx="calc(-1 * var(--mantine-spacing-md))" px="md"
             style={{ top: "var(--app-shell-header-height, 46px)", zIndex: 5 }}>
          <Group gap={6} py="xs">
            <IconHealthRecognition size={18} color="var(--mantine-color-gray-6)" />
            <Text fw="bold">Agent Status</Text>
          </Group>
          <Divider mx="calc(-1 * var(--mantine-spacing-md))" />
        </Box>

        {loading ? (
          <Stack mt="md" gap="sm">
            <Skeleton h={60} />
            <Skeleton h={60} />
            <Skeleton h={60} />
          </Stack>
        ) : (
          <Stack mt="md" gap="sm">
            <Card withBorder>
              <Group gap="sm" wrap="nowrap" align="center">
                <IconBrandTwitterFilled size={24} color={ok ? "var(--mantine-color-teal-6)" : "var(--mantine-color-red-6)"} />
                <Box style={{ flex: 1 }}>
                  <Text fw={600} size="sm">Sweeper Agent</Text>
                  <Text size="xs" c="dimmed">
                    {ok ? "Online and operational" : "Unreachable"}
                  </Text>
                </Box>
                <Badge color={ok ? "teal" : "red"} variant="light" size="lg">
                  {ok ? "OK" : "DOWN"}
                </Badge>
              </Group>
            </Card>

            <Card withBorder>
              <Stack gap="sm">
                <Group gap="sm" wrap="nowrap" align="center">
                  <IconBrowser size={20} color="var(--mantine-color-gray-6)" />
                  <Text fw={600} size="sm">Chrome CDP</Text>
                  <Badge color={status?.chrome === "ok" ? "teal" : "red"} variant="light" size="sm">
                    {status?.chrome === "ok" ? "Connected" : "Error"}
                  </Badge>
                </Group>
                {status?.chrome !== "ok" && status?.chrome && (
                  <Text size="xs" c="red">{status.chrome}</Text>
                )}
              </Stack>
            </Card>

            <Card withBorder>
              <Group gap="sm" wrap="nowrap" align="center">
                <IconCpu size={20} color="var(--mantine-color-gray-6)" />
                <Box style={{ flex: 1 }}>
                  <Text fw={600} size="sm">Model</Text>
                  <Text size="xs" c="dimmed">{status?.model || "—"}</Text>
                </Box>
              </Group>
            </Card>

            <Card withBorder>
              <Group gap="sm" wrap="nowrap" align="center">
                <IconPlugConnected size={20} color="var(--mantine-color-gray-6)" />
                <Box style={{ flex: 1 }}>
                  <Text fw={600} size="sm">OpenRouter</Text>
                  <Text size="xs" c="dimmed">
                    {status?.openrouter === "configured" ? "Configured" : "—"}
                  </Text>
                </Box>
                <Badge color={status?.openrouter === "configured" ? "teal" : "gray"} variant="light" size="sm">
                  {status?.openrouter === "configured" ? "OK" : "N/A"}
                </Badge>
              </Group>
            </Card>
          </Stack>
        )}
      </Container>
    </Box>
  );
}
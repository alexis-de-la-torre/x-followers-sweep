"use client";
import { AppShell, Group, Text } from "@mantine/core";
import { IconBrandTwitterFilled } from "@tabler/icons-react";

export default function AppLayout({ children }) {
  return (
    <AppShell header={{ height: 46 }} footer={{ height: 74 }} withBorder>
      <AppShell.Header bg="white">
        <Group h="100%" px="md" justify="space-between" style={{ position: "relative" }}>
          <div />
          <Group gap={6} align="center" wrap="nowrap"
                 style={{ position: "absolute", left: "50%", top: "50%", transform: "translate(-50%, -50%)" }}>
            <IconBrandTwitterFilled size={18} color="var(--mantine-color-gray-6)"
                                     style={{ display: "block", flexShrink: 0, transform: "translateY(-2px)" }} />
            <Text fw="bold">X Sweeper</Text>
          </Group>
          <div />
        </Group>
      </AppShell.Header>
      <AppShell.Main>{children}</AppShell.Main>
    </AppShell>
  );
}

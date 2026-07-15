"use client";
import { AppShell, Group, Text, UnstyledButton } from "@mantine/core";
import { IconBrandTwitterFilled, IconListDetails, IconHealthRecognition } from "@tabler/icons-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

export default function AppLayout({ children }) {
  const pathname = usePathname();
  return (
    <AppShell header={{ height: 46 }} footer={{ height: 56 }} withBorder>
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
      <AppShell.Footer bg="white">
        <Group h="100%" justify="space-around" align="center">
          <TabIcon href="/" label="Runs" active={pathname === "/" || pathname.startsWith("/run/")} Icon={IconListDetails} />
          <TabIcon href="/status" label="Status" active={pathname === "/status"} Icon={IconHealthRecognition} />
        </Group>
      </AppShell.Footer>
    </AppShell>
  );
}

function TabIcon({ href, label, active, Icon }) {
  const color = active ? "var(--mantine-color-dark-8)" : "var(--mantine-color-gray-5)";
  return (
    <UnstyledButton component={Link} href={href} aria-label={label} aria-current={active ? "page" : undefined}
                    style={{ display: "inline-flex", padding: 10 }}>
      <Icon size={26} stroke={active ? 2.2 : 1.6} color={color} />
    </UnstyledButton>
  );
}
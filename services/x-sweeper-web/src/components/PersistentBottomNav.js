"use client";

import { Box, Group, Text, UnstyledButton } from "@mantine/core";
import { IconAdjustments, IconHealthRecognition, IconListDetails } from "@tabler/icons-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

const DESTINATIONS = [
  { href: "/", label: "Runs", Icon: IconListDetails, matches: (pathname) => pathname === "/" || pathname.startsWith("/run/") },
  { href: "/status", label: "Status", Icon: IconHealthRecognition, matches: (pathname) => pathname === "/status" },
  { href: "/config", label: "Config", Icon: IconAdjustments, matches: (pathname) => pathname === "/config" },
];

export default function PersistentBottomNav() {
  const pathname = usePathname();
  const activeIndex = Math.max(0, DESTINATIONS.findIndex(({ matches }) => matches(pathname)));

  return (
    <Box
      component="footer"
      h={74}
      pos="fixed"
      bottom={0}
      left={0}
      right={0}
      style={{ border: 0, display: "flex", alignItems: "flex-start", zIndex: 100 }}
    >
      <Box
        component="nav"
        aria-label="Primary navigation"
        data-testid="floating-bottom-nav"
        h={54}
        w="calc(100% - 48px)"
        maw={248}
        mx="auto"
        mt={8}
        style={{
          background: "rgba(255, 255, 255, 0.72)",
          backdropFilter: "blur(6px)",
          WebkitBackdropFilter: "blur(6px)",
          borderRadius: 999,
          boxShadow: "0 4px 18px rgba(0, 0, 0, 0.09)",
          overflow: "hidden",
        }}
      >
        <Group h="100%" gap={0} justify="center" wrap="nowrap" pos="relative">
          {DESTINATIONS.map(({ href, label, Icon }, index) => {
            const active = index === activeIndex;
            return (
              <UnstyledButton
                key={href}
                component={Link}
                href={href}
                aria-label={label}
                aria-current={active ? "page" : undefined}
                style={{
                  width: 72,
                  height: "100%",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  zIndex: 1,
                }}
              >
                <Box
                  w={48}
                  h={38}
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 2,
                  }}
                >
                  <Icon size={22} stroke={active ? 2.4 : 1.7} color="var(--mantine-color-black)" />
                  <Text fz={9} fw={700} c="black">{label}</Text>
                </Box>
              </UnstyledButton>
            );
          })}
          <Box
            aria-hidden="true"
            data-testid="bottom-nav-indicator"
            className="bottom-nav-indicator"
            style={{
              position: "absolute",
              width: 6,
              height: 6,
              bottom: 4,
              left: "50%",
              transform: `translateX(calc(-50% + ${(activeIndex - 1) * 72}px))`,
              background: "var(--mantine-primary-color-filled)",
              borderRadius: "50%",
              pointerEvents: "none",
              zIndex: 0,
              willChange: "transform",
            }}
          />
        </Group>
      </Box>
    </Box>
  );
}

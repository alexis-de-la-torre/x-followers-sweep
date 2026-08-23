import { MantineProvider, ColorSchemeScript } from "@mantine/core";
import AppLayout from "@/components/AppLayout";
import PersistentBottomNav from "@/components/PersistentBottomNav";
import SweepSettingsProvider from "@/components/SweepSettingsProvider";
import "./globals.css";

export const metadata = {
  title: "X Sweeper — Sweep Runs",
  description: "X (Twitter) follower cleanup runs: steps, timing, current state",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <ColorSchemeScript />
      </head>
      <body suppressHydrationWarning>
        <MantineProvider>
          <SweepSettingsProvider>
            <AppLayout>{children}</AppLayout>
            <PersistentBottomNav />
          </SweepSettingsProvider>
        </MantineProvider>
      </body>
    </html>
  );
}

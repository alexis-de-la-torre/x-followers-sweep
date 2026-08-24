import { defineConfig } from "cypress";
import { execFileSync } from "node:child_process";

function kubectlJson(args) {
  return JSON.parse(execFileSync("kubectl", args, { encoding: "utf8" }));
}

export default defineConfig({
  e2e: {
    baseUrl: "http://localhost:3000",
    supportFile: "cypress/support/e2e.js",
    specPattern: "cypress/e2e/**/*.cy.js",
    viewportWidth: 390,
    viewportHeight: 844, // iPhone 14 Pro size — mobile-first
    defaultCommandTimeout: 10000,
    // Staging services may take time to answer, but accepted runs still have
    // their own explicit five-second persistence assertion in the spec.
    responseTimeout: 120000,
    video: true,
    screenshotOnRunFailure: true,
    chromeWebSecurity: false,
    // Ignore React hydration errors from Mantine — they don't affect functionality
    setupNodeEvents(on, config) {
      on("task", {
        log(message) {
          console.log(message);
          return null;
        },
        stagingChromeFreeSnapshot() {
          const namespace = "adlt-staging";
          const runtime = kubectlJson([
            "-n", namespace,
            "get", "deployment,statefulset,pod,service",
            "-l", "app.kubernetes.io/name=chrome-vnc",
            "-o", "json",
          ]);
          const profile = kubectlJson([
            "-n", namespace, "get", "persistentvolumeclaim", "chrome-vnc-pvc", "-o", "json",
          ]);
          const agentConfig = kubectlJson([
            "-n", namespace, "get", "configmap", "sweeper-agent-config", "-o", "json",
          ]);
          return {
            runtime: (runtime.items || []).map((item) => ({
              kind: item.kind,
              name: item.metadata?.name,
            })),
            profile: {
              name: profile.metadata?.name,
              phase: profile.status?.phase,
              capacity: profile.status?.capacity?.storage,
            },
            agentConfig: agentConfig.data || {},
          };
        },
      });
    },
  },
});

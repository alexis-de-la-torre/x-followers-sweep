import { defineConfig } from "cypress";

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
      });
    },
  },
});

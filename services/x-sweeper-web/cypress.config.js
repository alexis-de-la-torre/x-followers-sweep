import { defineConfig } from "cypress";

export default defineConfig({
  e2e: {
    baseUrl: "http://localhost:3000",
    supportFile: "cypress/support/e2e.js",
    specPattern: "cypress/e2e/**/*.cy.js",
    viewportWidth: 390,
    viewportHeight: 844, // iPhone 14 Pro size — mobile-first
    defaultCommandTimeout: 10000,
  },
});
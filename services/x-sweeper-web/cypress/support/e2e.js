import { isBenignUncaught } from "./uncaught";

// Ignore only the known Mantine/Next development hydration mismatch. Every
// other application exception remains fatal so the staging suite can go red.
Cypress.on("uncaught:exception", (err) => {
  return isBenignUncaught(err) ? false : undefined;
});

// Ignore React hydration errors from Mantine — they don't affect functionality
Cypress.on("uncaught:exception", (err) => {
  // React error #418: hydration mismatch (Mantine CSS/theme vars)
  if (err.message?.includes("Minified React error #418")) {
    return false;
  }
  return true;
});
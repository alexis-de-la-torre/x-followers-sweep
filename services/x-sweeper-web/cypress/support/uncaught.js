// Next development mode throws hydration mismatches that production recovers
// from by regenerating the client tree. Keep this allowlist specific: a broad
// exception handler would let genuine Sweeper render crashes pass unnoticed.
const HYDRATION_PATTERNS = [
  /Hydration failed because the server rendered HTML didn't match the client/i,
  /throwOnHydrationMismatch/,
  /server rendered HTML didn't match the client/i,
  /Text content does not match server-rendered HTML/i,
  /Minified React error #418/i,
];

export function isBenignUncaught(err) {
  if (!err) return false;
  const headline = `${err.name || ""}: ${err.message || ""}`;
  const stack = err.stack || "";
  return HYDRATION_PATTERNS.some((pattern) => pattern.test(headline) || pattern.test(stack));
}

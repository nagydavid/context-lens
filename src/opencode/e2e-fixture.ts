export const E2E_FIXTURE_LINES = 400;
export const E2E_FIXTURE_SYMBOL = "computeLensChecksum";
export const E2E_FIXTURE_SYMBOL_RANGE = { startLine: 232, endLine: 238 } as const;

/** Builds the deterministic large-file fixture consumed by the live OpenCode probe. */
export function buildE2eFixture(): string {
  const lines = Array.from(
    { length: E2E_FIXTURE_LINES },
    (_, index) => `export function fixtureValue${index + 1}(): number { return ${index + 1}; }`,
  );
  lines.splice(
    E2E_FIXTURE_SYMBOL_RANGE.startLine - 1,
    E2E_FIXTURE_SYMBOL_RANGE.endLine - E2E_FIXTURE_SYMBOL_RANGE.startLine + 1,
    "export function computeLensChecksum(input: string): string {",
    "  const normalized = input.trim().toLowerCase();",
    "  const length = normalized.length;",
    "  // Distinctive return used by the end-to-end assertion.",
    "  return `lens-checksum:${length}:C0NTEXT-LENS`;",
    "}",
    "",
  );
  return lines.join("\n");
}

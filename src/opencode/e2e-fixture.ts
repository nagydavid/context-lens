export const E2E_FIXTURE_LINES = 400;
export const E2E_FIXTURE_SYMBOL = "computeLensChecksum";
export const E2E_FIXTURE_SYMBOL_RANGE = { startLine: 232, endLine: 238 } as const;
export const E2E_LARGE_FIXTURE_LINES = 3000;
export const E2E_LARGE_FIXTURE_SYMBOL = "computeLensFanoutDigest";
export const E2E_LARGE_FIXTURE_SYMBOL_RANGE = { startLine: 2200, endLine: 2206 } as const;

function buildFixture(
  lineCount: number,
  range: { startLine: number; endLine: number },
  body: string[],
): string {
  const lines = Array.from(
    { length: lineCount },
    (_, index) => `export function fixtureValue${index + 1}(): number { return ${index + 1}; }`,
  );
  lines.splice(range.startLine - 1, range.endLine - range.startLine + 1, ...body);
  return lines.join("\n");
}

/** Builds the deterministic fixture consumed by the ordinary live OpenCode probe. */
export function buildE2eFixture(): string {
  return buildFixture(E2E_FIXTURE_LINES, E2E_FIXTURE_SYMBOL_RANGE, [
    "export function computeLensChecksum(input: string): string {",
    "  const normalized = input.trim().toLowerCase();",
    "  const length = normalized.length;",
    "  // Distinctive return used by the end-to-end assertion.",
    "  return `lens-checksum:${length}:C0NTEXT-LENS`;",
    "}",
    "",
  ]);
}

/** Builds the 3000-line fixture used to exercise chunked child-session fan-out. */
export function buildLargeE2eFixture(): string {
  return buildFixture(E2E_LARGE_FIXTURE_LINES, E2E_LARGE_FIXTURE_SYMBOL_RANGE, [
    "export function computeLensFanoutDigest(input: string): string {",
    "  const normalized = input.trim().toUpperCase();",
    "  const length = normalized.length;",
    "  // Distinctive return used by the chunk fan-out assertion.",
    "  return `fanout-digest:${length}:C0NTEXT-LENS`;",
    "}",
    "",
  ]);
}

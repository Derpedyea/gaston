export function shouldRetryReviewError(error: unknown): boolean {
  const detail = error instanceof Error ? error.message : String(error);
  if (detail.startsWith("OPENROUTER_API_KEY is malformed")) return false;
  const status = detail.match(/^(?:OpenRouter .* (?:request|completion) failed|GitHub API .* failed) \((\d{3})\):/)?.[1];
  if (!status) return true;
  const code = Number(status);
  return code === 408 || code === 429 || code >= 500;
}

export function reviewRetryDelaySeconds(attempt: number): number {
  return Math.min(5 * (3 ** Math.max(0, Math.trunc(attempt) - 1)), 120);
}

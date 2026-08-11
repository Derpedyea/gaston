export function shouldRetryReviewError(error: unknown): boolean {
  if (hasRetryClassification(error)) return error.retryable;
  if (error instanceof TypeError) return true;
  const detail = error instanceof Error ? error.message : String(error);
  if (detail.startsWith("Retryable review dependency failure: ")) return true;
  if (detail.startsWith("OPENROUTER_API_KEY is malformed")) return false;
  const status = detail.match(/^(?:OpenRouter .* (?:request|completion) failed|GitHub API .* failed) \((\d{3})\):/)?.[1];
  if (!status) return false;
  const code = Number(status);
  return code === 408 || code === 429 || code >= 500;
}

export class RetryableReviewError extends Error {
  readonly retryable = true;

  constructor(cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`Retryable review dependency failure: ${detail}`, { cause });
    this.name = "RetryableReviewError";
  }
}

export function reviewRetryDelaySeconds(attempt: number): number {
  return Math.min(5 * (3 ** Math.max(0, Math.trunc(attempt) - 1)), 120);
}

function hasRetryClassification(error: unknown): error is { retryable: boolean } {
  return typeof error === "object"
    && error !== null
    && "retryable" in error
    && typeof error.retryable === "boolean";
}

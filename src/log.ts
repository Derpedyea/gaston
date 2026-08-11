type LogScalar = string | number | boolean | null;
type LogValue = LogScalar | readonly LogScalar[];

type LogFields = Record<string, LogValue | undefined>;

export function logInfo(event: string, fields: LogFields = {}): void {
  console.log(compact({ event, ...fields }));
}

export function logWarn(event: string, fields: LogFields = {}): void {
  console.warn(compact({ event, ...fields }));
}

export function logError(event: string, fields: LogFields = {}): void {
  console.error(compact({ event, ...fields }));
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function compact(fields: LogFields): Record<string, LogValue> {
  const result: Record<string, LogValue> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

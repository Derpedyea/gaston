export async function withCheckpoint<T>(
  get: () => Promise<T | undefined>,
  put: (value: T) => Promise<void>,
  compute: () => Promise<T>,
): Promise<{ value: T; cached: boolean }> {
  const existing = await get();
  if (existing !== undefined) return { value: existing, cached: true };

  const value = await compute();
  await put(value);
  return { value, cached: false };
}

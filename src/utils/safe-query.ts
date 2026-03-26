/**
 * Wraps a promise with a timeout. Returns the result or a fallback if the promise
 * takes too long or throws.
 */
export async function safeQuery<T>(
  label: string,
  promise: Promise<T>,
  fallback: T,
  timeoutMs: number = 5000,
  logger?: { warn(msg: string, meta?: Record<string, unknown>): void },
): Promise<{ value: T; ok: boolean }> {
  try {
    const result = await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
      ),
    ]);
    return { value: result, ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger?.warn(`safeQuery(${label}) failed: ${message}`);
    return { value: fallback, ok: false };
  }
}

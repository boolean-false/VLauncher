export function transientDownloadError(error: unknown): boolean {
  const text = String(error);
  if (
    /signature|hash|mismatch|certificate|invalid peer|cancel|paused/i.test(text)
  )
    return false;
  const status = text.match(
    /(?:\bstatus:?\s*|\breturned\s+|\bHTTP\s+(?:status\s+(?:server|client)\s+error\s*\()?)(\d{3})\b/i,
  )?.[1];
  return (
    (status !== undefined &&
      ["408", "429", "500", "502", "503", "504"].includes(status)) ||
    /timeout|timed out|connection reset|connection closed|connection refused|network error|error sending request|error decoding response body/i.test(
      text,
    )
  );
}

export async function retryDownload<T>(
  download: () => Promise<T>,
  signal: AbortSignal,
  onRetry: (attempt: number, delay: number) => void,
  delays = [1000, 3000],
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    try {
      const result = await download();
      signal.throwIfAborted();
      return result;
    } catch (error) {
      signal.throwIfAborted();
      if (attempt >= delays.length || !transientDownloadError(error))
        throw error;
      const delay = delays[attempt];
      onRetry(attempt + 2, delay);
      await new Promise<void>((resolve, reject) => {
        const cancel = () => {
          signal.removeEventListener("abort", cancel);
          clearTimeout(timer);
          reject(signal.reason);
        };
        const timer = setTimeout(() => {
          signal.removeEventListener("abort", cancel);
          resolve();
        }, delay);
        signal.addEventListener("abort", cancel, { once: true });
        if (signal.aborted) cancel();
      });
    }
  }
}

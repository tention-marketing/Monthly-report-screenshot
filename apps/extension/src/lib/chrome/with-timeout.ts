export class ChromeOperationTimeoutError extends Error {
  constructor(readonly stage: string, readonly timeoutMs: number) {
    super(`${stage} timed out after ${Math.ceil(timeoutMs / 1000)} seconds.`);
    this.name = "ChromeOperationTimeoutError";
  }
}

/**
 * Chrome Promise APIs do not provide cancellation. This bounds the caller's wait
 * so an extension action can always return the UI to a usable state.
 */
export function withTimeout<T>(operation: () => Promise<T>, stage: string, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = globalThis.setTimeout(() => reject(new ChromeOperationTimeoutError(stage, timeoutMs)), timeoutMs);
    Promise.resolve()
      .then(operation)
      .then((value) => { globalThis.clearTimeout(timer); resolve(value); })
      .catch((error: unknown) => { globalThis.clearTimeout(timer); reject(error); });
  });
}

export function isChromeOperationTimeout(error: unknown): error is ChromeOperationTimeoutError {
  return error instanceof ChromeOperationTimeoutError;
}

export function chromeErrorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "Chrome did not provide an error message.";
}

const nativeFetch = globalThis.fetch;
const nativeHeaders = globalThis.Headers;
const nativeRequest = globalThis.Request;
const nativeResponse = globalThis.Response;

export function restoreNativeFetchGlobals(): void {
  if (globalThis.fetch !== nativeFetch) {
    Object.defineProperty(globalThis, 'fetch', {
      value: nativeFetch,
      configurable: true,
      writable: true,
    });
  }
  if (globalThis.Headers !== nativeHeaders) {
    Object.defineProperty(globalThis, 'Headers', {
      value: nativeHeaders,
      configurable: true,
      writable: true,
    });
  }
  if (globalThis.Request !== nativeRequest) {
    Object.defineProperty(globalThis, 'Request', {
      value: nativeRequest,
      configurable: true,
      writable: true,
    });
  }
  if (globalThis.Response !== nativeResponse) {
    Object.defineProperty(globalThis, 'Response', {
      value: nativeResponse,
      configurable: true,
      writable: true,
    });
  }
}

restoreNativeFetchGlobals();

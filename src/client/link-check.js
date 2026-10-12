// Metadata is read-only. A transport failure says nothing about the drop's state.
export function checkMetadataResponse(response) {
  if (response.ok) return true;
  if (response.status >= 400 && response.status < 500 &&
      response.status !== 408 && response.status !== 429) return false;
  throw new Error('Link check failed');
}

export const LINK_CHECK_TIMEOUT_MS = 20_000;

/** Bound headers, body and validation, even if a transport ignores abort. */
export async function checkLink(load) {
  const controller = new AbortController();
  const askedAt = performance.now();
  let timer;
  try {
    const timeout = new Promise((_, reject) => {
      timer = window.setTimeout(() => {
        // Reject independently of abort: an already queued or ignored response must
        // never repaint a failed check after the person has started another one.
        reject(new Error('Link check timed out'));
        controller.abort();
      }, LINK_CHECK_TIMEOUT_MS);
    });
    const value = await Promise.race([load(controller.signal), timeout]);
    return value ? { status: 'ok', value, askedAt } : { status: 'unavailable' };
  } catch {
    // Exception text may contain request details. Only static copy reaches the UI.
    return { status: 'unreachable' };
  } finally {
    window.clearTimeout(timer);
    // Also stop unread error bodies; a proxy may return headers and then hang.
    controller.abort();
  }
}

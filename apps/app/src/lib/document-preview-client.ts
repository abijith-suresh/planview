export async function readPreviewDocument(url: string, maxBytes: number, signal: AbortSignal) {
  const response = await fetch(url, {
    credentials: "omit",
    mode: "cors",
    referrerPolicy: "no-referrer",
    signal,
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error("The document is unavailable. Try reopening it from your workspace.");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let byteLength = 0;
  try {
    if (Number(response.headers.get("content-length")) > maxBytes) {
      throw new Error("This document exceeds the 8 MiB preview limit.");
    }
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > maxBytes) {
        throw new Error("This document exceeds the 8 MiB preview limit.");
      }
      chunks.push(new Uint8Array(value));
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  return new Blob(chunks, { type: "text/html;charset=utf-8" });
}

// Serialized into the small server-rendered preview. Keep dependencies explicit
// so bundling and minification cannot introduce names missing from the browser.
export function initializeDocumentPreview(
  url: string,
  maxBytes: number,
  readDocument: typeof readPreviewDocument
) {
  const frame = document.getElementById("document-preview") as HTMLIFrameElement;
  const state = document.getElementById("preview-state") as HTMLElement;
  const message = document.getElementById("preview-message") as HTMLElement;
  const retry = document.getElementById("preview-retry") as HTMLButtonElement;
  let objectUrl: string | undefined;
  let request: AbortController | undefined;

  const open = async () => {
    request?.abort();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = undefined;
    frame.hidden = true;
    state.hidden = false;
    state.setAttribute("role", "status");
    message.textContent = "Opening document…";
    retry.hidden = true;
    const controller = new AbortController();
    request = controller;
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const blob = await readDocument(url, maxBytes, controller.signal);
      if (controller.signal.aborted) return;
      objectUrl = URL.createObjectURL(blob);
      frame.onload = () => {
        frame.hidden = false;
        state.hidden = true;
      };
      frame.src = objectUrl;
    } catch (error) {
      state.setAttribute("role", "alert");
      const reason = error instanceof Error ? error.message : "";
      message.textContent = controller.signal.aborted
        ? "The document took too long to load. Try again."
        : reason === "This document exceeds the 8 MiB preview limit." ||
            reason === "The document is unavailable. Try reopening it from your workspace."
          ? reason
          : "The document could not be opened. Try again.";
      retry.hidden = false;
    } finally {
      clearTimeout(timeout);
    }
  };

  retry.addEventListener("click", () => void open());
  window.addEventListener("pagehide", () => {
    request?.abort();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  });
  void open();
}

import { ConvexClient } from "convex/browser";
import { createStore } from "solid-js/store";

import { api } from "../../convex/_generated/api";
import { authClient } from "~/lib/auth";
import type { DocumentRecord } from "~/lib/documents";

export type DocumentsStatus = "idle" | "connecting" | "ready" | "error";

export type DocumentsState = {
  status: DocumentsStatus;
  documents: DocumentRecord[];
  error: string;
};

const [documentsStore, setDocumentsStore] = createStore<DocumentsState>({
  status: "idle",
  documents: [],
  error: "",
});

export { documentsStore };

const backendNotConfiguredError = "The cloud backend is not configured yet.";
const sessionExpiredError = "Your session expired. Sign in again.";
const loadFailedError = "Documents could not be loaded. Try refreshing the page.";

let client: ConvexClient | undefined;
let unsubscribe: (() => void) | undefined;
let cachedToken: string | null = null;
let pendingToken: Promise<string | null> | undefined;
let authFailed = false;

const markSessionExpired = () => {
  if (authFailed) return;
  authFailed = true;
  client?.client.clearAuth();
  setDocumentsStore({ status: "error", error: sessionExpiredError });
};

export function resetDocumentsSubscription() {
  unsubscribe?.();
  unsubscribe = undefined;

  if (client) {
    void client.close().catch(() => undefined);
    client = undefined;
  }

  authFailed = false;
  cachedToken = null;
  pendingToken = undefined;
  setDocumentsStore({ status: "idle", documents: [], error: "" });
}

const fetchAccessToken = async ({
  forceRefreshToken = false,
}: {
  forceRefreshToken?: boolean;
} = {}): Promise<string | null> => {
  if (cachedToken && !forceRefreshToken) return cachedToken;
  if (!forceRefreshToken && pendingToken) return pendingToken;

  pendingToken = (async () => {
    try {
      const result = await authClient.convex.token({ fetchOptions: { throw: false } });
      const token = result?.data?.token ?? null;
      cachedToken = token;
      return token;
    } catch {
      cachedToken = null;
      return null;
    } finally {
      pendingToken = undefined;
    }
  })();

  return pendingToken;
};

function startSubscription(convexUrl: string) {
  let freshClient: ConvexClient;

  try {
    freshClient = new ConvexClient(convexUrl);
  } catch {
    setDocumentsStore({ status: "error", documents: [], error: loadFailedError });
    return;
  }

  client = freshClient;
  setDocumentsStore({ status: "connecting" });

  freshClient.setAuth(fetchAccessToken, (isAuthenticated) => {
    if (!isAuthenticated && client === freshClient) markSessionExpired();
  });

  unsubscribe = freshClient.onUpdate(
    api.documents.list,
    {},
    (result) => {
      setDocumentsStore({ status: "ready", documents: result as DocumentRecord[], error: "" });
    },
    (error) => {
      if (client !== freshClient || authFailed) return;

      if (/unauthenticated|authentication/i.test(error.message)) {
        markSessionExpired();
        return;
      }

      setDocumentsStore({ status: "error", error: loadFailedError });
    }
  );
}

export function ensureDocumentsSubscription() {
  if (import.meta.env.SSR || typeof window === "undefined") return;

  const { VITE_CONVEX_URL: convexUrl } = import.meta.env;

  if (!convexUrl) {
    setDocumentsStore({ status: "error", documents: [], error: backendNotConfiguredError });
    return;
  }

  if (authFailed) {
    resetDocumentsSubscription();
  } else if (client) {
    if (!client.closed && unsubscribe) return;
    resetDocumentsSubscription();
  }

  startSubscription(convexUrl);
}

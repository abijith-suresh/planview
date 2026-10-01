import { ConvexClient } from "convex/browser";
import { createStore } from "solid-js/store";

import { api } from "../../convex/_generated/api";
import { authClient } from "~/lib/auth";
import { createDocumentPages } from "~/lib/document-pages";
import type { DocumentRecord } from "~/lib/documents";

export type DocumentsStatus = "idle" | "connecting" | "ready" | "error";

export type DocumentsState = {
  status: DocumentsStatus;
  documents: DocumentRecord[];
  error: string;
  hasMore: boolean;
  loadingMore: boolean;
};

const [documentsStore, setDocumentsStore] = createStore<DocumentsState>({
  status: "idle",
  documents: [],
  error: "",
  hasMore: false,
  loadingMore: false,
});

export { documentsStore };

const backendNotConfiguredError = "The cloud backend is not configured yet.";
const sessionExpiredError = "Your session expired. Sign in again.";
const loadFailedError = "Documents could not be loaded. Try refreshing the page.";

let client: ConvexClient | undefined;
let pagination: ReturnType<typeof createDocumentPages<DocumentRecord>> | undefined;
let paginationId = 0;
let cachedToken: string | null = null;
let pendingToken: Promise<string | null> | undefined;
let authFailed = false;
let generation = 0;

const markSessionExpired = () => {
  if (authFailed) return;
  authFailed = true;
  client?.client.clearAuth();
  setDocumentsStore({
    status: "error",
    documents: [],
    error: sessionExpiredError,
    hasMore: false,
    loadingMore: false,
  });
};

export function resetDocumentsSubscription() {
  generation += 1;
  pagination?.close();
  pagination = undefined;

  if (client) {
    void client.close().catch(() => undefined);
    client = undefined;
  }

  authFailed = false;
  cachedToken = null;
  pendingToken = undefined;
  setDocumentsStore({
    status: "idle",
    documents: [],
    error: "",
    hasMore: false,
    loadingMore: false,
  });
}

const fetchAccessToken = async ({
  forceRefreshToken = false,
}: {
  forceRefreshToken?: boolean;
} = {}): Promise<string | null> => {
  if (cachedToken && !forceRefreshToken) return cachedToken;
  if (!forceRefreshToken && pendingToken) return pendingToken;

  const tokenGeneration = generation;
  pendingToken = (async () => {
    try {
      const result = await authClient.convex.token({ fetchOptions: { throw: false } });
      const token = result?.data?.token ?? null;
      if (tokenGeneration !== generation) return null;
      cachedToken = token;
      return token;
    } catch {
      if (tokenGeneration === generation) cachedToken = null;
      return null;
    } finally {
      if (tokenGeneration === generation) pendingToken = undefined;
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

  pagination = createDocumentPages<DocumentRecord>({
    id: ++paginationId,
    subscribe: (paginationOpts, update, error) =>
      freshClient.onUpdate(api.documents.listPage, { paginationOpts }, update, error),
    update: (state) => {
      if (client !== freshClient || authFailed) return;
      const { initialLoading, ...loaded } = state;
      setDocumentsStore({ status: initialLoading ? "connecting" : "ready", ...loaded, error: "" });
    },
    error: (error) => {
      if (client !== freshClient || authFailed) return;
      if (/unauthenticated|authentication/i.test(error.message)) {
        markSessionExpired();
        return;
      }
      setDocumentsStore({ status: "error", loadingMore: false, error: loadFailedError });
    },
  });
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
    if (!client.closed && pagination) return;
    resetDocumentsSubscription();
  }

  startSubscription(convexUrl);
}

export function loadMoreDocuments() {
  if (authFailed) return;
  pagination?.loadMore();
}

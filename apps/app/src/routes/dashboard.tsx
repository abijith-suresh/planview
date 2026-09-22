import { Meta, Title } from "@solidjs/meta";
import { A } from "@solidjs/router";
import { Show, createEffect, createSignal } from "solid-js";

import AppShell from "~/components/AppShell";
import Icon from "~/components/Icon";
import { formatBytes, type DocumentRecord, getErrorMessage } from "~/lib/documents";
import { useWorkspaceAuth } from "~/lib/workspace-auth";

export default function Dashboard() {
  const { session, redirectToSignIn, signOut, userInitial, userName } = useWorkspaceAuth();
  const [documents, setDocuments] = createSignal<DocumentRecord[]>([]);
  const [isLoading, setIsLoading] = createSignal(true);
  const [documentError, setDocumentError] = createSignal("");

  const storageUsed = () =>
    formatBytes(documents().reduce((total, document) => total + document.sizeBytes, 0));

  const loadDocuments = async () => {
    setIsLoading(true);
    setDocumentError("");

    try {
      const response = await fetch("/api/documents", {
        headers: { Accept: "application/json" },
      });

      if (response.status === 401) {
        redirectToSignIn();
        return;
      }

      if (!response.ok) throw new Error(await getErrorMessage(response));

      setDocuments((await response.json()) as DocumentRecord[]);
    } catch (error) {
      setDocumentError(error instanceof Error ? error.message : "Documents could not be loaded.");
    } finally {
      setIsLoading(false);
    }
  };

  createEffect(() => {
    const currentSession = session();

    if (!currentSession.isPending && currentSession.data) void loadDocuments();
  });

  const statusLabel = () => {
    if (isLoading()) return "Checking workspace";
    if (documentError()) return "Needs attention";
    return "Ready";
  };

  const statusMessage = () => {
    if (isLoading()) return "Checking your saved HTML pages…";
    if (documentError()) return documentError();

    const count = documents().length;
    return count === 0
      ? "No HTML pages are saved yet."
      : `${count} HTML ${count === 1 ? "page" : "pages"} saved in your workspace.`;
  };

  return (
    <Show
      when={!session().isPending && session().data}
      fallback={
        <main class="auth-loading" aria-live="polite">
          <span class="status-dot" aria-hidden="true" />
          Opening your workspace…
        </main>
      }
    >
      <Title>Overview | plansplease</Title>
      <Meta name="description" content="A short overview of your plansplease workspace." />
      <AppShell
        active="dashboard"
        onSignOut={signOut}
        userInitial={userInitial}
        userName={userName}
      >
        <div class="page-content">
          <header class="page-header">
            <div>
              <h1>Overview</h1>
              <p>A quiet place for the HTML pages your agent makes.</p>
            </div>
            <A class="button button-secondary" href="/documents">
              <Icon name="file" />
              <span>View documents</span>
            </A>
          </header>

          <section class="overview-status" aria-labelledby="workspace-status-title">
            <div class="status-main">
              <div class="status-label">
                <span class="status-dot" aria-hidden="true" />
                <span id="workspace-status-title">{statusLabel()}</span>
              </div>
              <p classList={{ "status-copy-error": Boolean(documentError()) }}>{statusMessage()}</p>
            </div>
            <dl class="overview-facts">
              <div>
                <dt>Documents</dt>
                <dd>{documents().length}</dd>
              </div>
              <div>
                <dt>Stored</dt>
                <dd>{storageUsed()}</dd>
              </div>
              <div>
                <dt>Access</dt>
                <dd>Testing</dd>
              </div>
            </dl>
          </section>

          <Show when={documentError()}>
            <p class="error-message" role="alert">
              {documentError()} Try refreshing the page.
            </p>
          </Show>

          <Show when={!isLoading() && documents().length === 0 && !documentError()}>
            <section class="overview-empty" aria-labelledby="empty-overview-title">
              <div>
                <h2 id="empty-overview-title">Nothing here yet</h2>
                <p>Upload your first standalone HTML page to give it a workspace link.</p>
              </div>
              <A class="text-link" href="/documents">
                Add a document <span aria-hidden="true">→</span>
              </A>
            </section>
          </Show>
        </div>
      </AppShell>
    </Show>
  );
}

import { Meta, Title } from "@solidjs/meta";
import { A } from "@solidjs/router";
import { For, Show, createEffect, createSignal, onCleanup } from "solid-js";

import AppShell from "~/components/AppShell";
import Icon from "~/components/Icon";
import { formatBytes, formatRelativeDate, type DocumentRecord } from "~/lib/documents";
import { documentsStore, ensureDocumentsSubscription } from "~/lib/documents-live";
import { useWorkspaceAuth } from "~/lib/workspace-auth";

export default function Dashboard() {
  const { session, userInitial, userName } = useWorkspaceAuth();
  const documents = () => documentsStore.documents;
  const status = () => documentsStore.status;
  const [actionMessage, setActionMessage] = createSignal("");
  let feedbackTimer: ReturnType<typeof setTimeout> | undefined;

  createEffect(() => {
    const currentSession = session();

    if (!currentSession.isPending && currentSession.data) ensureDocumentsSubscription();
  });

  const isReady = () => status() === "ready";
  onCleanup(() => {
    if (feedbackTimer) clearTimeout(feedbackTimer);
  });

  const showActionMessage = (message: string) => {
    setActionMessage(message);
    if (feedbackTimer) clearTimeout(feedbackTimer);
    feedbackTimer = setTimeout(() => setActionMessage(""), 2600);
  };

  const documentHref = (id: string) => `/api/documents/${encodeURIComponent(id)}`;

  const copyDocumentLink = async (document: DocumentRecord) => {
    if (typeof window === "undefined" || !navigator.clipboard) {
      showActionMessage("Copying links is not available in this browser.");
      return;
    }

    try {
      await navigator.clipboard.writeText(
        new URL(documentHref(document._id), window.location.origin).href
      );
      showActionMessage(`${document.title} copied.`);
    } catch {
      showActionMessage("The link could not be copied.");
    }
  };

  return (
    <Show
      when={!session().isPending && session().data}
      fallback={
        <main class="auth-loading" aria-live="polite">
          <Show
            when={!session().error}
            fallback={<p role="alert">Could not check your session. Refresh to try again.</p>}
          >
            <span class="signal-dot" aria-hidden="true" />
            Opening your workspace…
          </Show>
        </main>
      }
    >
      <Title>Overview | plansplease</Title>
      <Meta name="description" content="A short overview of your plansplease workspace." />
      <AppShell active="dashboard" userInitial={userInitial} userName={userName}>
        <div class="page-content dashboard-content">
          <header class="page-header">
            <div>
              <h1>Overview</h1>
              <p class="page-lede">Pick up where you left off.</p>
            </div>
          </header>

          <Show when={status() === "error"}>
            <p class="error-message" role="alert">
              {documentsStore.error}
            </p>
          </Show>

          <Show when={isReady() && documents().length > 0}>
            <section class="card" aria-labelledby="recent-pages-title">
              <div class="list-header">
                <h2 id="recent-pages-title">Recent pages</h2>
                <A class="text-link" href="/documents">
                  View all documents →
                </A>
              </div>
              <For each={documents().slice(0, 5)}>
                {(document) => (
                  <article class="document-row">
                    <span class="document-file-icon" aria-hidden="true">
                      <Icon name="file" size={17} />
                    </span>
                    <div class="document-details">
                      <strong title={document.title}>{document.title}</strong>
                      <small>
                        {formatRelativeDate(document.createdAt)} · {formatBytes(document.sizeBytes)}
                      </small>
                    </div>
                    <div class="document-actions">
                      <a
                        class="icon-button"
                        href={documentHref(document._id)}
                        target="_blank"
                        rel="noreferrer"
                        aria-label={`Open ${document.title}`}
                        title="Open"
                      >
                        <Icon name="external" />
                      </a>
                      <button
                        class="icon-button"
                        type="button"
                        aria-label={`Copy link for ${document.title}`}
                        title="Copy link"
                        onClick={() => void copyDocumentLink(document)}
                      >
                        <Icon name="copy" />
                      </button>
                    </div>
                  </article>
                )}
              </For>
            </section>
          </Show>

          <Show when={isReady() && documents().length === 0}>
            <section class="card" aria-labelledby="empty-overview-title">
              <div class="empty-state">
                <span class="empty-icon" aria-hidden="true">
                  <Icon name="file" size={24} />
                </span>
                <h2 id="empty-overview-title">Your first page starts with your agent</h2>
                <p>Connect with MCP or upload an HTML file from the CLI.</p>
                <div class="empty-actions">
                  <A class="button-primary" href="/settings#connect-agent">
                    Connect your agent
                  </A>
                </div>
              </div>
            </section>
          </Show>
          <Show when={status() === "idle" || status() === "connecting"}>
            <p class="page-note" role="status">
              Loading recent pages…
            </p>
          </Show>

          <div class="action-message" role="status" aria-live="polite">
            {actionMessage()}
          </div>
        </div>
      </AppShell>
    </Show>
  );
}

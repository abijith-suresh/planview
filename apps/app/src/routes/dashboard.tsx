import { Meta, Title } from "@solidjs/meta";
import { A } from "@solidjs/router";
import { For, Show, createEffect, createSignal } from "solid-js";

import AppShell from "~/components/AppShell";
import Icon from "~/components/Icon";
import {
  formatBytes,
  formatDocumentDate,
  formatRelativeDate,
  type DocumentRecord,
} from "~/lib/documents";
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
  const isConnecting = () => status() === "connecting" || status() === "idle";
  const storedTotal = () => documents().reduce((total, document) => total + document.sizeBytes, 0);

  const documentsValue = () => (isReady() ? String(documents().length) : "…");
  const documentsMeta = () => {
    if (!isReady()) return "Checking workspace…";
    if (documents().length === 0) return "No HTML pages saved yet.";
    return documents().length === 1
      ? "1 HTML page saved in your workspace."
      : `${documents().length} HTML pages saved in your workspace.`;
  };

  const storedValue = () => {
    if (!isReady()) return "…";
    return formatBytes(storedTotal());
  };

  const lastUploadValue = () => {
    const first = documents()[0];
    if (isReady()) {
      if (first) return formatDocumentDate(first.createdAt);
      return "—";
    }
    return isConnecting() ? "…" : "—";
  };

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
          <span class="signal-dot" aria-hidden="true" />
          Opening your workspace…
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
              <p class="page-lede">A quiet place for the HTML pages your agent makes.</p>
            </div>
          </header>

          <Show when={status() === "error"}>
            <p class="error-message" role="alert">
              {documentsStore.error}
            </p>
          </Show>

          <div class="stat-grid">
            <article class="stat-card">
              <span class="stat-label">Documents</span>
              <span class="stat-value">{documentsValue()}</span>
              <p class="stat-meta">{documentsMeta()}</p>
            </article>
            <article class="stat-card">
              <span class="stat-label">Stored</span>
              <span class="stat-value">{storedValue()}</span>
              <p class="stat-meta">Total size of the pages you saved.</p>
            </article>
            <article class="stat-card">
              <span class="stat-label">Last upload</span>
              <span class="stat-value">{lastUploadValue()}</span>
              <p class="stat-meta">
                {isReady() && documents().length === 0
                  ? "Nothing uploaded yet."
                  : "Most recent page added to this workspace."}
              </p>
            </article>
          </div>

          <Show when={isReady() && documents().length > 0}>
            <section class="card" aria-labelledby="recent-pages-title">
              <div class="list-header">
                <h2 id="recent-pages-title">Recent pages</h2>
                <A class="text-link" href="/documents">
                  {documents().length === 1
                    ? "View 1 page"
                    : `View all ${documents().length} pages`}{" "}
                  →
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

            <section class="card onboarding-card" aria-labelledby="terminal-card-title">
              <h2 id="terminal-card-title">From your terminal.</h2>
              <p class="stat-meta">Serve a page locally</p>
              <code class="step-code">planview publish ./report.html</code>
              <p class="stat-meta">Save a private copy here</p>
              <code class="step-code">planview login && planview upload ./report.html</code>
            </section>
          </Show>

          <Show when={isReady() && documents().length === 0}>
            <section class="card" aria-labelledby="empty-overview-title">
              <div class="empty-state">
                <span class="empty-icon" aria-hidden="true">
                  <Icon name="file" size={24} />
                </span>
                <h2 id="empty-overview-title">Nothing here yet.</h2>
                <p>
                  Your first saved page will appear here with its size, date, and its own private
                  link.
                </p>
                <div class="empty-actions">
                  <A class="text-link" href="/documents">
                    View documents
                  </A>
                </div>
              </div>
            </section>

            <section class="card onboarding-card" aria-labelledby="onboarding-card-title">
              <h2 id="onboarding-card-title">Three ways a page gets here.</h2>
              <ol class="steps">
                <li class="step">
                  <span class="step-index" aria-hidden="true">
                    01
                  </span>
                  <h3>Publish a file</h3>
                  <p>Any agent can write it. One command hands it a URL.</p>
                  <code class="step-code">planview publish ./report.html</code>
                </li>
                <li class="step">
                  <span class="step-index" aria-hidden="true">
                    02
                  </span>
                  <h3>Save a cloud copy</h3>
                  <p>Sign in once, then upload the page to this workspace.</p>
                  <code class="step-code">planview login && planview upload ./report.html</code>
                </li>
                <li class="step">
                  <span class="step-index" aria-hidden="true">
                    03
                  </span>
                  <h3>Keep it working</h3>
                  <p>Pages stay here — searchable, deletable, yours — until you delete them.</p>
                </li>
              </ol>
              <p class="page-note">
                Install the CLI once — <code>npm install --global @abijith-suresh/planview</code> —
                and any page it publishes can be saved here.
              </p>
            </section>
          </Show>

          <div class="action-message" role="status" aria-live="polite">
            {actionMessage()}
          </div>
        </div>
      </AppShell>
    </Show>
  );
}

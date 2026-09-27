import { Meta, Title } from "@solidjs/meta";
import { A } from "@solidjs/router";
import { Show, createEffect } from "solid-js";

import AppShell from "~/components/AppShell";
import Icon from "~/components/Icon";
import { formatBytes } from "~/lib/documents";
import { documentsStore, ensureDocumentsSubscription } from "~/lib/documents-live";
import { useWorkspaceAuth } from "~/lib/workspace-auth";

export default function Dashboard() {
  const { session, signOut, userInitial, userName } = useWorkspaceAuth();
  const documents = () => documentsStore.documents;
  const status = () => documentsStore.status;

  createEffect(() => {
    const currentSession = session();

    if (!currentSession.isPending && currentSession.data) ensureDocumentsSubscription();
  });

  const isReady = () => status() === "ready";
  const storedTotal = () => documents().reduce((total, document) => total + document.sizeBytes, 0);

  const documentsValue = () => (isReady() ? String(documents().length) : "…");
  const documentsMeta = () => {
    if (!isReady()) return "Checking workspace…";
    if (documents().length === 0) return "No HTML pages saved yet.";
    return documents().length === 1
      ? "1 HTML page saved in your workspace."
      : `${documents().length} HTML pages saved in your workspace.`;
  };

  const storedValue = () => (isReady() ? formatBytes(storedTotal()) : "…");

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
      <AppShell
        active="dashboard"
        onSignOut={signOut}
        userInitial={userInitial}
        userName={userName}
      >
        <div class="page-content dashboard-content">
          <header class="page-header">
            <div>
              <h1>Overview</h1>
              <p class="page-lede">A quiet place for the HTML pages your agent makes.</p>
            </div>
            <A class="button-secondary" href="/documents">
              <Icon name="file" />
              <span>View documents</span>
            </A>
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
          </div>

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
        </div>
      </AppShell>
    </Show>
  );
}

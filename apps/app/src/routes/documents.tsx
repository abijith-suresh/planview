import { Meta, Title } from "@solidjs/meta";
import { For, Show, createEffect, createSignal } from "solid-js";

import AppShell from "~/components/AppShell";
import Icon from "~/components/Icon";
import {
  formatBytes,
  formatDocumentDate,
  type DocumentRecord,
  getErrorMessage,
} from "~/lib/documents";
import { documentsStore, ensureDocumentsSubscription } from "~/lib/documents-live";
import { useWorkspaceAuth } from "~/lib/workspace-auth";

export default function Documents() {
  const { session, redirectToSignIn, signOut, userInitial, userName } = useWorkspaceAuth();
  const documents = () => documentsStore.documents;
  const status = () => documentsStore.status;
  const [deletingId, setDeletingId] = createSignal("");
  const [pendingDeleteId, setPendingDeleteId] = createSignal("");
  const [deleteError, setDeleteError] = createSignal("");
  const [actionMessage, setActionMessage] = createSignal("");
  let feedbackTimer: ReturnType<typeof setTimeout> | undefined;

  createEffect(() => {
    const currentSession = session();

    if (!currentSession.isPending && currentSession.data) ensureDocumentsSubscription();
  });

  const isReady = () => status() === "ready";

  const pageCountLabel = (count: number) =>
    count === 1 ? "1 HTML page in this workspace." : `${count} HTML pages in this workspace.`;

  const pageLede = () => {
    if (status() === "error") return "";
    if (!isReady()) return "Checking workspace…";
    return pageCountLabel(documents().length);
  };

  const listCount = () => (!isReady() && documents().length === 0 ? "…" : documents().length);

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
      showActionMessage(`Link copied for ${document.title}.`);
    } catch {
      showActionMessage("The link could not be copied.");
    }
  };

  const removeDocument = async (document: DocumentRecord) => {
    setDeleteError("");
    setDeletingId(document._id);

    try {
      const response = await fetch(documentHref(document._id), { method: "DELETE" });

      if (response.status === 401) {
        redirectToSignIn();
        return;
      }

      if (!response.ok) throw new Error(await getErrorMessage(response));

      showActionMessage(`${document.title} deleted.`);
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : "The document could not be deleted.");
    } finally {
      setDeletingId("");
      setPendingDeleteId("");
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
      <Title>Documents | plansplease</Title>
      <Meta
        name="description"
        content="Open, copy a link, or delete the HTML pages saved in your plansplease workspace."
      />
      <AppShell
        active="documents"
        onSignOut={signOut}
        userInitial={userInitial}
        userName={userName}
      >
        <div class="page-content">
          <header class="page-header">
            <div>
              <h1>Documents</h1>
              <p class="page-lede">{pageLede()}</p>
            </div>
          </header>

          <section class="documents-list" aria-labelledby="documents-list-title">
            <div class="list-header">
              <h2 id="documents-list-title">All documents</h2>
              <span class="list-count">{listCount()}</span>
            </div>
            <Show
              when={status() !== "error"}
              fallback={
                <p class="error-message" role="alert">
                  {documentsStore.error}
                </p>
              }
            >
              <Show
                when={documents().length > 0}
                fallback={
                  <div class="empty-state">
                    <Show when={isReady()} fallback={<p>Loading documents…</p>}>
                      <span class="empty-icon" aria-hidden="true">
                        <Icon name="file" size={24} />
                      </span>
                      <h2>No pages yet.</h2>
                      <p>
                        Publish and upload from your terminal — <code>planview login</code>, then{" "}
                        <code>planview upload ./page.html</code>.
                      </p>
                    </Show>
                  </div>
                }
              >
                <For each={documents()}>
                  {(document) => (
                    <article class="document-row">
                      <span class="document-file-icon" aria-hidden="true">
                        <Icon name="file" size={17} />
                      </span>
                      <div class="document-details">
                        <strong title={document.title}>{document.title}</strong>
                        <small>
                          {formatBytes(document.sizeBytes)} ·{" "}
                          {formatDocumentDate(document.createdAt)}
                        </small>
                      </div>
                      <div class="document-actions">
                        <Show
                          when={pendingDeleteId() === document._id}
                          fallback={
                            <>
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
                              <button
                                class="icon-button icon-button-danger"
                                type="button"
                                aria-label={`Delete ${document.title}`}
                                title="Delete"
                                disabled={deletingId() === document._id}
                                onClick={() => setPendingDeleteId(document._id)}
                              >
                                <Icon name="trash" />
                              </button>
                            </>
                          }
                        >
                          <span class="delete-confirm" role="alert">
                            <span class="confirm-label">Delete "{document.title}"?</span>
                            <button
                              class="button-danger"
                              type="button"
                              disabled={deletingId() === document._id}
                              onClick={() => void removeDocument(document)}
                            >
                              Delete
                            </button>
                            <button
                              class="icon-button"
                              type="button"
                              aria-label="Cancel"
                              title="Cancel"
                              disabled={deletingId() === document._id}
                              onClick={() => setPendingDeleteId("")}
                            >
                              <svg
                                aria-hidden="true"
                                fill="none"
                                height="16"
                                viewBox="0 0 24 24"
                                width="16"
                                xmlns="http://www.w3.org/2000/svg"
                              >
                                <path
                                  d="M18 6 6 18M6 6l12 12"
                                  stroke="currentColor"
                                  stroke-linecap="round"
                                  stroke-width="1.7"
                                />
                              </svg>
                            </button>
                          </span>
                        </Show>
                      </div>
                    </article>
                  )}
                </For>
              </Show>
            </Show>
          </section>

          <Show when={deleteError()}>
            <p class="error-message" role="alert">
              {deleteError()} Try refreshing the page.
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

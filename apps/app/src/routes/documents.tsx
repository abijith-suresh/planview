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
import { createUploadThing } from "~/lib/uploadthing";
import { useWorkspaceAuth } from "~/lib/workspace-auth";

export default function Documents() {
  const { session, redirectToSignIn, signOut, userInitial, userName } = useWorkspaceAuth();
  const [documents, setDocuments] = createSignal<DocumentRecord[]>([]);
  const [isLoading, setIsLoading] = createSignal(true);
  const [isUploading, setIsUploading] = createSignal(false);
  const [uploadError, setUploadError] = createSignal("");
  const [documentError, setDocumentError] = createSignal("");
  const [selectedFile, setSelectedFile] = createSignal<File>();
  const [deletingId, setDeletingId] = createSignal("");
  const [pendingDeleteId, setPendingDeleteId] = createSignal("");
  const [actionMessage, setActionMessage] = createSignal("");
  let fileInput: HTMLInputElement | undefined;
  let feedbackTimer: ReturnType<typeof setTimeout> | undefined;
  let latestUploadError = "";
  const htmlUploader = createUploadThing("htmlDocument", {
    onUploadError: (error) => {
      latestUploadError = error.message;
      setUploadError(error.message);
    },
  });

  const pageCountLabel = (count: number) =>
    count === 1 ? "1 HTML page in this workspace." : `${count} HTML pages in this workspace.`;

  const showActionMessage = (message: string) => {
    setActionMessage(message);
    if (feedbackTimer) clearTimeout(feedbackTimer);
    feedbackTimer = setTimeout(() => setActionMessage(""), 2600);
  };

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

  const handleFileChange = (event: Event) => {
    const input = event.currentTarget as HTMLInputElement;
    setSelectedFile(input.files?.[0]);
    setUploadError("");
  };

  const uploadDocument = async (event: SubmitEvent) => {
    event.preventDefault();
    latestUploadError = "";
    setUploadError("");

    const file = selectedFile() ?? fileInput?.files?.[0];

    if (!file) {
      setUploadError("Choose one .html file first.");
      return;
    }

    if (!file.name.toLowerCase().endsWith(".html")) {
      setUploadError("The first pass accepts standalone .html files only.");
      return;
    }

    setIsUploading(true);

    try {
      const title = file.name.replace(/\.html$/i, "").trim() || "Untitled HTML";
      const uploadResults = await htmlUploader.startUpload([file], { title });
      const uploaded = uploadResults?.[0];
      const uploadMetadata = uploaded?.serverData;

      if (!uploaded || !uploadMetadata?.ownerId || !uploadMetadata.customId) {
        throw new Error(latestUploadError || "The HTML file could not be uploaded.");
      }

      const documentResponse = await fetch("/api/documents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          storageProvider: "uploadthing",
          uploadOwnerId: uploadMetadata.ownerId,
          uploadCustomId: uploadMetadata.customId,
          contentType: "text/html",
          sizeBytes: uploaded.size,
        }),
      });

      if (!documentResponse.ok) throw new Error(await getErrorMessage(documentResponse));

      if (fileInput) fileInput.value = "";
      setSelectedFile(undefined);
      showActionMessage(`${title} uploaded.`);
      await loadDocuments();
    } catch (error) {
      setUploadError(
        error instanceof Error ? error.message : "The HTML file could not be uploaded."
      );
    } finally {
      setIsUploading(false);
    }
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
    setDocumentError("");
    setDeletingId(document._id);

    try {
      const response = await fetch(documentHref(document._id), { method: "DELETE" });

      if (response.status === 401) {
        redirectToSignIn();
        return;
      }

      if (!response.ok) throw new Error(await getErrorMessage(response));

      showActionMessage(`${document.title} deleted.`);
      await loadDocuments();
    } catch (error) {
      setDocumentError(
        error instanceof Error ? error.message : "The document could not be deleted."
      );
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
              <p class="page-lede">{pageCountLabel(documents().length)}</p>
            </div>
            <form class="upload-form" onSubmit={uploadDocument}>
              <label class="button-secondary" for="html-file">
                <Icon name="plus" />
                <span>Choose HTML</span>
              </label>
              <input
                ref={(element) => {
                  fileInput = element;
                }}
                id="html-file"
                class="file-input"
                name="html-file"
                type="file"
                accept=".html,text/html"
                aria-label="Choose an HTML file"
                onChange={handleFileChange}
              />
              <Show when={selectedFile()}>
                <span class="selected-file" title={selectedFile()?.name}>
                  {selectedFile()?.name}
                </span>
              </Show>
              <button class="button-primary" type="submit" disabled={isUploading()}>
                {isUploading() ? "Uploading…" : "Upload"}
              </button>
            </form>
          </header>

          <p class="upload-hint">
            One standalone <code>.html</code> file, up to 8 MiB. The title comes from the filename.
          </p>

          <Show when={uploadError()}>
            <p class="error-message" role="alert">
              {uploadError()}
            </p>
          </Show>
          <Show when={documentError()}>
            <p class="error-message" role="alert">
              {documentError()} Try refreshing the page.
            </p>
          </Show>

          <section class="documents-list" aria-labelledby="documents-list-title">
            <div class="list-header">
              <h2 id="documents-list-title">All documents</h2>
              <span class="list-count">{documents().length}</span>
            </div>
            <Show
              when={!isLoading() && documents().length > 0}
              fallback={
                <div class="empty-state">
                  <Show
                    when={isLoading()}
                    fallback={
                      <>
                        <span class="empty-icon" aria-hidden="true">
                          <Icon name="file" size={24} />
                        </span>
                        <h2>No pages yet.</h2>
                        <p>
                          Upload a standalone HTML page to give it a workspace link. Pages stay in
                          this workspace until you delete them.
                        </p>
                        <div class="empty-actions">
                          <label class="button-primary" for="html-file">
                            Choose HTML
                          </label>
                        </div>
                      </>
                    }
                  >
                    <p>Loading documents…</p>
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
                        {formatBytes(document.sizeBytes)} · {formatDocumentDate(document.createdAt)}
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
          </section>

          <div class="action-message" role="status" aria-live="polite">
            {actionMessage()}
          </div>
        </div>
      </AppShell>
    </Show>
  );
}

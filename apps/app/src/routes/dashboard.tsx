import { Meta, Title } from "@solidjs/meta";
import { For, Show, createEffect, createSignal } from "solid-js";
import Wordmark from "~/components/Wordmark";
import { authClient } from "~/lib/auth";

type DocumentRecord = {
  _id: string;
  title: string;
  contentType: string;
  sizeBytes: number;
  createdAt: number;
  updatedAt: number;
};

type ApiError = { error?: string };

const navigation = [
  { label: "Overview", href: "#overview", active: true },
  { label: "Documents", href: "#documents", active: false },
  { label: "Local CLI", href: "#connection", active: false },
];

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDocumentDate(timestamp: number) {
  const elapsed = Date.now() - timestamp;

  if (elapsed < 60_000) return "just now";
  if (elapsed < 24 * 60 * 60 * 1000) return `${Math.floor(elapsed / (60 * 60 * 1000))}h ago`;

  return new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(timestamp);
}

async function getErrorMessage(response: Response) {
  try {
    const body = (await response.json()) as ApiError;
    return body.error ?? `Request failed (${response.status})`;
  } catch {
    return `Request failed (${response.status})`;
  }
}

export default function Dashboard() {
  const session = authClient.useSession();
  const [documents, setDocuments] = createSignal<DocumentRecord[]>([]);
  const [isLoading, setIsLoading] = createSignal(true);
  const [isUploading, setIsUploading] = createSignal(false);
  const [uploadError, setUploadError] = createSignal("");
  const [documentError, setDocumentError] = createSignal("");
  let authRedirectStarted = false;
  let isSigningOut = false;
  let fileInput: HTMLInputElement | undefined;

  const userName = () => session().data?.user.name || session().data?.user.email || "Workspace";
  const userInitial = () => userName().slice(0, 1).toUpperCase();
  const storageUsed = () =>
    formatBytes(documents().reduce((total, document) => total + document.sizeBytes, 0));

  const redirectToSignIn = () => {
    if (typeof window !== "undefined") window.location.assign("/auth/github");
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

      if (!response.ok) {
        throw new Error(await getErrorMessage(response));
      }

      setDocuments((await response.json()) as DocumentRecord[]);
    } catch (error) {
      setDocumentError(error instanceof Error ? error.message : "Documents could not be loaded.");
    } finally {
      setIsLoading(false);
    }
  };

  createEffect(() => {
    const currentSession = session();

    if (currentSession.isPending) return;

    if (!currentSession.data) {
      if (!isSigningOut && !authRedirectStarted) {
        authRedirectStarted = true;
        redirectToSignIn();
      }
      return;
    }

    void loadDocuments();
  });

  const uploadDocument = async (event: SubmitEvent) => {
    event.preventDefault();
    setUploadError("");

    const file = fileInput?.files?.[0];

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
      const uploadUrlResponse = await fetch("/api/documents/upload-url", { method: "POST" });

      if (!uploadUrlResponse.ok) {
        throw new Error(await getErrorMessage(uploadUrlResponse));
      }

      const { uploadUrl } = (await uploadUrlResponse.json()) as { uploadUrl: string };
      const uploadResponse = await fetch(uploadUrl, {
        method: "POST",
        headers: { "Content-Type": "text/html" },
        body: file,
      });

      if (!uploadResponse.ok) {
        throw new Error("The HTML file could not be uploaded.");
      }

      const { storageId } = (await uploadResponse.json()) as { storageId: string };
      const title = file.name.replace(/\.html$/i, "").trim() || "Untitled HTML";
      const documentResponse = await fetch("/api/documents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          storageId,
          contentType: "text/html",
          sizeBytes: file.size,
        }),
      });

      if (!documentResponse.ok) {
        throw new Error(await getErrorMessage(documentResponse));
      }

      if (fileInput) fileInput.value = "";
      await loadDocuments();
    } catch (error) {
      setUploadError(
        error instanceof Error ? error.message : "The HTML file could not be uploaded."
      );
    } finally {
      setIsUploading(false);
    }
  };

  const removeDocument = async (id: string) => {
    setDocumentError("");

    try {
      const response = await fetch(`/api/documents/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });

      if (response.status === 401) {
        redirectToSignIn();
        return;
      }

      if (!response.ok) {
        throw new Error(await getErrorMessage(response));
      }

      await loadDocuments();
    } catch (error) {
      setDocumentError(
        error instanceof Error ? error.message : "The document could not be deleted."
      );
    }
  };

  const signOut = async () => {
    isSigningOut = true;
    await authClient.signOut();
    window.location.assign("/signed-out");
  };

  return (
    <div class="app-frame" data-auth-state="connected">
      <Title>Workspace | plansplease</Title>
      <Meta
        name="description"
        content="Your private plansplease workspace for HTML pages made by your coding agent."
      />

      <aside class="app-sidebar" aria-label="Workspace navigation">
        <div>
          <div class="sidebar-brand">
            <Wordmark inverse />
          </div>

          <div class="workspace-switcher">
            <span class="workspace-avatar" aria-hidden="true">
              {userInitial()}
            </span>
            <span>
              <strong>{userName()}'s workspace</strong>
              <small>Private workspace</small>
            </span>
            <span class="chevron" aria-hidden="true">
              ⌄
            </span>
          </div>

          <nav class="sidebar-nav">
            <p class="nav-label">Workspace</p>
            <For each={navigation}>
              {(item) => (
                <a
                  class="sidebar-link"
                  classList={{ "sidebar-link-active": item.active }}
                  href={item.href}
                >
                  {item.label}
                  {item.label === "Documents" && (
                    <span class="nav-count">{documents().length.toString().padStart(2, "0")}</span>
                  )}
                </a>
              )}
            </For>
          </nav>
        </div>

        <div class="sidebar-footer">
          <div class="sidebar-local-status">
            <span class="signal-dot" aria-hidden="true" />
            <span>
              <strong>Cloud sync</strong>
              <small>connected</small>
            </span>
          </div>
          <button class="sidebar-signout" type="button" onClick={signOut}>
            Sign out
          </button>
        </div>
      </aside>

      <Show
        when={!session().isPending && session().data}
        fallback={
          <main class="dashboard-content auth-loading" aria-live="polite">
            <span class="signal-dot" aria-hidden="true" />
            Opening your workspace...
          </main>
        }
      >
        <main class="dashboard-content">
          <header class="dashboard-topbar">
            <div class="breadcrumbs">
              <span>Workspace</span>
              <span aria-hidden="true">/</span>
              <strong>Pages</strong>
            </div>
            <div class="dashboard-top-actions">
              <span class="preview-pill">
                <span class="signal-dot" aria-hidden="true" />
                Connected
              </span>
              <button class="avatar-button" type="button" aria-label="Signed-in account">
                {userInitial()}
              </button>
            </div>
          </header>

          <div class="dashboard-body">
            <section class="dashboard-intro" id="overview" aria-labelledby="dashboard-title">
              <div>
                <p class="section-kicker">Private workspace</p>
                <h1 id="dashboard-title">
                  Pages made to be
                  <em>opened again.</em>
                </h1>
                <p>
                  Upload one HTML file at a time. Keep the pages your agent makes available wherever
                  you work.
                </p>
              </div>
              <div class="intro-stamp">
                <span>Workspace status</span>
                <strong>Connected</strong>
                <small>Files are private to this account.</small>
              </div>
            </section>

            <section class="metric-grid" aria-label="Workspace summary">
              <div class="metric-card metric-card-ink">
                <span class="metric-label">Saved pages</span>
                <strong>{documents().length.toString().padStart(2, "0")}</strong>
                <small>private to you</small>
              </div>
              <div class="metric-card">
                <span class="metric-label">HTML files</span>
                <strong>{documents().length.toString().padStart(2, "0")}</strong>
                <small>one file per page</small>
              </div>
              <div class="metric-card metric-card-green">
                <span class="metric-label">Storage used</span>
                <strong>{storageUsed()}</strong>
                <small>this workspace</small>
              </div>
            </section>

            <section class="dashboard-grid">
              <div class="panel documents-panel" id="documents">
                <div class="panel-heading">
                  <div>
                    <p class="panel-kicker">Workspace files</p>
                    <h2>Pages</h2>
                  </div>
                  <span class="panel-index">{documents().length} items</span>
                </div>

                <form class="upload-card" onSubmit={uploadDocument}>
                  <div>
                    <p class="panel-kicker upload-kicker">Add a page</p>
                    <strong>Upload one HTML file.</strong>
                    <small>Standalone .html files only for now.</small>
                  </div>
                  <label class="upload-field">
                    <span>Choose an HTML file</span>
                    <input
                      ref={(element) => {
                        fileInput = element;
                      }}
                      type="file"
                      accept=".html,text/html"
                    />
                  </label>
                  <button class="upload-button" type="submit" disabled={isUploading()}>
                    {isUploading() ? "Uploading..." : "Upload HTML"}
                  </button>
                </form>

                <Show when={uploadError()}>
                  <p class="auth-error" role="alert">
                    {uploadError()}
                  </p>
                </Show>
                <Show when={documentError()}>
                  <p class="auth-error" role="alert">
                    {documentError()}
                  </p>
                </Show>

                <div class="document-list">
                  <Show
                    when={!isLoading() && documents().length > 0}
                    fallback={
                      <p class="empty-documents">
                        {isLoading()
                          ? "Loading your pages..."
                          : "Upload an HTML file to see it here."}
                      </p>
                    }
                  >
                    <For each={documents()}>
                      {(document, index) => (
                        <div class="document-row">
                          <span
                            class="document-tone"
                            classList={{
                              "document-tone-green": index() % 3 === 1,
                              "document-tone-blue": index() % 3 === 2,
                            }}
                          />
                          <a
                            class="document-main"
                            href={`/api/documents/${encodeURIComponent(document._id)}`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            <strong>{document.title}</strong>
                            <small>HTML snapshot / {formatBytes(document.sizeBytes)}</small>
                          </a>
                          <span class="document-time">
                            {formatDocumentDate(document.createdAt)}
                          </span>
                          <a
                            class="document-arrow"
                            href={`/api/documents/${encodeURIComponent(document._id)}`}
                            target="_blank"
                            rel="noreferrer"
                            aria-label={`Open ${document.title}`}
                          >
                            Open
                          </a>
                          <button
                            class="document-delete"
                            type="button"
                            aria-label={`Delete ${document.title}`}
                            onClick={() => void removeDocument(document._id)}
                          >
                            Delete
                          </button>
                        </div>
                      )}
                    </For>
                  </Show>
                </div>

                <div class="panel-bottomline">
                  <span>Files are private to your account.</span>
                  <a href="#connection">
                    Local CLI <span aria-hidden="true">→</span>
                  </a>
                </div>
              </div>

              <aside
                class="panel connection-panel"
                id="connection"
                aria-labelledby="connection-title"
              >
                <span class="connection-badge">Local first</span>
                <p class="panel-kicker">Local CLI</p>
                <h2 id="connection-title">
                  Preview locally.
                  <em>Keep what matters.</em>
                </h2>
                <p>
                  The CLI is the fastest way to preview a page on your machine. Cloud publishing will
                  connect to this same workspace as the product grows.
                </p>
                <div class="terminal-card">
                  <span>$</span>
                  <code>planview start page.html</code>
                  <small>local preview</small>
                </div>
                <a class="connection-link" href="#documents">
                  Back to pages <span aria-hidden="true">→</span>
                </a>
              </aside>
            </section>

            <p class="dashboard-footnote">
              Private workspace <span aria-hidden="true">·</span> one standalone HTML file per upload.
            </p>
          </div>
        </main>
      </Show>
    </div>
  );
}

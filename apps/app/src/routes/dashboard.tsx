import { Meta, Title } from "@solidjs/meta";
import { useNavigate } from "@solidjs/router";
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
  { label: "CLI connection", href: "#connection", active: false },
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
  const navigate = useNavigate();
  const session = authClient.useSession();
  const [documents, setDocuments] = createSignal<DocumentRecord[]>([]);
  const [isLoading, setIsLoading] = createSignal(true);
  const [isUploading, setIsUploading] = createSignal(false);
  const [uploadError, setUploadError] = createSignal("");
  const [documentError, setDocumentError] = createSignal("");
  let fileInput: HTMLInputElement | undefined;

  const userName = () => session().data?.user.name || session().data?.user.email || "Workspace";
  const userInitial = () => userName().slice(0, 1).toUpperCase();
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
        await navigate("/", { replace: true });
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
      void navigate("/", { replace: true });
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
        await navigate("/", { replace: true });
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
    await authClient.signOut();
    await navigate("/", { replace: true });
  };

  return (
    <div class="app-frame" data-auth-state="connected">
      <Title>Workspace | Planview</Title>
      <Meta
        name="description"
        content="The Planview cloud workspace for persistent HTML snapshots."
      />

      <aside class="app-sidebar" aria-label="Workspace navigation">
        <div>
          <div class="sidebar-brand">
            <Wordmark inverse />
            <span class="sidebar-build">Staging / 01</span>
          </div>

          <div class="workspace-switcher">
            <span class="workspace-avatar" aria-hidden="true">
              {userInitial()}
            </span>
            <span>
              <strong>{userName()}'s workspace</strong>
              <small>Personal / cloud</small>
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
                  <span class="sidebar-link-mark" aria-hidden="true">
                    {item.active ? "◉" : "○"}
                  </span>
                  {item.label}
                  {item.label === "Documents" && (
                    <span class="nav-count">{documents().length.toString().padStart(2, "0")}</span>
                  )}
                </a>
              )}
            </For>
            <p class="nav-label nav-label-spaced">Account</p>
            <a class="sidebar-link sidebar-link-muted" href="#settings">
              <span class="sidebar-link-mark" aria-hidden="true">
                ◇
              </span>
              Settings
            </a>
          </nav>
        </div>

        <div class="sidebar-footer">
          <div class="sidebar-local-status">
            <span class="signal-dot" aria-hidden="true" />
            <span>
              <strong>Cloud backend</strong>
              <small>connected</small>
            </span>
          </div>
          <button class="sidebar-signout" type="button" onClick={signOut}>
            Sign out <span aria-hidden="true">↗</span>
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
              <strong>Overview</strong>
            </div>
            <div class="dashboard-top-actions">
              <span class="preview-pill">
                <span class="signal-dot" aria-hidden="true" />
                Staging / connected
              </span>
              <button class="avatar-button" type="button" aria-label="Signed-in account">
                {userInitial()}
              </button>
            </div>
          </header>

          <div class="dashboard-body">
            <section class="dashboard-intro" id="overview" aria-labelledby="dashboard-title">
              <div>
                <p class="eyebrow">
                  <span class="signal-dot" aria-hidden="true" />
                  Personal cloud workspace
                </p>
                <h1 id="dashboard-title">
                  A little room for
                  <em>good work.</em>
                </h1>
                <p>Your cloud workspace for the small HTML things worth keeping around.</p>
              </div>
              <div class="intro-stamp">
                <span>Cloud status</span>
                <strong>Quiet / ready</strong>
                <small>Convex storage is connected for this staging workspace.</small>
              </div>
            </section>

            <section class="metric-grid" aria-label="Workspace summary">
              <div class="metric-card metric-card-ink">
                <span class="metric-label">Retained documents</span>
                <strong>{documents().length.toString().padStart(2, "0")}</strong>
                <small>private to this account</small>
              </div>
              <div class="metric-card">
                <span class="metric-label">Published files</span>
                <strong>{documents().length.toString().padStart(2, "0")}</strong>
                <small>standalone HTML snapshots</small>
              </div>
              <div class="metric-card metric-card-green">
                <span class="metric-label">Storage used</span>
                <strong>{storageUsed()}</strong>
                <small>Convex storage / staging</small>
              </div>
            </section>

            <section class="dashboard-grid">
              <div class="panel documents-panel" id="documents">
                <div class="panel-heading">
                  <div>
                    <p class="panel-kicker">Recent work</p>
                    <h2>Documents</h2>
                  </div>
                  <span class="panel-index">{documents().length} items</span>
                </div>

                <form class="upload-card" onSubmit={uploadDocument}>
                  <div>
                    <p class="panel-kicker upload-kicker">Publish one file</p>
                    <strong>Upload a standalone HTML snapshot.</strong>
                    <small>Bundles and asset folders arrive with the R2 slice.</small>
                  </div>
                  <label class="upload-field">
                    <span class="sr-only">HTML file</span>
                    <input
                      ref={(element) => {
                        fileInput = element;
                      }}
                      type="file"
                      accept=".html,text/html"
                    />
                  </label>
                  <button class="upload-button" type="submit" disabled={isUploading()}>
                    {isUploading() ? "Uploading..." : "Publish file"}
                    <span aria-hidden="true">↗</span>
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
                          ? "Loading your documents..."
                          : "Your first HTML snapshot will appear here."}
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
                            ↗
                          </a>
                          <button
                            class="document-delete"
                            type="button"
                            aria-label={`Delete ${document.title}`}
                            onClick={() => void removeDocument(document._id)}
                          >
                            ×
                          </button>
                        </div>
                      )}
                    </For>
                  </Show>
                </div>

                <div class="panel-bottomline">
                  <span>Files are private to your account in this first pass.</span>
                  <a href="#connection">
                    Connect CLI <span aria-hidden="true">↗</span>
                  </a>
                </div>
              </div>

              <aside
                class="panel connection-panel"
                id="connection"
                aria-labelledby="connection-title"
              >
                <div class="connection-signal" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </div>
                <p class="panel-kicker">Next connection</p>
                <h2 id="connection-title">
                  Bring the
                  <em>local loop.</em>
                </h2>
                <p>
                  The CLI will make this workspace useful to your agents. Authenticate once, then
                  publish an HTML file from the terminal.
                </p>
                <div class="terminal-card">
                  <span>$</span>
                  <code>planview cloud login</code>
                  <small>CLI slice planned next</small>
                </div>
                <a class="connection-link" href="#documents">
                  Return to documents <span aria-hidden="true">↗</span>
                </a>
              </aside>
            </section>

            <p class="dashboard-footnote">
              Staging surface <span aria-hidden="true">·</span> Better Auth sessions and Convex
              storage are connected; CLI and MCP are still separate slices.
            </p>
          </div>
        </main>
      </Show>
    </div>
  );
}

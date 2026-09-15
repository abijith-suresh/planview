import { Meta, Title } from "@solidjs/meta";
import { A } from "@solidjs/router";
import { For } from "solid-js";
import Wordmark from "~/components/Wordmark";

const documents = [
  {
    id: "html_7K3F",
    title: "Quiet morning",
    detail: "HTML snapshot / 18 KB",
    time: "just now",
    tone: "green",
  },
  {
    id: "html_2N8Q",
    title: "Launch notes",
    detail: "HTML snapshot / 42 KB",
    time: "yesterday",
    tone: "blue",
  },
  {
    id: "html_9P1M",
    title: "Reader study",
    detail: "HTML snapshot / 31 KB",
    time: "03 Sep 2026",
    tone: "orange",
  },
];

const navigation = [
  { label: "Overview", href: "#overview", active: true },
  { label: "Documents", href: "#documents", active: false },
  { label: "CLI connection", href: "#connection", active: false },
];

export default function Dashboard() {
  return (
    <div class="app-frame" data-auth-state="preview">
      <Title>Workspace | Planview</Title>
      <Meta name="description" content="Preview of the Planview cloud workspace dashboard." />

      <aside class="app-sidebar" aria-label="Workspace navigation">
        <div>
          <div class="sidebar-brand">
            <Wordmark inverse />
            <span class="sidebar-build">Preview / 01</span>
          </div>

          <div class="workspace-switcher">
            <span class="workspace-avatar" aria-hidden="true">
              A
            </span>
            <span>
              <strong>Abijith's workspace</strong>
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
                  {item.label === "Documents" && <span class="nav-count">03</span>}
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
              <strong>Local CLI</strong>
              <small>not connected</small>
            </span>
          </div>
          <A class="sidebar-signout" href="/">
            Sign out <span aria-hidden="true">↗</span>
          </A>
        </div>
      </aside>

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
              Preview mode
            </span>
            <button class="avatar-button" type="button" aria-label="Open account menu">
              A
            </button>
          </div>
        </header>

        <div class="dashboard-body">
          <section class="dashboard-intro" id="overview" aria-labelledby="dashboard-title">
            <div>
              <p class="eyebrow">
                <span class="signal-dot" aria-hidden="true" />
                Thursday / 15 September 2026
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
              <small>Convex connection comes next</small>
            </div>
          </section>

          <section class="metric-grid" aria-label="Workspace summary">
            <div class="metric-card metric-card-ink">
              <span class="metric-label">Retained documents</span>
              <strong>03</strong>
              <small>available by link</small>
            </div>
            <div class="metric-card">
              <span class="metric-label">This month</span>
              <strong>03</strong>
              <small>HTML snapshots published</small>
            </div>
            <div class="metric-card metric-card-green">
              <span class="metric-label">Storage used</span>
              <strong>91 KB</strong>
              <small>Convex storage / preview</small>
            </div>
          </section>

          <section class="dashboard-grid">
            <div class="panel documents-panel" id="documents">
              <div class="panel-heading">
                <div>
                  <p class="panel-kicker">Recent work</p>
                  <h2>Documents</h2>
                </div>
                <span class="panel-index">03 items</span>
              </div>

              <div class="document-list">
                <For each={documents}>
                  {(document) => (
                    <a class="document-row" href={`#${document.id}`}>
                      <span
                        class="document-tone"
                        classList={{ [`document-tone-${document.tone}`]: true }}
                      />
                      <span class="document-main">
                        <strong>{document.title}</strong>
                        <small>{document.detail}</small>
                      </span>
                      <span class="document-time">{document.time}</span>
                      <span class="document-arrow" aria-hidden="true">
                        ↗
                      </span>
                    </a>
                  )}
                </For>
              </div>

              <div class="panel-bottomline">
                <span>Links are unlisted until you share them.</span>
                <a href="#all-documents">
                  View all <span aria-hidden="true">↗</span>
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
                <small>planned command</small>
              </div>
              <a class="connection-link" href="#cli-docs">
                Read the connection notes <span aria-hidden="true">↗</span>
              </a>
            </aside>
          </section>

          <p class="dashboard-footnote">
            Preview surface only <span aria-hidden="true">·</span> Better Auth, Convex, and the
            cloud CLI are intentionally not connected yet.
          </p>
        </div>
      </main>
    </div>
  );
}

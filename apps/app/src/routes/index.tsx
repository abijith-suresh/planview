import { Meta, Title } from "@solidjs/meta";
import { A } from "@solidjs/router";
import Wordmark from "~/components/Wordmark";
import { authPreview } from "~/lib/auth";

export default function Home() {
  return (
    <main class="auth-page">
      <Title>Sign in | Planview</Title>
      <Meta
        name="description"
        content="Sign in to the Planview cloud workspace for persistent HTML snapshots."
      />

      <section class="auth-story" aria-labelledby="story-title">
        <div class="auth-story-grid" aria-hidden="true" />
        <header class="auth-story-header">
          <Wordmark inverse />
          <span>Cloud workspace / 001</span>
        </header>

        <div class="auth-story-body">
          <p class="eyebrow eyebrow-light">
            <span class="signal-dot" aria-hidden="true" />A place for the useful version
          </p>
          <h1 id="story-title">
            Keep the useful
            <em>things close.</em>
          </h1>
          <p class="story-copy">
            Push the small, finished-looking things your agent makes into a cloud workspace you can
            return to from anywhere.
          </p>

          <div class="story-ticket">
            <div class="story-ticket-topline">
              <span>cloud / retained</span>
              <span>PV 01</span>
            </div>
            <div class="story-ticket-address">
              content.planview.dev/<b>quiet-morning</b>
            </div>
            <div class="story-ticket-rule" />
            <div class="story-ticket-footer">
              <span>HTML snapshot</span>
              <span>↗</span>
              <span>available anywhere</span>
            </div>
          </div>
        </div>

        <footer class="auth-story-footer">
          <span>Local first / cloud when useful</span>
          <span>15.09.26</span>
        </footer>
      </section>

      <section class="auth-panel" aria-labelledby="login-title">
        <div class="auth-panel-inner">
          <div class="mobile-wordmark">
            <Wordmark />
          </div>

          <p class="eyebrow">
            <span class="signal-dot" aria-hidden="true" />
            Private cloud workspace
          </p>
          <h2 id="login-title">
            Sign in to your
            <em>workspace.</em>
          </h2>
          <p class="auth-intro">
            Your local CLI can publish a durable HTML snapshot here. Start with GitHub, then keep
            the rest of the surface quiet.
          </p>

          <div class="auth-card">
            <div class="auth-card-heading">
              <span class="auth-card-label">Continue with</span>
              <span class="auth-card-index">01 / 01</span>
            </div>
            <button class="github-button" type="button" disabled aria-disabled="true">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 2.5a9.5 9.5 0 0 0-3 18.51c.48.09.66-.21.66-.46v-1.63c-2.7.59-3.27-1.3-3.27-1.3-.44-1.13-1.08-1.43-1.08-1.43-.88-.6.07-.59.07-.59.97.07 1.48 1 1.48 1 .87 1.48 2.28 1.05 2.84.8.09-.62.34-1.05.62-1.29-2.16-.25-4.43-1.08-4.43-4.81 0-1.06.38-1.93 1-2.61-.1-.25-.43-1.24.1-2.58 0 0 .82-.26 2.67 1a9.3 9.3 0 0 1 4.86 0c1.85-1.26 2.67-1 2.67-1 .53 1.34.2 2.33.1 2.58.62.68 1 1.55 1 2.61 0 3.74-2.27 4.56-4.44 4.8.35.3.66.88.66 1.78v2.64c0 .25.18.55.67.46A9.5 9.5 0 0 0 12 2.5Z" />
              </svg>
              <span>Continue with GitHub</span>
              <small>coming next</small>
            </button>
            <div class="auth-card-footer">
              <span>{authPreview.provider} only, for now</span>
              <span class="lock-mark" aria-hidden="true">
                ⌁
              </span>
            </div>
          </div>

          <p class="preview-note">
            <strong>Preview build.</strong> {authPreview.description}
          </p>
          <A class="dashboard-link" href="/dashboard">
            Open the workspace preview <span aria-hidden="true">↗</span>
          </A>
        </div>
      </section>
    </main>
  );
}

import { Meta, Title } from "@solidjs/meta";
import { Show, createSignal } from "solid-js";
import Wordmark from "~/components/Wordmark";
import { authClient } from "~/lib/auth";

export default function Home() {
  const [isSigningIn, setIsSigningIn] = createSignal(false);
  const [authError, setAuthError] = createSignal("");

  const signInWithGitHub = async () => {
    setAuthError("");
    setIsSigningIn(true);

    try {
      const response = await authClient.signIn.social({
        provider: "github",
        callbackURL: "/dashboard",
      });

      if (response.error) {
        setAuthError(response.error.message ?? "GitHub sign-in could not be started.");
        setIsSigningIn(false);
      }
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "GitHub sign-in could not be started.");
      setIsSigningIn(false);
    }
  };

  return (
    <main class="auth-page">
      <Title>Sign in | plansplease</Title>
      <Meta
        name="description"
        content="Sign in to your private plansplease workspace for HTML pages made by your coding agent."
      />

      <section class="auth-story" aria-labelledby="story-title">
        <header class="auth-story-header">
          <Wordmark inverse />
          <span class="auth-story-note">Private HTML workspace</span>
        </header>

        <div class="auth-story-body">
          <h1 id="story-title">
            Give agent-made pages
            <em>a place to live.</em>
          </h1>
          <p class="story-copy">
            plansplease keeps the HTML your coding agent makes close. Preview it locally, then save
            the pages you want to open again from anywhere.
          </p>

          <div class="story-preview" aria-label="Example saved HTML page">
            <div class="preview-window-bar">
              <span class="preview-window-dots" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
              <span class="preview-window-address">app.plansplease.dev / pages / morning-plan</span>
            </div>
            <div class="preview-window-body">
              <div class="preview-window-meta">
                <span>HTML page</span>
                <span>private</span>
              </div>
              <p class="preview-window-date">Monday / 08:30</p>
              <h2>Morning plan</h2>
              <p>A little room to figure out what comes next.</p>
              <div class="preview-task-list">
                <span>
                  <b>01</b>
                  Make coffee before opening tabs
                </span>
                <span>
                  <b>02</b>
                  Read the useful bits of yesterday
                </span>
              </div>
            </div>
          </div>
        </div>

        <footer class="auth-story-footer">
          <span>one HTML file at a time</span>
          <span>private by default</span>
        </footer>
      </section>

      <section class="auth-panel" aria-labelledby="login-title">
        <div class="auth-panel-inner">
          <div class="mobile-wordmark">
            <Wordmark />
          </div>

          <div class="auth-panel-heading">
            <span class="auth-panel-kicker">Your workspace</span>
            <span class="auth-panel-rule" aria-hidden="true" />
          </div>
          <h2 id="login-title">
            Welcome to
            <em>plansplease.</em>
          </h2>
          <p class="auth-intro">Sign in with GitHub to create your private workspace.</p>

          <div class="auth-card">
            <div class="auth-card-heading">
              <span class="auth-card-label">Get started</span>
              <span class="auth-card-index">GitHub</span>
            </div>
            <button
              class="github-button"
              type="button"
              disabled={isSigningIn()}
              aria-busy={isSigningIn()}
              onClick={signInWithGitHub}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 2.5a9.5 9.5 0 0 0-3 18.51c.48.09.66-.21.66-.46v-1.63c-2.7.59-3.27-1.3-3.27-1.3-.44-1.13-1.08-1.43-1.08-1.43-.88-.6.07-.59.07-.59.97.07 1.48 1 1.48 1 .87 1.48 2.28 1.05 2.84.8.09-.62.34-1.05.62-1.29-2.16-.25-4.43-1.08-4.43-4.81 0-1.06.38-1.93 1-2.61-.1-.25-.43-1.24.1-2.58 0 0 .82-.26 2.67 1a9.3 9.3 0 0 1 4.86 0c1.85-1.26 2.67-1 2.67-1 .53 1.34.2 2.33.1 2.58.62.68 1 1.55 1 2.61 0 3.74-2.27 4.56-4.44 4.8.35.3.66.88.66 1.78v2.64c0 .25.18.55.67.46A9.5 9.5 0 0 0 12 2.5Z" />
              </svg>
              <span>{isSigningIn() ? "Opening GitHub..." : "Continue with GitHub"}</span>
            </button>
            <div class="auth-card-footer">
              <span>New accounts are created automatically.</span>
              <span>Secure sign-in</span>
            </div>
          </div>

          <Show when={authError()}>
            <p class="auth-error" role="alert">
              {authError()}
            </p>
          </Show>

          <p class="auth-note">Your files stay private to your account.</p>
        </div>
      </section>
    </main>
  );
}

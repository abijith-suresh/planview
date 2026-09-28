import { Meta, Title } from "@solidjs/meta";
import { Show, createSignal } from "solid-js";

import AppShell from "~/components/AppShell";
import Icon from "~/components/Icon";
import { useWorkspaceAuth } from "~/lib/workspace-auth";

export default function Settings() {
  const { session, signOut, user, userInitial, userName } = useWorkspaceAuth();
  const [signOutError, setSignOutError] = createSignal("");
  const [isSigningOut, setIsSigningOut] = createSignal(false);

  const handleSignOut = async () => {
    setSignOutError("");
    setIsSigningOut(true);

    try {
      await signOut();
    } catch {
      setSignOutError("Sign out failed. Try again.");
      setIsSigningOut(false);
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
      <Title>Settings | plansplease</Title>
      <Meta name="description" content="Your plansplease account, CLI connection, and session." />
      <AppShell active="settings" userInitial={userInitial} userName={userName}>
        <div class="page-content settings-content">
          <header class="page-header">
            <div>
              <h1>Settings</h1>
              <p class="page-lede">Your account and workspace details.</p>
            </div>
          </header>

          <section class="card onboarding-card" aria-labelledby="settings-account-title">
            <h2 id="settings-account-title">Account</h2>
            <div class="settings-account">
              <span class="profile-avatar">
                {user()?.image ? (
                  <img src={user()?.image ?? ""} alt="" />
                ) : (
                  <span>{userInitial()}</span>
                )}
              </span>
              <div>
                <strong>{userName()}</strong>
                <span class="stat-meta">{user()?.email}</span>
                <span class="stat-meta">Signed in with GitHub</span>
              </div>
            </div>
          </section>

          <section class="card onboarding-card" aria-labelledby="settings-cli-title">
            <h2 id="settings-cli-title">Connect the CLI</h2>
            <p>
              Run <code>planview login</code> in your terminal and approve the browser page that
              opens.
            </p>
            <p class="page-note">
              Uploading from the CLI is how pages reach this workspace. Pages appear here
              automatically as they are saved.
            </p>
          </section>

          <section class="card onboarding-card" aria-labelledby="settings-session-title">
            <h2 id="settings-session-title">Session</h2>
            <p>Signing out returns you to the plansplease site.</p>
            <div class="settings-actions">
              <button
                class="button-secondary"
                type="button"
                disabled={isSigningOut()}
                onClick={() => void handleSignOut()}
              >
                <Icon name="log-out" />
                <span>{isSigningOut() ? "Signing out…" : "Sign out"}</span>
              </button>
              <Show when={signOutError()}>
                <p class="error-message" role="alert">
                  {signOutError()}
                </p>
              </Show>
            </div>
          </section>
        </div>
      </AppShell>
    </Show>
  );
}

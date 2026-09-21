import { A } from "@solidjs/router";
import { Show, createSignal, type JSX } from "solid-js";

import Icon from "~/components/Icon";

type AppShellProps = {
  active: "dashboard" | "documents";
  userInitial: () => string;
  userName: () => string;
  onSignOut: () => Promise<void>;
  children: JSX.Element;
};

export default function AppShell(props: AppShellProps) {
  const [signOutError, setSignOutError] = createSignal("");

  const handleSignOut = async () => {
    setSignOutError("");

    try {
      await props.onSignOut();
    } catch {
      setSignOutError("Sign out failed. Try again.");
    }
  };

  return (
    <div class="app-frame">
      <aside class="app-sidebar" aria-label="Workspace navigation">
        <div class="sidebar-primary">
          <div class="sidebar-brand">
            <A class="wordmark" href="/dashboard">
              plansplease
            </A>
          </div>

          <nav class="sidebar-nav" aria-label="Workspace">
            <A
              class="sidebar-link"
              classList={{ "sidebar-link-active": props.active === "dashboard" }}
              href="/dashboard"
              aria-current={props.active === "dashboard" ? "page" : undefined}
            >
              <Icon name="grid" />
              <span>Overview</span>
            </A>
            <A
              class="sidebar-link"
              classList={{ "sidebar-link-active": props.active === "documents" }}
              href="/documents"
              aria-current={props.active === "documents" ? "page" : undefined}
            >
              <Icon name="file" />
              <span>Documents</span>
            </A>
          </nav>
        </div>

        <div class="sidebar-footer">
          <div class="account-row">
            <span class="account-avatar" aria-hidden="true">
              {props.userInitial()}
            </span>
            <span class="account-name">{props.userName()}</span>
          </div>
          <Show when={signOutError()}>
            <p class="sidebar-error" role="alert">
              {signOutError()}
            </p>
          </Show>
          <button class="sidebar-signout" type="button" onClick={() => void handleSignOut()}>
            <Icon name="log-out" />
            <span>Sign out</span>
          </button>
        </div>
      </aside>

      <a class="skip-link" href="#main-content">
        Skip to main content
      </a>
      <main id="main-content" class="app-main">
        {props.children}
      </main>
    </div>
  );
}

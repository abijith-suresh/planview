import { A } from "@solidjs/router";
import type { JSX } from "solid-js";

import Icon from "~/components/Icon";

type AppShellProps = {
  active: "dashboard" | "documents" | "settings";
  userInitial: () => string;
  userName: () => string;
  children: JSX.Element;
};

export default function AppShell(props: AppShellProps) {
  return (
    <div class="app-frame">
      <a class="skip-link" href="#main-content">
        Skip to main content
      </a>
      <aside class="app-sidebar" aria-label="Workspace navigation">
        <div class="sidebar-brand">
          <A class="wordmark" href="/dashboard">
            <span class="brand-name">
              <span class="brand-plans">plans</span>
              <span class="brand-please">please</span>
            </span>
          </A>
        </div>

        <nav class="sidebar-nav" aria-label="Workspace">
          <A
            class="sidebar-link"
            classList={{ "sidebar-link-active": props.active === "dashboard" }}
            href="/dashboard"
            aria-label="Overview"
            aria-current={props.active === "dashboard" ? "page" : undefined}
          >
            <Icon name="grid" />
            <span>Overview</span>
          </A>
          <A
            class="sidebar-link"
            classList={{ "sidebar-link-active": props.active === "documents" }}
            href="/documents"
            aria-label="Documents"
            aria-current={props.active === "documents" ? "page" : undefined}
          >
            <Icon name="file" />
            <span>Documents</span>
          </A>
          <A
            class="sidebar-link"
            classList={{ "sidebar-link-active": props.active === "settings" }}
            href="/settings"
            aria-label="Settings"
            aria-current={props.active === "settings" ? "page" : undefined}
          >
            <Icon name="settings" />
            <span>Settings</span>
          </A>
        </nav>

        <div class="sidebar-footer">
          <div class="account-row">
            <span class="account-avatar" aria-hidden="true">
              {props.userInitial()}
            </span>
            <span class="account-name">{props.userName()}</span>
          </div>
        </div>
      </aside>

      <main id="main-content" class="app-main" tabindex="-1">
        {props.children}
      </main>
    </div>
  );
}

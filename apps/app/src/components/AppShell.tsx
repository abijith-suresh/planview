import { A, useLocation } from "@solidjs/router";
import { createEffect, createSignal, onCleanup, onMount, type JSX } from "solid-js";

import Icon from "~/components/Icon";
import { docsUrl } from "~/lib/docs-url";

type AppShellProps = {
  active: "documents" | "settings";
  userName: () => string;
  children: JSX.Element;
};

let focusNextWorkspacePage = false;

export default function AppShell(props: AppShellProps) {
  const location = useLocation();
  const [menuOpen, setMenuOpen] = createSignal(false);
  let dialog!: HTMLDialogElement;
  let menuButton!: HTMLButtonElement;
  let desktopNav!: HTMLElement;
  let previousOverflow: string | undefined;

  const unlockScroll = () => {
    if (previousOverflow !== undefined) {
      document.body.style.overflow = previousOverflow;
      previousOverflow = undefined;
    }
  };
  const closeMenu = (restoreFocus = true) => {
    if (!dialog?.open) return;
    dialog.close();
    setMenuOpen(false);
    unlockScroll();
    if (restoreFocus) menuButton.focus();
  };
  const openMenu = () => {
    if (dialog.open) return;
    previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialog.showModal();
    setMenuOpen(true);
  };
  const navigateFromMenu = (destination?: string, event?: MouseEvent) => {
    if (
      event &&
      (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
    ) {
      closeMenu();
      return;
    }
    closeMenu(false);
    if (destination === location.pathname) {
      document.getElementById("main-content")?.focus();
    } else {
      focusNextWorkspacePage = true;
    }
  };

  createEffect(() => {
    // Also close when navigation comes from browser Back or another route link.
    location.pathname;
    location.search;
    if (typeof document !== "undefined" && dialog?.open) navigateFromMenu();
  });
  onMount(() => {
    if (focusNextWorkspacePage) {
      focusNextWorkspacePage = false;
      requestAnimationFrame(() => document.getElementById("main-content")?.focus());
    }
    const mobile = window.matchMedia("(max-width: 760px)");
    const handleResize = () => {
      if (!mobile.matches && dialog.open) {
        closeMenu(false);
        desktopNav.querySelector<HTMLElement>('[aria-current="page"]')?.focus();
      }
    };
    mobile.addEventListener("change", handleResize);
    onCleanup(() => {
      mobile.removeEventListener("change", handleResize);
      if (dialog.open) {
        focusNextWorkspacePage = true;
        dialog.close();
      }
      unlockScroll();
    });
  });

  const navigation = (mobile = false) => (
    <nav
      class="sidebar-nav"
      aria-label={mobile ? "Mobile workspace" : "Workspace"}
      ref={(element) => {
        if (!mobile) desktopNav = element;
      }}
    >
      <A
        class="sidebar-link"
        classList={{ "sidebar-link-active": props.active === "documents" }}
        href="/documents"
        aria-current={props.active === "documents" ? "page" : undefined}
        onClick={mobile ? (event) => navigateFromMenu("/documents", event) : undefined}
      >
        <Icon name="file" />
        <span>Documents</span>
      </A>
      <A
        class="sidebar-link"
        classList={{ "sidebar-link-active": props.active === "settings" }}
        href="/settings"
        aria-current={props.active === "settings" ? "page" : undefined}
        onClick={mobile ? (event) => navigateFromMenu("/settings", event) : undefined}
      >
        <Icon name="settings" />
        <span>Settings</span>
      </A>
    </nav>
  );
  const footer = (mobile = false) => (
    <div class="sidebar-footer">
      <a
        class="sidebar-link"
        href={docsUrl()}
        target="_blank"
        rel="noreferrer"
        onClick={mobile ? () => closeMenu() : undefined}
      >
        <Icon name="book" />
        <span>Documentation</span>
        <span class="sr-only"> (opens in a new tab)</span>
      </a>
      <p class="account-name">{props.userName()}</p>
    </div>
  );

  return (
    <div class="app-frame">
      <a class="skip-link" href="#main-content">
        Skip to main content
      </a>
      <aside class="app-sidebar" aria-label="Workspace navigation">
        <div class="sidebar-brand">
          <A class="wordmark" href="/documents">
            <span class="brand-name">
              <span class="brand-plans">plans</span>
              <span class="brand-please">please</span>
            </span>
          </A>
          <button
            ref={menuButton}
            class="mobile-menu-button"
            type="button"
            aria-haspopup="dialog"
            aria-expanded={menuOpen()}
            aria-controls="workspace-menu"
            onClick={openMenu}
          >
            <Icon name="menu" />
            <span>Menu</span>
          </button>
        </div>
        <div class="desktop-navigation">
          {navigation()}
          {footer()}
        </div>
      </aside>
      <dialog
        ref={dialog}
        id="workspace-menu"
        class="mobile-menu"
        aria-labelledby="workspace-menu-title"
        onCancel={(event) => {
          event.preventDefault();
          closeMenu();
        }}
        onClose={() => {
          if (!dialog.open) {
            setMenuOpen(false);
            unlockScroll();
          }
        }}
        onPointerDown={(event) => {
          if (event.target !== dialog) return;
          const bounds = dialog.getBoundingClientRect();
          if (
            event.clientX < bounds.left ||
            event.clientX > bounds.right ||
            event.clientY < bounds.top ||
            event.clientY > bounds.bottom
          )
            closeMenu();
        }}
      >
        <div class="mobile-menu-heading">
          <h2 id="workspace-menu-title">Menu</h2>
          <button
            class="icon-button"
            type="button"
            aria-label="Close menu"
            autofocus
            onClick={() => closeMenu()}
          >
            <Icon name="x" size={20} />
          </button>
        </div>
        {navigation(true)}
        {footer(true)}
      </dialog>
      <main id="main-content" class="app-main" tabindex="-1">
        {props.children}
      </main>
    </div>
  );
}

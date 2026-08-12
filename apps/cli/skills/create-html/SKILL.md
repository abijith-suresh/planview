---
name: create-html
description: Create accessible, self-contained HTML with browser-native platform patterns and progressive enhancement.
metadata:
  author: planview
  version: "0.1"
---

# Create HTML

Build a complete, usable HTML document before adding polish. Prefer the platform:
semantic elements, native controls, CSS layout, and small browser APIs are easier
to inspect, save, publish, and run without a build step.

## Build sequence

1. Clarify the user task, content hierarchy, states, and the smallest useful
   interaction model.
2. Start with `<!doctype html>`, a language attribute, responsive viewport, a
   meaningful `<title>`, semantic landmarks, and real heading order.
3. Use native controls first: `<button>` for actions, `<a>` for navigation,
   `<form>` for submission, `<label>` for fields, `<details>` for disclosure,
   and `<dialog>` for modal flows. Add ARIA only when native semantics do not
   express the behavior.
4. Use CSS custom properties, grid/flexbox, `clamp()`, and media/container
   queries for responsive layout. Respect `prefers-reduced-motion`, visible
   focus, contrast, zoom, and forced-colors users.
5. Add progressive enhancement with a small module script. Use `addEventListener`,
   `FormData`, `URL`, `URLSearchParams`, `fetch`, `AbortController`, and
   `localStorage` only where the feature still has a sensible fallback.
6. Test keyboard-only navigation, narrow and wide viewports, empty/loading/error
   states, and a refresh with JavaScript disabled.

## Browser-native patterns

Reach for the patterns in `references/browser-native-patterns.md` before importing
a component library. Keep the document self-contained unless a dependency is an
explicit requirement. Use custom elements only when a repeated behavior has a
clear boundary; keep their public attributes and events small and documented.

## Output checklist

- Content is meaningful without color, hover, animation, or JavaScript.
- Every control has an accessible name and every status update has an appropriate
  live-region strategy without stealing focus.
- Links navigate and buttons act; do not make clickable `<div>` elements.
- Images have useful alternative text (or empty alt text when decorative), and
  form errors identify the field and explain how to fix it.
- Avoid inline secrets, unsafe HTML injection, third-party trackers, and opaque
  generated markup. Escape untrusted text and validate at the boundary.
- Format the final file so it can be opened directly in a browser or published
  with `planview publish ./page.html`.

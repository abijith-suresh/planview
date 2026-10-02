---
title: Features under review
description: Separate live staging behavior, merged implementation, feature PRs, and proposals.
---
Status reviewed on **2 October 2026**. A merged repository change is not proof that
staging has deployed it. Check the running service before relying on a new behavior.

## Current staging workflows

GitHub account sign-in, standalone HTML uploads, account-owned previews, CLI
upload credentials, and OAuth MCP document tools are available for testing.
UploadThing object URLs remain public during alpha.

## Merged changes

- [App navigation and document interface, #120](https://github.com/abijith-suresh/planview/pull/120)
  removes the overview, adds mobile navigation, and corrects sign-in and sign-out
  destinations. The independent auth-routing PR below contains the same helpers.

- [Stable Effect 4 upgrade, #121](https://github.com/abijith-suresh/planview/pull/121)
  updates local runtime code; install a build from the corresponding source.
- [Friendly staging origin, #127](https://github.com/abijith-suresh/planview/pull/127)
  updates app links and migrates known old CLI credentials to the same backend.
  The friendly Railway domains are already configured.
- [500 MB account quota, #131](https://github.com/abijith-suresh/planview/pull/131)
  reserves encoded bytes before uploads and retains uncertain outcomes until
  cleanup. It is awaiting staging rollout and needs the coordinated backend/app
  deployment described in the app README.

## Open implementations

| PR | Behavior | Staging status |
| --- | --- | --- |
| [#128: provider boundary and delivery](https://github.com/abijith-suresh/planview/pull/128) | Direct browser delivery for standalone HTML and a provider adapter | Awaiting merge and deployment |
| [#130: unlisted sharing](https://github.com/abijith-suresh/planview/pull/130) | Optional bearer links with rotation/revocation and noindex | Awaiting merge and deployment |
| [#132: auth routing](https://github.com/abijith-suresh/planview/pull/132) | Correct app/site sign-in and sign-out destinations | Helpers merged in #120; this duplicate PR remains open |
| [#133: cloud bundles](https://github.com/abijith-suresh/planview/pull/133) | CLI folders, MCP text assets, and relative CSS/JS/module previews | Awaiting merge and deployment |

Cloud bundles would require root `index.html`, at most 512 files, and an 8 MiB
encoded object. MCP text assets and CLI binary assets have different inputs.
Bundle delivery would pass through the app with a bounded cache, so app bandwidth
costs still apply. Cloud bundles, sharing, and direct browser delivery are not
current staging promises. The routing helpers are merged in #120, while their original PR remains open.

## Proposals only

- [Revisions, #123](https://github.com/abijith-suresh/planview/pull/123): discuss
  stable document identity, version URLs, and agent behavior before changing uploads.
- [Self-hosting, #129](https://github.com/abijith-suresh/planview/pull/129): define
  a supported installation, auth, storage, persistence, and upgrade contract.
- [Naming and environments, #122](https://github.com/abijith-suresh/planview/pull/122):
  plan repository/product naming and staging versus production deployments.

There is no supported home-server installation, private storage migration,
paid-plan storage promise, or automatic revision behavior yet.

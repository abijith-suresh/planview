# plansplease brand assets

All three apps use the refined Return P icon on the existing coral and dark
palette. A long stem and connected bowl establish the P; rounded corners and a
diagonal opening retain the geometry of the Return study. The refined mark uses
one continuous contour, matched 12-unit stem and bowl widths, consistent corner
radii, and parallel edges around the 45-degree opening. The site,
app and docs each have a 1200 × 630 PNG preview. Text is outlined in the editable
SVG sources using Schibsted Grotesk 600 and Instrument Sans 400, matching the UI.
Their font licenses are included here. Outlines keep rendering independent of
system fonts and external font services.

Edit these SVG sources, then run `npm run brand:generate` to regenerate the
committed public assets. This uses the development-only Sharp dependency; no
image rendering runs on a request or during deployment. The ICO contains 16, 32
and 48 pixel PNG frames. Touch and larger PNG icons have a square, opaque coral
background so the platform can apply its own corner mask.
Icons and social previews use `?v=2` after replacing the mark and removing badges.
Bump the corresponding version in all three apps when changing committed images
that use the same filename. Social artwork carries the product name and a useful
headline, without app, site or docs badges.

When changing domains, set `PUBLIC_SITE_URL` for the marketing build,
`PUBLIC_DOCS_URL` for the docs build, and `SITE_URL` for the app server.
The site and app require an origin; the docs URL may include a deployment prefix.

Preview text is generic product copy. The app must not include document titles,
HTML content or account details in link previews. The larger icons are static
assets for future use; this change does not add a service worker or install flow.

The [icon studies](concepts/README.md) record the alternatives and actual-size
favicon exports. Refined B, the connected-bowl variation, is used in this PR.
The studies remain outside the public directories and are not served by the
applications.

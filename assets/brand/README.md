# plansplease brand assets

All three apps use the coral page icon on the existing dark palette. The site,
app and docs each have a 1200 × 630 PNG preview. Text is outlined in the editable
SVG sources using Schibsted Grotesk 600 and Instrument Sans 400, matching the UI.
Their font licenses are included here. Outlines keep rendering independent of
system fonts and external font services.

Edit these SVG sources, then run `npm run brand:generate` to regenerate the
committed public assets. This uses the development-only Sharp dependency; no
image rendering runs on a request or during deployment. The ICO contains 16, 32
and 48 pixel PNG frames. Touch icons have an opaque background.
Metadata uses `?v=1` to bypass older cached favicons. Bump this version in all
three apps when changing committed images that use the same filename.

When changing domains, set `PUBLIC_SITE_URL` for the marketing build,
`PUBLIC_DOCS_URL` for the docs build, and `SITE_URL` for the app server.
The site and app require an origin; the docs URL may include a deployment prefix.

Preview text is generic product copy. The app must not include document titles,
HTML content or account details in link previews. The larger icons are static
assets for future use; this change does not add a service worker or install flow.

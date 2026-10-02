---
"@abijith-suresh/planview": patch
---

Rename the CLI executable from planview to plansplease. Update scripts to invoke plansplease; the previous command is no longer installed. Help, version output, the manual and agent examples use the plansplease name. Existing profiles, documents, credentials, daemon state and installed skills retain their locations, and the npm package and PLANVIEW_* settings keep their names.

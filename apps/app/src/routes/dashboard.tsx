import { Navigate } from "@solidjs/router";

// Preserve existing bookmarks while the workspace opens directly to Documents.
export default function DashboardRedirect() {
  return <Navigate href="/documents" />;
}

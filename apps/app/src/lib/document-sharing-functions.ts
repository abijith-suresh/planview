import { makeFunctionReference } from "convex/server";

import type { Id } from "../../convex/_generated/dataModel";
import type { ShareDocument } from "../../convex/documentSharingModel";
import type { McpDocumentProof } from "../../convex/mcpProof";

export const documentSharingFunctions = {
  enable: makeFunctionReference<"mutation", { id: Id<"documents">; tokenHash: string }, boolean>(
    "documentSharing:enable"
  ),
  disable: makeFunctionReference<"mutation", { id: Id<"documents"> }, boolean>(
    "documentSharing:disable"
  ),
  enableWithMcpProof: makeFunctionReference<
    "mutation",
    { id: Id<"documents">; ownerId: string; tokenHash: string; proof: McpDocumentProof },
    boolean
  >("documentSharing:enableWithMcpProof"),
  disableWithMcpProof: makeFunctionReference<
    "mutation",
    { id: Id<"documents">; ownerId: string; proof: McpDocumentProof },
    boolean
  >("documentSharing:disableWithMcpProof"),
  resolve: makeFunctionReference<
    "query",
    { id: Id<"documents">; token: string },
    { document: Omit<ShareDocument, "ownerId">; legacyReadUrl: string | null } | null
  >("documentSharing:resolve"),
};

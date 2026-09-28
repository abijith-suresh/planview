import { signMcpDocumentProof, type McpDocumentProofInput } from "../../convex/mcpProof";

import { requireMutationSecret } from "./document-mutation-proof";

export const createMcpDocumentProof = (input: McpDocumentProofInput) =>
  signMcpDocumentProof(requireMutationSecret(), input);

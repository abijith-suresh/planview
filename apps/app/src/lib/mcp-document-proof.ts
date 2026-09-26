import { signMcpDocumentProof, type McpDocumentProofInput } from "../../convex/mcp-proof";

import { requireMutationSecret } from "./document-mutation-proof";

export const createMcpDocumentProof = (input: McpDocumentProofInput) =>
  signMcpDocumentProof(requireMutationSecret(), input);

import {
  signCreateDocumentProof,
  type CreateDocumentProofInput,
} from "../../convex/document-proof";

const requireMutationSecret = () => {
  const secret = process.env["DOCUMENT_MUTATION_SECRET"];
  if (!secret || new TextEncoder().encode(secret).length < 32) {
    throw new Error("Document mutation signing is not configured");
  }
  return secret;
};

export const createDocumentProof = (input: CreateDocumentProofInput) =>
  signCreateDocumentProof(requireMutationSecret(), input);

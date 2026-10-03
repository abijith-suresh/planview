import {
  signCreateDocumentProof,
  signAbandonDocumentProof,
  type AbandonDocumentProofInput,
  type CreateDocumentProofInput,
} from "../../convex/documentProof";

export const requireMutationSecret = () => {
  const secret = process.env["DOCUMENT_MUTATION_SECRET"];
  if (!secret || new TextEncoder().encode(secret).length < 32) {
    throw new Error("Document mutation signing is not configured");
  }
  return secret;
};

export const createDocumentProof = (input: CreateDocumentProofInput) =>
  signCreateDocumentProof(requireMutationSecret(), input);

export const createAbandonDocumentProof = (input: AbandonDocumentProofInput) =>
  signAbandonDocumentProof(requireMutationSecret(), input);

import { randomBytes } from "node:crypto";

import { hashShareToken } from "../../convex/documentSharingModel.ts";

export const createDocumentShareToken = async () => {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: await hashShareToken(token) };
};

export const documentShareUrl = (siteUrl: string, id: string, token: string) => {
  const origin = new URL(siteUrl);
  if (
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  ) {
    throw new Error("The sharing origin must be an origin without credentials or a path");
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("Invalid sharing token");
  if (
    origin.protocol !== "https:" &&
    !(origin.protocol === "http:" && ["localhost", "127.0.0.1"].includes(origin.hostname))
  ) {
    throw new Error("The sharing origin must use HTTPS");
  }
  return new URL(`/s/${encodeURIComponent(id)}/${token}`, origin.origin).toString();
};

import { createHash, randomBytes } from "node:crypto";

const prefix = "planview_cli_";

export const issueCliCredential = () => {
  const secret = randomBytes(32).toString("base64url");
  return { secret, tokenHash: hashCliCredential(`${prefix}${secret}`) };
};

export const hashCliCredential = (token: string) =>
  createHash("sha256").update(token, "utf8").digest("hex");

export const cliCredentialFromRequest = (request: Request) => {
  const authorization = request.headers.get("authorization");
  const token = authorization?.match(/^Bearer\s+(planview_cli_[A-Za-z0-9_-]+)$/i)?.[1];
  return token ? { tokenHash: hashCliCredential(token) } : null;
};

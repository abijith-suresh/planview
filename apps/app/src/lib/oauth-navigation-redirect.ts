type RedirectInstruction = { redirect?: unknown; url?: unknown };

export async function oauthNavigationRedirect(request: Request, response: Response) {
  const requestUrl = new URL(request.url);
  const mode = request.headers.get("sec-fetch-mode");
  const isNavigation =
    mode === "navigate" || (!mode && request.headers.get("accept")?.includes("text/html"));

  if (
    request.method !== "GET" ||
    requestUrl.pathname !== "/api/auth/oauth2/authorize" ||
    !isNavigation ||
    response.status !== 200 ||
    !response.headers.get("content-type")?.includes("application/json")
  ) {
    return response;
  }

  let instruction: RedirectInstruction;
  try {
    instruction = (await response.clone().json()) as RedirectInstruction;
  } catch {
    return response;
  }

  if (instruction?.redirect !== true || typeof instruction.url !== "string") {
    return response;
  }

  let location: URL;
  try {
    location = new URL(instruction.url, requestUrl);
  } catch {
    return response;
  }
  if (location.protocol !== "https:" && location.protocol !== "http:") return response;

  const headers = new Headers(response.headers);
  headers.delete("content-type");
  headers.delete("content-length");
  headers.delete("content-encoding");
  headers.delete("transfer-encoding");
  headers.set("location", instruction.url);
  return new Response(null, { status: 302, headers });
}

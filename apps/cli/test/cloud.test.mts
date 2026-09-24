import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolveAppDataPaths } from "@planview/local";
import { MAX_HTML_SIZE_BYTES, readBoundedCloudFile } from "../dist/cloud-file.js";
import { loginToCloud, uploadCloudDocument } from "../dist/cloud.js";

const collectRequest = async (request: IncomingMessage) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
};

const sendJson = (response: ServerResponse, status: number, body: unknown) => {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
};

const listen = async (server: ReturnType<typeof createServer>) => {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
};

const close = async (server: ReturnType<typeof createServer>) =>
  new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });

const withIsolatedAppData = async (run: (root: string) => Promise<void>) => {
  const root = mkdtempSync(join(tmpdir(), "planview-cloud-test-"));
  const envKeys = ["HOME", "USERPROFILE", "LOCALAPPDATA", "XDG_DATA_HOME"] as const;
  const previous = new Map(envKeys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    HOME: root,
    USERPROFILE: root,
    LOCALAPPDATA: join(root, "local-app-data"),
    XDG_DATA_HOME: join(root, "xdg-data"),
  });

  try {
    await run(root);
  } finally {
    for (const key of envKeys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
};

const fakeReader = (options: {
  initialSize: number;
  currentSize?: () => number;
  read: (
    buffer: Buffer,
    offset: number,
    length: number,
    position: number | null | undefined
  ) => Promise<number>;
}) => {
  let statCalls = 0;
  const reader = {
    stat: async () => {
      statCalls += 1;
      return {
        size:
          statCalls === 1 ? options.initialSize : (options.currentSize?.() ?? options.initialSize),
      } as Stats;
    },
    read: async (
      buffer: Buffer,
      offset: number,
      length: number,
      position: number | null | undefined
    ) => ({
      bytesRead: await options.read(buffer, offset, length, position),
      buffer,
    }),
  };
  return reader as unknown as Pick<FileHandle, "read" | "stat">;
};

const saveTestCredentials = async (profile: string) => {
  const cloudUrl = "https://cloud.example.test";
  await loginToCloud({
    profile,
    cloudUrl,
    writeStatus: () => undefined,
    openBrowser: async (signInUrl) => {
      const signIn = new URL(signInUrl);
      const returnToValue = signIn.searchParams.get("returnTo");
      assert.ok(returnToValue);
      const returnTo = new URL(returnToValue, cloudUrl);
      const state = returnTo.searchParams.get("state");
      const callbackUrl = returnTo.searchParams.get("redirect_uri");
      assert.ok(state);
      assert.ok(callbackUrl);

      const callback = new URL(callbackUrl);
      const response = await fetch(callback, {
        method: "POST",
        headers: { Origin: callback.origin, "Content-Type": "application/json" },
        body: JSON.stringify({ state, token: "security-test-token" }),
      });
      assert.equal(response.status, 200);
      await response.text();
    },
  });
};

const cloudCredentialsPath = (profile: string) =>
  join(resolveAppDataPaths({ profile }).appDataDir, "cloud-credentials.json");

test("cloud login callback and upload preserve the local protocol", async () => {
  await withIsolatedAppData(async (root) => {
    let responseMode: "success" | "expired" | "failure" = "success";
    const uploadRequests: Array<{ headers: IncomingMessage["headers"]; body: string }> = [];
    const server = createServer(async (request, response) => {
      if (request.method !== "POST" || request.url !== "/api/documents/upload") {
        sendJson(response, 404, { error: "Not found" });
        return;
      }

      const body = await collectRequest(request);
      uploadRequests.push({ headers: request.headers, body });
      if (responseMode === "expired") {
        sendJson(response, 401, { error: "expired" });
      } else if (responseMode === "failure") {
        sendJson(response, 422, { error: "Upload rejected by the test server." });
      } else {
        sendJson(response, 201, { id: "folder/document id" });
      }
    });
    const cloudUrl = await listen(server);

    try {
      const statuses: string[] = [];
      let callbackPageStatus = 0;
      let wrongOriginStatus = 0;
      let wrongStateStatus = 0;
      let acceptedCallbackStatus = 0;

      const login = await loginToCloud({
        profile: "cloud-test",
        cloudUrl,
        writeStatus: (message) => {
          statuses.push(message);
        },
        openBrowser: async (signInUrl) => {
          const signIn = new URL(signInUrl);
          assert.equal(signIn.origin, cloudUrl);
          assert.equal(signIn.pathname, "/auth/github");

          const returnToValue = signIn.searchParams.get("returnTo");
          assert.ok(returnToValue);
          const returnTo = new URL(returnToValue, cloudUrl);
          assert.equal(returnTo.pathname, "/cli/authorize");
          const state = returnTo.searchParams.get("state");
          const callbackUrl = returnTo.searchParams.get("redirect_uri");
          assert.ok(state);
          assert.ok(callbackUrl);

          const callback = new URL(callbackUrl);
          assert.equal(callback.protocol, "http:");
          assert.equal(callback.hostname, "127.0.0.1");
          assert.equal(callback.pathname, "/callback");

          const page = await fetch(callback);
          callbackPageStatus = page.status;
          assert.match(page.headers.get("content-security-policy") ?? "", /default-src 'none'/);
          await page.text();

          const wrongOrigin = await fetch(callback, {
            method: "POST",
            headers: {
              Origin: "http://127.0.0.1:1",
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ state, token: "test-token" }),
          });
          wrongOriginStatus = wrongOrigin.status;
          await wrongOrigin.text();

          const wrongState = await fetch(callback, {
            method: "POST",
            headers: { Origin: callback.origin, "Content-Type": "application/json" },
            body: JSON.stringify({
              state: `${state.slice(0, -1)}${state.endsWith("A") ? "B" : "A"}`,
              token: "test-token",
            }),
          });
          wrongStateStatus = wrongState.status;
          await wrongState.text();

          const accepted = await fetch(callback, {
            method: "POST",
            headers: { Origin: callback.origin, "Content-Type": "application/json" },
            body: JSON.stringify({ state, token: "test-token" }),
          });
          acceptedCallbackStatus = accepted.status;
          await accepted.text();
        },
      });

      assert.deepEqual(login, { cloudUrl });
      assert.equal(callbackPageStatus, 200);
      assert.equal(wrongOriginStatus, 403);
      assert.equal(wrongStateStatus, 403);
      assert.equal(acceptedCallbackStatus, 200);
      assert.ok(statuses.some((message) => message.includes("Continue in your browser:")));
      assert.ok(statuses.some((message) => message.includes("Waiting for you to authorize")));

      const sourcePath = join(root, "Project plan.HTML");
      writeFileSync(sourcePath, "<!doctype html><title>Plan</title>");
      const uploaded = await uploadCloudDocument(sourcePath, "cloud-test");
      assert.deepEqual(uploaded, {
        id: "folder/document id",
        url: `${cloudUrl}/api/documents/folder%2Fdocument%20id`,
      });
      assert.equal(uploadRequests.length, 1);
      assert.equal(uploadRequests[0]?.headers.authorization, "Bearer planview_cli_test-token");
      assert.match(
        uploadRequests[0]?.headers["content-type"] ?? "",
        /^multipart\/form-data; boundary=/
      );
      assert.match(uploadRequests[0]?.body ?? "", /name="title"\r\n\r\nProject plan\r\n/);
      assert.match(
        uploadRequests[0]?.body ?? "",
        /filename="Project plan\.HTML"\r\nContent-Type: text\/html\r\n\r\n<!doctype html><title>Plan<\/title>/
      );

      responseMode = "expired";
      await assert.rejects(uploadCloudDocument(sourcePath, "cloud-test"), /login expired/);
      responseMode = "failure";
      await assert.rejects(
        uploadCloudDocument(sourcePath, "cloud-test"),
        /Upload rejected by the test server\./
      );

      const oversizedPath = join(root, "too-large.html");
      writeFileSync(oversizedPath, Buffer.alloc(MAX_HTML_SIZE_BYTES + 1));
      const requestCount = uploadRequests.length;
      await assert.rejects(uploadCloudDocument(oversizedPath, "cloud-test"), /up to 8 MiB/);
      assert.equal(uploadRequests.length, requestCount);

      const credentialsPath = join(
        resolveAppDataPaths({ profile: "cloud-test" }).appDataDir,
        "cloud-credentials.json"
      );
      assert.ok(readFileSync(credentialsPath, "utf8").includes("planview_cli_test-token"));
    } finally {
      server.closeAllConnections();
      await close(server);
    }
  });
});

test("bounded cloud reads catch growth at EOF and cap bytes read", async () => {
  let readTotal = 0;
  const growingAtEof = fakeReader({
    initialSize: 2,
    currentSize: () => MAX_HTML_SIZE_BYTES + 1,
    read: async (buffer, offset, length, position) => {
      if (position === 0) {
        buffer.write("ab", offset, "utf8");
        readTotal += 2;
        return Math.min(length, 2);
      }
      return 0;
    },
  });
  await assert.rejects(readBoundedCloudFile(growingAtEof), /up to 8 MiB/);
  assert.equal(readTotal, 2);

  let totalRequested = 0;
  const growingDuringRead = fakeReader({
    initialSize: 1,
    currentSize: () => MAX_HTML_SIZE_BYTES + 1,
    read: async (buffer, offset, length) => {
      totalRequested += length;
      buffer.fill(0x61, offset, offset + length);
      return length;
    },
  });
  await assert.rejects(readBoundedCloudFile(growingDuringRead), /up to 8 MiB/);
  assert.equal(totalRequested, MAX_HTML_SIZE_BYTES + 1);

  let position = 0;
  const exactLimit = fakeReader({
    initialSize: MAX_HTML_SIZE_BYTES,
    read: async (buffer, offset, length) => {
      const bytesRead = Math.min(length, MAX_HTML_SIZE_BYTES - position);
      buffer.fill(0x62, offset, offset + bytesRead);
      position += bytesRead;
      return bytesRead;
    },
  });
  const contents = await readBoundedCloudFile(exactLimit);
  assert.equal(contents.byteLength, MAX_HTML_SIZE_BYTES);
  assert.equal(contents[0], 0x62);
  assert.equal(contents.at(-1), 0x62);
});

test("cloud credentials are saved with private file and profile directory modes on POSIX", {
  skip: process.platform === "win32",
}, async () => {
  await withIsolatedAppData(async () => {
    const profile = "cloud-permissions";
    await saveTestCredentials(profile);

    const credentialsPath = cloudCredentialsPath(profile);
    const directoryStats = lstatSync(resolveAppDataPaths({ profile }).appDataDir);
    const credentialsStats = lstatSync(credentialsPath);

    assert.equal(directoryStats.mode & 0o777, 0o700);
    assert.equal(credentialsStats.mode & 0o777, 0o600);
    assert.equal(directoryStats.uid, process.getuid?.());
    assert.equal(credentialsStats.uid, process.getuid?.());
  });
});

test("cloud upload refuses credentials with permissions shared beyond the current user on POSIX", {
  skip: process.platform === "win32",
}, async () => {
  await withIsolatedAppData(async () => {
    const profile = "cloud-permissive-credentials";
    await saveTestCredentials(profile);
    chmodSync(cloudCredentialsPath(profile), 0o644);

    await assert.rejects(uploadCloudDocument("unused.html", profile), {
      message: /not private to the current user/,
    });
  });
});

test("cloud upload refuses credentials stored through a symbolic link on POSIX", {
  skip: process.platform === "win32",
}, async () => {
  await withIsolatedAppData(async (root) => {
    const profile = "cloud-symlink-credentials";
    await saveTestCredentials(profile);

    const credentialsPath = cloudCredentialsPath(profile);
    const externalCredentialsPath = join(root, "external-cloud-credentials.json");
    writeFileSync(
      externalCredentialsPath,
      JSON.stringify({
        version: 1,
        cloudUrl: "https://cloud.example.test",
        token: "planview_cli_security-test-token",
      })
    );
    rmSync(credentialsPath);
    symlinkSync(externalCredentialsPath, credentialsPath);

    assert.equal(lstatSync(credentialsPath).isSymbolicLink(), true);
    await assert.rejects(uploadCloudDocument("unused.html", profile), { code: "ELOOP" });
  });
});

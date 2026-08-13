import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { validateDocumentId } from "@planview/core";
import {
  createDocumentPublicationCoordinator,
  openDocumentFileStore,
  openStorage,
  V1_CLEANUP_ITEM_BUDGET,
} from "@planview/storage";
import { Effect } from "effect";

const packageRoot = new URL("..", import.meta.url);
const entry = fileURLToPath(new URL("./dist/entry.js", packageRoot));
const daemon = await import(new URL("./dist/index.js", packageRoot));

const waitFor = async (condition, timeout = 5_000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const value = await condition();
      if (value !== undefined && value !== false) {
        return value;
      }
    } catch {
      // The fixture may not have been created yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for daemon process state.");
};

const waitForExit = (child, timeout = 10_000) =>
  new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for daemon process exit."));
    }, timeout);
    const onExit = (code, signal) => {
      cleanup();
      resolve({ code, signal });
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.off("exit", onExit);
      child.off("error", onError);
    };
    child.once("exit", onExit);
    child.once("error", onError);
  });

const stopChild = async (child) => {
  if (child === undefined) {
    return;
  }
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  try {
    child.kill("SIGTERM");
  } catch {
    // The process can exit between the state check and kill on Windows.
  }
  await waitForExit(child);
};

const removeFixture = async (fixture) => {
  await rm(fixture, { force: true, recursive: true, maxRetries: 10, retryDelay: 50 });
};

const freePort = async () => {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
  return port;
};

const startChild = (appDataDir, runtimeDir, port) =>
  spawn(process.execPath, [entry], {
    env: {
      ...process.env,
      NODE_ENV: "test",
      PLANVIEW_APP_DATA_DIR: appDataDir,
      PLANVIEW_RUNTIME_DIR: runtimeDir,
      PLANVIEW_TEST_DAEMON_PORT: String(port),
    },
    stdio: "ignore",
  });

const seedPublishedDocument = async (appDataDir, fixture, documentId, contents) => {
  const sourcePath = join(fixture, `${documentId}.source.html`);
  const documentsDir = join(appDataDir, "documents");
  const stagingDir = join(appDataDir, "staging");
  mkdirSync(appDataDir, { recursive: true, mode: 0o700 });
  writeFileSync(sourcePath, contents);
  const metadataStore = Effect.runSync(openStorage(join(appDataDir, "metadata.sqlite")));
  const documentFileStore = Effect.runSync(openDocumentFileStore({ documentsDir, stagingDir }));
  try {
    const publication = createDocumentPublicationCoordinator({
      documentFileStore,
      metadataStore,
      generateId: () => documentId,
    });
    await publication.publish(sourcePath);
  } finally {
    await documentFileStore.close();
    metadataStore.close();
  }
  return sourcePath;
};

const openStalledDocument = async (port, documentId) => {
  const socket = createConnection({ host: "127.0.0.1", port });
  await new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.once("connect", resolve);
  });
  await new Promise((resolve, reject) => {
    let received = Buffer.alloc(0);
    const onData = (chunk) => {
      received = Buffer.concat([received, chunk]);
      if (received.includes(Buffer.from("\r\n\r\n"))) {
        socket.off("error", reject);
        socket.pause();
        resolve();
      }
    };
    socket.on("data", onData);
    socket.once("error", reject);
    socket.write(
      `GET /${documentId} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: keep-alive\r\n\r\n`
    );
  });
  return socket;
};

const within = async (promise, milliseconds) => {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`operation exceeded ${milliseconds}ms`)),
          milliseconds
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

const descriptorAt = (runtimeDir) => {
  try {
    return JSON.parse(readFileSync(join(runtimeDir, "daemon.json"), "utf8"));
  } catch {
    return undefined;
  }
};

test("public configuration fixes 4777, while test injection is explicit and contained", () => {
  const fixture = mkdtempSync(join(tmpdir(), "planview-daemon-config-"));
  const appDataDir = join(fixture, "app-data");
  try {
    const publicConfig = daemon.resolveDaemonConfig(
      { appDataDir },
      { PLANVIEW_DAEMON_PORT: "4999", PLANVIEW_PORT: "4998" }
    );
    assert.equal(publicConfig.port, daemon.DAEMON_PORT);
    assert.equal(publicConfig.port, 4777);

    const testConfig = daemon.resolveDaemonConfigForTest({ appDataDir, port: 4997 });
    assert.equal(testConfig.port, 4997);
    assert.throws(
      () => daemon.resolveDaemonPaths({ appDataDir, runtimeDir: join(fixture, "outside") }),
      /contained below app-data/
    );
  } finally {
    rmSync(fixture, { force: true, recursive: true });
  }
});

test("a detached child failure is observed and the starter releases its lifecycle lock", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "planview-daemon-start-failure-"));
  const appDataDir = join(fixture, "app-data");
  const runtimeDir = join(appDataDir, "runtime");
  const config = daemon.resolveDaemonConfigForTest({
    appDataDir,
    runtimeDir,
    port: await freePort(),
  });

  try {
    await assert.rejects(
      daemon.startDetachedDaemon(config, {
        daemonScriptPath: join(fixture, "missing-daemon-entry.js"),
      }),
      (error) =>
        error?._tag === "DaemonRequestError" && /failed before readiness/.test(error.message)
    );
    assert.equal(existsSync(join(runtimeDir, daemon.DAEMON_LOCK_NAME)), false);
  } finally {
    await removeFixture(fixture);
  }
});

test("a stale protected malformed lifecycle lock is recovered only after its conservative lease", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "planview-daemon-lock-"));
  const appDataDir = join(fixture, "app-data");
  const runtimeDir = join(appDataDir, "runtime");
  const port = await freePort();
  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  const lockPath = join(runtimeDir, daemon.DAEMON_LOCK_NAME);
  writeFileSync(lockPath, "not json", { encoding: "utf8", mode: 0o600 });
  const staleTime = new Date(
    Date.now() - daemon.DAEMON_STARTUP_LEASE_MS - daemon.DAEMON_STARTUP_GRACE_MS - 1_000
  );
  utimesSync(lockPath, staleTime, staleTime);
  const child = startChild(appDataDir, runtimeDir, port);

  try {
    const descriptor = await waitFor(() => descriptorAt(runtimeDir));
    assert.equal(descriptor.port, port);
    assert.equal(descriptor.host, "127.0.0.1");
  } finally {
    await stopChild(child);
    await removeFixture(fixture);
  }
});

test("reclaims an old well-formed lock whose local owner is dead", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "planview-daemon-dead-lock-"));
  const appDataDir = join(fixture, "app-data");
  const runtimeDir = join(appDataDir, "runtime");
  const port = await freePort();
  const owner = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await waitForExit(owner);
  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  const lockPath = join(runtimeDir, daemon.DAEMON_LOCK_NAME);
  const staleTimestamp =
    Date.now() - daemon.DAEMON_STARTUP_LEASE_MS - daemon.DAEMON_STARTUP_GRACE_MS - 1_000;
  writeFileSync(
    lockPath,
    JSON.stringify({
      version: 1,
      pid: owner.pid,
      host: hostname(),
      token: "dead-lock-token-that-is-long-enough-to-validate",
      acquiredAt: staleTimestamp,
    }),
    { encoding: "utf8", mode: 0o600 }
  );
  const staleTime = new Date(staleTimestamp);
  utimesSync(lockPath, staleTime, staleTime);
  const child = startChild(appDataDir, runtimeDir, port);

  try {
    const descriptor = await waitFor(() => descriptorAt(runtimeDir));
    assert.equal(descriptor.port, port);
  } finally {
    await stopChild(child);
    await removeFixture(fixture);
  }
});

test("does not reclaim an old well-formed lock whose local owner is alive", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "planview-daemon-live-lock-"));
  const appDataDir = join(fixture, "app-data");
  const runtimeDir = join(appDataDir, "runtime");
  const port = await freePort();
  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  const lockPath = join(runtimeDir, daemon.DAEMON_LOCK_NAME);
  writeFileSync(
    lockPath,
    JSON.stringify({
      version: 1,
      pid: process.pid,
      host: hostname(),
      token: "live-lock-token-that-is-long-enough-to-validate",
      acquiredAt:
        Date.now() - daemon.DAEMON_STARTUP_LEASE_MS - daemon.DAEMON_STARTUP_GRACE_MS - 1_000,
    }),
    { encoding: "utf8", mode: 0o600 }
  );
  const staleTime = new Date(
    Date.now() - daemon.DAEMON_STARTUP_LEASE_MS - daemon.DAEMON_STARTUP_GRACE_MS - 1_000
  );
  utimesSync(lockPath, staleTime, staleTime);
  const child = startChild(appDataDir, runtimeDir, port);

  try {
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(descriptorAt(runtimeDir), undefined);
    assert.equal(JSON.parse(readFileSync(lockPath, "utf8")).pid, process.pid);
  } finally {
    await stopChild(child);
    await removeFixture(fixture);
  }
});

test("status and stop surface corrupt and insecure descriptors as typed errors", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "planview-daemon-descriptor-"));
  const appDataDir = join(fixture, "app-data");
  const runtimeDir = join(appDataDir, "runtime");
  const config = daemon.resolveDaemonConfigForTest({
    appDataDir,
    runtimeDir,
    port: await freePort(),
  });
  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  const descriptorPath = join(runtimeDir, daemon.DAEMON_DESCRIPTOR_NAME);

  try {
    writeFileSync(descriptorPath, "{not-json", { encoding: "utf8", mode: 0o600 });
    await assert.rejects(
      daemon.inspectDaemon(config),
      (error) => error?._tag === "DaemonDescriptorError"
    );
    await assert.rejects(
      daemon.stopDaemon(config),
      (error) => error?._tag === "DaemonDescriptorError"
    );

    if (process.platform !== "win32") {
      writeFileSync(
        descriptorPath,
        JSON.stringify({
          version: 1,
          pid: process.pid,
          host: "127.0.0.1",
          port: config.port,
          secret: "private-descriptor-secret-that-is-long-enough",
          startedAt: Date.now(),
        }),
        { encoding: "utf8", mode: 0o600 }
      );
      chmodSync(descriptorPath, 0o644);
      await assert.rejects(
        daemon.inspectDaemon(config),
        (error) => error?._tag === "DaemonDescriptorError"
      );
      await assert.rejects(
        daemon.stopDaemon(config),
        (error) => error?._tag === "DaemonDescriptorError"
      );
    }
  } finally {
    await removeFixture(fixture);
  }
});

test("lifecycle and status reject a descriptor endpoint mismatch with a typed error", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "planview-daemon-endpoint-mismatch-"));
  const appDataDir = join(fixture, "app-data");
  const runtimeDir = join(appDataDir, "runtime");
  const config = daemon.resolveDaemonConfig({ appDataDir, runtimeDir });
  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(runtimeDir, daemon.DAEMON_DESCRIPTOR_NAME),
    JSON.stringify({
      version: 1,
      pid: process.pid,
      host: "localhost",
      port: 4776,
      secret: "private-descriptor-secret-that-is-long-enough",
      startedAt: Date.now(),
    }),
    { encoding: "utf8", mode: 0o600 }
  );

  try {
    for (const operation of [
      () => daemon.inspectDaemon(config),
      () => daemon.startDetachedDaemon(config, { daemonScriptPath: entry }),
      () => daemon.stopDaemon(config),
      () => daemon.restartDaemon(config, { daemonScriptPath: entry }),
    ]) {
      await assert.rejects(
        operation(),
        (error) =>
          error?._tag === "DaemonDescriptorEndpointMismatchError" &&
          error.descriptorHost === "localhost" &&
          error.descriptorPort === 4776 &&
          error.configHost === "127.0.0.1" &&
          error.configPort === 4777
      );
    }
  } finally {
    await removeFixture(fixture);
  }
});

test("exact management paths do not shadow a published id beginning with __planview", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "planview-daemon-document-route-"));
  const appDataDir = join(fixture, "app-data");
  const runtimeDir = join(appDataDir, "runtime");
  const documentsDir = join(appDataDir, "documents");
  const stagingDir = join(appDataDir, "staging");
  const port = await freePort();
  const sourcePath = join(fixture, "source.html");
  const documentId = validateDocumentId("__planviewabcdefghijk");
  writeFileSync(sourcePath, "<!doctype html><p>private-looking id</p>");
  mkdirSync(appDataDir, { recursive: true, mode: 0o700 });

  const metadataStore = Effect.runSync(openStorage(join(appDataDir, "metadata.sqlite")));
  const documentFileStore = Effect.runSync(openDocumentFileStore({ documentsDir, stagingDir }));
  const publication = createDocumentPublicationCoordinator({
    documentFileStore,
    metadataStore,
    generateId: () => documentId,
  });
  await publication.publish(sourcePath);
  await documentFileStore.close();
  metadataStore.close();

  const child = startChild(appDataDir, runtimeDir, port);
  try {
    const descriptor = await waitFor(() => descriptorAt(runtimeDir));
    const document = await fetch(`http://127.0.0.1:${port}/${documentId}`);
    assert.equal(document.status, 200);
    assert.equal(await document.text(), "<!doctype html><p>private-looking id</p>");

    const management = await fetch(`http://127.0.0.1:${port}/__planview/status`);
    assert.equal(management.status, 401);
    const authorized = await fetch(`http://127.0.0.1:${port}/__planview/status`, {
      headers: { "x-planview-secret": descriptor.secret },
    });
    assert.equal(authorized.status, 200);
  } finally {
    await stopChild(child);
    await removeFixture(fixture);
  }
});

test("the daemon is a private, graceful process with POSIX ownership checks", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "planview-daemon-process-"));
  const appDataDir = join(fixture, "app-data");
  const runtimeDir = join(appDataDir, "runtime");
  const port = await freePort();
  const child = startChild(appDataDir, runtimeDir, port);

  try {
    const descriptor = await waitFor(() => descriptorAt(runtimeDir));
    assert.equal(descriptor.host, "127.0.0.1");
    assert.equal(descriptor.port, port);
    assert.equal(typeof descriptor.secret, "string");
    if (process.platform !== "win32") {
      assert.equal(statSync(appDataDir).mode & 0o077, 0);
      assert.equal(statSync(runtimeDir).mode & 0o077, 0);
      assert.equal(statSync(join(runtimeDir, "daemon.json")).mode & 0o077, 0);
      assert.equal(statSync(join(runtimeDir, "daemon.json")).uid, process.getuid());
    }

    const root = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(root.status, 200);
    assert.match(await root.text(), /Planview daemon running/);

    const unauthorized = await fetch(`http://127.0.0.1:${port}/__planview/ready`);
    assert.equal(unauthorized.status, 401);
    const ready = await fetch(`http://127.0.0.1:${port}/__planview/ready`, {
      headers: { "x-planview-secret": descriptor.secret },
    });
    assert.equal(ready.status, 200);
    assert.equal((await ready.json()).ready, true);

    child.kill("SIGTERM");
    const exit = await waitForExit(child);
    assert.equal(exit.code, 0);
    assert.equal(exit.signal, null);
    await waitFor(() => (descriptorAt(runtimeDir) === undefined ? true : undefined));
  } finally {
    await stopChild(child);
    await removeFixture(fixture);
  }
});

test("concurrent starts, stops, and restarts share one lifecycle lock", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "planview-daemon-stress-"));
  const appDataDir = join(fixture, "app-data");
  const runtimeDir = join(appDataDir, "runtime");
  const config = daemon.resolveDaemonConfigForTest({
    appDataDir,
    runtimeDir,
    port: await freePort(),
  });
  const options = { daemonScriptPath: entry };

  try {
    const starts = await Promise.all(
      Array.from({ length: 20 }, () => daemon.startDetachedDaemon(config, options))
    );
    assert.equal(starts.filter((result) => result.reused === false).length, 1);
    assert.equal(new Set(starts.map((result) => result.descriptor.pid)).size, 1);

    const stops = await Promise.all(Array.from({ length: 20 }, () => daemon.stopDaemon(config)));
    assert.ok(stops.every((result) => result.state === "stopped"));
    assert.equal(descriptorAt(runtimeDir), undefined);

    const restarts = await Promise.all(
      Array.from({ length: 20 }, () => daemon.restartDaemon(config, options))
    );
    assert.ok(restarts.every((result) => result.state === "running"));
    assert.ok(descriptorAt(runtimeDir));
  } finally {
    await daemon.stopDaemon(config).catch(() => undefined);
    await removeFixture(fixture);
  }
});

test("a stalled raw-socket read does not block publish or clean", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "planview-daemon-read-concurrency-"));
  const appDataDir = join(fixture, "app-data");
  const runtimeDir = join(appDataDir, "runtime");
  const port = await freePort();
  const documentId = validateDocumentId("c".repeat(21));
  let socket;
  let child;
  try {
    await seedPublishedDocument(
      appDataDir,
      fixture,
      documentId,
      Buffer.alloc(10 * 1024 * 1024, "x")
    );
    child = startChild(appDataDir, runtimeDir, port);
    const descriptor = await waitFor(() => descriptorAt(runtimeDir));
    await waitFor(async () => {
      const ready = await fetch(`http://127.0.0.1:${port}/__planview/ready`, {
        headers: { "x-planview-secret": descriptor.secret },
      });
      return ready.status === 200 ? true : undefined;
    });
    socket = await openStalledDocument(port, documentId);
    const publishSource = join(fixture, "unrelated.html");
    writeFileSync(publishSource, "unrelated publish");
    const publishResponse = await within(
      fetch(`http://127.0.0.1:${port}/__planview/publish`, {
        method: "POST",
        headers: {
          "x-planview-secret": descriptor.secret,
          "content-type": "application/json",
        },
        body: JSON.stringify({ sourcePath: publishSource }),
      }),
      2_000
    );
    assert.equal(publishResponse.status, 201);
    const cleanResponse = await within(
      fetch(`http://127.0.0.1:${port}/__planview/clean`, {
        method: "POST",
        headers: { "x-planview-secret": descriptor.secret },
      }),
      2_000
    );
    assert.equal(cleanResponse.status, 200);
    await stopChild(child);
    child = undefined;
  } finally {
    socket?.destroy();
    await stopChild(child);
    await removeFixture(fixture);
  }
});

test("shutdown aborts a stalled document read before closing storage", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "planview-daemon-read-shutdown-"));
  const appDataDir = join(fixture, "app-data");
  const runtimeDir = join(appDataDir, "runtime");
  const port = await freePort();
  const documentId = validateDocumentId("d".repeat(21));
  let socket;
  let child;
  try {
    await seedPublishedDocument(appDataDir, fixture, documentId, "shutdown read");
    child = startChild(appDataDir, runtimeDir, port);
    const descriptor = await waitFor(() => descriptorAt(runtimeDir));
    await waitFor(async () => {
      const ready = await fetch(`http://127.0.0.1:${port}/__planview/ready`, {
        headers: { "x-planview-secret": descriptor.secret },
      });
      return ready.status === 200 ? true : undefined;
    });
    socket = await openStalledDocument(port, documentId);
    const startedAt = Date.now();
    const result = await daemon.stopDaemon(
      daemon.resolveDaemonConfigForTest({ appDataDir, runtimeDir, port })
    );
    assert.equal(result.state, "stopped");
    assert.ok(Date.now() - startedAt < daemon.DAEMON_SHUTDOWN_TIMEOUT_MS + 2_000);
    await waitForExit(child);
    child = undefined;
  } finally {
    socket?.destroy();
    await stopChild(child);
    await removeFixture(fixture);
  }
});

test("shutdown waits for a manual cleanup before closing storage", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "planview-daemon-clean-shutdown-"));
  const appDataDir = join(fixture, "app-data");
  const runtimeDir = join(appDataDir, "runtime");
  const documentsDir = join(appDataDir, "documents");
  const port = await freePort();
  const child = startChild(appDataDir, runtimeDir, port);
  let metadataStore;
  try {
    const descriptor = await waitFor(() => descriptorAt(runtimeDir));
    await waitFor(async () => {
      const ready = await fetch(`http://127.0.0.1:${port}/__planview/ready`, {
        headers: { "x-planview-secret": descriptor.secret },
      });
      return ready.status === 200 ? true : undefined;
    });
    metadataStore = Effect.runSync(openStorage(join(appDataDir, "metadata.sqlite")));
    // One bounded cleanup slice must leave work for shutdown to overlap.
    const documents = V1_CLEANUP_ITEM_BUDGET + 1;
    for (let index = 0; index < documents; index += 1) {
      const documentId = `a${index.toString(36).padStart(20, "0")}`;
      writeFileSync(join(documentsDir, `${documentId}.html`), "x");
      metadataStore.insertDocumentMetadata({
        id: documentId,
        createdAt: 1,
        lastAccessedAt: 1,
        size: 1,
      });
    }
    const cleanResponsePromise = fetch(`http://127.0.0.1:${port}/__planview/clean`, {
      method: "POST",
      headers: { "x-planview-secret": descriptor.secret },
    });
    await waitFor(() => {
      const remaining = metadataStore.getDocumentAggregate().count;
      return remaining > 0 && remaining < documents ? remaining : undefined;
    });
    const result = await daemon.stopDaemon(
      daemon.resolveDaemonConfigForTest({ appDataDir, runtimeDir, port })
    );
    const cleanResponse = await cleanResponsePromise;
    assert.equal(cleanResponse.status, 200);
    const cleanupResult = await cleanResponse.json();
    assert.equal(cleanupResult.removedDocuments > 0, true);
    assert.equal(cleanupResult.removedDocuments < documents, true);
    assert.equal(cleanupResult.resumable, true);
    assert.equal(result.state, "stopped");
    const exit = await waitForExit(child);
    assert.equal(exit.code, 0);
  } finally {
    metadataStore?.close();
    await stopChild(child);
    await removeFixture(fixture);
  }
});

test("automatic cleanup drains resumable work after a bounded manual slice", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "planview-daemon-clean-drain-"));
  const appDataDir = join(fixture, "app-data");
  const runtimeDir = join(appDataDir, "runtime");
  const documentsDir = join(appDataDir, "documents");
  const port = await freePort();
  const child = startChild(appDataDir, runtimeDir, port);
  let metadataStore;
  try {
    const descriptor = await waitFor(() => descriptorAt(runtimeDir));
    await waitFor(async () => {
      const ready = await fetch(`http://127.0.0.1:${port}/__planview/ready`, {
        headers: { "x-planview-secret": descriptor.secret },
      });
      return ready.status === 200 ? true : undefined;
    });
    metadataStore = Effect.runSync(openStorage(join(appDataDir, "metadata.sqlite")));
    const documents = 700;
    for (let index = 0; index < documents; index += 1) {
      const documentId = `a${index.toString(36).padStart(20, "0")}`;
      writeFileSync(join(documentsDir, `${documentId}.html`), "x");
      metadataStore.insertDocumentMetadata({
        id: documentId,
        createdAt: 1,
        lastAccessedAt: 1,
        size: 1,
      });
    }
    const startedAt = Date.now();
    const cleanResponse = await fetch(`http://127.0.0.1:${port}/__planview/clean`, {
      method: "POST",
      headers: { "x-planview-secret": descriptor.secret },
    });
    assert.equal(cleanResponse.status, 200);
    assert.equal(Date.now() - startedAt < 4_000, true);
    await waitFor(
      () => (metadataStore.getDocumentAggregate().count === 0 ? true : undefined),
      15_000
    );
    await daemon.stopDaemon(daemon.resolveDaemonConfigForTest({ appDataDir, runtimeDir, port }));
    await waitForExit(child);
  } finally {
    metadataStore?.close();
    await stopChild(child);
    await removeFixture(fixture);
  }
});

test("shutdown force-closes an idle connection by its deadline", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "planview-daemon-shutdown-"));
  const appDataDir = join(fixture, "app-data");
  const runtimeDir = join(appDataDir, "runtime");
  const port = await freePort();
  const child = startChild(appDataDir, runtimeDir, port);
  let socket;

  try {
    await waitFor(() => descriptorAt(runtimeDir));
    socket = createConnection({ host: "127.0.0.1", port });
    await new Promise((resolve, reject) => {
      socket.once("error", reject);
      socket.once("connect", resolve);
    });
    const startedAt = Date.now();
    const result = await daemon.stopDaemon(
      daemon.resolveDaemonConfigForTest({ appDataDir, runtimeDir, port })
    );
    assert.equal(result.state, "stopped");
    const exit = await waitForExit(child, daemon.DAEMON_SHUTDOWN_TIMEOUT_MS + 5_000);
    assert.equal(exit.code, 0);
    assert.ok(Date.now() - startedAt <= daemon.DAEMON_SHUTDOWN_TIMEOUT_MS + 3_000);
  } finally {
    socket?.destroy();
    await stopChild(child);
    await removeFixture(fixture);
  }
});

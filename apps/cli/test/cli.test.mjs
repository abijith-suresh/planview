import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Effect, Exit } from "effect";
import { test } from "node:test";
import { formatHelp, main, run } from "../dist/index.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "../..");
const cli = resolve(packageRoot, "dist/index.js");
const packageJson = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8"));

const removeFixture = (path) =>
  rm(path, { force: true, recursive: true, maxRetries: 10, retryDelay: 50 });

const waitFor = async (condition, timeout = 10_000) => {
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
  throw new Error("Timed out waiting for daemon lifecycle state.");
};

const waitForExit = (child, timeout = 10_000) =>
  new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for starter process exit."));
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

const execute = (...args) =>
  spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
  });

test("--help and -h produce the same deterministic output", () => {
  const long = execute("--help");
  const short = execute("-h");

  assert.equal(long.status, 0);
  assert.equal(long.error, undefined);
  assert.equal(long.stderr, "");
  assert.equal(long.stdout, short.stdout);
  assert.match(long.stdout, /^Usage: planview <command>/);
});

test("--version and -v produce the package version", () => {
  const long = execute("--version");
  const short = execute("-v");

  assert.equal(long.status, 0);
  assert.equal(long.error, undefined);
  assert.equal(long.stderr, "");
  assert.equal(long.stdout, `planview ${packageJson.version}\n`);
  assert.equal(short.stdout, long.stdout);
});

test("unknown options fail as typed Effects and preserve boundary output", () => {
  const stdout = [];
  const stderr = [];
  const program = run(
    ["--unknown"],
    (message) => stdout.push(message),
    (message) => stderr.push(message)
  );
  const exit = Effect.runSyncExit(program);
  stderr.length = 0;
  const error = Effect.runSync(Effect.flip(program));

  assert.equal(Exit.isFailure(exit), true);
  assert.equal(error._tag, "UnknownOptionError");
  assert.equal(error.option, "--unknown");
  assert.deepEqual(stdout, []);
  assert.deepEqual(stderr, [`Unknown option: --unknown\n\n${formatHelp()}`]);
});

test("the Effect boundary maps typed argument failures to the existing exit code", () => {
  const stdout = [];
  const stderr = [];

  assert.equal(
    main(
      ["--help", "unexpected"],
      (message) => stdout.push(message),
      (message) => stderr.push(message)
    ),
    1
  );
  assert.deepEqual(stdout, []);
  assert.deepEqual(stderr, [`Unexpected argument: unexpected\n\n${formatHelp()}`]);
});

test("unknown options fail with a useful error", () => {
  const result = execute("--unknown");

  assert.equal(result.status, 1);
  assert.equal(result.error, undefined);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /^Unknown option: --unknown\n/);
  assert.match(result.stderr, /Usage: planview <command>/);
});

test("recognized options reject trailing arguments", () => {
  const result = execute("--help", "unexpected");

  assert.equal(result.status, 1);
  assert.equal(result.error, undefined);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /^Unexpected argument: unexpected\n/);
});

test("the installed bin invokes the built CLI", () => {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(
    npm,
    ["exec", "--workspace", "planview", "--", "planview", "--version"],
    { cwd: repositoryRoot, encoding: "utf8" }
  );

  assert.equal(result.status, 0);
  assert.equal(result.error, undefined);
  assert.equal(result.stdout, `planview ${packageJson.version}\n`);
  assert.equal(result.stderr, "");
});

test("importing the entrypoint does not execute the command", () => {
  const moduleUrl = pathToFileURL(cli).href;
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", `await import(${JSON.stringify(moduleUrl)});`],
    { encoding: "utf8" }
  );

  assert.equal(result.status, 0);
  assert.equal(result.error, undefined);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});

test("a starter crash after daemon lock adoption does not strand lifecycle commands", async () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), "planview-daemon-adoption-test-"));
  const appDataDir = join(runtimeRoot, "app-data");
  const daemonRuntimeDir = join(appDataDir, "runtime");
  const port = await freePort();
  const environment = {
    ...process.env,
    NODE_ENV: "test",
    PLANVIEW_APP_DATA_DIR: appDataDir,
    PLANVIEW_RUNTIME_DIR: daemonRuntimeDir,
    PLANVIEW_TEST_DAEMON_PORT: String(port),
    PLANVIEW_TEST_DAEMON_ADOPTION_PAUSE_MS: "2000",
  };
  const starter = spawn(process.execPath, [cli, "start"], {
    encoding: "utf8",
    env: environment,
    stdio: "ignore",
  });
  const executeInFixture = (...args) =>
    spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", env: environment });
  const lockPath = join(daemonRuntimeDir, "lifecycle.lock");

  try {
    const adopted = await waitFor(() => {
      const lock = JSON.parse(readFileSync(lockPath, "utf8"));
      return lock.pid !== starter.pid ? lock : undefined;
    });
    assert.notEqual(adopted.pid, starter.pid);

    starter.kill();
    await waitForExit(starter);
    await waitFor(() => JSON.parse(readFileSync(join(daemonRuntimeDir, "daemon.json"), "utf8")));
    await waitFor(() => (existsSync(lockPath) ? undefined : true));

    const restarted = executeInFixture("restart");
    assert.equal(restarted.status, 0, restarted.stderr);
    assert.match(restarted.stdout, /restarted/);

    const stopped = executeInFixture("stop");
    assert.equal(stopped.status, 0, stopped.stderr);
    assert.match(stopped.stdout, /stopped/);
  } finally {
    if (starter.exitCode === null && starter.signalCode === null) {
      starter.kill();
      await waitForExit(starter).catch(() => undefined);
    }
    executeInFixture("stop");
    await removeFixture(runtimeRoot);
  }
});

test("start, status, stop, and restart are process-backed and private", async () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), "planview-daemon-test-"));
  const appDataDir = join(runtimeRoot, "app-data");
  const daemonRuntimeDir = join(appDataDir, "runtime");
  const port = await freePort();
  const environment = {
    ...process.env,
    NODE_ENV: "test",
    PLANVIEW_APP_DATA_DIR: appDataDir,
    PLANVIEW_RUNTIME_DIR: daemonRuntimeDir,
    PLANVIEW_TEST_DAEMON_PORT: String(port),
  };
  const executeInFixture = (...args) =>
    spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", env: environment });

  try {
    const before = executeInFixture("status");
    assert.equal(before.status, 0);
    assert.match(before.stdout, /not running/);
    assert.equal(existsSync(daemonRuntimeDir), false, "status must not create runtime state");

    const started = executeInFixture("start");
    assert.equal(started.status, 0, started.stderr);
    assert.match(started.stdout, /started/);

    const descriptor = JSON.parse(readFileSync(join(daemonRuntimeDir, "daemon.json"), "utf8"));
    assert.equal(descriptor.host, "127.0.0.1");
    assert.equal(descriptor.port, port);
    if (process.platform !== "win32") {
      assert.equal(statSync(daemonRuntimeDir).mode & 0o077, 0);
      assert.equal(statSync(join(daemonRuntimeDir, "daemon.json")).mode & 0o077, 0);
    }

    const unauthorized = await fetch(`http://127.0.0.1:${port}/__planview/status`);
    assert.equal(unauthorized.status, 401);
    assert.equal(unauthorized.headers.get("access-control-allow-origin"), null);
    const root = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(root.status, 200);
    assert.match(await root.text(), /Planview daemon running/);

    const status = executeInFixture("status");
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, /is running/);
    const idempotent = executeInFixture("start");
    assert.equal(idempotent.status, 0, idempotent.stderr);
    assert.match(idempotent.stdout, /already running/);

    const restarted = executeInFixture("restart");
    assert.equal(restarted.status, 0, restarted.stderr);
    assert.match(restarted.stdout, /restarted/);

    const stopped = executeInFixture("stop");
    assert.equal(stopped.status, 0, stopped.stderr);
    assert.match(stopped.stdout, /stopped/);
    assert.equal(existsSync(join(daemonRuntimeDir, "daemon.json")), false);
    const after = executeInFixture("status");
    assert.equal(after.status, 0);
    assert.match(after.stdout, /not running/);
  } finally {
    executeInFixture("stop");
    await removeFixture(runtimeRoot);
  }
});

const freePort = () =>
  new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.once("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        rejectPort(new Error("Could not allocate a test port."));
        return;
      }
      server.close((error) =>
        error === undefined ? resolvePort(address.port) : rejectPort(error)
      );
    });
  });

test("publish validates before startup and preserves the source file", async () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), "planview-publish-validation-test-"));
  const appDataDir = join(runtimeRoot, "data");
  const runtimeDir = join(appDataDir, "runtime");
  const port = await freePort();
  const environment = {
    ...process.env,
    NODE_ENV: "test",
    PLANVIEW_APP_DATA_DIR: appDataDir,
    PLANVIEW_RUNTIME_DIR: runtimeDir,
    PLANVIEW_TEST_DAEMON_PORT: String(port),
  };
  const executeInFixture = (...args) =>
    spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", env: environment });
  const invalidPath = join(runtimeRoot, "source.txt");
  writeFileSync(invalidPath, "not html");
  const invalid = executeInFixture("publish", invalidPath);
  assert.equal(invalid.status, 1);
  assert.equal(invalid.stdout, "");
  assert.match(invalid.stderr, /only \.html and \.htm files are supported/);
  assert.equal(existsSync(runtimeDir), false);

  const oversizedPath = join(runtimeRoot, "oversized.html");
  writeFileSync(oversizedPath, Buffer.alloc(10 * 1024 * 1024 + 1, 0x61));
  const oversized = executeInFixture("publish", oversizedPath);
  assert.equal(oversized.status, 1);
  assert.equal(oversized.stdout, "");
  assert.match(oversized.stderr, /must not exceed 10485760 bytes/);
  assert.equal(existsSync(runtimeDir), false);
  await removeFixture(runtimeRoot);
});

test("publish budgets a slow maximum-size publication before returning its committed URL", async () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), "planview-publish-timeout-test-"));
  const appDataDir = join(runtimeRoot, "data");
  const runtimeDir = join(appDataDir, "runtime");
  const port = await freePort();
  const environment = {
    ...process.env,
    NODE_ENV: "test",
    PLANVIEW_APP_DATA_DIR: appDataDir,
    PLANVIEW_RUNTIME_DIR: runtimeDir,
    PLANVIEW_TEST_DAEMON_PORT: String(port),
    PLANVIEW_TEST_DAEMON_PUBLISH_PAUSE_MS: "1500",
  };
  const sourcePath = join(runtimeRoot, "slow.html");
  writeFileSync(sourcePath, Buffer.alloc(10 * 1024 * 1024, 0x61));

  try {
    const published = spawnSync(process.execPath, [cli, "publish", sourcePath], {
      encoding: "utf8",
      env: environment,
      timeout: 30_000,
    });
    assert.equal(published.status, 0, published.stderr);
    assert.equal(published.stderr, "");
    assert.match(published.stdout, new RegExp(`^http://localhost:${port}/[A-Za-z0-9_-]{21}\\n$`));
    const retrieved = await fetch(published.stdout.trim().replace("localhost", "127.0.0.1"));
    assert.equal(retrieved.status, 200);
    assert.equal((await retrieved.arrayBuffer()).byteLength, 10 * 1024 * 1024);
  } finally {
    spawnSync(process.execPath, [cli, "stop"], { encoding: "utf8", env: environment });
    await removeFixture(runtimeRoot);
  }
});

test("publish starts or reuses the daemon, serves raw immutable HTML, and records access after retrieval", async () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), "planview-publish-test-"));
  const appDataDir = join(runtimeRoot, "data");
  const runtimeDir = join(appDataDir, "runtime");
  const port = await freePort();
  const environment = {
    ...process.env,
    NODE_ENV: "test",
    PLANVIEW_APP_DATA_DIR: appDataDir,
    PLANVIEW_RUNTIME_DIR: runtimeDir,
    PLANVIEW_TEST_DAEMON_PORT: String(port),
  };
  const executeInFixture = (...args) =>
    spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", env: environment });
  const sourcePath = join(runtimeRoot, "source.html");
  const original = "<!doctype html><html><body><h1>snapshot one</h1></body></html>";
  writeFileSync(sourcePath, original);
  let database;

  try {
    const first = executeInFixture("publish", sourcePath);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(first.stderr, "");
    assert.match(first.stdout, new RegExp(`^http://localhost:${port}/[A-Za-z0-9_-]{21}\\n$`));
    assert.equal(readFileSync(sourcePath, "utf8"), original);
    const firstUrl = first.stdout.trim();
    const firstBrowserUrl = firstUrl.replace("localhost", "127.0.0.1");

    database = new DatabaseSync(join(appDataDir, "metadata.sqlite"), { timeout: 5000 });
    const before = database
      .prepare("SELECT createdAt, lastAccessedAt FROM documents WHERE id = :id")
      .get({ ":id": firstUrl.slice(firstUrl.lastIndexOf("/") + 1) });
    assert.ok(before);
    database.close();
    database = undefined;

    writeFileSync(sourcePath, "<!doctype html><html><body>changed source</body></html>");
    await new Promise((resolve) => setTimeout(resolve, 10));
    const retrieved = await fetch(firstBrowserUrl);
    assert.equal(retrieved.status, 200);
    assert.equal(retrieved.headers.get("content-type"), "text/html; charset=utf-8");
    assert.equal(await retrieved.text(), original);
    database = new DatabaseSync(join(appDataDir, "metadata.sqlite"), { timeout: 5000 });
    const after = database
      .prepare("SELECT createdAt, lastAccessedAt FROM documents WHERE id = :id")
      .get({ ":id": firstUrl.slice(firstUrl.lastIndexOf("/") + 1) });
    assert.ok(after);
    assert.ok(after.lastAccessedAt > before.lastAccessedAt);
    assert.equal(after.createdAt, before.createdAt);

    const missing = await fetch(`http://127.0.0.1:${port}/_____________________`);
    assert.equal(missing.status, 404);
    assert.match(missing.headers.get("content-type") ?? "", /^text\/html/);
    assert.match(await missing.text(), /<h1>Not found<\/h1>/);
    const method = await fetch(firstBrowserUrl, { method: "POST" });
    assert.equal(method.status, 405);
    assert.match(method.headers.get("content-type") ?? "", /^text\/html/);
    assert.match(await method.text(), /<h1>Method not allowed<\/h1>/);

    const unauthorized = await fetch(`http://127.0.0.1:${port}/__planview/publish`, {
      method: "POST",
      body: JSON.stringify({ sourcePath }),
    });
    assert.equal(unauthorized.status, 401);

    const second = executeInFixture("publish", sourcePath);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(second.stderr, "");
    assert.match(second.stdout, new RegExp(`^http://localhost:${port}/[A-Za-z0-9_-]{21}\\n$`));
    assert.notEqual(second.stdout, first.stdout);
    const secondRetrieved = await fetch(second.stdout.trim().replace("localhost", "127.0.0.1"));
    assert.equal(
      await secondRetrieved.text(),
      "<!doctype html><html><body>changed source</body></html>"
    );
    const firstAgain = await fetch(firstBrowserUrl);
    assert.equal(await firstAgain.text(), original);
  } finally {
    database?.close();
    executeInFixture("stop");
    await removeFixture(runtimeRoot);
  }
});

test("start never stops an unknown owner of the daemon port", async () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), "planview-port-owner-test-"));
  const port = await freePort();
  const owner = createServer((socket) => socket.end());
  await new Promise((resolve, reject) => {
    owner.once("error", reject);
    owner.listen(port, "127.0.0.1", resolve);
  });
  const result = spawnSync(process.execPath, [cli, "start"], {
    encoding: "utf8",
    env: {
      ...process.env,
      NODE_ENV: "test",
      PLANVIEW_APP_DATA_DIR: join(runtimeRoot, "data"),
      PLANVIEW_RUNTIME_DIR: join(runtimeRoot, "data", "runtime"),
      PLANVIEW_TEST_DAEMON_PORT: String(port),
    },
  });

  try {
    assert.equal(result.status, 1);
    assert.match(result.stderr, /unknown process/);
    assert.match(result.stderr, /\n$/);
    assert.equal(owner.listening, true);
  } finally {
    await new Promise((resolve, reject) =>
      owner.close((error) => (error ? reject(error) : resolve()))
    );
    await removeFixture(runtimeRoot);
  }
});

test("a clean build is included by the package dry run", () => {
  rmSync(resolve(packageRoot, "dist"), { force: true, recursive: true });
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(npm, ["pack", "--dry-run", "--json"], {
    cwd: packageRoot,
    encoding: "utf8",
  });

  assert.equal(result.status, 0);
  assert.equal(result.error, undefined);
  assert.match(result.stdout, /"path": "dist\/index\.js"/);
  assert.match(result.stdout, /"path": "dist\/index\.d\.ts"/);
});

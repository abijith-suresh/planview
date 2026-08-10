import assert from "node:assert/strict";
import { test } from "node:test";
import {
  resolveAppDataPaths,
  V1_CLEANUP_INTERVAL_HOURS,
  V1_MAX_HTML_SIZE_BYTES,
  V1_POLICY,
  V1_PORT,
  V1_RETENTION_DAYS,
} from "../dist/index.js";

const dependencies = (platform, homeDir, env = {}) => ({ platform, homeDir, env });

const paths = (appDataDir, separator = "/") => ({
  appDataDir,
  databasePath: `${appDataDir}${separator}metadata.sqlite`,
  documentsDir: `${appDataDir}${separator}documents`,
  stagingDir: `${appDataDir}${separator}staging`,
});

test("uses XDG_DATA_HOME for Linux and WSL-style environments", () => {
  assert.deepEqual(
    resolveAppDataPaths(
      dependencies("linux", "/home/alice", {
        XDG_DATA_HOME: "/mnt/data/alice-data",
        LOCALAPPDATA: "C:\\Users\\alice\\AppData\\Local",
      })
    ),
    paths("/mnt/data/alice-data/planview")
  );
});

test("uses the Linux XDG default when XDG_DATA_HOME is absent or empty", () => {
  for (const env of [{}, { XDG_DATA_HOME: "" }]) {
    assert.deepEqual(
      resolveAppDataPaths(dependencies("linux", "/home/alice", env)),
      paths("/home/alice/.local/share/planview")
    );
  }
});

test("ignores a relative XDG_DATA_HOME instead of resolving storage below the cwd", () => {
  assert.deepEqual(
    resolveAppDataPaths(dependencies("linux", "/home/alice", { XDG_DATA_HOME: "relative-data" })),
    paths("/home/alice/.local/share/planview")
  );
});

test("uses macOS Application Support and ignores Linux and Windows variables", () => {
  assert.deepEqual(
    resolveAppDataPaths(
      dependencies("darwin", "/Users/alice", {
        XDG_DATA_HOME: "/tmp/not-used",
        LOCALAPPDATA: "C:\\not-used",
      })
    ),
    paths("/Users/alice/Library/Application Support/Planview")
  );
});

test("uses LOCALAPPDATA on Windows with Windows path semantics", () => {
  assert.deepEqual(
    resolveAppDataPaths(
      dependencies("win32", "C:\\Users\\alice", {
        LOCALAPPDATA: "C:\\Users\\alice\\AppData\\Local",
      })
    ),
    paths("C:\\Users\\alice\\AppData\\Local\\Planview", "\\")
  );
});

test("uses the safe Windows local-data fallback when LOCALAPPDATA is absent or relative", () => {
  for (const env of [{}, { LOCALAPPDATA: "relative-data" }]) {
    assert.deepEqual(
      resolveAppDataPaths(dependencies("win32", "C:\\Users\\alice", env)),
      paths("C:\\Users\\alice\\AppData\\Local\\Planview", "\\")
    );
  }
});

test("uses the POSIX data fallback for other Unix-like platforms", () => {
  assert.deepEqual(
    resolveAppDataPaths(dependencies("freebsd", "/home/alice", { XDG_DATA_HOME: "/srv/data" })),
    paths("/srv/data/planview")
  );
});

test("rejects a relative injected home directory", () => {
  assert.throws(
    () => resolveAppDataPaths(dependencies("linux", "alice")),
    /home directory must be an absolute path/
  );
});

test("never uses the legacy hidden home-directory location", () => {
  const resolved = resolveAppDataPaths(dependencies("linux", "/home/alice"));
  assert.notEqual(resolved.appDataDir, "/home/alice/.planview");
  assert.doesNotMatch(resolved.appDataDir, /\\?\.planview(?:[\\/]|$)/);
});

test("keeps the v1 policy values fixed and isolated", () => {
  assert.equal(V1_PORT, 4777);
  assert.equal(V1_MAX_HTML_SIZE_BYTES, 10 * 1024 * 1024);
  assert.equal(V1_RETENTION_DAYS, 30);
  assert.equal(V1_CLEANUP_INTERVAL_HOURS, 24);
  assert.deepEqual(V1_POLICY, {
    port: 4777,
    maxHtmlSizeBytes: 10 * 1024 * 1024,
    retentionDays: 30,
    cleanupIntervalHours: 24,
  });
  assert.equal(Object.isFrozen(V1_POLICY), true);
});

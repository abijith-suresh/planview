import assert from "node:assert/strict";
import { createServer } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const shell = process.platform === "win32";

const text = (value) => (value === null ? "" : value.toString("utf8"));

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: null,
    shell,
    ...options,
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with status ${result.status ?? "unknown"}.\n${text(result.stdout)}${text(result.stderr)}`
    );
  }
  return result;
};

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

const pack = (destination) => {
  const result = run(
    npm,
    [
      "pack",
      "--workspace",
      "@abijith-suresh/planview",
      "--pack-destination",
      destination,
      "--json",
    ],
    { env: { ...process.env, npm_config_loglevel: "warn" } }
  );
  let packages;
  try {
    packages = JSON.parse(text(result.stdout));
  } catch (cause) {
    throw new Error(`npm pack did not return JSON.\n${text(result.stdout)}${text(result.stderr)}`, {
      cause,
    });
  }
  assert.equal(packages.length, 1, "npm pack should produce exactly one package");
  const tarball = packages[0]?.filename;
  assert.equal(typeof tarball, "string", "npm pack should report its tarball");
  return join(destination, tarball);
};

const findInstalledCli = (prefix) => {
  const candidates =
    process.platform === "win32"
      ? [join(prefix, "planview.cmd"), join(prefix, "node_modules", ".bin", "planview.cmd")]
      : [join(prefix, "bin", "planview"), join(prefix, "node_modules", ".bin", "planview")];
  const cli = candidates.find((candidate) => existsSync(candidate));
  assert.ok(cli, `npm did not install a planview executable. Tried: ${candidates.join(", ")}`);
  return cli;
};

const assertSuccessful = (result, label) => {
  assert.equal(result.error, undefined, `${label} should start`);
  assert.equal(result.status, 0, `${label} failed:\n${text(result.stderr)}`);
};

const runSmoke = async () => {
  for (const directory of [
    "apps/cli/dist",
    "packages/core/dist",
    "packages/daemon/dist",
    "packages/storage/dist",
  ]) {
    rmSync(resolve(root, directory), { force: true, recursive: true });
  }

  const workspace = mkdtempSync(join(tmpdir(), "planview-cross-platform-"));
  const packageDestination = join(workspace, "package");
  const installPrefix = join(workspace, "install");
  mkdirSync(packageDestination);
  const home = join(workspace, "home");
  const appData = join(workspace, "app-data");
  const runtime = join(appData, "runtime");
  const source = join(workspace, "fixture.html");
  const port = await freePort();
  const environment = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    NODE_ENV: "test",
    PLANVIEW_APP_DATA_DIR: appData,
    PLANVIEW_RUNTIME_DIR: runtime,
    PLANVIEW_TEST_DAEMON_PORT: String(port),
  };

  let execute;
  try {
    const tarball = pack(packageDestination);
    run(npm, ["install", "--global", "--prefix", installPrefix, "--ignore-scripts", tarball]);
    const cli = findInstalledCli(installPrefix);
    execute = (args, options = {}) =>
      spawnSync(cli, args, {
        cwd: root,
        env: environment,
        encoding: null,
        shell,
        ...options,
      });

    const version = execute(["--version"]);
    assertSuccessful(version, "packed CLI --version");
    assert.match(text(version.stdout), /^planview \d+\.\d+\.\d+\n$/);

    const before = execute(["status"]);
    assertSuccessful(before, "initial packed CLI status");
    assert.match(text(before.stdout), /not running/);

    const original = "<!doctype html><html><body>cross-platform smoke</body></html>\n";
    writeFileSync(source, original);
    const published = execute(["publish", source]);
    assertSuccessful(published, "packed CLI publish");
    const url = text(published.stdout).trim();
    assert.match(url, new RegExp(`^http://localhost:${port}/[A-Za-z0-9_-]{21}$`));
    const id = url.slice(url.lastIndexOf("/") + 1);

    const running = execute(["status"]);
    assertSuccessful(running, "running packed CLI status");
    assert.match(text(running.stdout), /is running/);

    const retrieved = execute(["get", id]);
    assertSuccessful(retrieved, "packed CLI get");
    assert.deepEqual(retrieved.stdout, Buffer.from(original));

    const stopped = execute(["stop"]);
    assertSuccessful(stopped, "packed CLI stop");
    assert.match(text(stopped.stdout), /stopped/);
    const after = execute(["status"]);
    assertSuccessful(after, "stopped packed CLI status");
    assert.match(text(after.stdout), /not running/);

    const skills = execute(["skills", "install"]);
    assertSuccessful(skills, "packed CLI skills install");
    assert.match(text(skills.stdout), /Installed planview and create-html skills/);
    assert.ok(existsSync(join(home, ".agents", "skills", "planview", "SKILL.md")));
    assert.ok(existsSync(join(home, ".agents", "skills", "create-html", "SKILL.md")));
    assert.ok(
      existsSync(
        join(home, ".agents", "skills", "create-html", "references", "browser-native-patterns.md")
      )
    );
  } finally {
    if (execute !== undefined) {
      execute(["stop"]);
    }
    rmSync(workspace, { force: true, recursive: true });
  }
};

await runSmoke();
process.stdout.write(`Cross-platform packed CLI smoke passed on ${process.platform}.\n`);

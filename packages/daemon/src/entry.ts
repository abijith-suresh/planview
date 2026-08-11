import { resolveDaemonConfig, resolveDaemonConfigForTest, runDaemonProcess } from "./index.js";

try {
  const { NODE_ENV, PLANVIEW_TEST_DAEMON_PORT: configuredTestPort } = process.env;
  const testPort = NODE_ENV === "test" ? configuredTestPort : undefined;
  const config =
    testPort === undefined
      ? resolveDaemonConfig()
      : resolveDaemonConfigForTest({ port: Number(testPort) });
  await runDaemonProcess(config);
} catch (cause) {
  process.stderr.write(
    `Planview daemon failed: ${cause instanceof Error ? cause.message : String(cause)}\n`
  );
  process.exitCode = 1;
}

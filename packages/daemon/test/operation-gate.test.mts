import assert from "node:assert/strict";
import { test } from "node:test";
import { createOperationGate } from "../dist/operation-gate.js";

const deferred = <Value,>() => {
  let resolvePromise: (value: Value | PromiseLike<Value>) => void = () => undefined;
  const promise = new Promise<Value>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
};

test("runs queued operations in order and resolves idle waiters after the queue drains", async () => {
  const gate = createOperationGate();
  const firstStarted = deferred<void>();
  const releaseFirst = deferred<void>();
  const order: string[] = [];

  const first = gate(async () => {
    order.push("first:start");
    firstStarted.resolve(undefined);
    await releaseFirst.promise;
    order.push("first:end");
    return "first";
  });
  await firstStarted.promise;

  const second = gate(async () => {
    order.push("second");
    return "second";
  });
  const idle = gate.waitForIdle();

  assert.deepEqual(order, ["first:start"]);
  assert.equal(gate.isIdle(), false);
  releaseFirst.resolve(undefined);

  assert.equal(await first, "first");
  assert.equal(await second, "second");
  await idle;
  assert.deepEqual(order, ["first:start", "first:end", "second"]);
  assert.equal(gate.isIdle(), true);
});

test("removes a queued request when its caller aborts", async () => {
  const gate = createOperationGate();
  const firstStarted = deferred<void>();
  const releaseFirst = deferred<void>();
  let queuedOperationStarted = false;

  const first = gate(async () => {
    firstStarted.resolve(undefined);
    await releaseFirst.promise;
  });
  await firstStarted.promise;

  const request = new AbortController();
  const requestAbort = new Error("request cancelled");
  const queued = gate(async () => {
    queuedOperationStarted = true;
  }, request.signal);
  const queuedRejection = assert.rejects(queued, (cause) => cause === requestAbort);

  request.abort(requestAbort);
  await queuedRejection;
  releaseFirst.resolve(undefined);
  await first;
  await gate.waitForIdle();

  assert.equal(queuedOperationStarted, false);
});

test("closes queued work and can abort the active operation at the shutdown deadline", async () => {
  const gate = createOperationGate();
  const activeStarted = deferred<AbortSignal>();
  const active = gate(
    (signal) =>
      new Promise<void>((resolve) => {
        activeStarted.resolve(signal);
        signal.addEventListener("abort", () => resolve(), { once: true });
      })
  );
  const activeSignal = await activeStarted.promise;
  const queued = gate(async () => undefined);
  const shutdownCause = new Error("daemon shutdown");
  const queuedRejection = assert.rejects(queued, (cause) => cause === shutdownCause);

  gate.close(shutdownCause);
  await queuedRejection;
  assert.equal(activeSignal.aborted, false);
  await assert.rejects(
    gate(async () => undefined),
    /daemon is shutting down/
  );

  const idle = gate.waitForIdle();
  const deadlineCause = new Error("shutdown deadline elapsed");
  gate.abortActive(deadlineCause);

  assert.equal(activeSignal.aborted, true);
  assert.equal(activeSignal.reason, deadlineCause);
  await active;
  await idle;
  assert.equal(gate.isIdle(), true);
});

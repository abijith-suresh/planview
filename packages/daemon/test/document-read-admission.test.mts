import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createDocumentReadAdmission,
  DocumentReadAdmissionError,
} from "../dist/document-read-admission.js";

const admissionError = (code: "capacity" | "closed" | "timeout") => (cause: unknown) =>
  cause instanceof DocumentReadAdmissionError && cause.code === code;

const createAdmission = (options?: {
  readonly maxActiveReads?: number;
  readonly maxQueuedReads?: number;
  readonly queueTimeoutMs?: number;
}) =>
  createDocumentReadAdmission({
    maxActiveReads: options?.maxActiveReads ?? 1,
    maxQueuedReads: options?.maxQueuedReads ?? 1,
    queueTimeoutMs: options?.queueTimeoutMs ?? 1_000,
  });

test("bounds active and queued reads, then grants permits in FIFO order", async () => {
  const admission = createAdmission({ maxQueuedReads: 2 });
  const first = await admission.acquire();
  const secondPromise = admission.acquire();
  let thirdGranted = false;
  const thirdPromise = admission.acquire().then((permit) => {
    thirdGranted = true;
    return permit;
  });

  await assert.rejects(admission.acquire(), admissionError("capacity"));
  first.release();
  first.release();

  const second = await secondPromise;
  assert.equal(thirdGranted, false);
  second.release();
  const third = await thirdPromise;
  third.release();
});

test("removes an aborted queued read so a later waiter can acquire a permit", async () => {
  const admission = createAdmission();
  const active = await admission.acquire();
  const request = new AbortController();
  const reason = new Error("request cancelled");
  const queued = admission.acquire(request.signal);
  const queuedRejection = assert.rejects(queued, (cause) => cause === reason);

  request.abort(reason);
  await queuedRejection;

  const next = admission.acquire();
  active.release();
  const nextPermit = await next;
  nextPermit.release();
});

test("rejects a queued read when its queue deadline expires", async () => {
  const admission = createAdmission({ queueTimeoutMs: 20 });
  const active = await admission.acquire();

  await assert.rejects(admission.acquire(), admissionError("timeout"));
  active.release();
});

test("rejects queued reads and aborts active reads when admission closes", async () => {
  const admission = createAdmission();
  const active = await admission.acquire();
  const queued = admission.acquire();
  const queuedRejection = assert.rejects(queued, admissionError("closed"));

  admission.close();
  await queuedRejection;
  await assert.rejects(admission.acquire(), admissionError("closed"));
  assert.equal(active.signal.aborted, true);
  active.release();
});

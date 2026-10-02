import assert from "node:assert/strict";
import { test } from "node:test";

import { createDocumentPages, type DocumentPage } from "../src/lib/document-pages.ts";

type Document = { _id: string };

function setup() {
  const subscriptions: Array<{
    options: { cursor: string | null; numItems: number; id: number };
    update(page: DocumentPage<Document>): void;
    error(error: Error): void;
    stopped: boolean;
  }> = [];
  let state = {
    documents: [] as Document[],
    hasMore: false,
    loadingMore: false,
    initialLoading: true,
  };
  let failure: Error | undefined;
  const controller = createDocumentPages<Document>({
    id: 7,
    subscribe(options, update, error) {
      const subscription = { options, update, error, stopped: false };
      subscriptions.push(subscription);
      return () => {
        subscription.stopped = true;
      };
    },
    update: (next) => {
      state = next;
    },
    error: (error) => {
      failure = error;
    },
  });
  const page = (start: number, count: number, isDone = false) => ({
    page: Array.from({ length: count }, (_, offset) => ({ _id: String(start + offset) })),
    isDone,
    continueCursor: String(start + count),
  });
  return { controller, subscriptions, state: () => state, failure: () => failure, page };
}

test("loads beyond 100 documents using bounded live pages", () => {
  const { controller, subscriptions, state, page } = setup();
  subscriptions[0]!.update(page(0, 50));
  controller.loadMore();
  controller.loadMore();
  assert.equal(subscriptions.length, 2, "repeated clicks do not start duplicate requests");
  assert.equal(state().loadingMore, true);
  subscriptions[1]!.update(page(50, 50));
  controller.loadMore();
  subscriptions[2]!.update(page(100, 51, true));
  assert.equal(state().documents.length, 151);
  assert.equal(state().hasMore, false);
  assert.equal(state().loadingMore, false);
  assert.deepEqual(
    subscriptions.map(({ options }) => options),
    [
      { cursor: null, numItems: 50, id: 7 },
      { cursor: "50", numItems: 50, id: 7 },
      { cursor: "100", numItems: 50, id: 7 },
    ]
  );
  controller.loadMore();
  assert.equal(subscriptions.length, 3);
});

test("live updates replace page contents without duplicate rows", () => {
  const { controller, subscriptions, state, page } = setup();
  subscriptions[0]!.update(page(0, 50));
  controller.loadMore();
  subscriptions[1]!.update(page(49, 50, true));
  assert.equal(state().documents.length, 99);
  subscriptions[0]!.update(page(1, 49));
  assert.equal(state().documents[0]!._id, "1");
  assert.equal(state().documents.length, 98);
});

test("a failed next page preserves documents and can be retried", () => {
  const { controller, subscriptions, state, failure, page } = setup();
  subscriptions[0]!.update(page(0, 50));
  controller.loadMore();
  subscriptions[1]!.error(new Error("Network error"));
  assert.equal(state().documents.length, 50);
  assert.equal(state().loadingMore, false);
  assert.equal(subscriptions[1]!.stopped, true);
  assert.equal(failure()?.message, "Network error");
  controller.loadMore();
  subscriptions[2]!.update(page(50, 1, true));
  assert.equal(state().documents.length, 51);
});

test("closing stops subscriptions and ignores late account data", () => {
  const { controller, subscriptions, state, page } = setup();
  subscriptions[0]!.update(page(0, 50));
  controller.close();
  subscriptions[0]!.update(page(100, 1, true));
  controller.loadMore();
  assert.equal(subscriptions[0]!.stopped, true);
  assert.equal(state().documents[0]!._id, "0");
  assert.equal(subscriptions.length, 1);
});

test("required splits wait for the complete cursor range before loading more", () => {
  const { controller, subscriptions, state, page } = setup();
  subscriptions[0]!.update({
    ...page(0, 1),
    continueCursor: "100",
    pageStatus: "SplitRequired",
    splitCursor: "50",
  });
  assert.equal(state().documents.length, 0, "incomplete range is not presented as a complete page");
  assert.equal(state().initialLoading, true);
  controller.loadMore();
  assert.equal(subscriptions.length, 3, "cannot skip past an incomplete range");
  assert.deepEqual(subscriptions[1]!.options, {
    cursor: null,
    numItems: 50,
    id: 7,
    endCursor: "50",
  });
  assert.deepEqual(subscriptions[2]!.options, {
    cursor: "50",
    numItems: 50,
    id: 7,
    endCursor: "100",
  });
  subscriptions[1]!.update(page(0, 50));
  assert.equal(state().documents.length, 0);
  subscriptions[2]!.update(page(50, 50));
  assert.equal(state().documents.length, 100);
  assert.equal(subscriptions[0]!.stopped, true, "completed child ranges retire their parent query");
  assert.equal(state().initialLoading, false);
  controller.loadMore();
  assert.equal(subscriptions[3]!.options.cursor, "100");
  subscriptions[3]!.update(page(100, 1, true));
  assert.equal(state().documents.length, 101);
});

test("recommended splits keep complete rows until both child queries are ready", () => {
  const { controller, subscriptions, state, page } = setup();
  subscriptions[0]!.update({ ...page(0, 100), pageStatus: "SplitRecommended", splitCursor: "50" });
  assert.equal(state().documents.length, 100);
  controller.loadMore();
  assert.equal(subscriptions.length, 3);
  subscriptions[1]!.update(page(0, 50));
  subscriptions[2]!.update(page(50, 50));
  assert.equal(state().documents.length, 100);
  controller.close();
  assert.ok(subscriptions.every(({ stopped }) => stopped));
});

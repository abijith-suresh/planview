import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const entry = require.resolve("@convex-dev/better-auth");
const { convexAdapter } = await import(new URL("./adapter.js", pathToFileURL(entry)).href);

test("authorization codes are consumed through one Convex mutation", async () => {
  const row = {
    _id: "verification-id",
    _creationTime: 123,
    identifier: "code-id",
    value: "code-value",
    expiresAt: 456,
    createdAt: 123,
    updatedAt: 123,
  };
  let remaining: typeof row | null = row;
  let mutations = 0;
  const ctx = {
    runMutation: async (
      _reference: unknown,
      args: { input: { model: string; where: unknown[] } }
    ) => {
      mutations += 1;
      assert.equal(args.input.model, "verification");
      assert.deepEqual(args.input.where, [
        {
          field: "_id",
          operator: "eq",
          value: row._id,
          connector: "AND",
          mode: "sensitive",
        },
      ]);
      const consumed = remaining;
      remaining = null;
      return consumed;
    },
  };
  const adapter = convexAdapter(ctx, { adapter: { deleteOne: "deleteOne" } })({});

  const results = await Promise.all([
    adapter.consumeOne({ model: "verification", where: [{ field: "id", value: row._id }] }),
    adapter.consumeOne({ model: "verification", where: [{ field: "id", value: row._id }] }),
  ]);

  assert.equal(mutations, 2);
  assert.deepEqual(
    results.map((result: { id?: string } | null) => result?.id ?? null),
    [row._id, null]
  );
});

import test from "node:test";
import assert from "node:assert/strict";
import { sortSemanticApplications } from "../lib/semantic-computer.js";

test("application discovery prioritizes running and evidence-backed recent use", () => {
  const input = [
    { id: "old", displayName: "Old", isRunning: false, useCount: 20, lastUsedDate: "2026-01-01T00:00:00Z" },
    { id: "unknown", displayName: "Unknown", isRunning: false, useCount: null, lastUsedDate: null },
    { id: "recent", displayName: "Recent", isRunning: false, useCount: 20, lastUsedDate: "2026-08-01T00:00:00Z" },
    { id: "running", displayName: "Running", isRunning: true, useCount: null, lastUsedDate: null },
    { id: "frequent", displayName: "Frequent", isRunning: false, useCount: 50, lastUsedDate: "2025-01-01T00:00:00Z" },
  ];
  assert.deepEqual(sortSemanticApplications(input).map((application) => application.id), [
    "running", "frequent", "recent", "old", "unknown",
  ]);
  assert.equal(input[0].id, "old", "sorting must not mutate provider results");
});

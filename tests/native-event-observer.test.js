import test from "node:test";
import assert from "node:assert/strict";
import { decodeNativeObservationTarget } from "../lib/native-event-observer.js";

function encode(payload) {
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

test("native observer targets are derived only from platform element identities", () => {
  assert.deepEqual(decodeNativeObservationTarget(encode({ source: "macos-ax", pid: 42, path: [1] })), {
    source: "macos-ax", target: "42",
  });
  assert.deepEqual(decodeNativeObservationTarget(encode({ source: "windows-uia", hwnd: 9001, path: [2] })), {
    source: "windows-uia", target: "9001",
  });
  assert.deepEqual(decodeNativeObservationTarget(encode({ source: "linux-atspi", path: [3, 4] })), {
    source: "linux-atspi", target: "3",
  });
});

test("native observer target decoding fails closed", () => {
  for (const value of [
    "not-base64-json",
    encode({ source: "macos-ax", pid: -1, path: [] }),
    encode({ source: "windows-uia", path: [] }),
    encode({ source: "windows-uia", hwnd: "not-a-handle", path: [] }),
    encode({ source: "linux-atspi", path: [] }),
    encode({ source: "linux-atspi", path: [-1] }),
    encode({ source: "browser-cdp", targetId: "x" }),
  ]) assert.equal(decodeNativeObservationTarget(value), null);
});

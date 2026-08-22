import test from "node:test";
import assert from "node:assert/strict";
import { buildCompactAxSnapshot } from "../lib/ego-snapshot.js";

const ax = (value) => ({ value });

test("compact AX snapshots assign bounded refs and preserve useful state", () => {
  const result = buildCompactAxSnapshot([
    { ignored: false, backendDOMNodeId: 10, role: ax("button"), name: ax("Submit"), properties: [{ name: "disabled", value: ax(true) }] },
    { ignored: false, backendDOMNodeId: 11, role: ax("textbox"), name: ax("Email"), value: ax("person@example.com"), properties: [] },
    { ignored: false, backendDOMNodeId: 12, role: ax("generic"), name: ax(""), properties: [] },
    { ignored: true, backendDOMNodeId: 13, role: ax("link"), name: ax("Hidden"), properties: [] },
  ]);
  assert.equal(result.nodeCount, 2);
  assert.equal(result.refs.length, 2);
  assert.match(result.content, /@1 button "Submit" \[disabled\]/);
  assert.match(result.content, /@2 textbox "Email" value="person@example\.com"/);
  assert.deepEqual(result.refs.map(({ ref, backendNodeId }) => [ref, backendNodeId]), [["@1", 10], ["@2", 11]]);
});

test("compact AX snapshots honor text and output limits", () => {
  const nodes = Array.from({ length: 5 }, (_, index) => ({
    ignored: false,
    backendDOMNodeId: index + 1,
    role: ax("statictext"),
    name: ax(`line ${index}`),
    properties: [],
  }));
  assert.equal(buildCompactAxSnapshot(nodes, { includeText: false }).nodeCount, 0);
  const bounded = buildCompactAxSnapshot(nodes, { maxNodes: 2, maxChars: 20 });
  assert.equal(bounded.nodeCount, 2);
  assert.equal(bounded.truncated, true);
  assert.ok(bounded.content.length <= 21);
});

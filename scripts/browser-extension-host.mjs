#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { connect } from "node:net";
import { browserExtensionPaths } from "../lib/browser-extension-paths.js";

const paths = browserExtensionPaths();
const secret = (await readFile(paths.secret, "utf8")).trim();
let nativeBuffer = Buffer.alloc(0);
let lineBuffer = "";
let socket = null;
let reconnectTimer = null;
let authenticatedHello = null;
const pendingMessages = [];

function writeNative(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([header, body]));
}

function forwardBridgeData(chunk) {
  lineBuffer += chunk;
  while (lineBuffer.includes("\n")) {
    const index = lineBuffer.indexOf("\n");
    const line = lineBuffer.slice(0, index);
    lineBuffer = lineBuffer.slice(index + 1);
    if (line.trim()) writeNative(JSON.parse(line));
  }
}

function enqueue(message) {
  if (message.type === "tabs" || message.type === "heartbeat") {
    const index = pendingMessages.findIndex((item) => item.type === message.type);
    if (index >= 0) pendingMessages.splice(index, 1);
  }
  pendingMessages.push(message);
  if (pendingMessages.length > 256) pendingMessages.splice(0, pendingMessages.length - 256);
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectBridge();
  }, 500);
}

function connectBridge() {
  if (socket && !socket.destroyed) return;
  lineBuffer = "";
  const candidate = connect(paths.socket);
  socket = candidate;
  candidate.setEncoding("utf8");
  candidate.on("connect", () => {
    if (authenticatedHello) candidate.write(`${JSON.stringify(authenticatedHello)}\n`);
    while (pendingMessages.length) candidate.write(`${JSON.stringify(pendingMessages.shift())}\n`);
  });
  candidate.on("data", forwardBridgeData);
  candidate.on("error", () => {});
  candidate.on("close", () => {
    if (socket === candidate) socket = null;
    scheduleReconnect();
  });
}

function sendBridge(message) {
  if (message.type === "hello") {
    authenticatedHello = { ...message, secret };
    if (socket && !socket.destroyed && socket.readyState === "open") socket.write(`${JSON.stringify(authenticatedHello)}\n`);
    return;
  }
  if (socket && !socket.destroyed && socket.readyState === "open") socket.write(`${JSON.stringify(message)}\n`);
  else enqueue(message);
}

connectBridge();
process.stdin.on("data", (chunk) => {
  nativeBuffer = Buffer.concat([nativeBuffer, chunk]);
  while (nativeBuffer.length >= 4) {
    const length = nativeBuffer.readUInt32LE(0);
    if (length > 16 * 1024 * 1024) process.exit(2);
    if (nativeBuffer.length < 4 + length) return;
    const message = JSON.parse(nativeBuffer.subarray(4, 4 + length).toString("utf8"));
    nativeBuffer = nativeBuffer.subarray(4 + length);
    sendBridge(message);
  }
});
process.stdin.on("end", () => {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  socket?.end();
});

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import {
  nativeComputerBackendName,
  nativeComputerBackendSupported,
  nativeComputerDoctor,
  nativeComputerState,
  nativeComputerUse,
} from "./lib/native-computer-backend.js";
import { listSemanticElements, semanticElementAction } from "./lib/semantic-computer.js";

const API_WIDTH = 1280;
const DEFAULT_SETTLE_MS = clampNumber(Number(process.env.COMPUTER_SCREENSHOT_SETTLE_MS ?? 2000), 0, 5000, 2000);
const DEFAULT_TYPING_DELAY_MS = clampNumber(Number(process.env.COMPUTER_TYPING_DELAY_MS ?? 12), 0, 1000, 12);
const DEFAULT_TYPING_BATCH_SIZE = clampNumber(Number(process.env.COMPUTER_TYPING_BATCH_SIZE ?? 50), 1, 500, 50);
const KEYMAP_SETTLE_MS = 300;
const MAX_WAIT_MS = 30_000;
const MAX_FOLLOW_UP_ACTIONS = 9;
const MAX_TEXT_CHARS = 20_000;
const MAX_WINDOWS = 30;
const MAX_STDERR_BYTES = 256 * 1024;
const MAX_SCREENSHOT_BYTES = 12 * 1024 * 1024;
const ELEMENT_SNAPSHOT_TTL_MS = 90_000;
const MAX_ELEMENT_SNAPSHOTS = 24;
const ELEMENT_ACTIONS = ["press", "focus", "set_value", "toggle", "increment", "decrement", "scroll_into_view"];
const ELEMENT_SNAPSHOTS = new Map();

const BUTTONS = {
  left: "1",
  middle: "2",
  right: "3",
  back: "8",
  forward: "9",
};

const SCROLL_BUTTONS = {
  up: "4",
  down: "5",
  left: "6",
  right: "7",
};

const ACTION_NAMES = ["screenshot", "click", "move", "drag", "type", "key", "scroll", "wait"];

const pointSchema = z.object({
  x: z.number().int(),
  y: z.number().int(),
});

const actionSchema = z.object({
  action: z.enum(ACTION_NAMES),
  x: z.number().int().optional(),
  y: z.number().int().optional(),
  x2: z.number().int().optional(),
  y2: z.number().int().optional(),
  path: z.array(pointSchema).min(2).max(100).optional(),
  text: z.string().max(MAX_TEXT_CHARS).optional(),
  key: z.string().max(128).optional(),
  button: z.enum(["left", "right", "middle", "back", "forward"]).optional(),
  count: z.number().int().min(1).max(3).optional(),
  direction: z.enum(["up", "down", "left", "right"]).optional(),
  amount: z.number().int().min(1).max(100).optional(),
  durationMs: z.number().int().min(0).max(MAX_WAIT_MS).optional(),
});

const computerUseArgsSchema = actionSchema.extend({
  display: z.string().min(1).max(64).optional(),
  description: z.string().max(500).optional(),
  then: z.array(actionSchema).min(1).max(MAX_FOLLOW_UP_ACTIONS).optional(),
});

const stateShape = {
  display: z.string(),
  displayResolution: z.object({ width: z.number().int(), height: z.number().int() }),
  apiResolution: z.object({ width: z.number().int(), height: z.number().int() }),
  cursorPosition: z.object({ x: z.number().int(), y: z.number().int() }).nullable(),
  activeWindow: z.object({ id: z.string(), name: z.string() }).nullable(),
  windows: z.array(z.object({ id: z.string(), name: z.string() })),
  screenshotIncluded: z.boolean(),
  screenshotMimeType: z.string().nullable(),
  message: z.string(),
};

const environmentShape = {
  platform: z.string(),
  backend: z.string(),
  ready: z.boolean(),
  display: z.string().nullable(),
  displayResolution: z.object({ width: z.number().int(), height: z.number().int() }).nullable(),
  apiResolution: z.object({ width: z.number().int(), height: z.number().int() }).nullable(),
  permissions: z.record(z.boolean()),
  details: z.array(z.string()),
  message: z.string(),
};

const elementBoundsShape = z.object({ x: z.number().int(), y: z.number().int(), width: z.number().int(), height: z.number().int() });
const elementShape = z.object({
  index: z.number().int(),
  source: z.string(),
  role: z.string(),
  name: z.string(),
  value: z.string(),
  description: z.string(),
  enabled: z.boolean(),
  focused: z.boolean(),
  selected: z.boolean(),
  checked: z.boolean().nullable(),
  expanded: z.boolean().nullable(),
  bounds: elementBoundsShape.nullable(),
  actions: z.array(z.string()),
});
const elementsResultShape = {
  snapshotId: z.string(),
  expiresInMs: z.number().int(),
  source: z.string(),
  providers: z.array(z.string()),
  target: z.object({ id: z.string(), title: z.string(), url: z.string(), endpoint: z.string() }).nullable(),
  targets: z.array(z.object({ id: z.string(), title: z.string(), url: z.string(), endpoint: z.string() })),
  application: z.string().nullable(),
  applications: z.array(z.object({ index: z.number().int(), name: z.string() })),
  elements: z.array(elementShape),
  warnings: z.array(z.string()),
  message: z.string(),
};
const elementActionResultShape = {
  snapshotId: z.string(),
  elementIndex: z.number().int(),
  source: z.string(),
  action: z.string(),
  durationMs: z.number().int(),
  activeWindow: z.object({ id: z.string(), name: z.string() }).nullable(),
  screenshotIncluded: z.boolean(),
  screenshotMimeType: z.string().nullable(),
  message: z.string(),
};

const useResultShape = {
  display: z.string(),
  displayResolution: z.object({ width: z.number().int(), height: z.number().int() }),
  apiResolution: z.object({ width: z.number().int(), height: z.number().int() }),
  actionCount: z.number().int(),
  durationMs: z.number().int(),
  cursorPosition: z.object({ x: z.number().int(), y: z.number().int() }).nullable(),
  activeWindow: z.object({ id: z.string(), name: z.string() }).nullable(),
  screenshotIncluded: z.boolean(),
  screenshotMimeType: z.string().nullable(),
  message: z.string(),
};

const stateJsonSchema = {
  type: "object",
  properties: {
    display: { type: "string" },
    displayResolution: resolutionJsonSchema(),
    apiResolution: resolutionJsonSchema(),
    cursorPosition: pointOrNullJsonSchema(),
    activeWindow: windowOrNullJsonSchema(),
    windows: { type: "array", items: windowJsonSchema() },
    screenshotIncluded: { type: "boolean" },
    screenshotMimeType: { type: ["string", "null"] },
    message: { type: "string" },
  },
  required: ["display", "displayResolution", "apiResolution", "cursorPosition", "activeWindow", "windows", "screenshotIncluded", "screenshotMimeType", "message"],
  additionalProperties: false,
};

const environmentJsonSchema = {
  type: "object",
  properties: {
    platform: { type: "string" },
    backend: { type: "string" },
    ready: { type: "boolean" },
    display: { type: ["string", "null"] },
    displayResolution: { anyOf: [resolutionJsonSchema(), { type: "null" }] },
    apiResolution: { anyOf: [resolutionJsonSchema(), { type: "null" }] },
    permissions: { type: "object", additionalProperties: { type: "boolean" } },
    details: { type: "array", items: { type: "string" } },
    message: { type: "string" },
  },
  required: ["platform", "backend", "ready", "display", "displayResolution", "apiResolution", "permissions", "details", "message"],
  additionalProperties: false,
};

const elementBoundsJsonSchema = {
  type: "object",
  properties: { x: { type: "integer" }, y: { type: "integer" }, width: { type: "integer" }, height: { type: "integer" } },
  required: ["x", "y", "width", "height"],
  additionalProperties: false,
};
const elementJsonSchema = {
  type: "object",
  properties: {
    index: { type: "integer" }, source: { type: "string" }, role: { type: "string" }, name: { type: "string" },
    value: { type: "string" }, description: { type: "string" }, enabled: { type: "boolean" }, focused: { type: "boolean" },
    selected: { type: "boolean" }, checked: { type: ["boolean", "null"] }, expanded: { type: ["boolean", "null"] },
    bounds: { anyOf: [elementBoundsJsonSchema, { type: "null" }] }, actions: { type: "array", items: { type: "string" } },
  },
  required: ["index", "source", "role", "name", "value", "description", "enabled", "focused", "selected", "checked", "expanded", "bounds", "actions"],
  additionalProperties: false,
};
const elementsResultJsonSchema = {
  type: "object",
  properties: {
    snapshotId: { type: "string" }, expiresInMs: { type: "integer" }, source: { type: "string" },
    providers: { type: "array", items: { type: "string" } },
    target: { anyOf: [{ type: "object", properties: { id: { type: "string" }, title: { type: "string" }, url: { type: "string" }, endpoint: { type: "string" } }, required: ["id", "title", "url", "endpoint"], additionalProperties: false }, { type: "null" }] },
    targets: { type: "array", items: { type: "object", properties: { id: { type: "string" }, title: { type: "string" }, url: { type: "string" }, endpoint: { type: "string" } }, required: ["id", "title", "url", "endpoint"], additionalProperties: false } },
    application: { type: ["string", "null"] },
    applications: { type: "array", items: { type: "object", properties: { index: { type: "integer" }, name: { type: "string" } }, required: ["index", "name"], additionalProperties: false } },
    elements: { type: "array", items: elementJsonSchema }, warnings: { type: "array", items: { type: "string" } }, message: { type: "string" },
  },
  required: ["snapshotId", "expiresInMs", "source", "providers", "target", "targets", "application", "applications", "elements", "warnings", "message"],
  additionalProperties: false,
};
const elementActionResultJsonSchema = {
  type: "object",
  properties: {
    snapshotId: { type: "string" }, elementIndex: { type: "integer" }, source: { type: "string" }, action: { type: "string" }, durationMs: { type: "integer" },
    activeWindow: windowOrNullJsonSchema(), screenshotIncluded: { type: "boolean" }, screenshotMimeType: { type: ["string", "null"] }, message: { type: "string" },
  },
  required: ["snapshotId", "elementIndex", "source", "action", "durationMs", "activeWindow", "screenshotIncluded", "screenshotMimeType", "message"],
  additionalProperties: false,
};

const useResultJsonSchema = {
  type: "object",
  properties: {
    display: { type: "string" },
    displayResolution: resolutionJsonSchema(),
    apiResolution: resolutionJsonSchema(),
    actionCount: { type: "integer" },
    durationMs: { type: "integer" },
    cursorPosition: pointOrNullJsonSchema(),
    activeWindow: windowOrNullJsonSchema(),
    screenshotIncluded: { type: "boolean" },
    screenshotMimeType: { type: ["string", "null"] },
    message: { type: "string" },
  },
  required: ["display", "displayResolution", "apiResolution", "actionCount", "durationMs", "cursorPosition", "activeWindow", "screenshotIncluded", "screenshotMimeType", "message"],
  additionalProperties: false,
};

function resolutionJsonSchema() {
  return {
    type: "object",
    properties: { width: { type: "integer" }, height: { type: "integer" } },
    required: ["width", "height"],
    additionalProperties: false,
  };
}

function pointOrNullJsonSchema() {
  return {
    anyOf: [
      {
        type: "object",
        properties: { x: { type: "integer" }, y: { type: "integer" } },
        required: ["x", "y"],
        additionalProperties: false,
      },
      { type: "null" },
    ],
  };
}

function windowJsonSchema() {
  return {
    type: "object",
    properties: { id: { type: "string" }, name: { type: "string" } },
    required: ["id", "name"],
    additionalProperties: false,
  };
}

function windowOrNullJsonSchema() {
  return { anyOf: [windowJsonSchema(), { type: "null" }] };
}

function actionPropertiesJsonSchema() {
  return {
    action: {
      type: "string",
      enum: ACTION_NAMES,
      description: "Desktop action. Every call returns one screenshot after the full sequence completes.",
    },
    x: { type: "integer", description: "X coordinate in the API screenshot space (origin top-left)." },
    y: { type: "integer", description: "Y coordinate in the API screenshot space (origin top-left)." },
    x2: { type: "integer", description: "Drag end X coordinate when path is omitted." },
    y2: { type: "integer", description: "Drag end Y coordinate when path is omitted." },
    path: {
      type: "array",
      minItems: 2,
      maxItems: 100,
      items: {
        type: "object",
        properties: { x: { type: "integer" }, y: { type: "integer" } },
        required: ["x", "y"],
        additionalProperties: false,
      },
      description: "Optional ordered drag path. At least two points.",
    },
    text: { type: "string", maxLength: MAX_TEXT_CHARS, description: "Text for type. Unicode is supported with temporary X keymap bindings when needed." },
    key: { type: "string", maxLength: 128, description: "Portable key or chord, e.g. Return, ctrl+a, Alt+Left. meta/super maps to the platform command key." },
    button: { type: "string", enum: ["left", "right", "middle", "back", "forward"], default: "left" },
    count: { type: "integer", minimum: 1, maximum: 3, default: 1 },
    direction: { type: "string", enum: ["up", "down", "left", "right"], default: "down" },
    amount: { type: "integer", minimum: 1, maximum: 100, default: 3 },
    durationMs: { type: "integer", minimum: 0, maximum: MAX_WAIT_MS, description: `Wait duration. Max ${MAX_WAIT_MS}ms.` },
  };
}

function actionJsonSchema() {
  return {
    type: "object",
    properties: actionPropertiesJsonSchema(),
    required: ["action"],
    additionalProperties: false,
  };
}

function clampNumber(value, min, max, fallback) {
  return Number.isFinite(value) ? Math.min(Math.max(value, min), max) : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeDisplay(value) {
  const display = String(value ?? "").trim();
  if (!display || display.length > 64 || /[\s\0]/.test(display)) {
    throw new Error(`Invalid X11 display: ${JSON.stringify(display)}`);
  }
  return display;
}

function commandEnvironment(display, extra = {}) {
  return {
    ...process.env,
    DISPLAY: display,
    LANG: process.env.LANG ?? "C.UTF-8",
    LC_ALL: process.env.LC_ALL ?? "C.UTF-8",
    ...extra,
  };
}

function runProgram(command, args, options = {}) {
  const {
    env = process.env,
    input = null,
    timeoutMs = 10_000,
    maxStdoutBytes = 2 * 1024 * 1024,
    maxStderrBytes = MAX_STDERR_BYTES,
  } = options;

  return new Promise((resolve, reject) => {
    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let timedOut = false;
    let overflowError = null;

    const child = spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1000).unref();
    }, timeoutMs);

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };

    child.on("error", (error) => finish(error));
    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxStdoutBytes) {
        overflowError = new Error(`${command} stdout exceeded ${maxStdoutBytes} bytes.`);
        child.kill("SIGTERM");
        return;
      }
      stdoutChunks.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      const remaining = Math.max(maxStderrBytes - stderrBytes, 0);
      if (remaining > 0) stderrChunks.push(chunk.subarray(0, remaining));
      stderrBytes += chunk.length;
    });
    child.on("close", (code, signal) => {
      const stdout = Buffer.concat(stdoutChunks);
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      if (overflowError) return finish(overflowError);
      if (timedOut) return finish(new Error(`${command} timed out after ${timeoutMs}ms.`));
      if (code !== 0 || signal) {
        const suffix = stderr.trim() ? `: ${stderr.trim()}` : "";
        return finish(new Error(`${command} exited with ${code ?? signal}${suffix}`));
      }
      finish(null, { stdout, stderr });
    });

    child.stdin.on("error", () => {});
    if (input !== null && input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

async function runText(command, args, options = {}) {
  const result = await runProgram(command, args, options);
  return result.stdout.toString("utf8");
}

async function tryText(command, args, options = {}) {
  try {
    return await runText(command, args, options);
  } catch {
    return "";
  }
}

async function resolveDisplay(requested) {
  const candidates = [];
  if (requested) candidates.push(sanitizeDisplay(requested));
  if (process.env.DISPLAY) candidates.push(sanitizeDisplay(process.env.DISPLAY));
  for (let i = 0; i <= 9; i += 1) candidates.push(`:${i}`);

  const unique = [...new Set(candidates)];
  const errors = [];
  for (const display of unique) {
    try {
      await runProgram("xdpyinfo", ["-display", display], {
        env: commandEnvironment(display),
        timeoutMs: 2000,
        maxStdoutBytes: 64 * 1024,
      });
      return display;
    } catch (error) {
      errors.push(`${display}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`No working X11 display found. Tried ${unique.join(", ")}. ${errors.slice(0, 3).join(" | ")}`);
}

async function detectResolution(display) {
  const output = await runText("xrandr", ["--display", display, "--current"], {
    env: commandEnvironment(display),
    timeoutMs: 5000,
    maxStdoutBytes: 256 * 1024,
  });

  let width;
  let height;
  for (const line of output.split("\n")) {
    if (!line.includes("*")) continue;
    const match = line.trim().match(/^(\d+)x(\d+)/);
    if (match) {
      width = Number(match[1]);
      height = Number(match[2]);
      break;
    }
  }
  if (!width || !height) {
    const match = output.match(/current\s+(\d+)\s*x\s*(\d+)/i);
    if (match) {
      width = Number(match[1]);
      height = Number(match[2]);
    }
  }
  if (!width || !height) throw new Error(`Could not detect resolution for ${display}.`);

  const apiHeight = Math.round(API_WIDTH / (width / height));
  return {
    display: { width, height },
    api: { width: API_WIDTH, height: apiHeight },
  };
}

function apiToDisplay(point, resolution) {
  const { x, y } = point;
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("Coordinates must be finite numbers.");
  if (x < 0 || y < 0 || x >= resolution.api.width || y >= resolution.api.height) {
    throw new Error(`Coordinate (${x}, ${y}) is outside API display ${resolution.api.width}x${resolution.api.height}.`);
  }
  return {
    x: Math.round((x / resolution.api.width) * resolution.display.width),
    y: Math.round((y / resolution.api.height) * resolution.display.height),
  };
}

function displayToApi(point, resolution) {
  return {
    x: Math.max(0, Math.min(resolution.api.width - 1, Math.round((point.x / resolution.display.width) * resolution.api.width))),
    y: Math.max(0, Math.min(resolution.api.height - 1, Math.round((point.y / resolution.display.height) * resolution.api.height))),
  };
}

async function cursorPosition(display, resolution) {
  const output = await tryText("xdotool", ["getmouselocation", "--shell"], {
    env: commandEnvironment(display),
    timeoutMs: 3000,
  });
  const x = /(?:^|\n)X=(\d+)/.exec(output);
  const y = /(?:^|\n)Y=(\d+)/.exec(output);
  if (!x || !y) return null;
  return displayToApi({ x: Number(x[1]), y: Number(y[1]) }, resolution);
}

async function activeWindow(display) {
  const env = commandEnvironment(display);
  const id = (await tryText("xdotool", ["getactivewindow"], { env, timeoutMs: 2000 })).trim();
  if (!id) return null;
  const name = (await tryText("xdotool", ["getwindowname", id], { env, timeoutMs: 2000 })).trim();
  return { id, name };
}

async function visibleWindows(display) {
  const env = commandEnvironment(display);
  const ids = (await tryText("xdotool", ["search", "--onlyvisible", "--name", ".*"], {
    env,
    timeoutMs: 3000,
    maxStdoutBytes: 256 * 1024,
  }))
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, MAX_WINDOWS * 4);

  const windows = [];
  for (const id of ids) {
    const name = (await tryText("xdotool", ["getwindowname", id], { env, timeoutMs: 1500 })).trim();
    if (!name) continue;
    windows.push({ id, name });
    if (windows.length >= MAX_WINDOWS) break;
  }
  return windows;
}

async function captureScreenshot(display, resolution) {
  const { width, height } = resolution.display;
  const { width: apiWidth, height: apiHeight } = resolution.api;
  const result = await runProgram(
    "ffmpeg",
    [
      "-loglevel",
      "error",
      "-nostdin",
      "-f",
      "x11grab",
      "-video_size",
      `${width}x${height}`,
      "-i",
      display,
      "-frames:v",
      "1",
      "-vf",
      `scale=${apiWidth}:${apiHeight}`,
      "-f",
      "image2pipe",
      "-vcodec",
      "png",
      "pipe:1",
    ],
    {
      env: commandEnvironment(display),
      timeoutMs: 10_000,
      maxStdoutBytes: MAX_SCREENSHOT_BYTES,
    }
  );
  return { mimeType: "image/png", data: result.stdout.toString("base64") };
}

function keyForXdotool(value) {
  return String(value ?? "")
    .split("+")
    .map((part) => (part === "meta" ? "super" : part))
    .join("+");
}

function isAscii(text) {
  for (const char of text) if ((char.codePointAt(0) ?? 0) > 0x7f) return false;
  return true;
}

function unmappedCharacters(text) {
  return [...new Set([...text].filter((char) => !isAscii(char)))];
}

function unicodeKeysym(char) {
  return `U${(char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`;
}

function runThatFits(text, capacity) {
  const needed = new Set();
  let length = 0;
  for (const char of text) {
    if (!isAscii(char) && !needed.has(char)) {
      if (needed.size === capacity) break;
      needed.add(char);
    }
    length += char.length;
  }
  return text.slice(0, length);
}

async function spareKeycodes(display) {
  const output = await runText("xmodmap", ["-pke"], {
    env: commandEnvironment(display),
    timeoutMs: 5000,
    maxStdoutBytes: 1024 * 1024,
  });
  return output
    .split("\n")
    .map((line) => /^keycode\s+(\d+)\s*=\s*$/.exec(line.trim()))
    .filter(Boolean)
    .map((match) => Number(match[1]));
}

async function changeKeymap(display, entries) {
  await runProgram("xmodmap", ["-"], {
    env: commandEnvironment(display),
    input: `${entries.join("\n")}\n`,
    timeoutMs: 5000,
    maxStdoutBytes: 64 * 1024,
  });
}

async function sendKeystrokes(display, text, { clearModifiers = false, byCodePoint = false } = {}) {
  const units = byCodePoint ? [...text] : text.split("");
  for (let i = 0; i < units.length; i += DEFAULT_TYPING_BATCH_SIZE) {
    const batch = units.slice(i, i + DEFAULT_TYPING_BATCH_SIZE).join("");
    if (!batch) continue;
    await runProgram(
      "xdotool",
      ["type", ...(clearModifiers ? ["--clearmodifiers"] : []), "--delay", String(DEFAULT_TYPING_DELAY_MS), "--", batch],
      { env: commandEnvironment(display), timeoutMs: 15_000, maxStdoutBytes: 64 * 1024 }
    );
  }
}

async function typeWithBorrowedKeys(display, text) {
  let remaining = text;
  while (remaining !== "") {
    const spare = await spareKeycodes(display);
    if (spare.length === 0) {
      throw new Error(`Cannot type ${JSON.stringify(unmappedCharacters(remaining).join(""))}: X keymap has no spare keycodes.`);
    }
    const run = runThatFits(remaining, spare.length);
    remaining = remaining.slice(run.length);
    const bindings = unmappedCharacters(run).map((char, index) => [spare[index], unicodeKeysym(char)]);
    try {
      await changeKeymap(display, bindings.map(([keycode, keysym]) => `keycode ${keycode} = ${keysym} ${keysym}`));
      await sleep(KEYMAP_SETTLE_MS);
      await sendKeystrokes(display, run, { clearModifiers: true, byCodePoint: true });
      await sleep(KEYMAP_SETTLE_MS);
    } finally {
      await changeKeymap(display, bindings.map(([keycode]) => `keycode ${keycode} =`)).catch(() => {});
    }
  }
}

async function typeText(display, text) {
  const lines = String(text).split(/\r\n|\r|\n/);
  for (const [index, line] of lines.entries()) {
    if (index > 0) {
      await runProgram("xdotool", ["key", "Return"], { env: commandEnvironment(display), timeoutMs: 5000 });
    }
    if (!line) continue;
    if (isAscii(line)) await sendKeystrokes(display, line);
    else await typeWithBorrowedKeys(display, line);
  }
}

function dragPath(action) {
  if (Array.isArray(action.path) && action.path.length >= 2) return action.path;
  if ([action.x, action.y, action.x2, action.y2].every((value) => Number.isFinite(value))) {
    return [
      { x: action.x, y: action.y },
      { x: action.x2, y: action.y2 },
    ];
  }
  throw new Error("Drag requires x, y, x2, y2 or path with at least two points.");
}

function actionRequiresSettle(action) {
  if (["move", "click", "drag", "key", "scroll"].includes(action.action)) return true;
  return action.action === "type" && /[\r\n]/.test(action.text ?? "");
}

async function executeAction(display, resolution, action) {
  const env = commandEnvironment(display);
  const button = BUTTONS[action.button ?? "left"] ?? BUTTONS.left;

  switch (action.action) {
    case "screenshot":
      return;
    case "move": {
      if (action.x === undefined || action.y === undefined) throw new Error("Move requires x and y.");
      const point = apiToDisplay({ x: action.x, y: action.y }, resolution);
      await runProgram("xdotool", ["mousemove", "--sync", String(point.x), String(point.y)], { env, timeoutMs: 5000 });
      return;
    }
    case "click": {
      if ((action.x === undefined) !== (action.y === undefined)) throw new Error("Click x and y must be supplied together.");
      if (action.x !== undefined && action.y !== undefined) {
        const point = apiToDisplay({ x: action.x, y: action.y }, resolution);
        await runProgram("xdotool", ["mousemove", "--sync", String(point.x), String(point.y)], { env, timeoutMs: 5000 });
      }
      const count = action.count ?? 1;
      const args = ["click", ...(count > 1 ? ["--repeat", String(count), "--delay", "50"] : []), button];
      await runProgram("xdotool", args, { env, timeoutMs: 5000 });
      return;
    }
    case "drag": {
      const path = dragPath(action).map((point) => apiToDisplay(point, resolution));
      await runProgram("xdotool", ["mousemove", "--sync", String(path[0].x), String(path[0].y)], { env, timeoutMs: 5000 });
      await runProgram("xdotool", ["mousedown", button], { env, timeoutMs: 5000 });
      try {
        for (const point of path.slice(1)) {
          await runProgram("xdotool", ["mousemove", "--sync", String(point.x), String(point.y)], { env, timeoutMs: 5000 });
        }
      } finally {
        await runProgram("xdotool", ["mouseup", button], { env, timeoutMs: 5000 }).catch(() => {});
      }
      return;
    }
    case "type": {
      if (action.text === undefined) throw new Error("Type requires text.");
      await typeText(display, action.text);
      return;
    }
    case "key": {
      const key = keyForXdotool(action.key);
      if (!key) throw new Error("Key requires key.");
      await runProgram("xdotool", ["key", "--", key], { env, timeoutMs: 5000 });
      return;
    }
    case "scroll": {
      if ((action.x === undefined) !== (action.y === undefined)) throw new Error("Scroll x and y must be supplied together.");
      if (action.x !== undefined && action.y !== undefined) {
        const point = apiToDisplay({ x: action.x, y: action.y }, resolution);
        await runProgram("xdotool", ["mousemove", "--sync", String(point.x), String(point.y)], { env, timeoutMs: 5000 });
      }
      const direction = action.direction ?? "down";
      const amount = action.amount ?? 3;
      await runProgram("xdotool", ["click", "--repeat", String(amount), SCROLL_BUTTONS[direction]], { env, timeoutMs: 5000 });
      return;
    }
    case "wait":
      await sleep(action.durationMs ?? 1000);
      return;
    default:
      throw new Error(`Unsupported computer action: ${action.action}`);
  }
}

function summarizeAction(action) {
  switch (action.action) {
    case "type":
      return `type(${String(action.text ?? "").length} chars)`;
    case "click":
      return `click(${action.x ?? "cursor"},${action.y ?? "cursor"},${action.button ?? "left"},x${action.count ?? 1})`;
    case "move":
      return `move(${action.x ?? "?"},${action.y ?? "?"})`;
    case "drag":
      return `drag(${action.path?.length ?? 2} points)`;
    case "scroll":
      return `scroll(${action.direction ?? "down"},${action.amount ?? 3})`;
    case "key":
      return `key(${action.key ?? ""})`;
    case "wait":
      return `wait(${action.durationMs ?? 1000}ms)`;
    default:
      return action.action;
  }
}

function cleanupElementSnapshots() {
  const now = Date.now();
  for (const [id, snapshot] of ELEMENT_SNAPSHOTS.entries()) {
    if (snapshot.expiresAt <= now) ELEMENT_SNAPSHOTS.delete(id);
  }
  while (ELEMENT_SNAPSHOTS.size >= MAX_ELEMENT_SNAPSHOTS) {
    const oldest = ELEMENT_SNAPSHOTS.keys().next().value;
    if (!oldest) break;
    ELEMENT_SNAPSHOTS.delete(oldest);
  }
}

function storeElementSnapshot(result, options) {
  cleanupElementSnapshots();
  const snapshotId = randomBytes(18).toString("base64url");
  const createdAt = Date.now();
  const privateElements = (result.elements ?? []).map((element) => ({ ...element }));
  ELEMENT_SNAPSHOTS.set(snapshotId, { createdAt, expiresAt: createdAt + ELEMENT_SNAPSHOT_TTL_MS, elements: privateElements, options });
  const elements = privateElements.map((element, index) => ({
    index,
    source: String(element.source ?? result.source ?? "unknown"),
    role: String(element.role ?? ""),
    name: String(element.name ?? ""),
    value: String(element.value ?? ""),
    description: String(element.description ?? ""),
    enabled: element.enabled !== false,
    focused: Boolean(element.focused),
    selected: Boolean(element.selected),
    checked: typeof element.checked === "boolean" ? element.checked : null,
    expanded: typeof element.expanded === "boolean" ? element.expanded : null,
    bounds: element.bounds && [element.bounds.x, element.bounds.y, element.bounds.width, element.bounds.height].every(Number.isFinite)
      ? { x: Math.trunc(element.bounds.x), y: Math.trunc(element.bounds.y), width: Math.max(0, Math.trunc(element.bounds.width)), height: Math.max(0, Math.trunc(element.bounds.height)) }
      : null,
    actions: Array.isArray(element.actions) ? element.actions.map(String) : [],
  }));
  return { snapshotId, expiresInMs: ELEMENT_SNAPSHOT_TTL_MS, elements };
}

function getSnapshotElement(snapshotId, elementIndex) {
  cleanupElementSnapshots();
  const snapshot = ELEMENT_SNAPSHOTS.get(snapshotId);
  if (!snapshot) throw new Error("Element snapshot is missing or expired. Call computer_elements again.");
  const element = snapshot.elements[elementIndex];
  if (!element) throw new Error(`Element index ${elementIndex} does not exist in snapshot ${snapshotId}.`);
  return { snapshot, element };
}

async function captureComputerAfterSemanticAction(display) {
  if (nativeComputerBackendSupported()) {
    const state = await nativeComputerState({ includeScreenshot: true, includeWindows: false });
    return { display: nativeComputerBackendName(), resolution: state.resolution, screenshot: state.screenshot, active: state.active };
  }
  const resolvedDisplay = await resolveDisplay(display);
  const resolution = await detectResolution(resolvedDisplay);
  const [screenshot, active] = await Promise.all([captureScreenshot(resolvedDisplay, resolution), activeWindow(resolvedDisplay)]);
  return { display: resolvedDisplay, resolution, screenshot, active };
}

async function collectState(display, resolution, includeScreenshot = true, includeWindows = true) {
  const [cursor, active, windows, screenshot] = await Promise.all([
    cursorPosition(display, resolution),
    activeWindow(display),
    includeWindows ? visibleWindows(display) : Promise.resolve([]),
    includeScreenshot ? captureScreenshot(display, resolution) : Promise.resolve(null),
  ]);
  return { cursor, active, windows, screenshot };
}

export function buildComputerToolDescriptors({ readSecuritySchemes, writeSecuritySchemes, toolMeta }) {
  return [
    {
      name: "computer_environment",
      title: "Computer environment",
      description: "Check which local computer-control backend is active and whether its display/native permissions are ready before UI automation.",
      inputSchema: {
        type: "object",
        properties: {
          display: { type: "string", maxLength: 64, description: "Optional Linux X11 display to probe." },
        },
        additionalProperties: false,
      },
      outputSchema: environmentJsonSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
      securitySchemes: readSecuritySchemes,
      _meta: toolMeta("Checking computer environment", "Computer environment ready", readSecuritySchemes),
    },
    {
      name: "computer_elements",
      title: "Computer elements",
      description: "Read the current semantic accessibility tree and return a short-lived indexed snapshot. Prefer this over screen coordinates when a named button, link, field, menu item, checkbox, tab, or other control is available.",
      inputSchema: {
        type: "object",
        properties: {
          source: { type: "string", enum: ["auto", "desktop", "browser"], default: "auto" },
          targetId: { type: "string", description: "Optional Chrome/Electron CDP target id returned by a prior call." },
          title: { type: "string", description: "Optional browser page title substring." },
          url: { type: "string", description: "Optional browser page URL substring." },
          application: { type: "string", description: "Optional native application name substring." },
          query: { type: "string", description: "Filter element name, description, or value." },
          role: { type: "string", description: "Filter by accessibility role." },
          maxElements: { type: "integer", minimum: 1, maximum: 500, default: 120 },
          includeStaticText: { type: "boolean", default: false },
        },
        additionalProperties: false,
      },
      outputSchema: elementsResultJsonSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: false },
      securitySchemes: readSecuritySchemes,
      _meta: toolMeta("Reading computer elements", "Computer elements ready", readSecuritySchemes),
    },
    {
      name: "computer_element_action",
      title: "Computer element action",
      description: "Operate one element from a recent computer_elements snapshot by index, then return a fresh screenshot. Element snapshots are short-lived; refresh after every UI-changing action.",
      inputSchema: {
        type: "object",
        properties: {
          snapshotId: { type: "string", minLength: 8 },
          elementIndex: { type: "integer", minimum: 0 },
          action: { type: "string", enum: ELEMENT_ACTIONS },
          value: { type: "string", maxLength: MAX_TEXT_CHARS, description: "Required only for set_value." },
          display: { type: "string", maxLength: 64, description: "Optional Linux X11 display used for the post-action screenshot." },
          description: { type: "string", maxLength: 500, description: "Concise purpose for the action; value text is not stored in audit history." },
        },
        required: ["snapshotId", "elementIndex", "action"],
        additionalProperties: false,
      },
      outputSchema: elementActionResultJsonSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true, idempotentHint: false },
      securitySchemes: writeSecuritySchemes,
      _meta: toolMeta("Operating computer element", "Computer element action finished", writeSecuritySchemes),
    },
    {
      name: "computer_state",
      title: "Computer state",
      description:
        "Inspect the local computer before acting. Returns display/API resolution, cursor, active/visible windows, and an inline screenshot. Uses X11 on Linux, CoreGraphics/Accessibility on macOS, and Windows desktop APIs on Windows. Coordinates for computer_use are always in the returned API screenshot space.",
      inputSchema: {
        type: "object",
        properties: {
          display: { type: "string", maxLength: 64, description: "Optional X11 display such as :3. Defaults to the connector process DISPLAY, then auto-discovers :0..:9." },
          includeScreenshot: { type: "boolean", default: true },
          includeWindows: { type: "boolean", default: true },
        },
        additionalProperties: false,
      },
      outputSchema: stateJsonSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
      securitySchemes: readSecuritySchemes,
      _meta: toolMeta("Inspecting computer", "Computer state ready", readSecuritySchemes),
    },
    {
      name: "computer_use",
      title: "Computer use",
      description:
        `Control the local computer using the Grok Bot computer-use model with a platform-native backend, 1280-wide normalized coordinates, and one final screenshot. Supports screenshot/click/move/drag/type/key/scroll/wait plus up to ${MAX_FOLLOW_UP_ACTIONS} known follow-up actions in then. A ${DEFAULT_SETTLE_MS}ms settle is applied before the final screenshot after click/move/drag/key/scroll. Use computer_state first and do not batch steps that depend on seeing an intermediate screen.`,
      inputSchema: {
        type: "object",
        properties: {
          display: { type: "string", maxLength: 64, description: "Optional X11 display such as :3. Defaults to the connector process DISPLAY." },
          description: { type: "string", maxLength: 500, description: "Optional concise purpose for the action; typed text is never copied into connector command history." },
          ...actionPropertiesJsonSchema(),
          then: {
            type: "array",
            minItems: 1,
            maxItems: MAX_FOLLOW_UP_ACTIONS,
            items: actionJsonSchema(),
            description: "Known follow-up actions to execute in the same call before the one final screenshot.",
          },
        },
        required: ["action"],
        additionalProperties: false,
      },
      outputSchema: useResultJsonSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true, idempotentHint: false },
      securitySchemes: writeSecuritySchemes,
      _meta: toolMeta("Controlling computer", "Computer action finished", writeSecuritySchemes),
    },
  ];
}

export function registerComputerUseTools(server, options) {
  const {
    hasReadScope,
    hasWriteScope,
    readAuthChallenge,
    writeAuthChallenge,
    toolAuthError,
    readSecuritySchemes,
    writeSecuritySchemes,
    toolMeta,
    audit,
  } = options;

  server.registerTool(
    "computer_environment",
    {
      title: "Computer environment",
      description: "Check the active platform backend and whether the local display/native permissions are ready.",
      inputSchema: { display: z.string().min(1).max(64).optional() },
      outputSchema: environmentShape,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
      securitySchemes: readSecuritySchemes,
      _meta: toolMeta("Checking computer environment", "Computer environment ready", readSecuritySchemes),
    },
    async ({ display }) => {
      if (!hasReadScope()) return toolAuthError(readAuthChallenge);
      try {
        if (nativeComputerBackendSupported()) {
          const report = await nativeComputerDoctor({ prompt: false });
          const structuredContent = {
            platform: process.platform,
            backend: nativeComputerBackendName(),
            ready: report.ok,
            display: nativeComputerBackendName(),
            displayResolution: report.displayResolution ?? null,
            apiResolution: report.displayResolution
              ? { width: API_WIDTH, height: Math.round(API_WIDTH / (report.displayResolution.width / report.displayResolution.height)) }
              : null,
            permissions: report.permissions ?? {},
            details: report.error ? [report.error] : [],
            message: report.ok ? `${nativeComputerBackendName()} is ready.` : `${nativeComputerBackendName()} is not ready: ${report.error ?? "unknown error"}`,
          };
          return { structuredContent, content: [{ type: "text", text: structuredContent.message }] };
        }
        const resolvedDisplay = await resolveDisplay(display);
        const resolution = await detectResolution(resolvedDisplay);
        const structuredContent = {
          platform: process.platform,
          backend: "linux-x11",
          ready: true,
          display: resolvedDisplay,
          displayResolution: resolution.display,
          apiResolution: resolution.api,
          permissions: {},
          details: ["xdpyinfo/xrandr reachable", "xdotool input and ffmpeg screenshot backend enabled"],
          message: `linux-x11 is ready on ${resolvedDisplay}.`,
        };
        return { structuredContent, content: [{ type: "text", text: structuredContent.message }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const structuredContent = {
          platform: process.platform,
          backend: nativeComputerBackendSupported() ? nativeComputerBackendName() : "linux-x11",
          ready: false,
          display: display ?? null,
          displayResolution: null,
          apiResolution: null,
          permissions: {},
          details: [message],
          message: `Computer environment is not ready: ${message}`,
        };
        return { isError: true, structuredContent, content: [{ type: "text", text: structuredContent.message }] };
      }
    }
  );

  server.registerTool(
    "computer_elements",
    {
      title: "Computer elements",
      description: "Read a semantic accessibility tree and return a short-lived indexed snapshot for reliable element-based interaction.",
      inputSchema: {
        source: z.enum(["auto", "desktop", "browser"]).default("auto").optional(),
        targetId: z.string().max(200).optional(),
        title: z.string().max(500).optional(),
        url: z.string().max(2000).optional(),
        application: z.string().max(500).optional(),
        query: z.string().max(1000).optional(),
        role: z.string().max(200).optional(),
        maxElements: z.number().int().min(1).max(500).default(120).optional(),
        includeStaticText: z.boolean().default(false).optional(),
      },
      outputSchema: elementsResultShape,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: false },
      securitySchemes: readSecuritySchemes,
      _meta: toolMeta("Reading computer elements", "Computer elements ready", readSecuritySchemes),
    },
    async (args) => {
      if (!hasReadScope()) return toolAuthError(readAuthChallenge);
      try {
        const options = { ...args };
        const result = await listSemanticElements(options);
        const snapshot = storeElementSnapshot(result, options);
        const structuredContent = {
          snapshotId: snapshot.snapshotId,
          expiresInMs: snapshot.expiresInMs,
          source: String(result.source ?? "unknown"),
          providers: Array.isArray(result.providers) ? result.providers.map(String) : [String(result.source ?? "unknown")],
          target: result.target ? {
            id: String(result.target.id ?? ""), title: String(result.target.title ?? ""),
            url: String(result.target.url ?? ""), endpoint: String(result.target.endpoint ?? ""),
          } : null,
          targets: (result.targets ?? []).map((target) => ({
            id: String(target.id ?? ""), title: String(target.title ?? ""),
            url: String(target.url ?? ""), endpoint: String(target.endpoint ?? ""),
          })),
          application: result.application == null ? null : String(result.application),
          applications: (result.applications ?? []).map((application, index) => ({
            index: Number.isInteger(application.index) ? application.index : index,
            name: String(application.name ?? ""),
          })),
          elements: snapshot.elements,
          warnings: (result.warnings ?? []).map(String),
          message: `${result.message} Snapshot ${snapshot.snapshotId} expires in ${Math.round(snapshot.expiresInMs / 1000)} seconds.`,
        };
        return { structuredContent, content: [{ type: "text", text: structuredContent.message }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { isError: true, content: [{ type: "text", text: `Computer elements failed: ${message}` }] };
      }
    }
  );

  server.registerTool(
    "computer_element_action",
    {
      title: "Computer element action",
      description: "Operate one element from a recent computer_elements snapshot by index and return the resulting screenshot.",
      inputSchema: {
        snapshotId: z.string().min(8),
        elementIndex: z.number().int().min(0),
        action: z.enum(ELEMENT_ACTIONS),
        value: z.string().max(MAX_TEXT_CHARS).optional(),
        display: z.string().min(1).max(64).optional(),
        description: z.string().max(500).optional(),
      },
      outputSchema: elementActionResultShape,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true, idempotentHint: false },
      securitySchemes: writeSecuritySchemes,
      _meta: toolMeta("Operating computer element", "Computer element action finished", writeSecuritySchemes),
    },
    async ({ snapshotId, elementIndex, action, value, display }) => {
      if (!hasWriteScope()) return toolAuthError(writeAuthChallenge);
      const started = Date.now();
      let source = "unknown";
      const auditValue = action === "set_value" ? `(${String(value ?? "").length} chars)` : "";
      try {
        const { element } = getSnapshotElement(snapshotId, elementIndex);
        source = String(element.source ?? "unknown");
        if (Array.isArray(element.actions) && !element.actions.includes(action)) {
          throw new Error(`Element ${elementIndex} does not advertise action ${action}. Available: ${element.actions.join(", ") || "none"}.`);
        }
        if (action === "set_value" && value === undefined) throw new Error("set_value requires value.");
        await semanticElementAction({ elementId: element.id, action, value: value ?? "" });
        ELEMENT_SNAPSHOTS.delete(snapshotId);
        if (DEFAULT_SETTLE_MS > 0) await sleep(DEFAULT_SETTLE_MS);
        const state = await captureComputerAfterSemanticAction(display);
        if (!state.screenshot) throw new Error("Post-action screenshot was not available.");
        const durationMs = Date.now() - started;
        const structuredContent = {
          snapshotId, elementIndex, source, action, durationMs, activeWindow: state.active ?? null,
          screenshotIncluded: true, screenshotMimeType: state.screenshot.mimeType,
          message: `Executed ${action} on ${source} element ${elementIndex}; refresh computer_elements before the next UI-dependent action.`,
        };
        await audit?.({
          command: `computer_element_action ${source}[${elementIndex}].${action}${auditValue}`,
          cwd: state.display, status: "completed", exitCode: 0, signal: null, durationMs,
          stdout: structuredContent.message, stderr: "", truncated: false,
        });
        return {
          structuredContent,
          content: [
            { type: "text", text: structuredContent.message },
            { type: "image", data: state.screenshot.data, mimeType: state.screenshot.mimeType },
          ],
        };
      } catch (error) {
        const durationMs = Date.now() - started;
        const message = error instanceof Error ? error.message : String(error);
        await audit?.({
          command: `computer_element_action ${source}[${elementIndex}].${action}${auditValue}`,
          cwd: display ?? "computer", status: "failed", exitCode: 1, signal: null, durationMs,
          stdout: "", stderr: message, truncated: false,
        }).catch(() => {});
        return { isError: true, content: [{ type: "text", text: `Computer element action failed: ${message}` }] };
      }
    }
  );

  server.registerTool(
    "computer_state",
    {
      title: "Computer state",
      description:
        "Inspect the local computer before acting. Returns display/API resolution, cursor, active/visible windows, and an inline screenshot.",
      inputSchema: {
        display: z.string().min(1).max(64).optional(),
        includeScreenshot: z.boolean().default(true).optional(),
        includeWindows: z.boolean().default(true).optional(),
      },
      outputSchema: stateShape,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
      securitySchemes: readSecuritySchemes,
      _meta: toolMeta("Inspecting computer", "Computer state ready", readSecuritySchemes),
    },
    async ({ display, includeScreenshot, includeWindows }) => {
      if (!hasReadScope()) return toolAuthError(readAuthChallenge);
      try {
        const native = nativeComputerBackendSupported();
        const resolvedDisplay = native ? nativeComputerBackendName() : await resolveDisplay(display);
        const resolution = native ? null : await detectResolution(resolvedDisplay);
        const state = native
          ? await nativeComputerState({ includeScreenshot: includeScreenshot !== false, includeWindows: includeWindows !== false })
          : await collectState(resolvedDisplay, resolution, includeScreenshot !== false, includeWindows !== false);
        const effectiveResolution = native ? state.resolution : resolution;
        const structuredContent = {
          display: resolvedDisplay,
          displayResolution: effectiveResolution.display,
          apiResolution: effectiveResolution.api,
          cursorPosition: state.cursor,
          activeWindow: state.active,
          windows: state.windows,
          screenshotIncluded: Boolean(state.screenshot),
          screenshotMimeType: state.screenshot?.mimeType ?? null,
          message: `Computer state captured from ${resolvedDisplay} at API resolution ${effectiveResolution.api.width}x${effectiveResolution.api.height}.`,
        };
        const content = [{ type: "text", text: structuredContent.message }];
        if (state.screenshot) content.push({ type: "image", data: state.screenshot.data, mimeType: state.screenshot.mimeType });
        return { structuredContent, content };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          isError: true,
          content: [{ type: "text", text: `Computer state failed: ${message}` }],
        };
      }
    }
  );

  server.registerTool(
    "computer_use",
    {
      title: "Computer use",
      description:
        `Control the local computer using Grok Bot-style actions and one final screenshot. Up to ${MAX_FOLLOW_UP_ACTIONS} follow-up actions may be batched in then.`,
      inputSchema: {
        display: z.string().min(1).max(64).optional(),
        description: z.string().max(500).optional(),
        ...actionSchema.shape,
        then: z.array(actionSchema).min(1).max(MAX_FOLLOW_UP_ACTIONS).optional(),
      },
      outputSchema: useResultShape,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true, idempotentHint: false },
      securitySchemes: writeSecuritySchemes,
      _meta: toolMeta("Controlling computer", "Computer action finished", writeSecuritySchemes),
    },
    async (rawArgs) => {
      if (!hasWriteScope()) return toolAuthError(writeAuthChallenge);
      const started = Date.now();
      let resolvedDisplay = rawArgs?.display ? String(rawArgs.display) : process.env.DISPLAY || "auto";
      const parsed = computerUseArgsSchema.safeParse(rawArgs);
      if (!parsed.success) {
        return {
          isError: true,
          content: [{ type: "text", text: `Computer input failed: ${parsed.error.issues.map((issue) => issue.message).join("; ")}` }],
        };
      }

      const { display, description: _description, then = [], ...primary } = parsed.data;
      const actions = [primary, ...then];
      const auditSummary = actions.map(summarizeAction).join(" -> ");

      try {
        const native = nativeComputerBackendSupported();
        let resolution;
        let screenshot;
        let cursor;
        let active;
        if (native) {
          resolvedDisplay = nativeComputerBackendName();
          const state = await nativeComputerUse(actions);
          resolution = state.resolution;
          screenshot = state.screenshot;
          cursor = state.cursor;
          active = state.active;
          if (!screenshot) throw new Error("Native computer backend did not return a screenshot.");
        } else {
          resolvedDisplay = await resolveDisplay(display);
          resolution = await detectResolution(resolvedDisplay);
          let settleNeeded = false;
          for (const action of actions) {
            await executeAction(resolvedDisplay, resolution, action);
            if (actionRequiresSettle(action)) settleNeeded = true;
          }
          if (settleNeeded && DEFAULT_SETTLE_MS > 0) await sleep(DEFAULT_SETTLE_MS);
          [screenshot, cursor, active] = await Promise.all([
            captureScreenshot(resolvedDisplay, resolution),
            cursorPosition(resolvedDisplay, resolution),
            activeWindow(resolvedDisplay),
          ]);
        }
        const durationMs = Date.now() - started;
        const structuredContent = {
          display: resolvedDisplay,
          displayResolution: resolution.display,
          apiResolution: resolution.api,
          actionCount: actions.length,
          durationMs,
          cursorPosition: cursor,
          activeWindow: active,
          screenshotIncluded: true,
          screenshotMimeType: screenshot.mimeType,
          message: `Executed ${actions.length} computer action${actions.length === 1 ? "" : "s"} on ${resolvedDisplay} and captured the resulting screen.`,
        };
        await audit?.({
          command: `computer_use ${auditSummary}`,
          cwd: `DISPLAY=${resolvedDisplay}`,
          status: "completed",
          exitCode: 0,
          signal: null,
          durationMs,
          stdout: structuredContent.message,
          stderr: "",
          truncated: false,
        });
        return {
          structuredContent,
          content: [
            { type: "text", text: structuredContent.message },
            { type: "image", data: screenshot.data, mimeType: screenshot.mimeType },
          ],
        };
      } catch (error) {
        const durationMs = Date.now() - started;
        const message = error instanceof Error ? error.message : String(error);
        await audit?.({
          command: `computer_use ${auditSummary}`,
          cwd: `DISPLAY=${resolvedDisplay}`,
          status: "failed",
          exitCode: 1,
          signal: null,
          durationMs,
          stdout: "",
          stderr: message,
          truncated: false,
        }).catch(() => {});
        return {
          isError: true,
          content: [{ type: "text", text: `Computer action failed: ${message}` }],
        };
      }
    }
  );
}

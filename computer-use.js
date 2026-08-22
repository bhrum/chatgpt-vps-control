import { spawn } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { z } from "zod";
import {
  nativeComputerBackendName,
  nativeComputerBackendSupported,
  nativeComputerDoctor,
  nativeComputerState,
  nativeComputerUse,
  nativeComputerWindowAction,
} from "./lib/native-computer-backend.js";
import { listSemanticApplications, listSemanticElements, semanticElementAction } from "./lib/semantic-computer.js";
import { browserSessionCua, browserSessionLocator, browserSessionSnapshot, browserSessionTabAction, browserSessionUtility, listBrowserSessions, navigateBrowserSession, startBrowserSession, stopBrowserSession } from "./lib/browser-session.js";
import { activateLinuxApplication } from "./lib/linux-accessibility.js";

const API_WIDTH = 1280;
const BROWSER_SESSION_ACTIONS = ["list", "start", "navigate", "new_tab", "activate_tab", "back", "forward", "reload", "screenshot", "retain_tab", "release_tab", "cleanup_tabs", "close_tab", "stop"];
const BROWSER_UTILITY_ACTIONS = ["export_html", "export_text", "export_pdf", "clipboard_read", "clipboard_write", "logs", "dialog_state", "dialog_accept", "dialog_dismiss", "downloads", "download_wait", "download_cancel"];
const BROWSER_LOCATOR_ACTIONS = ["inspect", "wait_for", "click", "double_click", "hover", "focus", "fill", "type", "check", "uncheck", "select_option", "set_files", "drag_to", "press_key", "scroll_into_view", "scroll", "get_attribute"];
const BROWSER_CUA_ACTIONS = ["screenshot", "click", "double_click", "move", "drag", "type", "key", "keypress", "scroll", "download_media", "wait"];
const COMPUTER_USE_BRIDGE_OPERATIONS = ["list_apps", "get_app_state", "click", "drag", "perform_secondary_action", "press_key", "scroll", "select_text", "set_value", "type_text"];
const WINDOW_ACTIONS = ["activate", "close", "minimize", "maximize", "restore", "move_resize"];
const DEFAULT_SETTLE_MS = clampNumber(Number(process.env.COMPUTER_SCREENSHOT_SETTLE_MS ?? 2000), 0, 5000, 2000);
const SEMANTIC_SETTLE_MIN_MS = clampNumber(Number(process.env.COMPUTER_SEMANTIC_SETTLE_MIN_MS ?? 800), 0, 3000, 800);
const SEMANTIC_SETTLE_MAX_MS = clampNumber(Number(process.env.COMPUTER_SEMANTIC_SETTLE_MAX_MS ?? 5000), 500, 10_000, 5000);
const SEMANTIC_SETTLE_POLL_MS = clampNumber(Number(process.env.COMPUTER_SEMANTIC_SETTLE_POLL_MS ?? 250), 100, 1000, 250);
const DEFAULT_TYPING_DELAY_MS = clampNumber(Number(process.env.COMPUTER_TYPING_DELAY_MS ?? 12), 0, 1000, 12);
const DEFAULT_TYPING_BATCH_SIZE = clampNumber(Number(process.env.COMPUTER_TYPING_BATCH_SIZE ?? 50), 1, 500, 50);
const KEYMAP_SETTLE_MS = 300;
const MAX_WAIT_MS = 30_000;
const MAX_FOLLOW_UP_ACTIONS = 9;
const MAX_TEXT_CHARS = 20_000;
const MAX_NATIVE_ACTION_CHARS = 200;
const MAX_WINDOWS = 30;
const MAX_STDERR_BYTES = 256 * 1024;
const MAX_SCREENSHOT_BYTES = 12 * 1024 * 1024;
const ELEMENT_SNAPSHOT_TTL_MS = 90_000;
const MAX_ELEMENT_SNAPSHOTS = 24;
const ELEMENT_ACTIONS = ["press", "click", "focus", "set_value", "select_text", "toggle", "increment", "decrement", "scroll_into_view", "scroll"];
const ELEMENT_SNAPSHOTS = new Map();
const APP_STATE_CACHE = new Map();
const COMPUTER_USE_BRIDGE_STATES = new Map();
const WINDOW_CLAIM_TTL_MS = 90_000;
const WINDOW_CLAIM_SECRET = randomBytes(32);
const WINDOW_CLAIMS = new Map();

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
  application: z.string().min(1).max(500).optional(),
  activateApplication: z.boolean().default(false).optional(),
  description: z.string().max(500).optional(),
  then: z.array(actionSchema).min(1).max(MAX_FOLLOW_UP_ACTIONS).optional(),
});

const browserLocatorSchema = z.object({
  ref: z.string().regex(/^@?\d+$/).optional(),
  snapshotId: z.string().min(8).max(128).optional(),
  css: z.string().max(2000).optional(),
  role: z.string().max(200).optional(),
  name: z.string().max(2000).optional(),
  text: z.string().max(5000).optional(),
  exact: z.boolean().default(false).optional(),
  nth: z.number().int().min(0).max(10_000).default(0).optional(),
}).refine((locator) => Boolean(locator.ref || locator.css || locator.role || locator.name || locator.text), "Locator requires ref, css, role, name, or text.")
  .refine((locator) => !locator.ref || Boolean(locator.snapshotId), "A ref locator requires snapshotId.");

const browserLocatorStepSchema = z.object({
  action: z.enum(BROWSER_LOCATOR_ACTIONS),
  locator: browserLocatorSchema,
  frames: z.array(browserLocatorSchema).max(8).optional(),
  target: browserLocatorSchema.optional(),
  value: z.string().max(200_000).optional(),
  values: z.array(z.string().max(20_000)).max(100).optional(),
  files: z.array(z.string().min(1).max(4000)).max(20).optional(),
  key: z.string().max(200).optional(),
  attribute: z.string().max(500).optional(),
  button: z.enum(["left", "right", "middle"]).default("left").optional(),
  count: z.number().int().min(1).max(3).default(1).optional(),
  direction: z.enum(["up", "down", "left", "right"]).default("down").optional(),
  pages: z.number().int().min(1).max(100).default(1).optional(),
  state: z.enum(["attached", "detached", "visible", "hidden", "enabled", "disabled"]).default("visible").optional(),
  timeoutMs: z.number().int().min(0).max(30_000).default(5000).optional(),
  limit: z.number().int().min(1).max(500).default(100).optional(),
});

const stateShape = {
  display: z.string(),
  displayResolution: z.object({ width: z.number().int(), height: z.number().int() }),
  apiResolution: z.object({ width: z.number().int(), height: z.number().int() }),
  cursorPosition: z.object({ x: z.number().int(), y: z.number().int() }).nullable(),
  activeWindow: z.object({ id: z.string(), name: z.string() }).nullable(),
  windows: z.array(z.object({ id: z.string(), name: z.string(), claim: z.string() })),
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
  subrole: z.string(),
  identifier: z.string(),
  placeholder: z.string(),
  url: z.string(),
  depth: z.number().int(),
  enabled: z.boolean(),
  focused: z.boolean(),
  selected: z.boolean(),
  checked: z.boolean().nullable(),
  expanded: z.boolean().nullable(),
  bounds: elementBoundsShape.nullable(),
  actions: z.array(z.string()),
  nativeActions: z.array(z.string()),
});
const applicationShape = z.object({
  id: z.string(),
  displayName: z.string(),
  path: z.string(),
  isRunning: z.boolean(),
  pid: z.number().int().nullable(),
  lastUsedDate: z.string().nullable(),
  useCount: z.number().int().nullable(),
});
const applicationsResultShape = {
  applications: z.array(applicationShape),
  message: z.string(),
};
const appStateResultShape = {
  snapshotId: z.string(),
  expiresInMs: z.number().int(),
  application: z.string().nullable(),
  applicationId: z.string().nullable(),
  isDiff: z.boolean(),
  text: z.string(),
  screenshotIncluded: z.boolean(),
  screenshotMimeType: z.string().nullable(),
  screenshotScope: z.enum(["application", "desktop"]).nullable(),
  screenshotBounds: elementBoundsShape.nullable(),
  message: z.string(),
};
const computerUseBridgeResultShape = {
  operation: z.enum(COMPUTER_USE_BRIDGE_OPERATIONS),
  app: z.string().nullable(),
  applications: z.array(applicationShape),
  snapshotId: z.string().nullable(),
  expiresInMs: z.number().int().nullable(),
  elementIndex: z.number().int().nullable(),
  source: z.string().nullable(),
  isDiff: z.boolean().nullable(),
  text: z.string().nullable(),
  coordinateSpace: z.enum(["application_screenshot", "semantic_element", "none"]),
  screenshotIncluded: z.boolean(),
  screenshotMimeType: z.string().nullable(),
  screenshotScope: z.enum(["application", "desktop", "browser"]).nullable(),
  screenshotBounds: elementBoundsShape.nullable(),
  durationMs: z.number().int(),
  message: z.string(),
};
const browserTargetShape = z.object({
  id: z.string(), title: z.string(), url: z.string(), endpoint: z.string(),
});
const managedBrowserTargetShape = browserTargetShape.extend({ claim: z.string(), owner: z.enum(["user", "automation"]), retained: z.boolean() });
const browserSessionShape = z.object({
  name: z.string(), kind: z.enum(["managed", "attached", "extension"]), running: z.boolean(), endpoint: z.string().nullable(), pid: z.number().int().nullable(),
  targets: z.array(managedBrowserTargetShape),
});
const browserSessionResultShape = {
  action: z.string(),
  session: browserSessionShape.nullable(),
  sessions: z.array(browserSessionShape),
  target: managedBrowserTargetShape.nullable(),
  screenshotIncluded: z.boolean(),
  screenshotMimeType: z.string().nullable(),
  message: z.string(),
};

// Browser-session objects also carry private routing fields internally (for
// example extension instance ids and CDP websocket urls).  Never place those
// objects directly in MCP structuredContent: strict clients validate the
// advertised output schema and reject the whole result when an internal field
// leaks through.
function publicBrowserTarget(target) {
  if (!target) return null;
  return {
    id: String(target.id ?? ""),
    title: String(target.title ?? ""),
    url: String(target.url ?? ""),
    endpoint: String(target.endpoint ?? ""),
    claim: String(target.claim ?? ""),
    owner: target.owner === "automation" ? "automation" : "user",
    retained: target.retained === true,
  };
}

function publicBrowserSession(session) {
  if (!session) return null;
  return {
    name: String(session.name ?? ""),
    kind: session.kind,
    running: session.running === true,
    endpoint: session.endpoint == null ? null : String(session.endpoint),
    pid: Number.isInteger(session.pid) ? session.pid : null,
    targets: Array.isArray(session.targets) ? session.targets.map(publicBrowserTarget) : [],
  };
}
const browserLogShape = z.object({
  level: z.string(), text: z.string(), source: z.string(), timestamp: z.number(), url: z.string(), lineNumber: z.number().int().nullable(),
});
const browserDialogShape = z.object({ type: z.string(), message: z.string(), defaultPrompt: z.string(), url: z.string() });
const browserDownloadShape = z.object({
  guid: z.string(), url: z.string(), suggestedFilename: z.string(), state: z.string(),
  receivedBytes: z.number(), totalBytes: z.number().nullable(), path: z.string().nullable(), size: z.number().nullable(),
});
const browserDownloadFileShape = z.object({ name: z.string(), path: z.string(), size: z.number(), modifiedAt: z.string() });
const browserArtifactShape = z.object({ kind: z.enum(["pdf"]), name: z.string(), path: z.string(), size: z.number() });
const browserUtilityResultShape = {
  action: z.string(),
  session: browserSessionShape,
  target: managedBrowserTargetShape.nullable(),
  text: z.string().nullable(),
  logs: z.array(browserLogShape),
  dialog: browserDialogShape.nullable(),
  downloads: z.array(browserDownloadShape),
  files: z.array(browserDownloadFileShape),
  artifacts: z.array(browserArtifactShape),
  message: z.string(),
};
const browserLocatorElementShape = z.object({
  index: z.number().int(), tag: z.string(), role: z.string(), name: z.string(), text: z.string(), value: z.string(),
  checked: z.boolean().nullable(), disabled: z.boolean(), visible: z.boolean(), bounds: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }),
});
const browserLocatorStepResultShape = z.object({
  action: z.string(), matched: z.boolean(), value: z.string().nullable(),
  element: browserLocatorElementShape.nullable(), matches: z.array(browserLocatorElementShape),
});
const browserLocatorResultShape = {
  session: browserSessionShape,
  target: managedBrowserTargetShape.nullable(),
  results: z.array(browserLocatorStepResultShape),
  screenshotIncluded: z.boolean(),
  screenshotMimeType: z.string().nullable(),
  message: z.string(),
};
const browserSnapshotRefShape = z.object({ ref: z.string(), role: z.string(), name: z.string(), value: z.string() });
const browserSnapshotResultShape = {
  session: browserSessionShape,
  target: managedBrowserTargetShape.nullable(),
  snapshotId: z.string(),
  expiresInMs: z.number().int(),
  content: z.string(),
  refs: z.array(browserSnapshotRefShape),
  nodeCount: z.number().int(),
  truncated: z.boolean(),
  message: z.string(),
};
const browserCuaPointShape = z.object({
  x: z.number().min(0).max(100_000), y: z.number().min(0).max(100_000),
});
const browserCuaClipShape = z.object({
  x: z.number().min(0).max(100_000), y: z.number().min(0).max(100_000),
  width: z.number().positive().max(100_000), height: z.number().positive().max(100_000),
  scale: z.number().positive().max(4).default(1).optional(),
});
const browserCuaActionShape = z.object({
  action: z.enum(BROWSER_CUA_ACTIONS),
  x: z.number().min(0).max(100_000).optional(), y: z.number().min(0).max(100_000).optional(),
  fromX: z.number().min(0).max(100_000).optional(), fromY: z.number().min(0).max(100_000).optional(), toX: z.number().min(0).max(100_000).optional(), toY: z.number().min(0).max(100_000).optional(),
  path: z.array(browserCuaPointShape).min(2).max(100).optional(),
  text: z.string().max(200_000).optional(), key: z.string().max(200).optional(), keys: z.array(z.string().max(64)).max(12).optional(), keypress: z.array(z.string().max(64)).max(12).optional(),
  button: z.union([z.enum(["left", "right", "middle", "back", "forward"]), z.number().int().min(1).max(5)]).default("left").optional(),
  count: z.number().int().min(1).max(3).default(1).optional(),
  scrollX: z.number().min(-100_000).max(100_000).optional(), scrollY: z.number().min(-100_000).max(100_000).optional(),
  direction: z.enum(["up", "down", "left", "right"]).default("down").optional(), pages: z.number().int().min(1).max(100).default(1).optional(), steps: z.number().int().min(2).max(60).default(12).optional(),
  durationMs: z.number().int().min(0).max(30_000).default(100).optional(), timeoutMs: z.number().int().min(0).max(30_000).default(30_000).optional(),
  clip: browserCuaClipShape.optional(), fullPage: z.boolean().default(false).optional(),
});
const browserCuaResultShape = {
  session: browserSessionShape,
  target: managedBrowserTargetShape.nullable(),
  actionCount: z.number().int(),
  screenshotIncluded: z.boolean(),
  screenshotMimeType: z.string().nullable(),
  message: z.string(),
};
const elementsResultShape = {
  snapshotId: z.string(),
  expiresInMs: z.number().int(),
  source: z.string(),
  providers: z.array(z.string()),
  target: z.object({ id: z.string(), title: z.string(), url: z.string(), endpoint: z.string() }).nullable(),
  targets: z.array(z.object({ id: z.string(), title: z.string(), url: z.string(), endpoint: z.string() })),
  application: z.string().nullable(),
  applicationId: z.string().nullable(),
  applications: z.array(z.object({ index: z.number().int(), name: z.string() })),
  elements: z.array(elementShape),
  warnings: z.array(z.string()),
  message: z.string(),
};
const elementActionResultShape = {
  snapshotId: z.string(),
  nextSnapshotId: z.string().nullable(),
  nextExpiresInMs: z.number().int().nullable(),
  elementIndex: z.number().int(),
  source: z.string(),
  action: z.string(),
  durationMs: z.number().int(),
  activeWindow: z.object({ id: z.string(), name: z.string() }).nullable(),
  screenshotIncluded: z.boolean(),
  screenshotMimeType: z.string().nullable(),
  screenshotScope: z.enum(["application", "desktop", "browser"]).nullable(),
  screenshotBounds: elementBoundsShape.nullable(),
  stateIsDiff: z.boolean().nullable(),
  stateText: z.string().nullable(),
  settleDurationMs: z.number().int().nullable(),
  settleEventCount: z.number().int().nullable(),
  settleSource: z.string().nullable(),
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

const windowActionResultShape = {
  ...stateShape,
  action: z.enum(WINDOW_ACTIONS),
  windowId: z.string(),
  settleDurationMs: z.number().int().nullable(),
  settleEventCount: z.number().int().nullable(),
  settleSource: z.string().nullable(),
};

const stateJsonSchema = {
  type: "object",
  properties: {
    display: { type: "string" },
    displayResolution: resolutionJsonSchema(),
    apiResolution: resolutionJsonSchema(),
    cursorPosition: pointOrNullJsonSchema(),
    activeWindow: windowOrNullJsonSchema(),
    windows: { type: "array", items: claimedWindowJsonSchema() },
    screenshotIncluded: { type: "boolean" },
    screenshotMimeType: { type: ["string", "null"] },
    message: { type: "string" },
  },
  required: ["display", "displayResolution", "apiResolution", "cursorPosition", "activeWindow", "windows", "screenshotIncluded", "screenshotMimeType", "message"],
  additionalProperties: false,
};

const windowActionResultJsonSchema = {
  type: "object",
  properties: {
    ...stateJsonSchema.properties,
    action: { type: "string", enum: WINDOW_ACTIONS },
    windowId: { type: "string" },
    settleDurationMs: { type: ["integer", "null"] },
    settleEventCount: { type: ["integer", "null"] },
    settleSource: { type: ["string", "null"] },
  },
  required: [...stateJsonSchema.required, "action", "windowId", "settleDurationMs", "settleEventCount", "settleSource"],
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
    subrole: { type: "string" }, identifier: { type: "string" }, placeholder: { type: "string" }, url: { type: "string" },
    depth: { type: "integer" }, nativeActions: { type: "array", items: { type: "string" } },
    selected: { type: "boolean" }, checked: { type: ["boolean", "null"] }, expanded: { type: ["boolean", "null"] },
    bounds: { anyOf: [elementBoundsJsonSchema, { type: "null" }] }, actions: { type: "array", items: { type: "string" } },
  },
  required: ["index", "source", "role", "name", "value", "description", "subrole", "identifier", "placeholder", "url", "depth", "enabled", "focused", "selected", "checked", "expanded", "bounds", "actions", "nativeActions"],
  additionalProperties: false,
};
const applicationJsonSchema = {
  type: "object",
  properties: {
    id: { type: "string" }, displayName: { type: "string" }, path: { type: "string" },
    isRunning: { type: "boolean" }, pid: { type: ["integer", "null"] }, lastUsedDate: { type: ["string", "null"] }, useCount: { type: ["integer", "null"] },
  },
  required: ["id", "displayName", "path", "isRunning", "pid", "lastUsedDate", "useCount"],
  additionalProperties: false,
};
const applicationsResultJsonSchema = {
  type: "object",
  properties: { applications: { type: "array", items: applicationJsonSchema }, message: { type: "string" } },
  required: ["applications", "message"],
  additionalProperties: false,
};
const appStateResultJsonSchema = {
  type: "object",
  properties: {
    snapshotId: { type: "string" }, expiresInMs: { type: "integer" },
    application: { type: ["string", "null"] }, applicationId: { type: ["string", "null"] },
    isDiff: { type: "boolean" }, text: { type: "string" },
    screenshotIncluded: { type: "boolean" }, screenshotMimeType: { type: ["string", "null"] }, screenshotScope: { type: ["string", "null"], enum: ["application", "desktop", null] }, screenshotBounds: { anyOf: [elementBoundsJsonSchema, { type: "null" }] }, message: { type: "string" },
  },
  required: ["snapshotId", "expiresInMs", "application", "applicationId", "isDiff", "text", "screenshotIncluded", "screenshotMimeType", "screenshotScope", "screenshotBounds", "message"],
  additionalProperties: false,
};
const computerUseBridgeResultJsonSchema = {
  type: "object",
  properties: {
    operation: { type: "string", enum: COMPUTER_USE_BRIDGE_OPERATIONS },
    app: { type: ["string", "null"] },
    applications: { type: "array", items: applicationJsonSchema },
    snapshotId: { type: ["string", "null"] },
    expiresInMs: { type: ["integer", "null"] },
    elementIndex: { type: ["integer", "null"] },
    source: { type: ["string", "null"] },
    isDiff: { type: ["boolean", "null"] },
    text: { type: ["string", "null"] },
    coordinateSpace: { type: "string", enum: ["application_screenshot", "semantic_element", "none"] },
    screenshotIncluded: { type: "boolean" },
    screenshotMimeType: { type: ["string", "null"] },
    screenshotScope: { type: ["string", "null"], enum: ["application", "desktop", "browser", null] },
    screenshotBounds: { anyOf: [elementBoundsJsonSchema, { type: "null" }] },
    durationMs: { type: "integer" },
    message: { type: "string" },
  },
  required: ["operation", "app", "applications", "snapshotId", "expiresInMs", "elementIndex", "source", "isDiff", "text", "coordinateSpace", "screenshotIncluded", "screenshotMimeType", "screenshotScope", "screenshotBounds", "durationMs", "message"],
  additionalProperties: false,
};
const browserTargetJsonSchema = {
  type: "object",
  properties: { id: { type: "string" }, title: { type: "string" }, url: { type: "string" }, endpoint: { type: "string" }, claim: { type: "string" }, owner: { type: "string", enum: ["user", "automation"] }, retained: { type: "boolean" } },
  required: ["id", "title", "url", "endpoint", "claim", "owner", "retained"],
  additionalProperties: false,
};
const browserSessionJsonSchema = {
  type: "object",
  properties: {
    name: { type: "string" }, kind: { type: "string", enum: ["managed", "attached", "extension"] }, running: { type: "boolean" }, endpoint: { type: ["string", "null"] }, pid: { type: ["integer", "null"] },
    targets: { type: "array", items: browserTargetJsonSchema },
  },
  required: ["name", "kind", "running", "endpoint", "pid", "targets"],
  additionalProperties: false,
};
const browserSessionResultJsonSchema = {
  type: "object",
  properties: {
    action: { type: "string" },
    session: { anyOf: [browserSessionJsonSchema, { type: "null" }] },
    sessions: { type: "array", items: browserSessionJsonSchema },
    target: { anyOf: [browserTargetJsonSchema, { type: "null" }] },
    screenshotIncluded: { type: "boolean" },
    screenshotMimeType: { type: ["string", "null"] },
    message: { type: "string" },
  },
  required: ["action", "session", "sessions", "target", "screenshotIncluded", "screenshotMimeType", "message"],
  additionalProperties: false,
};
const browserLogJsonSchema = {
  type: "object",
  properties: {
    level: { type: "string" }, text: { type: "string" }, source: { type: "string" }, timestamp: { type: "number" },
    url: { type: "string" }, lineNumber: { type: ["integer", "null"] },
  },
  required: ["level", "text", "source", "timestamp", "url", "lineNumber"],
  additionalProperties: false,
};
const browserDialogJsonSchema = {
  type: "object",
  properties: { type: { type: "string" }, message: { type: "string" }, defaultPrompt: { type: "string" }, url: { type: "string" } },
  required: ["type", "message", "defaultPrompt", "url"],
  additionalProperties: false,
};
const browserDownloadJsonSchema = {
  type: "object",
  properties: {
    guid: { type: "string" }, url: { type: "string" }, suggestedFilename: { type: "string" }, state: { type: "string" },
    receivedBytes: { type: "number" }, totalBytes: { type: ["number", "null"] }, path: { type: ["string", "null"] }, size: { type: ["number", "null"] },
  },
  required: ["guid", "url", "suggestedFilename", "state", "receivedBytes", "totalBytes", "path", "size"],
  additionalProperties: false,
};
const browserDownloadFileJsonSchema = {
  type: "object",
  properties: { name: { type: "string" }, path: { type: "string" }, size: { type: "number" }, modifiedAt: { type: "string" } },
  required: ["name", "path", "size", "modifiedAt"],
  additionalProperties: false,
};
const browserArtifactJsonSchema = {
  type: "object",
  properties: { kind: { type: "string", enum: ["pdf"] }, name: { type: "string" }, path: { type: "string" }, size: { type: "number" } },
  required: ["kind", "name", "path", "size"],
  additionalProperties: false,
};
const browserUtilityResultJsonSchema = {
  type: "object",
  properties: {
    action: { type: "string" }, session: browserSessionJsonSchema,
    target: { anyOf: [browserTargetJsonSchema, { type: "null" }] }, text: { type: ["string", "null"] },
    logs: { type: "array", items: browserLogJsonSchema },
    dialog: { anyOf: [browserDialogJsonSchema, { type: "null" }] },
    downloads: { type: "array", items: browserDownloadJsonSchema },
    files: { type: "array", items: browserDownloadFileJsonSchema },
    artifacts: { type: "array", items: browserArtifactJsonSchema },
    message: { type: "string" },
  },
  required: ["action", "session", "target", "text", "logs", "dialog", "downloads", "files", "artifacts", "message"],
  additionalProperties: false,
};
const browserLocatorElementJsonSchema = {
  type: "object",
  properties: {
    index: { type: "integer" }, tag: { type: "string" }, role: { type: "string" }, name: { type: "string" },
    text: { type: "string" }, value: { type: "string" }, checked: { type: ["boolean", "null"] }, disabled: { type: "boolean" }, visible: { type: "boolean" },
    bounds: { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, width: { type: "number" }, height: { type: "number" } }, required: ["x", "y", "width", "height"], additionalProperties: false },
  },
  required: ["index", "tag", "role", "name", "text", "value", "checked", "disabled", "visible", "bounds"],
  additionalProperties: false,
};
const browserLocatorStepResultJsonSchema = {
  type: "object",
  properties: {
    action: { type: "string" }, matched: { type: "boolean" }, value: { type: ["string", "null"] },
    element: { anyOf: [browserLocatorElementJsonSchema, { type: "null" }] }, matches: { type: "array", items: browserLocatorElementJsonSchema },
  },
  required: ["action", "matched", "value", "element", "matches"],
  additionalProperties: false,
};
const browserLocatorResultJsonSchema = {
  type: "object",
  properties: {
    session: browserSessionJsonSchema, target: { anyOf: [browserTargetJsonSchema, { type: "null" }] },
    results: { type: "array", items: browserLocatorStepResultJsonSchema }, screenshotIncluded: { type: "boolean" },
    screenshotMimeType: { type: ["string", "null"] }, message: { type: "string" },
  },
  required: ["session", "target", "results", "screenshotIncluded", "screenshotMimeType", "message"],
  additionalProperties: false,
};
const browserSnapshotResultJsonSchema = {
  type: "object",
  properties: {
    session: browserSessionJsonSchema,
    target: { anyOf: [browserTargetJsonSchema, { type: "null" }] },
    snapshotId: { type: "string" }, expiresInMs: { type: "integer" }, content: { type: "string" },
    refs: { type: "array", items: { type: "object", properties: { ref: { type: "string" }, role: { type: "string" }, name: { type: "string" }, value: { type: "string" } }, required: ["ref", "role", "name", "value"], additionalProperties: false } },
    nodeCount: { type: "integer" }, truncated: { type: "boolean" }, message: { type: "string" },
  },
  required: ["session", "target", "snapshotId", "expiresInMs", "content", "refs", "nodeCount", "truncated", "message"],
  additionalProperties: false,
};
const browserCuaActionJsonSchema = {
  type: "object",
  properties: {
    action: { type: "string", enum: BROWSER_CUA_ACTIONS },
    x: { type: "number", minimum: 0, maximum: 100000 }, y: { type: "number", minimum: 0, maximum: 100000 },
    fromX: { type: "number", minimum: 0, maximum: 100000 }, fromY: { type: "number", minimum: 0, maximum: 100000 }, toX: { type: "number", minimum: 0, maximum: 100000 }, toY: { type: "number", minimum: 0, maximum: 100000 },
    path: { type: "array", minItems: 2, maxItems: 100, items: { type: "object", properties: { x: { type: "number", minimum: 0, maximum: 100000 }, y: { type: "number", minimum: 0, maximum: 100000 } }, required: ["x", "y"], additionalProperties: false } },
    text: { type: "string", maxLength: 200000 }, key: { type: "string", maxLength: 200 },
    keys: { type: "array", maxItems: 12, items: { type: "string", maxLength: 64 } }, keypress: { type: "array", maxItems: 12, items: { type: "string", maxLength: 64 } },
    button: { anyOf: [{ type: "string", enum: ["left", "right", "middle", "back", "forward"] }, { type: "integer", minimum: 1, maximum: 5 }], default: "left" }, count: { type: "integer", minimum: 1, maximum: 3, default: 1 },
    scrollX: { type: "number", minimum: -100000, maximum: 100000 }, scrollY: { type: "number", minimum: -100000, maximum: 100000 },
    direction: { type: "string", enum: ["up", "down", "left", "right"], default: "down" }, pages: { type: "integer", minimum: 1, maximum: 100, default: 1 }, steps: { type: "integer", minimum: 2, maximum: 60, default: 12 }, durationMs: { type: "integer", minimum: 0, maximum: 30000, default: 100 },
    timeoutMs: { type: "integer", minimum: 0, maximum: 30000, default: 30000 },
    clip: { type: "object", properties: { x: { type: "number", minimum: 0, maximum: 100000 }, y: { type: "number", minimum: 0, maximum: 100000 }, width: { type: "number", exclusiveMinimum: 0, maximum: 100000 }, height: { type: "number", exclusiveMinimum: 0, maximum: 100000 }, scale: { type: "number", exclusiveMinimum: 0, maximum: 4, default: 1 } }, required: ["x", "y", "width", "height"], additionalProperties: false },
    fullPage: { type: "boolean", default: false },
  },
  required: ["action"], additionalProperties: false,
};
const browserCuaResultJsonSchema = {
  type: "object",
  properties: { session: browserSessionJsonSchema, target: { anyOf: [browserTargetJsonSchema, { type: "null" }] }, actionCount: { type: "integer" }, screenshotIncluded: { type: "boolean" }, screenshotMimeType: { type: ["string", "null"] }, message: { type: "string" } },
  required: ["session", "target", "actionCount", "screenshotIncluded", "screenshotMimeType", "message"], additionalProperties: false,
};
const elementsResultJsonSchema = {
  type: "object",
  properties: {
    snapshotId: { type: "string" }, expiresInMs: { type: "integer" }, source: { type: "string" },
    providers: { type: "array", items: { type: "string" } },
    target: { anyOf: [{ type: "object", properties: { id: { type: "string" }, title: { type: "string" }, url: { type: "string" }, endpoint: { type: "string" } }, required: ["id", "title", "url", "endpoint"], additionalProperties: false }, { type: "null" }] },
    targets: { type: "array", items: { type: "object", properties: { id: { type: "string" }, title: { type: "string" }, url: { type: "string" }, endpoint: { type: "string" } }, required: ["id", "title", "url", "endpoint"], additionalProperties: false } },
    application: { type: ["string", "null"] },
    applicationId: { type: ["string", "null"] },
    applications: { type: "array", items: { type: "object", properties: { index: { type: "integer" }, name: { type: "string" } }, required: ["index", "name"], additionalProperties: false } },
    elements: { type: "array", items: elementJsonSchema }, warnings: { type: "array", items: { type: "string" } }, message: { type: "string" },
  },
  required: ["snapshotId", "expiresInMs", "source", "providers", "target", "targets", "application", "applicationId", "applications", "elements", "warnings", "message"],
  additionalProperties: false,
};
const elementActionResultJsonSchema = {
  type: "object",
  properties: {
    snapshotId: { type: "string" }, nextSnapshotId: { type: ["string", "null"] }, nextExpiresInMs: { type: ["integer", "null"] },
    elementIndex: { type: "integer" }, source: { type: "string" }, action: { type: "string" }, durationMs: { type: "integer" },
    activeWindow: windowOrNullJsonSchema(), screenshotIncluded: { type: "boolean" }, screenshotMimeType: { type: ["string", "null"] },
    screenshotScope: { type: ["string", "null"], enum: ["application", "desktop", "browser", null] }, screenshotBounds: { anyOf: [elementBoundsJsonSchema, { type: "null" }] },
    stateIsDiff: { type: ["boolean", "null"] }, stateText: { type: ["string", "null"] }, settleDurationMs: { type: ["integer", "null"] },
    settleEventCount: { type: ["integer", "null"] }, settleSource: { type: ["string", "null"] }, message: { type: "string" },
  },
  required: ["snapshotId", "nextSnapshotId", "nextExpiresInMs", "elementIndex", "source", "action", "durationMs", "activeWindow", "screenshotIncluded", "screenshotMimeType", "screenshotScope", "screenshotBounds", "stateIsDiff", "stateText", "settleDurationMs", "settleEventCount", "settleSource", "message"],
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

function claimedWindowJsonSchema() {
  return {
    type: "object",
    properties: { id: { type: "string" }, name: { type: "string" }, claim: { type: "string" } },
    required: ["id", "name", "claim"],
    additionalProperties: false,
  };
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

function parseLogindSessionState(output) {
  const values = new Map();
  for (const line of String(output ?? "").split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator > 0) values.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim().toLowerCase());
  }
  return {
    active: values.get("Active") === "yes",
    locked: values.get("LockedHint") === "yes",
  };
}

async function linuxInteractiveSessionState() {
  if (process.env.COMPUTER_MANAGED_X11 === "1") return { interactiveDesktop: true, screenLocked: false };
  const sessionId = String(process.env.XDG_SESSION_ID ?? "").trim();
  if (!sessionId) return { interactiveDesktop: true, screenLocked: false };
  const output = await runText("loginctl", ["show-session", sessionId, "--property=Active", "--property=LockedHint"], {
    timeoutMs: 3000,
    maxStdoutBytes: 16 * 1024,
  });
  const state = parseLogindSessionState(output);
  return { interactiveDesktop: state.active && !state.locked, screenLocked: state.locked };
}

async function assertLinuxInteractiveSession(actions) {
  const mutatesDesktop = actions.some((action) => !["screenshot", "wait"].includes(action.action));
  if (!mutatesDesktop) return;
  const state = await linuxInteractiveSessionState();
  if (!state.interactiveDesktop) {
    throw new Error("The Linux desktop session is locked or inactive; unlock the active session before sending computer input.");
  }
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

function validateWindowGeometry({ x, y, width, height }, apiResolution) {
  if (![x, y, width, height].every(Number.isInteger) || width <= 0 || height <= 0) {
    throw new Error("move_resize requires integer x, y, width, and height with positive size.");
  }
  if (x < 0 || y < 0 || x + width > apiResolution.width || y + height > apiResolution.height) {
    throw new Error(`Window geometry must fit inside API display ${apiResolution.width}x${apiResolution.height}.`);
  }
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

async function linuxWindowAction(display, resolution, { windowId, windowName, action, x, y, width, height }) {
  if (!/^\d{1,20}$/.test(String(windowId))) throw new Error("Invalid X11 window id; refresh computer_state.");
  const env = commandEnvironment(display);
  const id = String(windowId);
  const name = (await tryText("xdotool", ["getwindowname", id], { env, timeoutMs: 2000 })).trim();
  if (!name) throw new Error("The X11 window is stale or unavailable; refresh computer_state.");
  if (name !== windowName) throw new Error("The X11 window identity changed; refresh computer_state before acting.");
  const wmId = `0x${Number(id).toString(16)}`;
  if (action === "activate") {
    await runText("xdotool", ["windowactivate", "--sync", id], { env, timeoutMs: 5000 });
  } else if (action === "close") {
    await runText("xdotool", ["windowclose", id], { env, timeoutMs: 5000 });
  } else if (action === "minimize") {
    await runText("xdotool", ["windowminimize", id], { env, timeoutMs: 5000 });
  } else if (action === "maximize") {
    await runText("wmctrl", ["-i", "-r", wmId, "-b", "add,maximized_vert,maximized_horz"], { env, timeoutMs: 5000 });
  } else if (action === "restore") {
    await runText("wmctrl", ["-i", "-r", wmId, "-b", "remove,maximized_vert,maximized_horz,hidden"], { env, timeoutMs: 5000 });
    await runText("xdotool", ["windowmap", id, "windowactivate", "--sync", id], { env, timeoutMs: 5000 });
  } else if (action === "move_resize") {
    const position = apiToDisplay({ x, y }, resolution);
    const displayWidth = Math.max(1, Math.round((width / resolution.api.width) * resolution.display.width));
    const displayHeight = Math.max(1, Math.round((height / resolution.api.height) * resolution.display.height));
    await runText("wmctrl", ["-i", "-r", wmId, "-b", "remove,maximized_vert,maximized_horz"], { env, timeoutMs: 5000 });
    await runText("xdotool", ["windowmove", "--sync", id, String(position.x), String(position.y), "windowsize", "--sync", id, String(displayWidth), String(displayHeight)], { env, timeoutMs: 5000 });
  } else {
    throw new Error(`Unsupported X11 window action: ${action}`);
  }
  await sleep(250);
  return { ok: true, source: "linux-x11-window", action, windowId: id, settleDurationMs: 250, settleEventCount: 0, settleSource: "bounded-window-manager" };
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
    subrole: String(element.subrole ?? ""),
    identifier: String(element.identifier ?? ""),
    placeholder: String(element.placeholder ?? ""),
    url: String(element.url ?? ""),
    depth: Number.isInteger(element.depth) ? element.depth : 0,
    enabled: element.enabled !== false,
    focused: Boolean(element.focused),
    selected: Boolean(element.selected),
    checked: typeof element.checked === "boolean" ? element.checked : null,
    expanded: typeof element.expanded === "boolean" ? element.expanded : null,
    bounds: element.bounds && [element.bounds.x, element.bounds.y, element.bounds.width, element.bounds.height].every(Number.isFinite)
      ? { x: Math.trunc(element.bounds.x), y: Math.trunc(element.bounds.y), width: Math.max(0, Math.trunc(element.bounds.width)), height: Math.max(0, Math.trunc(element.bounds.height)) }
      : null,
    actions: Array.isArray(element.actions) ? element.actions.map(String) : [],
    nativeActions: Array.isArray(element.nativeActions) ? element.nativeActions.map(String) : [],
  }));
  return { snapshotId, expiresInMs: ELEMENT_SNAPSHOT_TTL_MS, elements };
}

function appStateIdentity(element) {
  const bounds = element.bounds ? `${element.bounds.x},${element.bounds.y},${element.bounds.width},${element.bounds.height}` : "";
  return [element.source, element.role, element.identifier || element.name, element.depth, bounds].join("|");
}

function appStateLine(element) {
  const indent = "  ".repeat(Math.max(0, Math.min(12, element.depth ?? 0)));
  const details = [];
  if (element.name) details.push(element.name);
  if (element.value) details.push(`Value: ${element.value}`);
  if (element.placeholder) details.push(`Placeholder: ${element.placeholder}`);
  if (element.url) details.push(`URL: ${element.url}`);
  if (element.focused) details.push("focused");
  if (element.selected) details.push("selected");
  if (!element.enabled) details.push("disabled");
  if (element.actions.length) details.push(`Actions: ${element.actions.join(",")}`);
  if (element.nativeActions.length) details.push(`Native: ${element.nativeActions.join(",")}`);
  return `${indent}${element.index} ${element.role}${details.length ? ` ${details.join(" | ")}` : ""}`;
}

export function pruneComputerUseBridgeElements(elements, { source = "", focusedWindowOnly = false } = {}) {
  if (String(source) !== "macos-ax" || focusedWindowOnly) return elements;
  let skippedSystemMenu = false;
  return elements.filter((element) => {
    const role = String(element.role ?? "");
    // The full macOS application AX root eagerly exposes every item from every
    // closed menu (including the system Apple menu and recent-document names).
    // Computer Use keeps the menu bar and its app-level headings, but does not
    // dump those inactive descendants into each state response.
    if (role === "AXMenu" || role === "AXMenuItem") return false;
    if (role === "AXMenuBarItem" && !skippedSystemMenu) {
      skippedSystemMenu = true;
      return false;
    }
    return true;
  });
}

function buildAppStateText({ application, applicationId, elements, disableDiff, filterKey = "" }) {
  const cacheKey = `${applicationId || application || "frontmost"}\0${filterKey}`;
  const current = new Map(elements.map((element) => [appStateIdentity(element), element]));
  const previous = APP_STATE_CACHE.get(cacheKey);
  APP_STATE_CACHE.set(cacheKey, current);
  while (APP_STATE_CACHE.size > 12) APP_STATE_CACHE.delete(APP_STATE_CACHE.keys().next().value);

  const heading = `Application: ${application || "unknown"}${applicationId ? ` (${applicationId})` : ""}`;
  if (disableDiff || !previous) return { isDiff: false, text: [heading, ...elements.map(appStateLine)].join("\n") };

  const added = [];
  const changed = [];
  const removed = [];
  for (const [identity, element] of current) {
    const old = previous.get(identity);
    if (!old) added.push(appStateLine(element));
    else if (JSON.stringify(old) !== JSON.stringify(element)) changed.push(appStateLine(element));
  }
  for (const [identity, element] of previous) {
    if (!current.has(identity)) removed.push(appStateLine(element));
  }
  const sections = [heading, "Accessibility changes since the previous state:"];
  if (added.length) sections.push("Added:", ...added);
  if (changed.length) sections.push("Changed:", ...changed);
  if (removed.length) sections.push("Removed (indexes are stale; do not act on them):", ...removed);
  if (!added.length && !changed.length && !removed.length) sections.push("No accessibility changes.");
  return { isDiff: true, text: sections.join("\n") };
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

function semanticStateFingerprint(result) {
  return JSON.stringify((result.elements ?? []).map((element) => [
    element.source, element.role, element.name, element.value, element.description,
    element.identifier, element.depth, element.enabled, element.focused,
    element.selected, element.checked, element.expanded, element.bounds,
  ]));
}

function semanticStateLooksBusy(result) {
  return (result.elements ?? []).some((element) => {
    const role = String(element.role ?? "").toLowerCase();
    const label = `${element.name ?? ""} ${element.description ?? ""} ${element.value ?? ""}`.toLowerCase();
    return role.includes("progress") || role.includes("busy") || /\b(loading|working|progress|please wait)\b/.test(label);
  });
}

async function refreshElementState(snapshot, { waitForSettle = true, elementSource = "" } = {}) {
  try {
    const started = Date.now();
    const nativeSource = ["macos-ax", "windows-uia", "linux-atspi"].includes(String(elementSource));
    const refreshOptions = { ...(snapshot.options ?? {}), ...(nativeSource ? { source: "desktop" } : {}), includeScreenshot: false };
    let result = await listSemanticElements(refreshOptions);
    if (waitForSettle) {
      let fingerprint = semanticStateFingerprint(result);
      let stableRounds = 0;
      while (Date.now() - started < SEMANTIC_SETTLE_MAX_MS) {
        const elapsed = Date.now() - started;
        if (elapsed >= SEMANTIC_SETTLE_MIN_MS && stableRounds >= 1 && !semanticStateLooksBusy(result)) break;
        await sleep(Math.min(SEMANTIC_SETTLE_POLL_MS, Math.max(1, SEMANTIC_SETTLE_MAX_MS - elapsed)));
        const next = await listSemanticElements(refreshOptions);
        const nextFingerprint = semanticStateFingerprint(next);
        stableRounds = nextFingerprint === fingerprint ? stableRounds + 1 : 0;
        fingerprint = nextFingerprint;
        result = next;
      }
    }
    if (nativeSource) {
      try { result = await listSemanticElements({ ...refreshOptions, includeScreenshot: true }); }
      catch {
        // Preserve the successful action and settled semantic state when capture permission is unavailable.
      }
    }
    if (snapshot.options?.bridgeMode) {
      result = {
        ...result,
        elements: pruneComputerUseBridgeElements(result.elements ?? [], {
          source: result.source ?? elementSource,
          focusedWindowOnly: snapshot.options?.focusedWindowOnly === true,
        }),
      };
    }
    const next = storeElementSnapshot(result, { ...(snapshot.options ?? {}), ...(nativeSource ? { source: "desktop" } : {}) });
    const application = result.application ?? result.target?.title ?? null;
    const applicationId = result.applicationId ?? (result.target?.id ? `browser:${result.target.id}` : null);
    const rendered = buildAppStateText({
      application,
      applicationId,
      elements: next.elements,
      disableDiff: false,
      filterKey: snapshot.options?.bridgeMode
        ? JSON.stringify({ bridgeMode: true, focusedWindowOnly: snapshot.options?.focusedWindowOnly === true })
        : "",
    });
    return {
      snapshot: next,
      rendered,
      screenshot: result.screenshot ?? null,
      application,
      applicationId,
      source: String(result.source ?? elementSource ?? "unknown"),
      settleDurationMs: Date.now() - started,
    };
  } catch {
    return null;
  }
}

function computerUseBridgeKey(app) {
  return String(app ?? "").trim().toLowerCase();
}

function rememberComputerUseBridgeState(app, snapshot, result) {
  const entry = {
    snapshotId: snapshot.snapshotId,
    expiresAt: Date.now() + snapshot.expiresInMs,
    screenshotBounds: result.screenshot?.scope === "application" ? result.screenshot?.bounds ?? null : null,
  };
  const keys = [app, result.applicationId, result.application].map(computerUseBridgeKey).filter(Boolean);
  for (const key of keys) {
    COMPUTER_USE_BRIDGE_STATES.delete(key);
    COMPUTER_USE_BRIDGE_STATES.set(key, entry);
  }
  const now = Date.now();
  for (const [key, value] of COMPUTER_USE_BRIDGE_STATES) {
    if (value.expiresAt <= now || !ELEMENT_SNAPSHOTS.has(value.snapshotId)) COMPUTER_USE_BRIDGE_STATES.delete(key);
  }
  while (COMPUTER_USE_BRIDGE_STATES.size > 24) COMPUTER_USE_BRIDGE_STATES.delete(COMPUTER_USE_BRIDGE_STATES.keys().next().value);
}

function currentComputerUseBridgeState(app, expectedSnapshotId = "") {
  cleanupElementSnapshots();
  const key = computerUseBridgeKey(app);
  const state = COMPUTER_USE_BRIDGE_STATES.get(key);
  if (!state || state.expiresAt <= Date.now() || !ELEMENT_SNAPSHOTS.has(state.snapshotId)) {
    COMPUTER_USE_BRIDGE_STATES.delete(key);
    throw new Error(`No fresh Computer Use bridge state exists for ${app}. Call computer_use_bridge with operation=get_app_state first.`);
  }
  if (expectedSnapshotId && state.snapshotId !== expectedSnapshotId) {
    throw new Error(`Computer Use bridge snapshot ${expectedSnapshotId} is stale for ${app}. Use the replacement snapshotId from the latest state.`);
  }
  return state;
}

function computerUseBridgeAlias(preferred, legacy, preferredName, legacyName) {
  if (preferred !== undefined && legacy !== undefined && preferred !== legacy) {
    throw new Error(`${preferredName} and ${legacyName} disagree; provide only one spelling.`);
  }
  return preferred ?? legacy;
}

async function readComputerUseBridgeState(app, disableDiff = false, focusedWindowOnly = false) {
  const options = {
    source: "desktop",
    application: app,
    maxElements: 500,
    maxDepth: 40,
    maxVisitedNodes: 20_000,
    focusedWindowOnly,
    includeStaticText: true,
    includeContainers: true,
    launchIfNeeded: true,
    activateApplication: false,
    includeScreenshot: true,
    bridgeMode: true,
  };
  const listed = await listSemanticElements(options);
  const result = {
    ...listed,
    elements: pruneComputerUseBridgeElements(listed.elements ?? [], {
      source: listed.source,
      focusedWindowOnly,
    }),
  };
  const snapshot = storeElementSnapshot(result, options);
  const application = result.application == null ? null : String(result.application);
  const applicationId = result.applicationId == null ? null : String(result.applicationId);
  const rendered = buildAppStateText({
    application,
    applicationId,
    elements: snapshot.elements,
    disableDiff: disableDiff === true,
    filterKey: JSON.stringify({ bridgeMode: true, focusedWindowOnly }),
  });
  let screenshot = result.screenshot ?? null;
  if (!screenshot) {
    try {
      const fallback = (await captureComputerAfterSemanticAction()).screenshot;
      screenshot = fallback ? { ...fallback, scope: "desktop", bounds: null } : null;
    }
    catch {}
  }
  const normalizedResult = { ...result, screenshot };
  rememberComputerUseBridgeState(app, snapshot, normalizedResult);
  return {
    snapshot,
    application: applicationId || application || String(app),
    source: String(result.source ?? nativeComputerBackendName()),
    rendered,
    screenshot,
  };
}

async function bridgeScreenshotPoints(app, snapshotId, points) {
  const state = currentComputerUseBridgeState(app, snapshotId);
  const bounds = state.screenshotBounds;
  if (!bounds || bounds.width <= 0 || bounds.height <= 0) {
    throw new Error(`Application-screenshot coordinates are unavailable for ${app}. Refresh get_app_state and use a semantic element index.`);
  }
  for (const { x, y } of points) {
    if (![x, y].every(Number.isFinite) || x < 0 || y < 0 || x >= bounds.width || y >= bounds.height) {
      throw new Error(`Coordinate (${x}, ${y}) is outside the ${bounds.width}x${bounds.height} application screenshot.`);
    }
  }
  if (process.platform === "darwin") {
    const scale = API_WIDTH / bounds.width;
    return points.map(({ x, y }) => ({ x: Math.round(x * scale), y: Math.round(y * scale) }));
  }

  // The macOS helper natively accepts app-local coordinates. Windows and X11
  // use a desktop-wide normalized input space, so translate the exact crop
  // origin returned with get_app_state before sending their raw action.
  let resolution;
  if (nativeComputerBackendSupported()) {
    resolution = (await nativeComputerState({ includeScreenshot: false, includeWindows: false })).resolution;
  } else {
    resolution = await detectResolution(await resolveDisplay());
  }
  return points.map(({ x, y }) => displayToApi({ x: bounds.x + x, y: bounds.y + y }, resolution));
}

async function performComputerUseBridgeElementAction({ app, snapshotId, elementIndex, action, value, text, prefix, suffix, selectionType, button, count, direction, pages, nativeAction }) {
  const bridgeState = currentComputerUseBridgeState(app, snapshotId);
  const { snapshot, element } = getSnapshotElement(bridgeState.snapshotId, elementIndex);
  const source = String(element.source ?? "unknown");
  const effectiveAction = nativeAction ? `native:${nativeAction}` : action;
  if (nativeAction) {
    const advertised = Array.isArray(element.nativeActions) ? element.nativeActions.map(String) : [];
    if (!advertised.includes(nativeAction)) throw new Error(`Element ${elementIndex} does not advertise native action ${nativeAction}.`);
  } else if (Array.isArray(element.actions) && !element.actions.includes(action)) {
    throw new Error(`Element ${elementIndex} does not advertise action ${action}. Available: ${element.actions.join(", ") || "none"}.`);
  }
  const actionResult = await semanticElementAction({
    elementId: element.id,
    action: effectiveAction,
    value: value ?? "",
    text: text ?? "",
    prefix: prefix ?? "",
    suffix: suffix ?? "",
    selectionType: selectionType ?? "text",
    button: button ?? "left",
    count: count ?? 1,
    direction: direction ?? "down",
    pages: pages ?? 1,
  });
  ELEMENT_SNAPSHOTS.delete(bridgeState.snapshotId);
  const eventSettled = ["ax-observer", "uia-events", "atspi-events", "macos-ax-service", "windows-uia-service", "linux-atspi-service"].includes(String(actionResult?.settleSource ?? ""));
  const refreshed = await refreshElementState(snapshot, { waitForSettle: !eventSettled, elementSource: source });
  if (refreshed) {
    const result = {
      application: refreshed.application ?? snapshot.options?.application ?? app,
      applicationId: refreshed.applicationId ?? snapshot.options?.application ?? app,
      screenshot: refreshed.screenshot,
    };
    rememberComputerUseBridgeState(app, refreshed.snapshot, result);
    return {
      snapshot: refreshed.snapshot,
      application: String(app),
      source: refreshed.source || source,
      rendered: refreshed.rendered,
      screenshot: refreshed.screenshot ?? actionResult?.screenshot ?? null,
    };
  }
  return readComputerUseBridgeState(app, false, snapshot.options?.focusedWindowOnly === true);
}

async function performComputerUseBridgeRawAction(app, snapshotId, action) {
  const bridgeState = currentComputerUseBridgeState(app, snapshotId);
  const snapshot = ELEMENT_SNAPSHOTS.get(bridgeState.snapshotId);
  const focusedWindowOnly = snapshot?.options?.focusedWindowOnly === true;
  let actionScreenshot = null;
  if (nativeComputerBackendSupported()) {
    const state = await nativeComputerUse([action], {
      application: app,
      activateApplication: process.platform !== "darwin",
    });
    actionScreenshot = state.screenshot;
  } else {
    const display = await resolveDisplay();
    const resolution = await detectResolution(display);
    await assertLinuxInteractiveSession([action]);
    await activateLinuxApplication(app);
    await executeAction(display, resolution, action);
    if (actionRequiresSettle(action) && DEFAULT_SETTLE_MS > 0) await sleep(DEFAULT_SETTLE_MS);
    actionScreenshot = await captureScreenshot(display, resolution);
  }
  // The observed state is consumed by every write. A caller must use the
  // replacement state returned below before attempting another indexed action.
  ELEMENT_SNAPSHOTS.delete(bridgeState.snapshotId);
  try {
    return await readComputerUseBridgeState(app, false, focusedWindowOnly);
  } catch {
    return {
      snapshot: null,
      application: String(app),
      source: nativeComputerBackendSupported() ? nativeComputerBackendName() : "linux-x11",
      rendered: null,
      screenshot: actionScreenshot,
    };
  }
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

function claimedWindows(scope, windows) {
  const now = Date.now();
  for (const [claim, entry] of WINDOW_CLAIMS) if (entry.expiresAt <= now) WINDOW_CLAIMS.delete(claim);
  const result = (windows ?? []).map((window) => {
    const id = String(window.id ?? "");
    const name = String(window.name ?? "");
    const claim = createHmac("sha256", WINDOW_CLAIM_SECRET).update(String(scope)).update("\0").update(id).update("\0").update(name).digest("base64url");
    WINDOW_CLAIMS.set(claim, { scope: String(scope), id, name, expiresAt: now + WINDOW_CLAIM_TTL_MS });
    return { id, name, claim };
  });
  while (WINDOW_CLAIMS.size > 200) WINDOW_CLAIMS.delete(WINDOW_CLAIMS.keys().next().value);
  return result;
}

function resolveWindowClaim(scope, windowId, claim) {
  const entry = WINDOW_CLAIMS.get(String(claim));
  if (!entry || entry.expiresAt <= Date.now() || entry.scope !== String(scope) || entry.id !== String(windowId)) {
    throw new Error("Window claim is missing, stale, or belongs to another desktop. Refresh computer_state.");
  }
  return entry;
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
      name: "computer_applications",
      title: "Computer applications",
      description: "List installed and running desktop applications with stable platform identifiers, running state, and evidence-backed recent-use metadata when the operating system exposes it. Use this before targeting a specific app.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      outputSchema: applicationsResultJsonSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
      securitySchemes: readSecuritySchemes,
      _meta: toolMeta("Listing computer applications", "Computer applications ready", readSecuritySchemes),
    },
    {
      name: "computer_app_state",
      title: "Computer application state",
      description: "Ensure one application is running, without taking foreground focus by default, then read its rich accessibility tree by stable app id. Later calls return a compact diff.",
      inputSchema: {
        type: "object",
        properties: {
          app: { type: "string", minLength: 1, maxLength: 500 },
          disableDiff: { type: "boolean", default: false },
          maxElements: { type: "integer", minimum: 1, maximum: 500, default: 240 },
          query: { type: "string", maxLength: 1000, description: "Optional native accessibility text filter for large browser-internal pages and system dialogs." },
          role: { type: "string", maxLength: 200 },
          maxDepth: { type: "integer", minimum: 1, maximum: 40, default: 16 },
          maxVisitedNodes: { type: "integer", minimum: 1, maximum: 20000, default: 3000 },
          focusedWindowOnly: { type: "boolean", default: true, description: "Read only the focused app window, including native file choosers." },
          activate: { type: "boolean", default: false, description: "Explicitly bring the application to the foreground. Leave false for background inspection." },
        },
        required: ["app"],
        additionalProperties: false,
      },
      outputSchema: appStateResultJsonSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true, idempotentHint: false },
      securitySchemes: writeSecuritySchemes,
      _meta: toolMeta("Opening and reading application state", "Application state ready", writeSecuritySchemes),
    },
    {
      name: "computer_browser_session",
      title: "Browser session",
      description: "Manage a dedicated Chrome/Chromium profile with loopback-only DevTools isolated from ordinary browser windows, an explicitly attached loopback CDP browser, or user-shared signed-in tabs connected through the optional browser extension. Exact claims and user/automation ownership protect every tab; automation tabs can be retained for handoff or batch-cleaned without closing user tabs. Attached and extension browsers can never be stopped by this tool.",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: BROWSER_SESSION_ACTIONS },
          session: { type: "string", minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$" },
          url: { type: "string", maxLength: 4000 },
          targetId: { type: "string", maxLength: 200 },
          targetClaim: { type: "string", maxLength: 200, description: "Current claim returned with the target; required for every existing-tab action." },
          headless: { type: "boolean", default: false },
        },
        required: ["action"],
        additionalProperties: false,
      },
      outputSchema: browserSessionResultJsonSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true, idempotentHint: false },
      securitySchemes: writeSecuritySchemes,
      _meta: toolMeta("Managing browser session", "Browser session ready", writeSecuritySchemes),
    },
    {
      name: "computer_browser_utility",
      title: "Browser utilities",
      description: "Use an exact claimed tab in a managed, attached, or extension-connected browser session for live DOM/text/PDF export, clipboard access (which may activate the claimed tab when browser focus is required), buffered developer logs, JavaScript dialogs, and supported download tracking.",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: BROWSER_UTILITY_ACTIONS },
          session: { type: "string", minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$" },
          targetId: { type: "string", maxLength: 200, description: "Required for tab-scoped actions; must belong to the selected managed session." },
          targetClaim: { type: "string", maxLength: 200, description: "Current claim returned with the target; required for tab-scoped actions." },
          text: { type: "string", maxLength: 2_000_000, description: "Clipboard text for clipboard_write. Its contents are not echoed in the result." },
          promptText: { type: "string", maxLength: 20_000, description: "Optional prompt response for dialog_accept." },
          clear: { type: "boolean", default: false, description: "Clear buffered developer logs after returning them." },
          limit: { type: "integer", minimum: 1, maximum: 500, default: 100 },
          downloadGuid: { type: "string", maxLength: 500 },
          timeoutMs: { type: "integer", minimum: 0, maximum: 30_000, default: 30_000 },
          filename: { type: "string", maxLength: 200 },
          pdfOptions: {
            type: "object",
            properties: {
              landscape: { type: "boolean", default: false }, printBackground: { type: "boolean", default: true }, preferCSSPageSize: { type: "boolean", default: false },
              scale: { type: "number", minimum: 0.1, maximum: 2, default: 1 }, paperWidth: { type: "number", minimum: 1, maximum: 100, default: 8.27 }, paperHeight: { type: "number", minimum: 1, maximum: 100, default: 11.69 },
              marginTop: { type: "number", minimum: 0, maximum: 10, default: 0 }, marginBottom: { type: "number", minimum: 0, maximum: 10, default: 0 }, marginLeft: { type: "number", minimum: 0, maximum: 10, default: 0 }, marginRight: { type: "number", minimum: 0, maximum: 10, default: 0 },
            },
            additionalProperties: false,
          },
        },
        required: ["action", "session"],
        additionalProperties: false,
      },
      outputSchema: browserUtilityResultJsonSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true, idempotentHint: false },
      securitySchemes: writeSecuritySchemes,
      _meta: toolMeta("Using managed browser utility", "Managed browser utility finished", writeSecuritySchemes),
    },
    {
      name: "computer_browser_snapshot",
      title: "Browser semantic snapshot",
      description: "Return a compact accessibility snapshot for one exact claimed browser tab. Actionable nodes receive short-lived @refs that can be used with computer_browser_locator together with the returned snapshotId.",
      inputSchema: {
        type: "object",
        properties: {
          session: { type: "string", minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$" },
          targetId: { type: "string", minLength: 1, maxLength: 200 },
          targetClaim: { type: "string", minLength: 1, maxLength: 200 },
          maxNodes: { type: "integer", minimum: 1, maximum: 1000, default: 500 },
          includeText: { type: "boolean", default: true },
        },
        required: ["session", "targetId", "targetClaim"],
        additionalProperties: false,
      },
      outputSchema: browserSnapshotResultJsonSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: false },
      securitySchemes: readSecuritySchemes,
      _meta: toolMeta("Reading browser semantic snapshot", "Browser semantic snapshot ready", readSecuritySchemes),
    },
    {
      name: "computer_browser_locator",
      title: "Browser locator",
      description: "Run one to twenty declarative visible-DOM locator steps against an exact claimed target. Locators use a short-lived snapshot @ref, CSS, role, accessible name, or text; arbitrary JavaScript evaluation is not exposed.",
      inputSchema: {
        type: "object",
        properties: {
          session: { type: "string", minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$" },
          targetId: { type: "string", minLength: 1, maxLength: 200 },
          targetClaim: { type: "string", minLength: 1, maxLength: 200 },
          steps: {
            type: "array", minItems: 1, maxItems: 20,
            items: {
              type: "object",
              properties: {
                action: { type: "string", enum: BROWSER_LOCATOR_ACTIONS },
                locator: {
                  type: "object",
                  properties: {
                    ref: { type: "string", pattern: "^@?[0-9]+$", description: "Short-lived ref returned by computer_browser_snapshot." },
                    snapshotId: { type: "string", minLength: 8, maxLength: 128, description: "Required with ref and must belong to this exact target claim." },
                    css: { type: "string", maxLength: 2000 }, role: { type: "string", maxLength: 200 },
                    name: { type: "string", maxLength: 2000 }, text: { type: "string", maxLength: 5000 },
                    exact: { type: "boolean", default: false }, nth: { type: "integer", minimum: 0, maximum: 10_000, default: 0 },
                  },
                  additionalProperties: false,
                },
                frames: {
                  type: "array", maxItems: 8,
                  items: {
                    type: "object",
                    properties: {
                      css: { type: "string", maxLength: 2000 }, role: { type: "string", maxLength: 200 },
                      name: { type: "string", maxLength: 2000 }, text: { type: "string", maxLength: 5000 },
                      exact: { type: "boolean", default: false }, nth: { type: "integer", minimum: 0, maximum: 10_000, default: 0 },
                    },
                    additionalProperties: false,
                  },
                },
                target: {
                  type: "object",
                  properties: {
                    ref: { type: "string", pattern: "^@?[0-9]+$" }, snapshotId: { type: "string", minLength: 8, maxLength: 128 },
                    css: { type: "string", maxLength: 2000 }, role: { type: "string", maxLength: 200 },
                    name: { type: "string", maxLength: 2000 }, text: { type: "string", maxLength: 5000 },
                    exact: { type: "boolean", default: false }, nth: { type: "integer", minimum: 0, maximum: 10_000, default: 0 },
                  },
                  additionalProperties: false,
                },
                value: { type: "string", maxLength: 200_000 }, values: { type: "array", maxItems: 100, items: { type: "string", maxLength: 20_000 } },
                files: { type: "array", maxItems: 20, items: { type: "string", minLength: 1, maxLength: 4000 } },
                key: { type: "string", maxLength: 200 }, attribute: { type: "string", maxLength: 500 },
                button: { type: "string", enum: ["left", "right", "middle"], default: "left" }, count: { type: "integer", minimum: 1, maximum: 3, default: 1 },
                direction: { type: "string", enum: ["up", "down", "left", "right"], default: "down" }, pages: { type: "integer", minimum: 1, maximum: 100, default: 1 },
                state: { type: "string", enum: ["attached", "detached", "visible", "hidden", "enabled", "disabled"], default: "visible" },
                timeoutMs: { type: "integer", minimum: 0, maximum: 30_000, default: 5000 }, limit: { type: "integer", minimum: 1, maximum: 500, default: 100 },
              },
              required: ["action", "locator"],
              additionalProperties: false,
            },
          },
        },
        required: ["session", "targetId", "targetClaim", "steps"],
        additionalProperties: false,
      },
      outputSchema: browserLocatorResultJsonSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true, idempotentHint: false },
      securitySchemes: writeSecuritySchemes,
      _meta: toolMeta("Running managed browser locator", "Managed browser locator finished", writeSecuritySchemes),
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
          includeContainers: { type: "boolean", default: false, description: "Include named container/group elements to preserve more of the accessibility hierarchy." },
          maxDepth: { type: "integer", minimum: 1, maximum: 40, default: 16, description: "Bound native accessibility recursion on very large app trees." },
          maxVisitedNodes: { type: "integer", minimum: 1, maximum: 20000, default: 3000, description: "Bound native nodes inspected even when a filter has few matches." },
          focusedWindowOnly: { type: "boolean", default: false, description: "On macOS, restrict traversal to the focused app window." },
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
      description: "Operate one element from a recent computer_elements snapshot by index, including exact click, scroll, value, and text-selection semantics, then return a fresh screenshot. Element snapshots are short-lived; refresh after every UI-changing action.",
      inputSchema: {
        type: "object",
        properties: {
          snapshotId: { type: "string", minLength: 8 },
          elementIndex: { type: "integer", minimum: 0 },
          action: { type: "string", enum: ELEMENT_ACTIONS },
          value: { type: "string", maxLength: MAX_TEXT_CHARS, description: "Required only for set_value." },
          text: { type: "string", maxLength: MAX_TEXT_CHARS, description: "Required only for select_text." },
          prefix: { type: "string", maxLength: 2000, description: "Optional preceding context used to disambiguate select_text." },
          suffix: { type: "string", maxLength: 2000, description: "Optional following context used to disambiguate select_text." },
          selectionType: { type: "string", enum: ["text", "cursor_before", "cursor_after"], default: "text" },
          button: { type: "string", enum: ["left", "right", "middle"], default: "left" },
          count: { type: "integer", minimum: 1, maximum: 3, default: 1 },
          direction: { type: "string", enum: ["up", "down", "left", "right"], default: "down" },
          pages: { type: "integer", minimum: 1, maximum: 100, default: 1 },
          display: { type: "string", maxLength: 64, description: "Optional Linux X11 display used for the post-action screenshot." },
          description: { type: "string", maxLength: 500, description: "Concise purpose for the action; value text is not stored in audit history." },
          returnState: { type: "boolean", default: true, description: "Set false for a fast action-only call, then explicitly refresh computer_app_state or computer_elements." },
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
      name: "computer_element_secondary_action",
      title: "Computer element secondary action",
      description: "Perform one exact native accessibility action advertised by a recent computer_elements snapshot. Never guess an action name.",
      inputSchema: {
        type: "object",
        properties: {
          snapshotId: { type: "string", minLength: 8 },
          elementIndex: { type: "integer", minimum: 0 },
          nativeAction: { type: "string", minLength: 1, maxLength: MAX_NATIVE_ACTION_CHARS },
          display: { type: "string", maxLength: 64 },
          description: { type: "string", maxLength: 500 },
          returnState: { type: "boolean", default: true, description: "Set false for a fast action-only call, then explicitly refresh semantic state." },
        },
        required: ["snapshotId", "elementIndex", "nativeAction"],
        additionalProperties: false,
      },
      outputSchema: elementActionResultJsonSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true, idempotentHint: false },
      securitySchemes: writeSecuritySchemes,
      _meta: toolMeta("Performing native accessibility action", "Native accessibility action finished", writeSecuritySchemes),
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
      name: "computer_window",
      title: "Computer window",
      description: "Control an exact window id returned by computer_state: activate, close, minimize, maximize, restore, or move and resize it in the same normalized API coordinate space. Returns refreshed windows and a screenshot.",
      inputSchema: {
        type: "object",
        properties: {
          display: { type: "string", maxLength: 64, description: "Optional Linux X11 display." },
          windowId: { type: "string", minLength: 1, maxLength: 100 },
          windowClaim: { type: "string", minLength: 20, maxLength: 200 },
          action: { type: "string", enum: WINDOW_ACTIONS },
          x: { type: "integer", minimum: 0, maximum: 10000 },
          y: { type: "integer", minimum: 0, maximum: 10000 },
          width: { type: "integer", minimum: 1, maximum: 10000 },
          height: { type: "integer", minimum: 1, maximum: 10000 },
          description: { type: "string", maxLength: 500 },
        },
        required: ["windowId", "windowClaim", "action"],
        additionalProperties: false,
      },
      outputSchema: windowActionResultJsonSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false, idempotentHint: false },
      securitySchemes: writeSecuritySchemes,
      _meta: toolMeta("Controlling window", "Window action finished", writeSecuritySchemes),
    },
    {
      name: "computer_use",
      title: "Computer use",
      description:
        `Control an app-scoped background window on macOS, or the foreground desktop elsewhere, with a platform-native backend, 1280-wide normalized coordinates, and one final screenshot. Raw keyboard/mouse input never activates a named app unless activateApplication=true; macOS sends background events directly to the target PID and captures its independent window. Supports screenshot/click/move/drag/type/key/scroll/wait plus up to ${MAX_FOLLOW_UP_ACTIONS} known follow-up actions in then, and rejects locked, inactive, or secure desktops.`,
      inputSchema: {
        type: "object",
        properties: {
          display: { type: "string", maxLength: 64, description: "Optional X11 display such as :3. Defaults to the connector process DISPLAY." },
          application: { type: "string", maxLength: 500, description: "Optional application name or stable platform identifier. On macOS this enables background app-window coordinates by default." },
          activateApplication: { type: "boolean", default: false, description: "Explicitly permit bringing application to the foreground before global keyboard/mouse input." },
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
    {
      name: "computer_use_bridge",
      title: "Computer Use-compatible remote bridge",
      description:
        "Drive a selected remote application through one MCP entrypoint that mirrors the app-scoped Computer Use contract: list_apps, get_app_state, click, drag, perform_secondary_action, press_key, scroll, select_text, set_value, and type_text. Call get_app_state before element or screenshot-coordinate actions. Coordinates use the returned application screenshot itself, while the bridge privately handles native normalization, short-lived snapshots, diffing, event settling, and stale-index rejection.",
      inputSchema: {
        type: "object",
        properties: {
          operation: { type: "string", enum: COMPUTER_USE_BRIDGE_OPERATIONS },
          app: { type: "string", minLength: 1, maxLength: 500 },
          disableDiff: { type: "boolean", default: false },
          focusedWindowOnly: { type: "boolean", default: false, description: "Limit state to the focused app window. The default returns the complete application tree, including its menu bar." },
          snapshotId: { type: "string", minLength: 8, maxLength: 200, description: "Required for every write; must match the latest get_app_state or action response." },
          snapshot_id: { type: "string", minLength: 8, maxLength: 200, description: "Snake-case alias for snapshotId." },
          elementIndex: { type: "integer", minimum: 0 },
          element_index: { type: "integer", minimum: 0, description: "Computer Use-compatible alias for elementIndex." },
          x: { type: "number", minimum: 0 }, y: { type: "number", minimum: 0 },
          fromX: { type: "number", minimum: 0 }, fromY: { type: "number", minimum: 0 },
          toX: { type: "number", minimum: 0 }, toY: { type: "number", minimum: 0 },
          from_x: { type: "number", minimum: 0 }, from_y: { type: "number", minimum: 0 },
          to_x: { type: "number", minimum: 0 }, to_y: { type: "number", minimum: 0 },
          mouseButton: { type: "string", enum: ["left", "right", "middle", "l", "r", "m"], default: "left" },
          mouse_button: { type: "string", enum: ["left", "right", "middle", "l", "r", "m"] },
          clickCount: { type: "integer", minimum: 1, maximum: 3, default: 1 },
          click_count: { type: "integer", minimum: 1, maximum: 3 },
          direction: { type: "string", enum: ["up", "down", "left", "right", "u", "d", "l", "r"] },
          pages: { type: "integer", minimum: 1, maximum: 100, default: 1 },
          value: { type: "string", maxLength: MAX_TEXT_CHARS },
          text: { type: "string", maxLength: MAX_TEXT_CHARS },
          prefix: { type: "string", maxLength: 2000 }, suffix: { type: "string", maxLength: 2000 },
          selectionType: { type: "string", enum: ["text", "cursor_before", "cursor_after"], default: "text" },
          selection_type: { type: "string", enum: ["text", "cursor_before", "cursor_after"] },
          key: { type: "string", minLength: 1, maxLength: 128 },
          nativeAction: { type: "string", minLength: 1, maxLength: MAX_NATIVE_ACTION_CHARS },
          action: { type: "string", minLength: 1, maxLength: MAX_NATIVE_ACTION_CHARS, description: "Computer Use-compatible secondary accessibility action name." },
          description: { type: "string", maxLength: 500 },
        },
        required: ["operation"],
        additionalProperties: false,
      },
      outputSchema: computerUseBridgeResultJsonSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true, idempotentHint: false },
      securitySchemes: writeSecuritySchemes,
      _meta: toolMeta("Driving remote application", "Remote application action finished", writeSecuritySchemes),
    },
    {
      name: "computer_browser_cua",
      title: "Browser page coordinate control",
      description:
        "Control one exact claimed browser tab in page CSS-pixel coordinates, in a coordinate space separate from desktop computer_use coordinates. Supports screenshot/click/double-click/move/drag/type/keypress/scroll/media-download/wait batches with modifier keys and bounded capture options, then returns a target-only page screenshot; stale or mismatched browser claims fail closed.",
      inputSchema: {
        type: "object",
        properties: {
          session: { type: "string", minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$" },
          targetId: { type: "string", minLength: 1, maxLength: 200 },
          targetClaim: { type: "string", minLength: 1, maxLength: 200, description: "Current claim returned with the target; required to bind input to this exact browser tab." },
          actions: {
            type: "array", minItems: 1, maxItems: 20,
            items: browserCuaActionJsonSchema,
            description: "Known page-coordinate actions executed in order; coordinates are browser viewport CSS pixels, not desktop screenshot coordinates.",
          },
        },
        required: ["session", "targetId", "targetClaim", "actions"],
        additionalProperties: false,
      },
      outputSchema: browserCuaResultJsonSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true, idempotentHint: false },
      securitySchemes: writeSecuritySchemes,
      _meta: toolMeta("Controlling browser page coordinates", "Browser page coordinate action finished", writeSecuritySchemes),
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
        const session = await linuxInteractiveSessionState();
        const structuredContent = {
          platform: process.platform,
          backend: "linux-x11",
          ready: session.interactiveDesktop,
          display: resolvedDisplay,
          displayResolution: resolution.display,
          apiResolution: resolution.api,
          permissions: session,
          details: ["xdpyinfo/xrandr reachable", "xdotool input and ffmpeg screenshot backend enabled"],
          message: session.interactiveDesktop
            ? `linux-x11 is ready on ${resolvedDisplay}.`
            : `linux-x11 is reachable on ${resolvedDisplay}, but its desktop session is locked or inactive.`,
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
    "computer_applications",
    {
      title: "Computer applications",
      description: "List installed and running desktop applications with stable identifiers and evidence-backed recent-use metadata for precise app targeting.",
      inputSchema: {},
      outputSchema: applicationsResultShape,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
      securitySchemes: readSecuritySchemes,
      _meta: toolMeta("Listing computer applications", "Computer applications ready", readSecuritySchemes),
    },
    async () => {
      if (!hasReadScope()) return toolAuthError(readAuthChallenge);
      try {
        const applications = await listSemanticApplications();
        const structuredContent = {
          applications,
          message: `Found ${applications.length} installed or running desktop applications. Prefer the stable id when selecting an application.`,
        };
        return { structuredContent, content: [{ type: "text", text: structuredContent.message }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { isError: true, content: [{ type: "text", text: `Computer applications failed: ${message}` }] };
      }
    }
  );

  server.registerTool(
    "computer_app_state",
    {
      title: "Computer application state",
      description: "Ensure one application is running without taking foreground focus by default, then return its rich accessibility tree and current screenshot; later calls return a compact AX diff.",
      inputSchema: {
        app: z.string().min(1).max(500),
        disableDiff: z.boolean().default(false).optional(),
        maxElements: z.number().int().min(1).max(500).default(240).optional(),
        query: z.string().max(1000).optional(),
        role: z.string().max(200).optional(),
        maxDepth: z.number().int().min(1).max(40).default(16).optional(),
        maxVisitedNodes: z.number().int().min(1).max(20_000).default(3000).optional(),
        focusedWindowOnly: z.boolean().default(true).optional(),
        activate: z.boolean().default(false).optional(),
      },
      outputSchema: appStateResultShape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true, idempotentHint: false },
      securitySchemes: writeSecuritySchemes,
      _meta: toolMeta("Opening and reading application state", "Application state ready", writeSecuritySchemes),
    },
    async ({ app, disableDiff, maxElements, query, role, maxDepth, maxVisitedNodes, focusedWindowOnly, activate }) => {
      if (!hasWriteScope()) return toolAuthError(writeAuthChallenge);
      try {
        const options = {
          source: "desktop",
          application: app,
          maxElements: maxElements ?? 240,
          query,
          role,
          maxDepth: maxDepth ?? 16,
          maxVisitedNodes: maxVisitedNodes ?? 3000,
          focusedWindowOnly: focusedWindowOnly !== false,
          includeStaticText: true,
          includeContainers: true,
          launchIfNeeded: true,
          activateApplication: activate === true,
          includeScreenshot: true,
        };
        const result = await listSemanticElements(options);
        const snapshot = storeElementSnapshot(result, options);
        const application = result.application == null ? null : String(result.application);
        const applicationId = result.applicationId == null ? null : String(result.applicationId);
        const filterKey = JSON.stringify({ query: query ?? "", role: role ?? "", maxDepth: maxDepth ?? 16, maxVisitedNodes: maxVisitedNodes ?? 3000, focusedWindowOnly: focusedWindowOnly !== false });
        const rendered = buildAppStateText({ application, applicationId, elements: snapshot.elements, disableDiff: disableDiff === true, filterKey });
        let state = { screenshot: result.screenshot ?? null };
        if (!state.screenshot) {
          try { state = await captureComputerAfterSemanticAction(); }
          catch {
            // Accessibility state remains useful when Screen Recording permission is unavailable.
          }
        }
        const structuredContent = {
          snapshotId: snapshot.snapshotId,
          expiresInMs: snapshot.expiresInMs,
          application,
          applicationId,
          isDiff: rendered.isDiff,
          text: rendered.text,
          screenshotIncluded: Boolean(state.screenshot),
          screenshotMimeType: state.screenshot?.mimeType ?? null,
          screenshotScope: state.screenshot?.scope ?? (state.screenshot ? "desktop" : null),
          screenshotBounds: state.screenshot?.bounds ?? null,
          message: `${rendered.isDiff ? "Returned accessibility changes" : "Returned the full accessibility tree"} for ${applicationId || application || app}. Snapshot ${snapshot.snapshotId} expires in ${Math.round(snapshot.expiresInMs / 1000)} seconds.`,
        };
        return {
          structuredContent,
          content: [
            { type: "text", text: `${structuredContent.message}\n${structuredContent.text}` },
            ...(state.screenshot ? [{ type: "image", data: state.screenshot.data, mimeType: state.screenshot.mimeType }] : []),
          ],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { isError: true, content: [{ type: "text", text: `Computer application state failed: ${message}` }] };
      }
    }
  );

  server.registerTool(
    "computer_browser_session",
    {
      title: "Browser session",
      description: "Control a dedicated Chrome/Chromium profile, an explicitly configured loopback CDP browser, or explicitly shared signed-in tabs through the optional extension, with exact target claims, ownership, lifecycle, history, reload, and page-only screenshots.",
      inputSchema: {
        action: z.enum(BROWSER_SESSION_ACTIONS),
        session: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/).optional(),
        url: z.string().max(4000).optional(),
        targetId: z.string().max(200).optional(),
        targetClaim: z.string().max(200).optional(),
        headless: z.boolean().default(false).optional(),
      },
      outputSchema: browserSessionResultShape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true, idempotentHint: false },
      securitySchemes: writeSecuritySchemes,
      _meta: toolMeta("Managing browser session", "Browser session ready", writeSecuritySchemes),
    },
    async ({ action, session, url, targetId, targetClaim, headless }) => {
      if (!hasWriteScope()) return toolAuthError(writeAuthChallenge);
      try {
        let selectedSession = null;
        let target = null;
        let screenshot = null;
        if (action === "start") {
          if (!session) throw new Error("start requires session.");
          selectedSession = await startBrowserSession({ name: session, url: url || "about:blank", headless: headless === true });
          target = selectedSession.targets.find((item) => !item.url.startsWith("chrome://")) ?? selectedSession.targets[0] ?? null;
        } else if (action === "navigate") {
          if (!session) throw new Error("navigate requires session.");
          if (!url) throw new Error("navigate requires url.");
          const result = await navigateBrowserSession({ name: session, url, targetId: targetId || "", targetClaim: targetClaim || "" });
          selectedSession = result.session;
          target = result.target ?? null;
          screenshot = result.screenshot ?? null;
        } else if (["new_tab", "activate_tab", "back", "forward", "reload", "screenshot", "retain_tab", "release_tab", "cleanup_tabs", "close_tab"].includes(action)) {
          if (!session) throw new Error(`${action} requires session.`);
          if (action === "new_tab" && !url) url = "about:blank";
          const result = await browserSessionTabAction({ name: session, action, targetId: targetId || "", targetClaim: targetClaim || "", url: url || "" });
          selectedSession = result.session;
          target = result.target ?? null;
          screenshot = result.screenshot ?? null;
        } else if (action === "stop") {
          if (!session) throw new Error("stop requires session.");
          selectedSession = await stopBrowserSession({ name: session });
        } else if (action !== "list") {
          throw new Error(`Unsupported browser session action: ${action}`);
        }
        const sessions = await listBrowserSessions();
        const structuredContent = {
          action,
          session: publicBrowserSession(selectedSession),
          sessions: sessions.map(publicBrowserSession),
          target: publicBrowserTarget(target),
          screenshotIncluded: Boolean(screenshot),
          screenshotMimeType: screenshot?.mimeType ?? null,
          message: action === "list"
            ? `Found ${sessions.length} browser session${sessions.length === 1 ? "" : "s"} (${sessions.filter((item) => item.kind === "attached").length} explicitly attached).`
            : `Browser session ${session} ${action} completed${selectedSession ? `; running=${selectedSession.running}` : ""}.`,
        };
        return {
          structuredContent,
          content: [
            { type: "text", text: structuredContent.message },
            ...(screenshot ? [{ type: "image", data: screenshot.data, mimeType: screenshot.mimeType }] : []),
          ],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { isError: true, content: [{ type: "text", text: `Browser session failed: ${message}` }] };
      }
    }
  );

  server.registerTool(
    "computer_browser_utility",
    {
      title: "Browser utilities",
      description: "Operate an exact claimed target in a managed, attached, or extension-connected browser: export content or a private PDF artifact, access clipboard, inspect logs, handle dialogs, or track supported downloads.",
      inputSchema: {
        action: z.enum(BROWSER_UTILITY_ACTIONS),
        session: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
        targetId: z.string().max(200).optional(),
        targetClaim: z.string().max(200).optional(),
        text: z.string().max(2_000_000).optional(),
        promptText: z.string().max(20_000).optional(),
        clear: z.boolean().default(false).optional(),
        limit: z.number().int().min(1).max(500).default(100).optional(),
        downloadGuid: z.string().max(500).optional(),
        timeoutMs: z.number().int().min(0).max(30_000).default(30_000).optional(),
        filename: z.string().max(200).optional(),
        pdfOptions: z.object({
          landscape: z.boolean().default(false).optional(), printBackground: z.boolean().default(true).optional(), preferCSSPageSize: z.boolean().default(false).optional(),
          scale: z.number().min(0.1).max(2).default(1).optional(), paperWidth: z.number().min(1).max(100).default(8.27).optional(), paperHeight: z.number().min(1).max(100).default(11.69).optional(),
          marginTop: z.number().min(0).max(10).default(0).optional(), marginBottom: z.number().min(0).max(10).default(0).optional(), marginLeft: z.number().min(0).max(10).default(0).optional(), marginRight: z.number().min(0).max(10).default(0).optional(),
        }).optional(),
      },
      outputSchema: browserUtilityResultShape,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true, idempotentHint: false },
      securitySchemes: writeSecuritySchemes,
      _meta: toolMeta("Using managed browser utility", "Managed browser utility finished", writeSecuritySchemes),
    },
    async ({ action, session, targetId, targetClaim, text, promptText, clear, limit, downloadGuid, timeoutMs, filename, pdfOptions }) => {
      if (!hasWriteScope()) return toolAuthError(writeAuthChallenge);
      try {
        if (action === "clipboard_write" && text === undefined) throw new Error("clipboard_write requires text.");
        const result = await browserSessionUtility({
          name: session,
          action,
          targetId: targetId || "",
          targetClaim: targetClaim || "",
          text: text ?? "",
          promptText: promptText ?? "",
          clear: clear === true,
          limit: limit ?? 100,
          downloadGuid: downloadGuid || "",
          timeoutMs: timeoutMs ?? 30_000,
          filename: filename ?? "",
          pdfOptions: pdfOptions ?? {},
        });
        const message = action === "export_pdf"
          ? `Exported ${result.artifacts[0]?.size ?? 0} PDF bytes from managed browser target ${targetId}.`
          : action.startsWith("export_")
          ? `Exported ${result.text?.length ?? 0} characters from managed browser target ${targetId}.`
          : action === "clipboard_read"
            ? `Read ${result.text?.length ?? 0} clipboard characters from managed browser target ${targetId}.`
            : action === "clipboard_write"
              ? `Wrote ${String(text ?? "").length} clipboard characters for managed browser target ${targetId}.`
              : action === "logs"
                ? `Returned ${result.logs.length} buffered developer log entr${result.logs.length === 1 ? "y" : "ies"} for managed browser target ${targetId}.`
                : action.startsWith("dialog_")
                  ? `Browser dialog action ${action} completed; open=${Boolean(result.dialog)}.`
                  : `Browser download action ${action} completed; tracked=${result.downloads.length}, files=${result.files.length}.`;
        const structuredContent = {
          action,
          ...result,
          session: publicBrowserSession(result.session),
          target: publicBrowserTarget(result.target),
          message,
        };
        return {
          structuredContent,
          content: [
            { type: "text", text: message },
            ...(result.text !== null ? [{ type: "text", text: result.text }] : []),
          ],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { isError: true, content: [{ type: "text", text: `Managed browser utility failed: ${message}` }] };
      }
    }
  );

  server.registerTool(
    "computer_browser_snapshot",
    {
      title: "Browser semantic snapshot",
      description: "Return a compact accessibility snapshot whose short-lived @refs are bound to one exact claimed browser target.",
      inputSchema: {
        session: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
        targetId: z.string().min(1).max(200),
        targetClaim: z.string().min(1).max(200),
        maxNodes: z.number().int().min(1).max(1000).default(500).optional(),
        includeText: z.boolean().default(true).optional(),
      },
      outputSchema: browserSnapshotResultShape,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: false },
      securitySchemes: readSecuritySchemes,
      _meta: toolMeta("Reading browser semantic snapshot", "Browser semantic snapshot ready", readSecuritySchemes),
    },
    async ({ session, targetId, targetClaim, maxNodes, includeText }) => {
      if (!hasReadScope()) return toolAuthError(readAuthChallenge);
      try {
        const result = await browserSessionSnapshot({ name: session, targetId, targetClaim, maxNodes, includeText });
        const message = `Returned ${result.nodeCount} semantic browser nodes and ${result.refs.length} short-lived refs for target ${targetId}.`;
        const structuredContent = {
          ...result,
          session: publicBrowserSession(result.session),
          target: publicBrowserTarget(result.target),
          message,
        };
        return { structuredContent, content: [{ type: "text", text: `${message}\n${result.content}` }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { isError: true, content: [{ type: "text", text: `Managed browser snapshot failed: ${message}` }] };
      }
    }
  );

  server.registerTool(
    "computer_browser_locator",
    {
      title: "Browser locator",
      description: "Run declarative @ref/CSS/role/name/text locator inspection, waiting, frame traversal, click, form, approved-root file upload, drag, keyboard, and scrolling steps against one exact claimed target, then return its screenshot.",
      inputSchema: {
        session: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
        targetId: z.string().min(1).max(200),
        targetClaim: z.string().min(1).max(200),
        steps: z.array(browserLocatorStepSchema).min(1).max(20),
      },
      outputSchema: browserLocatorResultShape,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true, idempotentHint: false },
      securitySchemes: writeSecuritySchemes,
      _meta: toolMeta("Running managed browser locator", "Managed browser locator finished", writeSecuritySchemes),
    },
    async ({ session, targetId, targetClaim, steps }) => {
      if (!hasWriteScope()) return toolAuthError(writeAuthChallenge);
      try {
        const result = await browserSessionLocator({ name: session, targetId, targetClaim, steps });
        const message = `Executed ${result.results.length} locator step${result.results.length === 1 ? "" : "s"} on managed browser target ${targetId}.`;
        const structuredContent = {
          session: publicBrowserSession(result.session),
          target: publicBrowserTarget(result.target),
          results: result.results,
          screenshotIncluded: Boolean(result.screenshot),
          screenshotMimeType: result.screenshot?.mimeType ?? null,
          message,
        };
        return {
          structuredContent,
          content: [
            { type: "text", text: message },
            ...(result.screenshot ? [{ type: "image", data: result.screenshot.data, mimeType: result.screenshot.mimeType }] : []),
          ],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { isError: true, content: [{ type: "text", text: `Managed browser locator failed: ${message}` }] };
      }
    }
  );

  server.registerTool(
    "computer_browser_cua",
    {
      title: "Browser page coordinate control",
      description: "Send bounded click/double-click/move/drag/type/keypress/scroll/media-download input to one exact claimed browser tab in page CSS-pixel coordinates, with clipped or full-page capture. This coordinate space is separate from desktop computer_use coordinates.",
      inputSchema: {
        session: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
        targetId: z.string().min(1).max(200),
        targetClaim: z.string().min(1).max(200),
        actions: z.array(browserCuaActionShape).min(1).max(20),
      },
      outputSchema: browserCuaResultShape,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true, idempotentHint: false },
      securitySchemes: writeSecuritySchemes,
      _meta: toolMeta("Controlling browser page coordinates", "Browser page coordinate action finished", writeSecuritySchemes),
    },
    async ({ session, targetId, targetClaim, actions }) => {
      if (!hasWriteScope()) return toolAuthError(writeAuthChallenge);
      try {
        const result = await browserSessionCua({ name: session, targetId, targetClaim, actions });
        const message = `Executed ${result.actionCount} browser page-coordinate action${result.actionCount === 1 ? "" : "s"} on managed browser target ${targetId}.`;
        const structuredContent = {
          session: publicBrowserSession(result.session),
          target: publicBrowserTarget(result.target),
          actionCount: result.actionCount,
          screenshotIncluded: Boolean(result.screenshot),
          screenshotMimeType: result.screenshot?.mimeType ?? null,
          message,
        };
        return {
          structuredContent,
          content: [
            { type: "text", text: message },
            ...(result.screenshot ? [{ type: "image", data: result.screenshot.data, mimeType: result.screenshot.mimeType }] : []),
          ],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { isError: true, content: [{ type: "text", text: `Browser page coordinate action failed: ${message}` }] };
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
        includeContainers: z.boolean().default(false).optional(),
        maxDepth: z.number().int().min(1).max(40).default(16).optional(),
        maxVisitedNodes: z.number().int().min(1).max(20_000).default(3000).optional(),
        focusedWindowOnly: z.boolean().default(false).optional(),
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
          applicationId: result.applicationId == null ? null : String(result.applicationId),
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
      description: "Operate one element from a recent computer_elements snapshot with semantic press/click/focus/value/text-selection/scroll behavior and return the resulting screenshot.",
      inputSchema: {
        snapshotId: z.string().min(8),
        elementIndex: z.number().int().min(0),
        action: z.enum(ELEMENT_ACTIONS),
        value: z.string().max(MAX_TEXT_CHARS).optional(),
        text: z.string().max(MAX_TEXT_CHARS).optional(),
        prefix: z.string().max(2000).optional(),
        suffix: z.string().max(2000).optional(),
        selectionType: z.enum(["text", "cursor_before", "cursor_after"]).default("text").optional(),
        button: z.enum(["left", "right", "middle"]).default("left").optional(),
        count: z.number().int().min(1).max(3).default(1).optional(),
        direction: z.enum(["up", "down", "left", "right"]).default("down").optional(),
        pages: z.number().int().min(1).max(100).default(1).optional(),
        display: z.string().min(1).max(64).optional(),
        description: z.string().max(500).optional(),
        returnState: z.boolean().default(true).optional(),
      },
      outputSchema: elementActionResultShape,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true, idempotentHint: false },
      securitySchemes: writeSecuritySchemes,
      _meta: toolMeta("Operating computer element", "Computer element action finished", writeSecuritySchemes),
    },
    async ({ snapshotId, elementIndex, action, value, text, prefix, suffix, selectionType, button, count, direction, pages, display, returnState }) => {
      if (!hasWriteScope()) return toolAuthError(writeAuthChallenge);
      const started = Date.now();
      let source = "unknown";
      const auditValue = action === "set_value"
        ? `(${String(value ?? "").length} chars)`
        : action === "select_text" ? `(${String(text ?? "").length} selected chars)` : "";
      try {
        const { snapshot, element } = getSnapshotElement(snapshotId, elementIndex);
        source = String(element.source ?? "unknown");
        if (Array.isArray(element.actions) && !element.actions.includes(action)) {
          throw new Error(`Element ${elementIndex} does not advertise action ${action}. Available: ${element.actions.join(", ") || "none"}.`);
        }
        if (action === "set_value" && value === undefined) throw new Error("set_value requires value.");
        if (action === "select_text" && !text) throw new Error("select_text requires non-empty text.");
        const actionResult = await semanticElementAction({
          elementId: element.id,
          action,
          value: value ?? "",
          text: text ?? "",
          prefix: prefix ?? "",
          suffix: suffix ?? "",
          selectionType: selectionType ?? "text",
          button: button ?? "left",
          count: count ?? 1,
          direction: direction ?? "down",
          pages: pages ?? 1,
          skipSettle: returnState === false,
        });
        ELEMENT_SNAPSHOTS.delete(snapshotId);
        const eventSettled = ["ax-observer", "uia-events", "atspi-events", "macos-ax-service", "windows-uia-service", "linux-atspi-service"].includes(String(actionResult?.settleSource ?? ""));
        const shouldReturnState = returnState !== false;
        const refreshed = shouldReturnState ? await refreshElementState(snapshot, { waitForSettle: !eventSettled, elementSource: source }) : null;
        let state = { display: display ?? "computer", screenshot: null, active: null };
        if (actionResult?.screenshot) {
          state = { display: "browser-cdp", screenshot: actionResult.screenshot, active: null };
        } else if (refreshed?.screenshot) {
          state = { display: source, screenshot: refreshed.screenshot, active: null };
        } else if (shouldReturnState) {
          try { state = await captureComputerAfterSemanticAction(display); }
          catch {
            // The semantic action has already succeeded. Do not invite a duplicate
            // retry merely because screenshot permission or capture is unavailable.
          }
        }
        const durationMs = Date.now() - started;
        const structuredContent = {
          snapshotId,
          nextSnapshotId: refreshed?.snapshot.snapshotId ?? null,
          nextExpiresInMs: refreshed?.snapshot.expiresInMs ?? null,
          elementIndex, source, action, durationMs, activeWindow: state.active ?? null,
          screenshotIncluded: Boolean(state.screenshot), screenshotMimeType: state.screenshot?.mimeType ?? null,
          screenshotScope: state.screenshot?.scope ?? (state.screenshot ? (source === "browser-cdp" ? "browser" : "desktop") : null),
          screenshotBounds: state.screenshot?.bounds ?? null,
          stateIsDiff: refreshed?.rendered.isDiff ?? null,
          stateText: refreshed?.rendered.text ?? null,
          settleDurationMs: Math.max(Number(actionResult?.settleDurationMs) || 0, Number(refreshed?.settleDurationMs) || 0) || null,
          settleEventCount: Number.isInteger(actionResult?.settleEventCount) ? actionResult.settleEventCount : null,
          settleSource: actionResult?.settleSource ?? (refreshed ? "semantic-fingerprint" : null),
          message: refreshed
            ? `Executed ${action} on ${source} element ${elementIndex}; use fresh snapshot ${refreshed.snapshot.snapshotId} for the next UI-dependent action.`
            : `Executed ${action} on ${source} element ${elementIndex}; refresh computer_elements before the next UI-dependent action.`,
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
            ...(structuredContent.stateText ? [{ type: "text", text: structuredContent.stateText }] : []),
            ...(state.screenshot ? [{ type: "image", data: state.screenshot.data, mimeType: state.screenshot.mimeType }] : []),
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
    "computer_element_secondary_action",
    {
      title: "Computer element secondary action",
      description: "Perform one exact native accessibility action advertised by a recent computer_elements snapshot.",
      inputSchema: {
        snapshotId: z.string().min(8),
        elementIndex: z.number().int().min(0),
        nativeAction: z.string().min(1).max(MAX_NATIVE_ACTION_CHARS),
        display: z.string().min(1).max(64).optional(),
        description: z.string().max(500).optional(),
        returnState: z.boolean().default(true).optional(),
      },
      outputSchema: elementActionResultShape,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true, idempotentHint: false },
      securitySchemes: writeSecuritySchemes,
      _meta: toolMeta("Performing native accessibility action", "Native accessibility action finished", writeSecuritySchemes),
    },
    async ({ snapshotId, elementIndex, nativeAction, display, returnState }) => {
      if (!hasWriteScope()) return toolAuthError(writeAuthChallenge);
      const started = Date.now();
      let source = "unknown";
      try {
        const { snapshot, element } = getSnapshotElement(snapshotId, elementIndex);
        source = String(element.source ?? "unknown");
        const advertised = Array.isArray(element.nativeActions) ? element.nativeActions.map(String) : [];
        if (!advertised.includes(nativeAction)) {
          throw new Error(`Element ${elementIndex} does not advertise native action ${nativeAction}. Available: ${advertised.join(", ") || "none"}.`);
        }
        const actionResult = await semanticElementAction({ elementId: element.id, action: `native:${nativeAction}`, skipSettle: returnState === false });
        ELEMENT_SNAPSHOTS.delete(snapshotId);
        const eventSettled = ["ax-observer", "uia-events", "atspi-events", "macos-ax-service", "windows-uia-service", "linux-atspi-service"].includes(String(actionResult?.settleSource ?? ""));
        const shouldReturnState = returnState !== false;
        const refreshed = shouldReturnState ? await refreshElementState(snapshot, { waitForSettle: !eventSettled, elementSource: source }) : null;
        let state = { display: display ?? "computer", screenshot: null, active: null };
        if (actionResult?.screenshot) {
          state = { display: source, screenshot: actionResult.screenshot, active: null };
        } else if (refreshed?.screenshot) {
          state = { display: source, screenshot: refreshed.screenshot, active: null };
        } else if (shouldReturnState) {
          try { state = await captureComputerAfterSemanticAction(display); }
          catch {
            // The native action has already succeeded; refreshed AX state can still
            // confirm the result when screen-capture permission is unavailable.
          }
        }
        const durationMs = Date.now() - started;
        const structuredContent = {
          snapshotId,
          nextSnapshotId: refreshed?.snapshot.snapshotId ?? null,
          nextExpiresInMs: refreshed?.snapshot.expiresInMs ?? null,
          elementIndex, source, action: `native:${nativeAction}`, durationMs, activeWindow: state.active ?? null,
          screenshotIncluded: Boolean(state.screenshot), screenshotMimeType: state.screenshot?.mimeType ?? null,
          screenshotScope: state.screenshot?.scope ?? (state.screenshot ? (source === "browser-cdp" ? "browser" : "desktop") : null),
          screenshotBounds: state.screenshot?.bounds ?? null,
          stateIsDiff: refreshed?.rendered.isDiff ?? null,
          stateText: refreshed?.rendered.text ?? null,
          settleDurationMs: Math.max(Number(actionResult?.settleDurationMs) || 0, Number(refreshed?.settleDurationMs) || 0) || null,
          settleEventCount: Number.isInteger(actionResult?.settleEventCount) ? actionResult.settleEventCount : null,
          settleSource: actionResult?.settleSource ?? (refreshed ? "semantic-fingerprint" : null),
          message: refreshed
            ? `Executed native accessibility action ${nativeAction} on ${source} element ${elementIndex}; use fresh snapshot ${refreshed.snapshot.snapshotId} for the next UI-dependent action.`
            : `Executed native accessibility action ${nativeAction} on ${source} element ${elementIndex}; refresh computer_elements before the next UI-dependent action.`,
        };
        await audit?.({
          command: `computer_element_secondary_action ${source}[${elementIndex}].${nativeAction}`,
          cwd: state.display, status: "completed", exitCode: 0, signal: null, durationMs,
          stdout: structuredContent.message, stderr: "", truncated: false,
        });
        return {
          structuredContent,
          content: [
            { type: "text", text: structuredContent.message },
            ...(structuredContent.stateText ? [{ type: "text", text: structuredContent.stateText }] : []),
            ...(state.screenshot ? [{ type: "image", data: state.screenshot.data, mimeType: state.screenshot.mimeType }] : []),
          ],
        };
      } catch (error) {
        const durationMs = Date.now() - started;
        const message = error instanceof Error ? error.message : String(error);
        await audit?.({
          command: `computer_element_secondary_action ${source}[${elementIndex}].${nativeAction}`,
          cwd: display ?? "computer", status: "failed", exitCode: 1, signal: null, durationMs,
          stdout: "", stderr: message, truncated: false,
        }).catch(() => {});
        return { isError: true, content: [{ type: "text", text: `Computer secondary action failed: ${message}` }] };
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
          windows: claimedWindows(resolvedDisplay, state.windows),
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
    "computer_window",
    {
      title: "Computer window",
      description: "Control an exact window from computer_state using platform-native activate, close, minimize, maximize, restore, or normalized move/resize behavior, then return refreshed state and a screenshot.",
      inputSchema: {
        display: z.string().min(1).max(64).optional(),
        windowId: z.string().min(1).max(100),
        windowClaim: z.string().min(20).max(200),
        action: z.enum(WINDOW_ACTIONS),
        x: z.number().int().min(0).max(10_000).optional(),
        y: z.number().int().min(0).max(10_000).optional(),
        width: z.number().int().min(1).max(10_000).optional(),
        height: z.number().int().min(1).max(10_000).optional(),
        description: z.string().max(500).optional(),
      },
      outputSchema: windowActionResultShape,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false, idempotentHint: false },
      securitySchemes: writeSecuritySchemes,
      _meta: toolMeta("Controlling window", "Window action finished", writeSecuritySchemes),
    },
    async ({ display, windowId, windowClaim, action, x, y, width, height, description }) => {
      if (!hasWriteScope()) return toolAuthError(writeAuthChallenge);
      const started = Date.now();
      let resolvedDisplay = display ?? "computer";
      try {
        const native = nativeComputerBackendSupported();
        let resolution;
        let state;
        let actionResult;
        if (native) {
          resolvedDisplay = nativeComputerBackendName();
          const before = await nativeComputerState({ includeScreenshot: false, includeWindows: true });
          resolution = before.resolution;
          const claimed = resolveWindowClaim(resolvedDisplay, windowId, windowClaim);
          if (action === "move_resize") validateWindowGeometry({ x, y, width, height }, resolution.api);
          state = await nativeComputerWindowAction({ windowId, expectedName: claimed.name, action, x, y, width, height });
          actionResult = state.actionResult;
        } else {
          resolvedDisplay = await resolveDisplay(display);
          resolution = await detectResolution(resolvedDisplay);
          const claimed = resolveWindowClaim(resolvedDisplay, windowId, windowClaim);
          if (action === "move_resize") validateWindowGeometry({ x, y, width, height }, resolution.api);
          await assertLinuxInteractiveSession([{ action: "window" }]);
          actionResult = await linuxWindowAction(resolvedDisplay, resolution, { windowId, windowName: claimed.name, action, x, y, width, height });
          state = await collectState(resolvedDisplay, resolution, true, true);
        }
        const effectiveResolution = native ? state.resolution : resolution;
        const structuredContent = {
          display: resolvedDisplay,
          displayResolution: effectiveResolution.display,
          apiResolution: effectiveResolution.api,
          cursorPosition: state.cursor,
          activeWindow: state.active,
          windows: claimedWindows(resolvedDisplay, state.windows),
          screenshotIncluded: Boolean(state.screenshot),
          screenshotMimeType: state.screenshot?.mimeType ?? null,
          action,
          windowId,
          settleDurationMs: Number.isInteger(actionResult?.settleDurationMs) ? actionResult.settleDurationMs : null,
          settleEventCount: Number.isInteger(actionResult?.settleEventCount) ? actionResult.settleEventCount : null,
          settleSource: actionResult?.settleSource ? String(actionResult.settleSource) : null,
          message: `Window ${windowId} ${action} completed on ${resolvedDisplay}; returned ${state.windows.length} visible windows.`,
        };
        await audit?.({
          command: `computer_window ${windowId} ${action}${description ? ` (${description})` : ""}`,
          cwd: resolvedDisplay, status: "completed", exitCode: 0, signal: null, durationMs: Date.now() - started,
          stdout: structuredContent.message, stderr: "", truncated: false,
        });
        return {
          structuredContent,
          content: [
            { type: "text", text: structuredContent.message },
            ...(state.screenshot ? [{ type: "image", data: state.screenshot.data, mimeType: state.screenshot.mimeType }] : []),
          ],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await audit?.({
          command: `computer_window ${windowId} ${action}`,
          cwd: resolvedDisplay, status: "failed", exitCode: 1, signal: null, durationMs: Date.now() - started,
          stdout: "", stderr: message, truncated: false,
        }).catch(() => {});
        return { isError: true, content: [{ type: "text", text: `Computer window action failed: ${message}` }] };
      }
    }
  );

  server.registerTool(
    "computer_use",
    {
      title: "Computer use",
      description:
        `Control an app-scoped background window on macOS, or the foreground desktop elsewhere, using platform-native actions and one final screenshot. A named app is activated only with activateApplication=true.`,
      inputSchema: {
        display: z.string().min(1).max(64).optional(),
        application: z.string().min(1).max(500).optional(),
        activateApplication: z.boolean().default(false).optional(),
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

      const { display, application, activateApplication, description: _description, then = [], ...primary } = parsed.data;
      const actions = [primary, ...then];
      const auditSummary = actions.map(summarizeAction).join(" -> ");

      try {
        if (application && activateApplication !== true && process.platform !== "darwin") {
          throw new Error("Background raw application input is currently available on macOS only; use semantic element actions or explicitly set activateApplication=true.");
        }
        const native = nativeComputerBackendSupported();
        let resolution;
        let screenshot;
        let cursor;
        let active;
        if (native) {
          resolvedDisplay = nativeComputerBackendName();
          const state = await nativeComputerUse(actions, { application, activateApplication: activateApplication === true });
          resolution = state.resolution;
          screenshot = state.screenshot;
          cursor = state.cursor;
          active = state.active;
          if (!screenshot) throw new Error("Native computer backend did not return a screenshot.");
        } else {
          resolvedDisplay = await resolveDisplay(display);
          resolution = await detectResolution(resolvedDisplay);
          await assertLinuxInteractiveSession(actions);
          if (application && activateApplication === true) await activateLinuxApplication(application);
          else if (application) throw new Error("Background raw application input is currently available on the macOS native backend; use semantic element actions on this platform or explicitly set activateApplication=true.");
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

  server.registerTool(
    "computer_use_bridge",
    {
      title: "Computer Use-compatible remote bridge",
      description: "Use the Computer Use app contract through an authenticated remote MCP device, with application-screenshot coordinates, semantic indexes, fresh-state diffing, and stale-index protection.",
      inputSchema: {
        operation: z.enum(COMPUTER_USE_BRIDGE_OPERATIONS),
        app: z.string().min(1).max(500).optional(),
        disableDiff: z.boolean().default(false).optional(),
        focusedWindowOnly: z.boolean().default(false).optional(),
        snapshotId: z.string().min(8).max(200).optional(),
        snapshot_id: z.string().min(8).max(200).optional(),
        elementIndex: z.number().int().min(0).optional(),
        element_index: z.number().int().min(0).optional(),
        x: z.number().min(0).optional(), y: z.number().min(0).optional(),
        fromX: z.number().min(0).optional(), fromY: z.number().min(0).optional(),
        toX: z.number().min(0).optional(), toY: z.number().min(0).optional(),
        from_x: z.number().min(0).optional(), from_y: z.number().min(0).optional(),
        to_x: z.number().min(0).optional(), to_y: z.number().min(0).optional(),
        mouseButton: z.enum(["left", "right", "middle", "l", "r", "m"]).optional(),
        mouse_button: z.enum(["left", "right", "middle", "l", "r", "m"]).optional(),
        clickCount: z.number().int().min(1).max(3).optional(),
        click_count: z.number().int().min(1).max(3).optional(),
        direction: z.enum(["up", "down", "left", "right", "u", "d", "l", "r"]).optional(),
        pages: z.number().int().min(1).max(100).default(1).optional(),
        value: z.string().max(MAX_TEXT_CHARS).optional(),
        text: z.string().max(MAX_TEXT_CHARS).optional(),
        prefix: z.string().max(2000).optional(), suffix: z.string().max(2000).optional(),
        selectionType: z.enum(["text", "cursor_before", "cursor_after"]).optional(),
        selection_type: z.enum(["text", "cursor_before", "cursor_after"]).optional(),
        key: z.string().min(1).max(128).optional(),
        nativeAction: z.string().min(1).max(MAX_NATIVE_ACTION_CHARS).optional(),
        action: z.string().min(1).max(MAX_NATIVE_ACTION_CHARS).optional(),
        description: z.string().max(500).optional(),
      },
      outputSchema: computerUseBridgeResultShape,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true, idempotentHint: false },
      securitySchemes: writeSecuritySchemes,
      _meta: toolMeta("Driving remote application", "Remote application action finished", writeSecuritySchemes),
    },
    async ({ operation, app, disableDiff, focusedWindowOnly, snapshotId, snapshot_id, elementIndex, element_index, x, y, fromX, fromY, toX, toY, from_x, from_y, to_x, to_y, mouseButton, mouse_button, clickCount, click_count, direction, pages, value, text, prefix, suffix, selectionType, selection_type, key, nativeAction, action: advertisedAction, description }) => {
      if (!hasWriteScope()) return toolAuthError(writeAuthChallenge);
      const started = Date.now();
      const mutating = operation !== "list_apps" && operation !== "get_app_state";
      try {
        if (operation === "list_apps") {
          const applications = await listSemanticApplications();
          const structuredContent = {
            operation, app: null, applications, snapshotId: null, expiresInMs: null,
            elementIndex: null, source: null, isDiff: null, text: null, coordinateSpace: "none",
            screenshotIncluded: false, screenshotMimeType: null, screenshotScope: null, screenshotBounds: null,
            durationMs: Date.now() - started,
            message: `Found ${applications.length} applications through the Computer Use-compatible remote bridge.`,
          };
          return { structuredContent, content: [{ type: "text", text: structuredContent.message }] };
        }
        if (!app) throw new Error(`${operation} requires app.`);

        const selectedSnapshotId = computerUseBridgeAlias(snapshot_id, snapshotId, "snapshot_id", "snapshotId");
        const selectedElementIndex = computerUseBridgeAlias(element_index, elementIndex, "element_index", "elementIndex");
        const selectedFromX = computerUseBridgeAlias(from_x, fromX, "from_x", "fromX");
        const selectedFromY = computerUseBridgeAlias(from_y, fromY, "from_y", "fromY");
        const selectedToX = computerUseBridgeAlias(to_x, toX, "to_x", "toX");
        const selectedToY = computerUseBridgeAlias(to_y, toY, "to_y", "toY");
        const selectedMouseButton = computerUseBridgeAlias(mouse_button, mouseButton, "mouse_button", "mouseButton") ?? "left";
        const selectedClickCount = computerUseBridgeAlias(click_count, clickCount, "click_count", "clickCount") ?? 1;
        const selectedSelectionType = computerUseBridgeAlias(selection_type, selectionType, "selection_type", "selectionType") ?? "text";
        const selectedNativeAction = computerUseBridgeAlias(advertisedAction, nativeAction, "action", "nativeAction");
        if (operation !== "get_app_state" && !selectedSnapshotId) {
          throw new Error(`${operation} requires snapshot_id from the latest get_app_state or action response.`);
        }

        let state;
        let coordinateSpace = "none";
        if (operation === "get_app_state") {
          state = await readComputerUseBridgeState(app, disableDiff === true, focusedWindowOnly === true);
          coordinateSpace = state.screenshot?.scope === "application" && state.screenshot?.bounds
            ? "application_screenshot"
            : "none";
        } else if (operation === "click" && selectedElementIndex !== undefined) {
          state = await performComputerUseBridgeElementAction({ app, snapshotId: selectedSnapshotId, elementIndex: selectedElementIndex, action: "click", button: ({ l: "left", r: "right", m: "middle" })[selectedMouseButton] ?? selectedMouseButton, count: selectedClickCount });
          coordinateSpace = "semantic_element";
        } else if (operation === "scroll" && selectedElementIndex !== undefined) {
          const normalizedDirection = ({ u: "up", d: "down", l: "left", r: "right" })[direction] ?? direction;
          if (!normalizedDirection) throw new Error("scroll requires direction.");
          state = await performComputerUseBridgeElementAction({ app, snapshotId: selectedSnapshotId, elementIndex: selectedElementIndex, action: "scroll", direction: normalizedDirection, pages });
          coordinateSpace = "semantic_element";
        } else if (operation === "set_value") {
          if (selectedElementIndex === undefined || value === undefined) throw new Error("set_value requires element_index and value.");
          state = await performComputerUseBridgeElementAction({ app, snapshotId: selectedSnapshotId, elementIndex: selectedElementIndex, action: "set_value", value });
          coordinateSpace = "semantic_element";
        } else if (operation === "select_text") {
          if (selectedElementIndex === undefined || !text) throw new Error("select_text requires element_index and non-empty text.");
          state = await performComputerUseBridgeElementAction({ app, snapshotId: selectedSnapshotId, elementIndex: selectedElementIndex, action: "select_text", text, prefix, suffix, selectionType: selectedSelectionType });
          coordinateSpace = "semantic_element";
        } else if (operation === "perform_secondary_action") {
          if (selectedElementIndex === undefined || !selectedNativeAction) throw new Error("perform_secondary_action requires element_index and an advertised action from get_app_state.");
          state = await performComputerUseBridgeElementAction({ app, snapshotId: selectedSnapshotId, elementIndex: selectedElementIndex, nativeAction: selectedNativeAction });
          coordinateSpace = "semantic_element";
        } else {
          let action;
          if (operation === "click") {
            if (x === undefined || y === undefined) throw new Error("coordinate click requires x and y from the latest application screenshot.");
            const [point] = await bridgeScreenshotPoints(app, selectedSnapshotId, [{ x, y }]);
            action = { action: "click", ...point, button: ({ l: "left", r: "right", m: "middle" })[selectedMouseButton] ?? selectedMouseButton, count: selectedClickCount };
          } else if (operation === "drag") {
            if ([selectedFromX, selectedFromY, selectedToX, selectedToY].some((coordinate) => coordinate === undefined)) throw new Error("drag requires from_x, from_y, to_x, and to_y from the latest application screenshot.");
            const [from, to] = await bridgeScreenshotPoints(app, selectedSnapshotId, [
              { x: selectedFromX, y: selectedFromY },
              { x: selectedToX, y: selectedToY },
            ]);
            action = { action: "drag", x: from.x, y: from.y, x2: to.x, y2: to.y, button: "left" };
          } else if (operation === "press_key") {
            if (!key) throw new Error("press_key requires key.");
            action = { action: "key", key };
          } else if (operation === "type_text") {
            if (text === undefined) throw new Error("type_text requires text.");
            action = { action: "type", text };
          } else if (operation === "scroll") {
            const normalizedDirection = ({ u: "up", d: "down", l: "left", r: "right" })[direction] ?? direction;
            if (!normalizedDirection) throw new Error("scroll requires direction.");
            action = { action: "scroll", direction: normalizedDirection, amount: Math.min(100, Math.max(1, pages ?? 1) * 8) };
          } else {
            throw new Error(`Unsupported Computer Use bridge operation: ${operation}.`);
          }
          state = await performComputerUseBridgeRawAction(app, selectedSnapshotId, action);
          coordinateSpace = operation === "click" || operation === "drag" ? "application_screenshot" : "none";
        }

        const screenshot = state.screenshot ?? null;
        const structuredContent = {
          operation,
          app: state.application ?? String(app),
          applications: [],
          snapshotId: state.snapshot?.snapshotId ?? null,
          expiresInMs: state.snapshot?.expiresInMs ?? null,
          elementIndex: selectedElementIndex ?? null,
          source: state.source ?? null,
          isDiff: state.rendered?.isDiff ?? null,
          text: state.rendered?.text ?? null,
          coordinateSpace,
          screenshotIncluded: Boolean(screenshot),
          screenshotMimeType: screenshot?.mimeType ?? null,
          screenshotScope: screenshot?.scope ?? (screenshot ? "desktop" : null),
          screenshotBounds: screenshot?.bounds ?? null,
          durationMs: Date.now() - started,
          message: operation === "get_app_state"
            ? `Returned fresh Computer Use-compatible state for ${app}; ${coordinateSpace === "application_screenshot" ? "the image is the application-local coordinate space" : "no application-local coordinate image is available, so use semantic indexes"} and snapshot ${state.snapshot?.snapshotId ?? "unavailable"} is short-lived.`
            : `Completed Computer Use-compatible ${operation} for ${app}${state.snapshot ? `; use refreshed snapshot ${state.snapshot.snapshotId}` : ""}.`,
        };
        if (mutating) {
          const detail = selectedElementIndex === undefined ? "" : ` element ${selectedElementIndex}`;
          await audit?.({
            command: `computer_use_bridge ${operation} ${app}${detail}${description ? ` (${description})` : ""}`,
            cwd: state.source ?? "computer", status: "completed", exitCode: 0, signal: null,
            durationMs: structuredContent.durationMs, stdout: structuredContent.message, stderr: "", truncated: false,
          });
        }
        return {
          structuredContent,
          content: [
            { type: "text", text: structuredContent.message },
            ...(structuredContent.text ? [{ type: "text", text: structuredContent.text }] : []),
            ...(screenshot ? [{ type: "image", data: screenshot.data, mimeType: screenshot.mimeType }] : []),
          ],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (mutating) await audit?.({
          command: `computer_use_bridge ${operation}${app ? ` ${app}` : ""}`,
          cwd: "computer", status: "failed", exitCode: 1, signal: null,
          durationMs: Date.now() - started, stdout: "", stderr: message, truncated: false,
        }).catch(() => {});
        return { isError: true, content: [{ type: "text", text: `Computer Use bridge failed: ${message}` }] };
      }
    }
  );
}

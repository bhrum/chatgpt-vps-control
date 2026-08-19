import { platform } from "node:os";
import { browserElementAction, listBrowserElements } from "./browser-accessibility.js";
import { linuxAccessibilityElementAction, listLinuxAccessibilityElements, listLinuxApplications } from "./linux-accessibility.js";
import { nativeComputerApplications, nativeComputerElementAction, nativeComputerElements } from "./native-computer-backend.js";
import { beginNativeEventObservation, waitNativeEventObservation } from "./native-event-observer.js";

function limit(value, fallback = 120) {
  const number = Number(value ?? fallback);
  return Math.max(1, Math.min(Number.isFinite(number) ? Math.trunc(number) : fallback, 500));
}

function withSource(elements, source) {
  return (elements ?? []).map((element) => ({ ...element, source: element.source ?? source }));
}

export async function listSemanticElements(options = {}) {
  const source = String(options.source ?? "auto").toLowerCase();
  const maxElements = limit(options.maxElements);
  const currentPlatform = platform();
  const results = [];
  const errors = [];

  if (source === "auto" || source === "desktop") {
    if (currentPlatform === "darwin" || currentPlatform === "win32") {
      try { results.push(await nativeComputerElements({ ...options, maxElements })); }
      catch (error) { errors.push(`${currentPlatform === "darwin" ? "macos-ax" : "windows-uia"}: ${error instanceof Error ? error.message : String(error)}`); }
    } else {
      try { results.push(await listLinuxAccessibilityElements({ ...options, maxElements })); }
      catch (error) { errors.push(`linux-atspi: ${error instanceof Error ? error.message : String(error)}`); }
    }
  }
  if (source === "auto" || source === "browser") {
    try { results.push(await listBrowserElements({ ...options, maxElements })); }
    catch (error) { errors.push(`browser-cdp: ${error instanceof Error ? error.message : String(error)}`); }
  }
  if (!results.length) throw new Error(errors.join(" | ") || "No semantic accessibility provider is available.");

  const elements = [];
  for (const result of results) {
    for (const element of withSource(result.elements, result.source)) {
      elements.push(element);
      if (elements.length >= maxElements) break;
    }
    if (elements.length >= maxElements) break;
  }
  return {
    source: results.length === 1 ? results[0].source : "combined",
    providers: results.map((result) => result.source),
    target: results.find((result) => result.target)?.target ?? null,
    targets: results.flatMap((result) => result.targets ?? []),
    applications: results.flatMap((result) => result.applications ?? []),
    application: results.length === 1 ? results[0].application ?? null : null,
    applicationId: results.length === 1 ? results[0].applicationId ?? null : null,
    screenshot: results.length === 1 ? results[0].screenshot ?? null : null,
    elements,
    warnings: errors,
    message: `Returned ${elements.length} semantic elements from ${results.map((result) => result.source).join(", ")}.`,
  };
}

export function sortSemanticApplications(applications) {
  return [...applications].sort((left, right) => {
    if (left.isRunning !== right.isRunning) return left.isRunning ? -1 : 1;
    if ((left.useCount ?? -1) !== (right.useCount ?? -1)) return (right.useCount ?? -1) - (left.useCount ?? -1);
    const leftUsed = Date.parse(left.lastUsedDate ?? "") || 0;
    const rightUsed = Date.parse(right.lastUsedDate ?? "") || 0;
    if (leftUsed !== rightUsed) return rightUsed - leftUsed;
    return left.displayName.localeCompare(right.displayName, undefined, { sensitivity: "base" });
  });
}

export async function listSemanticApplications() {
  const applications = platform() === "darwin" || platform() === "win32"
    ? await nativeComputerApplications()
    : await listLinuxApplications();
  return sortSemanticApplications(applications);
}

function sourceFromElementId(elementId) {
  let payload;
  try { payload = JSON.parse(Buffer.from(String(elementId), "base64url").toString("utf8")); }
  catch { return ""; }
  return String(payload?.source ?? "");
}

export async function semanticElementAction({ elementId, action, value = "", skipSettle = false, ...details }) {
  const source = sourceFromElementId(elementId);
  const nativeSource = ["macos-ax", "windows-uia", "linux-atspi"].includes(source);
  const observation = nativeSource && !skipSettle ? await beginNativeEventObservation(elementId) : null;
  const request = { elementId, action, value, ...details, eventObserverActive: Boolean(observation) || skipSettle };
  if (source === "browser-cdp") return browserElementAction(request);
  let result;
  if (source === "linux-atspi") result = await linuxAccessibilityElementAction(request);
  else if (source === "macos-ax" || source === "windows-uia") result = await nativeComputerElementAction(request);
  else if (platform() === "darwin" || platform() === "win32") result = await nativeComputerElementAction(request);
  else throw new Error("Unknown semantic element source. Refresh computer_elements and use its current snapshot.");
  if (skipSettle) return { ...result, settleDurationMs: 0, settleEventCount: 0, settleSource: "action-only" };
  const settled = await waitNativeEventObservation(observation);
  if (settled) return { ...result, ...settled };
  if (observation) {
    await new Promise((resolve) => setTimeout(resolve, 180));
    return { ...result, settleDurationMs: 180, settleEventCount: 0, settleSource: "bounded-fallback" };
  }
  return result;
}

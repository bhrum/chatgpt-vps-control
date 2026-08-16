import { platform } from "node:os";
import { browserElementAction, listBrowserElements } from "./browser-accessibility.js";
import { linuxAccessibilityElementAction, listLinuxAccessibilityElements } from "./linux-accessibility.js";
import { nativeComputerElementAction, nativeComputerElements } from "./native-computer-backend.js";

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
  if (platform() === "darwin" || platform() === "win32") {
    const result = await nativeComputerElements({ ...options, maxElements });
    return { ...result, elements: withSource(result.elements, result.source).slice(0, maxElements), providers: [result.source] };
  }

  const results = [];
  const errors = [];
  if (source === "auto" || source === "desktop") {
    try { results.push(await listLinuxAccessibilityElements({ ...options, maxElements })); }
    catch (error) { errors.push(`linux-atspi: ${error instanceof Error ? error.message : String(error)}`); }
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
    elements,
    warnings: errors,
    message: `Returned ${elements.length} semantic elements from ${results.map((result) => result.source).join(", ")}.`,
  };
}

function sourceFromElementId(elementId) {
  let payload;
  try { payload = JSON.parse(Buffer.from(String(elementId), "base64url").toString("utf8")); }
  catch { return ""; }
  return String(payload?.source ?? "");
}

export async function semanticElementAction({ elementId, action, value = "" }) {
  const source = sourceFromElementId(elementId);
  if (source === "browser-cdp") return browserElementAction({ elementId, action, value });
  if (source === "linux-atspi") return linuxAccessibilityElementAction({ elementId, action, value });
  if (source === "macos-ax" || source === "windows-uia") return nativeComputerElementAction({ elementId, action, value });
  if (platform() === "darwin" || platform() === "win32") return nativeComputerElementAction({ elementId, action, value });
  throw new Error("Unknown semantic element source. Refresh computer_elements and use its current snapshot.");
}

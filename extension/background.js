const NATIVE_HOST = "com.fabushi.chatgpt_computer_control";
const STORAGE = {
  instanceId: "profileInstanceId",
  generation: "browserGeneration",
  claimed: "claimedTabs",
  automation: "automationTabs",
  retained: "retainedTabs",
  automationGroup: "automationGroupId",
};
const HEARTBEAT_ALARM = "browser-bridge-heartbeat";
const RECONNECT_ALARM = "browser-bridge-reconnect";
let nativePort = null;
let nativeConnected = false;
let nativeError = "";
let reconnectTimer = null;
let reconnectDelay = 500;
const attachedTabs = new Set();
const debuggerQueues = new Map();
const childSessions = new Map();
const childSessionWaiters = new Map();

function randomId() {
  return crypto.randomUUID().replaceAll("-", "");
}

function isShareableUrl(value) {
  try { return ["http:", "https:"].includes(new URL(String(value || "")).protocol); } catch { return false; }
}

async function state() {
  const [persistent, ephemeral] = await Promise.all([
    chrome.storage.local.get([STORAGE.instanceId]),
    chrome.storage.session.get([STORAGE.generation, STORAGE.claimed, STORAGE.automation, STORAGE.retained, STORAGE.automationGroup]),
  ]);
  if (!persistent[STORAGE.instanceId]) {
    persistent[STORAGE.instanceId] = randomId();
    await chrome.storage.local.set({ [STORAGE.instanceId]: persistent[STORAGE.instanceId] });
  }
  if (!ephemeral[STORAGE.generation]) {
    ephemeral[STORAGE.generation] = randomId();
    await chrome.storage.session.set({ [STORAGE.generation]: ephemeral[STORAGE.generation] });
  }
  return {
    instanceId: persistent[STORAGE.instanceId],
    generation: ephemeral[STORAGE.generation],
    claimed: new Set((ephemeral[STORAGE.claimed] || []).map(Number)),
    automation: new Set((ephemeral[STORAGE.automation] || []).map(Number)),
    retained: new Set((ephemeral[STORAGE.retained] || []).map(Number)),
    automationGroup: Number.isInteger(ephemeral[STORAGE.automationGroup]) ? ephemeral[STORAGE.automationGroup] : null,
  };
}

async function saveSets(current) {
  await Promise.all([
    chrome.storage.session.set({
      [STORAGE.claimed]: [...current.claimed],
      [STORAGE.automation]: [...current.automation],
      [STORAGE.retained]: [...current.retained],
      [STORAGE.automationGroup]: current.automationGroup,
    }),
  ]);
}

async function updateBadge(current = null) {
  const value = current || await state();
  const count = new Set([...value.claimed, ...value.automation]).size;
  await Promise.all([
    chrome.action.setBadgeBackgroundColor({ color: count ? "#1677ff" : "#6b7280" }),
    chrome.action.setBadgeText({ text: count ? String(Math.min(count, 99)) : "" }),
  ]);
}

function post(message) {
  try { nativePort?.postMessage(message); return Boolean(nativePort); } catch { return false; }
}

async function visibleTabs() {
  const current = await state();
  const tabs = await chrome.tabs.query({});
  const present = new Set(tabs.map((tab) => tab.id));
  let changed = false;
  for (const set of [current.claimed, current.automation, current.retained]) {
    for (const id of set) if (!present.has(id)) { set.delete(id); changed = true; }
  }
  if (changed) await saveSets(current);
  await updateBadge(current);
  return tabs.filter((tab) => current.automation.has(tab.id) || isShareableUrl(tab.url || tab.pendingUrl)).map((tab) => ({
    id: String(tab.id),
    title: String(tab.title || ""),
    url: String(tab.url || tab.pendingUrl || ""),
    active: tab.active === true,
    windowId: tab.windowId,
    owner: current.automation.has(tab.id) ? "automation" : "user",
    retained: current.automation.has(tab.id) ? current.retained.has(tab.id) : true,
    claimed: current.claimed.has(tab.id) || current.automation.has(tab.id),
  }));
}

async function announce(type = "tabs") {
  const current = await state();
  post({ type, instanceId: current.instanceId, generation: current.generation, browser: navigator.userAgent, tabs: await visibleTabs() });
}

function connectNative() {
  clearTimeout(reconnectTimer);
  nativeConnected = false;
  nativeError = "";
  try { nativePort = chrome.runtime.connectNative(NATIVE_HOST); }
  catch (error) { nativeError = error?.message || String(error); scheduleReconnect(); return; }
  nativePort.onMessage.addListener((message) => {
    if (message.type === "hello_ack") {
      nativeConnected = true;
      nativeError = "";
      reconnectDelay = 500;
      chrome.alarms.clear(RECONNECT_ALARM).catch(() => {});
    }
    if (message.type === "request") handleRequest(message);
  });
  nativePort.onDisconnect.addListener(() => {
    nativeError = chrome.runtime.lastError?.message || "Native host disconnected.";
    nativeConnected = false;
    nativePort = null;
    scheduleReconnect();
  });
  announce("hello").catch(() => {});
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectNative();
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
  chrome.alarms.create(RECONNECT_ALARM, { delayInMinutes: 0.5 });
}

async function withDebuggerLock(tabId, operation) {
  const previous = debuggerQueues.get(tabId) || Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  debuggerQueues.set(tabId, current);
  try { return await current; }
  finally { if (debuggerQueues.get(tabId) === current) debuggerQueues.delete(tabId); }
}

async function ensureDebugger(tabId) {
  await withDebuggerLock(tabId, async () => {
    if (attachedTabs.has(tabId)) return;
    try { await chrome.debugger.attach({ tabId }, "1.3"); }
    catch (error) { if (!/already attached/i.test(String(error?.message))) throw error; }
    attachedTabs.add(tabId);
  });
}

function childSessionKey(tabId, parentSessionId, targetId) {
  return `${tabId}:${String(parentSessionId || "")}:${String(targetId || "")}`;
}

function clearChildSessions(tabId) {
  const prefix = `${tabId}:`;
  for (const key of childSessions.keys()) if (key.startsWith(prefix)) childSessions.delete(key);
  for (const [key, waiters] of childSessionWaiters) {
    if (!key.startsWith(prefix)) continue;
    for (const waiter of waiters) waiter.reject(new Error("Browser debugger child session closed."));
    childSessionWaiters.delete(key);
  }
}

function rememberChildSession(tabId, parentSessionId, targetId, sessionId) {
  const key = childSessionKey(tabId, parentSessionId, targetId);
  childSessions.set(key, String(sessionId));
  const waiters = childSessionWaiters.get(key);
  if (!waiters) return;
  childSessionWaiters.delete(key);
  for (const waiter of waiters) waiter.resolve(String(sessionId));
}

function forgetChildSession(tabId, sessionId) {
  const prefix = `${tabId}:`;
  for (const [key, value] of childSessions) {
    if (key.startsWith(prefix) && value === String(sessionId)) childSessions.delete(key);
  }
}

function waitForChildSession(key, timeoutMs = 3_000) {
  let waiter;
  const promise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const waiters = childSessionWaiters.get(key);
      waiters?.delete(waiter);
      if (!waiters?.size) childSessionWaiters.delete(key);
      reject(new Error("Timed out waiting for Chrome to attach the out-of-process iframe."));
    }, timeoutMs);
    waiter = {
      resolve: (value) => { clearTimeout(timer); resolve(value); },
      reject: (error) => { clearTimeout(timer); reject(error); },
    };
    const waiters = childSessionWaiters.get(key) ?? new Set();
    waiters.add(waiter);
    childSessionWaiters.set(key, waiters);
  });
  // A command may fail before autoAttachFrame awaits this promise. Attach a
  // value-free rejection handler so teardown/cancellation can never surface as
  // an unhandled service-worker rejection; callers still await the original.
  void promise.catch(() => {});
  return {
    promise,
    cancel(error) {
      const waiters = childSessionWaiters.get(key);
      waiters?.delete(waiter);
      if (!waiters?.size) childSessionWaiters.delete(key);
      waiter.reject(error);
    },
  };
}

async function autoAttachFrame(tabId, parentSessionId, frameTargetId) {
  const key = childSessionKey(tabId, parentSessionId, frameTargetId);
  const existing = childSessions.get(key);
  if (existing) return existing;
  const pending = waitForChildSession(key);
  try {
    const target = { tabId, ...(parentSessionId ? { sessionId: String(parentSessionId) } : {}) };
    await withDebuggerLock(tabId, () => chrome.debugger.sendCommand(target, "Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
      filter: [{ type: "iframe", exclude: false }],
    }));
    return childSessions.get(key) ?? await pending.promise;
  } catch (error) {
    pending.cancel(error);
    throw error;
  }
}

async function ensureAutomationGroup(tabId, current) {
  try {
    if (current.automationGroup != null) {
      await chrome.tabs.group({ groupId: current.automationGroup, tabIds: tabId });
      return;
    }
  } catch { current.automationGroup = null; }
  try {
    current.automationGroup = await chrome.tabs.group({ tabIds: tabId });
    await chrome.tabGroups.update(current.automationGroup, { title: "ChatGPT Control", color: "blue" });
    await saveSets(current);
  } catch { current.automationGroup = null; }
}

async function requireClaimedTab(targetId) {
  const id = Number(targetId);
  const current = await state();
  if (!Number.isInteger(id) || (!current.claimed.has(id) && !current.automation.has(id))) {
    throw new Error("Tab has not been claimed by ChatGPT Computer Control.");
  }
  return { id, current };
}

async function handleCommand(command, params) {
  if (command === "list_tabs") return { tabs: await visibleTabs() };
  if (command === "claim_tab") {
    const id = Number(params.targetId);
    if (!Number.isInteger(id)) throw new Error("claim_tab requires a numeric target id.");
    const tab = await chrome.tabs.get(id);
    const url = String(tab.url || tab.pendingUrl || "");
    const title = String(tab.title || "");
    const current = await state();
    if (!current.automation.has(id) && !isShareableUrl(url)) throw new Error("Only ordinary http/https tabs can be claimed.");
    if (String(params.url || "") !== url || String(params.title || "") !== title) {
      throw new Error("Tab title or URL changed before it could be claimed. Refresh the browser session.");
    }
    current.claimed.add(id);
    await saveSets(current);
    await updateBadge(current);
    return { targetId: String(id), title, url };
  }
  if (command === "downloads") {
    const id = Number(params.downloadGuid);
    if (params.action === "download_cancel") {
      if (!Number.isInteger(id)) throw new Error("download_cancel requires a numeric download id.");
      await chrome.downloads.cancel(id);
    }
    if (params.action === "download_wait") {
      if (!Number.isInteger(id)) throw new Error("download_wait requires a numeric download id.");
      const deadline = Date.now() + Math.max(0, Math.min(Number(params.timeoutMs) || 30_000, 30_000));
      while (Date.now() < deadline) {
        const [item] = await chrome.downloads.search({ id });
        if (!item || item.state !== "in_progress") break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    const items = await chrome.downloads.search({ limit: 100, orderBy: ["-startTime"] });
    return { downloads: items.map((item) => ({
      guid: String(item.id), url: String(item.finalUrl || item.url || ""), suggestedFilename: String(item.filename || "").split(/[\\/]/).pop() || "download",
      state: item.state === "in_progress" ? "inProgress" : String(item.state || "unknown"), receivedBytes: Number(item.bytesReceived) || 0,
      totalBytes: Number(item.totalBytes) >= 0 ? Number(item.totalBytes) : null, path: null, size: item.state === "complete" ? Number(item.fileSize) || null : null,
    })) };
  }
  if (command === "cdp") {
    const { id } = await requireClaimedTab(params.targetId);
    const target = { tabId: id, ...(params.sessionId ? { sessionId: String(params.sessionId) } : {}) };
    await ensureDebugger(id);
    return withDebuggerLock(id, () => chrome.debugger.sendCommand(target, String(params.method), params.params || {}));
  }
  if (command === "cdp_auto_attach_frame") {
    const { id } = await requireClaimedTab(params.targetId);
    const frameTargetId = String(params.frameTargetId || "");
    const parentSessionId = String(params.parentSessionId || "");
    if (!frameTargetId || frameTargetId.length > 200) throw new Error("cdp_auto_attach_frame requires a frame target id.");
    if (parentSessionId.length > 200) throw new Error("cdp_auto_attach_frame parent session id is too long.");
    await ensureDebugger(id);
    return { sessionId: await autoAttachFrame(id, parentSessionId, frameTargetId) };
  }
  if (command === "detach") {
    const { id, current } = await requireClaimedTab(params.targetId);
    await chrome.debugger.detach({ tabId: id }).catch(() => {});
    attachedTabs.delete(id);
    clearChildSessions(id);
    if (!current.automation.has(id)) {
      current.claimed.delete(id);
      await saveSets(current);
      await updateBadge(current);
    }
    return {};
  }
  if (command === "create_tab") {
    const tab = await chrome.tabs.create({ url: String(params.url || "about:blank"), active: params.active !== false });
    const current = await state();
    current.automation.add(tab.id);
    if (params.retained === true) current.retained.add(tab.id);
    await saveSets(current);
    await ensureAutomationGroup(tab.id, current);
    await announce();
    return { targetId: String(tab.id) };
  }
  if (command === "cleanup_tabs") {
    const current = await state();
    const ids = [...current.automation].filter((id) => !current.retained.has(id));
    if (ids.length) await chrome.tabs.remove(ids).catch(() => {});
    for (const id of ids) current.automation.delete(id);
    for (const id of ids) {
      current.retained.delete(id);
      attachedTabs.delete(id);
      clearChildSessions(id);
    }
    await saveSets(current);
    await announce();
    return { closed: ids.map(String) };
  }
  if (command === "tab_action") {
    const { id, current } = await requireClaimedTab(params.targetId);
    if (params.action === "activate_tab") {
      const tab = await chrome.tabs.get(id);
      await chrome.windows.update(tab.windowId, { focused: true });
      await chrome.tabs.update(id, { active: true });
    } else if (params.action === "close_tab") await chrome.tabs.remove(id);
    else if (params.action === "navigate") await chrome.tabs.update(id, { url: String(params.url) });
    else if (params.action === "reload") await chrome.tabs.reload(id);
    else if (params.action === "back") await chrome.tabs.goBack(id);
    else if (params.action === "forward") await chrome.tabs.goForward(id);
    else if (params.action === "retain_tab" || params.action === "release_tab") {
      if (!current.automation.has(id)) throw new Error("Only automation-created tabs can change lifecycle.");
      if (params.action === "retain_tab") current.retained.add(id); else current.retained.delete(id);
      await saveSets(current);
    } else throw new Error(`Unsupported tab action: ${params.action}`);
    await announce();
    return {};
  }
  throw new Error(`Unsupported native command: ${command}`);
}

async function handleRequest(message) {
  try {
    const result = await handleCommand(String(message.command), message.params || {});
    post({ type: "response", requestId: message.requestId, ok: true, result });
  } catch (error) {
    post({ type: "response", requestId: message.requestId, ok: false, error: error?.message || String(error) });
  }
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId == null) return;
  if (method === "Target.attachedToTarget" && params?.sessionId && params?.targetInfo?.targetId) {
    rememberChildSession(source.tabId, source.sessionId || "", params.targetInfo.targetId, params.sessionId);
  } else if (method === "Target.detachedFromTarget" && params?.sessionId) {
    forgetChildSession(source.tabId, params.sessionId);
  }
  post({ type: "cdp_event", targetId: String(source.tabId), method, params });
});
chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId != null) { attachedTabs.delete(source.tabId); clearChildSessions(source.tabId); }
});
chrome.tabs.onUpdated.addListener(() => announce().catch(() => {}));
chrome.tabs.onRemoved.addListener((tabId) => {
  (async () => {
    const current = await state();
    current.claimed.delete(tabId);
    current.automation.delete(tabId);
    current.retained.delete(tabId);
    attachedTabs.delete(tabId);
    clearChildSessions(tabId);
    await saveSets(current);
    await announce();
  })().catch(() => {});
});
chrome.tabGroups.onRemoved.addListener((group) => {
  (async () => {
    const current = await state();
    if (current.automationGroup === group.id) {
      current.automationGroup = null;
      await saveSets(current);
    }
  })().catch(() => {});
});
chrome.webNavigation.onCreatedNavigationTarget.addListener((details) => {
  (async () => {
    const current = await state();
    if (!current.claimed.has(details.sourceTabId) && !current.automation.has(details.sourceTabId)) return;
    current.automation.add(details.tabId);
    current.retained.delete(details.tabId);
    await saveSets(current);
    await ensureAutomationGroup(details.tabId, current);
    await announce();
  })().catch(() => {});
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RECONNECT_ALARM && !nativePort) connectNative();
  if (alarm.name === HEARTBEAT_ALARM) {
    if (nativePort) post({ type: "heartbeat", timestamp: Date.now() });
    else connectNative();
  }
});
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error("No active browser tab.");
    const current = await state();
    if (message.type === "status") return {
      eligible: isShareableUrl(tab.url), claimed: current.claimed.has(tab.id) || current.automation.has(tab.id),
      connected: nativeConnected, tabId: String(tab.id),
      extensionId: chrome.runtime.id, nativeError,
    };
    if (message.type === "reconnect") { if (!nativePort) connectNative(); return { connected: nativeConnected }; }
    throw new Error("Unsupported popup message.");
  })().then(sendResponse, (error) => sendResponse({ error: error?.message || String(error) }));
  return true;
});

connectNative();
chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: 0.5 });
updateBadge().catch(() => {});

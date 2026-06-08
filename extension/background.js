importScripts("license.js");

let offscreenLock = null;

async function ensureOffscreen() {
  // Serialize callers: the keep-alive alarm and the popup can both call
  // createDocument() at once, and the loser throws "Only a single offscreen
  // document may be created." A shared in-flight promise collapses the race.
  if (offscreenLock) return offscreenLock;
  offscreenLock = (async () => {
    try {
      if (await chrome.offscreen.hasDocument()) return;
      await chrome.offscreen.createDocument({
        url: "offscreen.html",
        reasons: ["WEB_RTC"],
        justification: "Persistent WebSocket connection to local MCP server",
      });
    } catch (e) {
      // Benign race: hasDocument() can lag a still-closing/opening doc, so the
      // create lost the race and a document already exists. Nothing to recover.
      if (!/single offscreen document/i.test(e.message || "")) {
        console.error("[BrowserControl] ensureOffscreen failed:", e.message);
      }
    } finally {
      offscreenLock = null;
    }
  })();
  return offscreenLock;
}

// Force a fresh offscreen document. The popup only sends ensure_offscreen while
// the socket is DOWN (attemptConnect() returns early if already connected), so
// tearing the existing doc down here is safe — and it's the ONLY way to recover
// a "zombie" offscreen document whose WebSocket has died but that hasDocument()
// still reports as present. Plain create-if-missing can never replace it.
async function recreateOffscreen() {
  try {
    if (await chrome.offscreen.hasDocument()) {
      await chrome.offscreen.closeDocument();
    }
  } catch (e) {
    console.error("[BrowserControl] closeDocument failed:", e.message);
  }
  return ensureOffscreen();
}

chrome.runtime.onStartup.addListener(ensureOffscreen);
chrome.runtime.onInstalled.addListener(async (details) => {
  await ensureOffscreen();
  if (details.reason === "install") await initTrial();
});

chrome.alarms.create("keepOffscreenAlive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "keepOffscreenAlive") ensureOffscreen();
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "command") {
    handleCommand(msg).then(sendResponse);
    return true;
  }
  if (msg.type === "ensure_offscreen") {
    // Popup asks us to (re)connect. Force a fresh offscreen doc — this only
    // fires while disconnected, so it recovers a stale/zombie offscreen document
    // that create-if-missing (ensureOffscreen) would skip over.
    recreateOffscreen()
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (msg.type === "subscribe") {
    startMonitor(msg.eventType, msg.filter);
    sendResponse({ success: true });
    return false;
  }
  if (msg.type === "unsubscribe") {
    stopMonitor(msg.eventType);
    sendResponse({ success: true });
    return false;
  }
  if (msg.type === "dom_mutation_batch") {
    sendEvent("dom_mutation", {
      mutations: msg.mutations,
      url: msg.url,
      count: msg.mutations.length,
    });
    return false;
  }
});

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

// ── Debugger Session Manager (reference-counted) ──

const debuggerSessions = new Map();

async function acquireDebugger(tabId) {
  var session = debuggerSessions.get(tabId);
  if (session) {
    session.refCount++;
    return;
  }
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
  } catch (e) {
    if (!e.message?.includes("Already attached")) {
      throw new Error("Debugger attach failed: " + e.message);
    }
  }
  debuggerSessions.set(tabId, { refCount: 1, persistent: false });
}

async function releaseDebugger(tabId, force) {
  var session = debuggerSessions.get(tabId);
  if (!session) return;
  session.refCount--;
  if (session.refCount <= 0 && !session.persistent || force) {
    debuggerSessions.delete(tabId);
    try { await chrome.debugger.detach({ tabId }); } catch {}
  }
}

function markDebuggerPersistent(tabId) {
  var session = debuggerSessions.get(tabId);
  if (session) session.persistent = true;
}

async function releasePersistentDebugger(tabId) {
  var session = debuggerSessions.get(tabId);
  if (session) {
    session.persistent = false;
    if (session.refCount <= 0) {
      debuggerSessions.delete(tabId);
      try { await chrome.debugger.detach({ tabId }); } catch {}
    }
  }
}

chrome.debugger.onDetach.addListener(function (source) {
  if (source.tabId) debuggerSessions.delete(source.tabId);
});

async function handleCommand(msg) {
  const { command, params } = msg;

  const access = await checkAccess();
  // Only premium commands are gated once the trial ends — everything else stays
  // usable on the free tier, so an expired trial or a declined payment never
  // fully locks the user out (the old hard block was a dead-end). PREMIUM_COMMANDS
  // ships empty, so enabling enforcement is a deliberate, one-place decision.
  if (access.tier === "free" && isPremiumCommand(command)) {
    return {
      success: false,
      error:
        (access.notice ? access.notice + " " : "") +
        `"${command}" requires an active license. Activate a key or buy one in the extension popup.`,
      licenseStatus: access.status,
      tier: access.tier,
      purchaseUrl: PURCHASE_URL,
    };
  }

  try {
    switch (command) {
      case "get_active_tab_info":
        return await cmdGetActiveTabInfo();
      case "execute_js":
        return await cmdExecuteJs(params);
      case "fill_field":
        return await cmdFillField(params);
      case "click_element":
        return await cmdClickElement(params);
      case "get_page_content":
        return await cmdGetPageContent(params);
      case "get_form_fields":
        return await cmdGetFormFields();
      case "select_option":
        return await cmdSelectOption(params);
      case "list_tabs":
        return await cmdListTabs();
      case "switch_tab":
        return await cmdSwitchTab(params);
      case "reload_extension":
        return await cmdReloadExtension();
      case "navigate":
        return await cmdNavigate(params);
      case "wait_for_load":
        return await cmdWaitForLoad(params);
      case "wait_for_element":
        return await cmdWaitForElement(params);
      case "scroll_to":
        return await cmdScrollTo(params);
      case "scroll_by":
        return await cmdScrollBy(params);
      case "get_scroll_position":
        return await cmdGetScrollPosition(params);
      case "take_screenshot":
        return await cmdTakeScreenshot();
      case "upload_file":
        return await cmdUploadFile(params);
      case "close_dialogs":
        return await cmdCloseDialogs(params);
      case "press_key":
        return await cmdPressKey(params);
      case "hover_element":
        return await cmdHoverElement(params);
      case "get_element_attributes":
        return await cmdGetElementAttributes(params);
      case "find_elements":
        return await cmdFindElements(params);
      case "go_back":
        return await cmdGoBack();
      case "go_forward":
        return await cmdGoForward();
      case "new_tab":
        return await cmdNewTab(params);
      case "close_tab":
        return await cmdCloseTab(params);
      case "set_viewport":
        return await cmdSetViewport(params);
      case "get_cookies":
        return await cmdGetCookies();
      case "get_cookie":
        return await cmdGetCookie(params);
      case "set_cookie":
        return await cmdSetCookie(params);
      case "delete_cookie":
        return await cmdDeleteCookie(params);
      case "clear_cookies":
        return await cmdClearCookies(params);
      case "get_network_requests":
        return await cmdGetNetworkRequests(params);
      case "wait_for_network_request":
        return await cmdWaitForNetworkRequest(params);
      case "read_clipboard":
        return await cmdReadClipboard();
      case "write_clipboard":
        return await cmdWriteClipboard(params);
      case "read_clipboard_html":
        return await cmdReadClipboardHtml();
      case "highlight_element":
        return await cmdHighlightElement(params);
      case "highlight_all":
        return await cmdHighlightAll(params);
      case "clear_highlights":
        return await cmdClearHighlights();
      case "annotate_element":
        return await cmdAnnotateElement(params);
      case "play_tone":
        return await cmdPlayTone(params);
      case "extract_table":
        return await cmdExtractTable(params);
      case "get_links":
        return await cmdGetLinks(params);
      case "get_metadata":
        return await cmdGetMetadata();
      case "query_selector_all":
        return await cmdQuerySelectorAll(params);
      case "get_storage":
        return await cmdGetStorage(params);
      case "set_storage":
        return await cmdSetStorage(params);
      case "remove_storage":
        return await cmdRemoveStorage(params);
      case "clear_storage":
        return await cmdClearStorage(params);
      case "list_frames":
        return await cmdListFrames();
      case "frame_content":
        return await cmdFrameContent(params);
      case "frame_click":
        return await cmdFrameClick(params);
      case "frame_fill":
        return await cmdFrameFill(params);
      case "frame_execute_js":
        return await cmdFrameExecuteJs(params);
      case "devtools_console_log":
        return await cmdDevtoolsConsoleLog(params);
      case "devtools_performance_metrics":
        return await cmdDevtoolsPerformanceMetrics();
      case "devtools_performance_trace":
        return await cmdDevtoolsPerformanceTrace(params);
      case "devtools_dom_tree":
        return await cmdDevtoolsDomTree(params);
      case "devtools_css_computed":
        return await cmdDevtoolsCssComputed(params);
      case "devtools_network_throttle":
        return await cmdDevtoolsNetworkThrottle(params);
      case "devtools_cpu_throttle":
        return await cmdDevtoolsCpuThrottle(params);
      case "devtools_coverage":
        return await cmdDevtoolsCoverage(params);
      case "devtools_heap_snapshot":
        return await cmdDevtoolsHeapSnapshot();
      case "devtools_emulate_device":
        return await cmdDevtoolsEmulateDevice(params);
      case "keyboard_shortcut":
        return await cmdKeyboardShortcut(params);
      case "keyboard_type_text":
        return await cmdKeyboardTypeText(params);
      case "keyboard_hold_key":
        return await cmdKeyboardHoldKey(params);
      case "keyboard_combo":
        return await cmdKeyboardCombo(params);
      case "keyboard_shortcuts_list":
        return await cmdKeyboardShortcutsList(params);
      // Phase 1: Core Interaction
      case "right_click":
        return await cmdRightClick(params);
      case "middle_click":
        return await cmdMiddleClick(params);
      case "double_click":
        return await cmdDoubleClick(params);
      case "triple_click":
        return await cmdTripleClick(params);
      case "drag_and_drop":
        return await cmdDragAndDrop(params);
      case "select_text":
        return await cmdSelectText(params);
      case "get_selection":
        return await cmdGetSelection();
      case "touch_event":
        return await cmdTouchEvent(params);
      // Phase 2: Tab & Window Management
      case "pin_tab":
        return await cmdPinTab(params);
      case "mute_tab":
        return await cmdMuteTab(params);
      case "duplicate_tab":
        return await cmdDuplicateTab(params);
      case "move_tab":
        return await cmdMoveTab(params);
      case "create_window":
        return await cmdCreateWindow(params);
      case "close_window":
        return await cmdCloseWindow(params);
      case "resize_window":
        return await cmdResizeWindow(params);
      case "list_windows":
        return await cmdListWindows();
      // Phase 3: Page Features
      case "reload_page":
        return await cmdReloadPage(params);
      case "stop_loading":
        return await cmdStopLoading();
      case "find_text":
        return await cmdFindText(params);
      case "set_zoom":
        return await cmdSetZoom(params);
      case "save_pdf":
        return await cmdSavePdf(params);
      case "save_html":
        return await cmdSaveHtml();
      // Phase 4: Media Control
      case "media_control":
        return await cmdMediaControl(params);
      case "media_volume":
        return await cmdMediaVolume(params);
      case "media_seek":
        return await cmdMediaSeek(params);
      case "media_playback_rate":
        return await cmdMediaPlaybackRate(params);
      case "media_pip":
        return await cmdMediaPip(params);
      case "media_state":
        return await cmdMediaState(params);
      // Phase 5: Emulation & Overrides
      case "override_geolocation":
        return await cmdOverrideGeolocation(params);
      case "override_timezone":
        return await cmdOverrideTimezone(params);
      case "override_locale":
        return await cmdOverrideLocale(params);
      case "override_user_agent":
        return await cmdOverrideUserAgent(params);
      case "override_media":
        return await cmdOverrideMedia(params);
      case "override_vision":
        return await cmdOverrideVision(params);
      case "override_permission":
        return await cmdOverridePermission(params);
      case "clear_overrides":
        return await cmdClearOverrides();
      // Phase 7: Accessibility
      case "accessibility_tree":
        return await cmdAccessibilityTree(params);
      case "accessibility_info":
        return await cmdAccessibilityInfo(params);
      case "aria_check":
        return await cmdAriaCheck(params);
      // Phase 8: Advanced Storage
      case "indexeddb_list":
        return await cmdIndexeddbList();
      case "indexeddb_query":
        return await cmdIndexeddbQuery(params);
      case "indexeddb_clear":
        return await cmdIndexeddbClear(params);
      case "cache_list":
        return await cmdCacheList();
      case "cache_query":
        return await cmdCacheQuery(params);
      case "cache_clear":
        return await cmdCacheClear(params);
      // Phase 9: Service Workers
      case "list_service_workers":
        return await cmdListServiceWorkers();
      case "unregister_service_worker":
        return await cmdUnregisterServiceWorker(params);
      case "update_service_worker":
        return await cmdUpdateServiceWorker(params);
      // Phase 10: WebSocket Monitoring
      case "websocket_monitor":
        return await cmdWebsocketMonitor(params);
      case "websocket_list":
        return await cmdWebsocketList();
      // Phase 12: CSS & Animation
      case "animation_control":
        return await cmdAnimationControl(params);
      // Phase 13: Focus Management
      case "focus_element":
        return await cmdFocusElement(params);
      case "tab_focus":
        return await cmdTabFocus(params);
      case "get_focused_element":
        return await cmdGetFocusedElement();
      // Phase 14: Notifications & Dialogs
      case "dialog_handle":
        return await cmdDialogHandle(params);
      case "notification_monitor":
        return await cmdNotificationMonitor(params);
      default:
        return { success: false, error: `Unknown command: ${command}` };
    }
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// --- Tab info ---

async function cmdGetActiveTabInfo() {
  const tab = await getActiveTab();
  if (!tab) return { success: false, error: "No active tab found" };
  return {
    success: true,
    data: { tabId: tab.id, url: tab.url, title: tab.title },
  };
}

// --- Navigation ---

async function cmdNavigate({ url }) {
  const tab = await getActiveTab();
  if (!tab) return { success: false, error: "No active tab found" };

  await chrome.tabs.update(tab.id, { url });
  return { success: true, data: `Navigating to ${url}` };
}

async function cmdWaitForLoad({ timeoutMs }) {
  const timeout = timeoutMs || 15000;
  const tab = await getActiveTab();
  if (!tab) return { success: false, error: "No active tab found" };

  const start = Date.now();
  while (Date.now() - start < timeout) {
    const current = await chrome.tabs.get(tab.id);
    if (current.status === "complete") {
      return { success: true, data: { url: current.url, title: current.title } };
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return { success: false, error: `Page did not finish loading within ${timeout}ms` };
}

async function cmdWaitForElement({ selector, timeoutMs }) {
  const timeout = timeoutMs || 10000;
  const tab = await getActiveTab();
  if (!tab) return { success: false, error: "No active tab found" };

  const start = Date.now();
  while (Date.now() - start < timeout) {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        return { found: true, visible: rect.width > 0 && rect.height > 0 };
      },
      args: [selector],
      world: "MAIN",
    });

    if (result.result?.found) {
      return { success: true, data: result.result };
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return { success: false, error: `Element ${selector} not found within ${timeout}ms` };
}

// --- JavaScript execution ---

async function cmdExecuteJs({ code }) {
  const tab = await getActiveTab();
  if (!tab) return { success: false, error: "No active tab found" };

  try {
    await chrome.debugger.attach({ tabId: tab.id }, "1.3");
  } catch (e) {
    if (!e.message?.includes("Already attached")) {
      return { success: false, error: `Debugger attach failed: ${e.message}` };
    }
  }

  try {
    const result = await chrome.debugger.sendCommand(
      { tabId: tab.id },
      "Runtime.evaluate",
      {
        expression: code,
        returnByValue: true,
        awaitPromise: true,
        userGesture: true,
      }
    );

    if (result.exceptionDetails) {
      const ed = result.exceptionDetails;
      // CDP puts the literal "Uncaught" in `text`; the real message lives in
      // exception.description (or .value for thrown non-Error values). Prefer
      // the richer field so the caller doesn't just get "Uncaught".
      const detail =
        ed.exception?.description ||
        ed.exception?.value ||
        ed.text ||
        "JS execution error";
      return { success: false, error: String(detail) };
    }

    const r = result.result || {};
    if (r.value !== undefined) {
      return { success: true, data: r.value };
    }
    // With returnByValue, CDP yields no `value` for results it can't serialize
    // (DOM nodes, functions, cross-frame documents, circular objects). Don't
    // silently report null — tell the caller why so they can return a
    // serializable value instead.
    if (r.type && r.type !== "undefined") {
      return {
        success: true,
        data: null,
        note: `Return value was not serializable (${r.subtype || r.type}${r.className ? ": " + r.className : ""}). Return a JSON-serializable value (e.g. el.outerHTML, el.length, or a plain object) instead.`,
      };
    }
    return { success: true, data: null };
  } finally {
    try {
      await chrome.debugger.detach({ tabId: tab.id });
    } catch {}
  }
}

// --- Form interaction (React-compatible) ---

async function cmdFillField({ selector, value }) {
  const tab = await getActiveTab();
  if (!tab) return { success: false, error: "No active tab found" };

  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (selector, value) => {
      const el = document.querySelector(selector);
      if (!el) return { success: false, error: `Element not found: ${selector}` };

      el.focus();

      if (el.getAttribute("contenteditable") !== null) {
        el.focus();
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(el);
        selection.removeAllRanges();
        selection.addRange(range);
        document.execCommand("insertText", false, value);
        return { success: true, data: `Filled contenteditable ${selector} with ${value.length} chars` };
      }

      const nativeInputValueSetter =
        Object.getOwnPropertyDescriptor(
          el.tagName === "TEXTAREA"
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype,
          "value"
        )?.set;

      if (nativeInputValueSetter) {
        nativeInputValueSetter.call(el, value);
      } else {
        el.value = value;
      }

      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.dispatchEvent(new Event("blur", { bubbles: true }));

      return { success: true, data: `Filled ${selector} with ${value.length} chars` };
    },
    args: [selector, value],
    world: "MAIN",
  });

  return result.result;
}

async function cmdClickElement({ selector }) {
  const tab = await getActiveTab();
  if (!tab) return { success: false, error: "No active tab found" };

  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (selector) => {
      const el = document.querySelector(selector);
      if (!el) return { success: false, error: `Element not found: ${selector}` };

      el.scrollIntoView({ behavior: "instant", block: "center" });
      el.click();
      return { success: true, data: `Clicked ${selector}` };
    },
    args: [selector],
    world: "MAIN",
  });

  return result.result;
}

async function cmdSelectOption({ selector, value }) {
  const tab = await getActiveTab();
  if (!tab) return { success: false, error: "No active tab found" };

  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (selector, value) => {
      const el = document.querySelector(selector);
      if (!el) return { success: false, error: `Element not found: ${selector}` };

      const nativeSetter = Object.getOwnPropertyDescriptor(
        HTMLSelectElement.prototype,
        "value"
      )?.set;

      if (nativeSetter) {
        nativeSetter.call(el, value);
      } else {
        el.value = value;
      }

      el.dispatchEvent(new Event("change", { bubbles: true }));
      return { success: true, data: `Selected "${value}" in ${selector}` };
    },
    args: [selector, value],
    world: "MAIN",
  });

  return result.result;
}

// --- Page reading ---

async function cmdGetPageContent({ selector }) {
  const tab = await getActiveTab();
  if (!tab) return { success: false, error: "No active tab found" };

  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (selector) => {
      const el = selector ? document.querySelector(selector) : document.body;
      if (!el) return { success: false, error: `Element not found: ${selector}` };
      return { success: true, data: el.innerText.substring(0, 50000) };
    },
    args: [selector || null],
    world: "MAIN",
  });

  return result.result;
}

async function cmdGetFormFields() {
  const tab = await getActiveTab();
  if (!tab) return { success: false, error: "No active tab found" };

  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      const fields = [];
      const inputs = document.querySelectorAll(
        'input, textarea, select, [contenteditable="true"]'
      );
      inputs.forEach((el, i) => {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return;

        const field = {
          index: i,
          tag: el.tagName.toLowerCase(),
          type: el.type || null,
          name: el.name || null,
          id: el.id || null,
          placeholder: el.placeholder || null,
          value: el.value || el.textContent || "",
          selector: el.id
            ? `#${el.id}`
            : el.name
            ? `[name="${el.name}"]`
            : null,
        };

        const label = el.labels?.[0]?.textContent?.trim();
        if (label) field.label = label;

        const ariaLabel = el.getAttribute("aria-label");
        if (ariaLabel) field.ariaLabel = ariaLabel;

        fields.push(field);
      });
      return { success: true, data: fields };
    },
    args: [],
    world: "MAIN",
  });

  return result.result;
}

// --- Scroll ---

async function cmdScrollTo({ selector }) {
  const tab = await getActiveTab();
  if (!tab) return { success: false, error: "No active tab found" };

  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (selector) => {
      if (!selector) {
        window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
        return { success: true, data: "Scrolled to bottom" };
      }
      const el = document.querySelector(selector);
      if (!el) return { success: false, error: `Element not found: ${selector}` };
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      return { success: true, data: `Scrolled to ${selector}` };
    },
    args: [selector || null],
    world: "MAIN",
  });

  return result.result;
}

async function cmdScrollBy({ direction, amount, selector }) {
  const tab = await getActiveTab();
  if (!tab) return { success: false, error: "No active tab found" };

  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (direction, amount, selector) => {
      var target = selector ? document.querySelector(selector) : window;
      if (selector && !target) return { success: false, error: "Element not found: " + selector };

      var px = amount || 500;

      // Detect flex column-reverse containers (e.g. LinkedIn messages)
      // These have negative scrollTop values where -scrollHeight is the top
      var isReversed = false;
      if (selector && target !== window) {
        var style = window.getComputedStyle(target);
        var minScroll = target.scrollHeight - target.clientHeight;
        isReversed = (style.flexDirection === "column-reverse") ||
          (target.scrollTop < 0) || (target.scrollTop === 0 && minScroll > 0 && target.scrollBy(0, -1) === undefined && target.scrollTop < 0 && (target.scrollTop = 0) === 0);
        // Simpler check: just test if scrollTop can go negative
        target.scrollTop = -1;
        if (target.scrollTop < 0) { isReversed = true; }
        target.scrollTop = target.scrollTop + 1; // restore
      }

      var dx = 0, dy = 0;
      switch (direction) {
        case "up": dy = isReversed ? -px : -px; break;
        case "down": dy = isReversed ? px : px; break;
        case "left": dx = -px; break;
        case "right": dx = px; break;
        case "top":
          if (selector) {
            if (isReversed) target.scrollTop = -(target.scrollHeight);
            else target.scrollTop = 0;
          } else {
            window.scrollTo({ top: 0, behavior: "smooth" });
          }
          return { success: true, data: "Scrolled to top" };
        case "bottom":
          if (selector) {
            if (isReversed) target.scrollTop = 0;
            else target.scrollTop = target.scrollHeight;
          } else {
            window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
          }
          return { success: true, data: "Scrolled to bottom" };
        default: dy = px;
      }

      if (selector) {
        target.scrollBy(dx, isReversed ? -dy : dy);
      } else {
        window.scrollBy({ left: dx, top: dy, behavior: "smooth" });
      }

      var pos = selector
        ? { scrollTop: target.scrollTop, scrollHeight: target.scrollHeight, reversed: isReversed }
        : { scrollY: window.scrollY, pageHeight: document.body.scrollHeight };
      return { success: true, data: { scrolled: direction + " " + px + "px", position: pos } };
    },
    args: [direction || "down", amount || 500, selector || null],
    world: "MAIN",
  });

  return result.result;
}

async function cmdGetScrollPosition({ selector }) {
  const tab = await getActiveTab();
  if (!tab) return { success: false, error: "No active tab found" };

  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (selector) => {
      if (selector) {
        var el = document.querySelector(selector);
        if (!el) return { success: false, error: "Element not found: " + selector };

        // Detect column-reverse (scrollTop goes negative)
        var savedScroll = el.scrollTop;
        el.scrollTop = -1;
        var isReversed = el.scrollTop < 0;
        el.scrollTop = savedScroll;

        var maxScroll = el.scrollHeight - el.clientHeight;
        var atTop, atBottom;
        if (isReversed) {
          atTop = el.scrollTop <= -(maxScroll - 2);
          atBottom = el.scrollTop >= -2;
        } else {
          atTop = el.scrollTop <= 2;
          atBottom = Math.abs(el.scrollHeight - el.clientHeight - el.scrollTop) < 2;
        }

        return {
          success: true,
          data: {
            scrollTop: el.scrollTop, scrollLeft: el.scrollLeft,
            scrollHeight: el.scrollHeight, scrollWidth: el.scrollWidth,
            clientHeight: el.clientHeight, clientWidth: el.clientWidth,
            reversed: isReversed, atTop: atTop, atBottom: atBottom,
          },
        };
      }
      return {
        success: true,
        data: {
          scrollX: window.scrollX, scrollY: window.scrollY,
          pageHeight: document.body.scrollHeight, pageWidth: document.body.scrollWidth,
          viewportHeight: window.innerHeight, viewportWidth: window.innerWidth,
          atTop: window.scrollY === 0,
          atBottom: Math.abs(document.body.scrollHeight - window.innerHeight - window.scrollY) < 2,
        },
      };
    },
    args: [selector || null],
    world: "MAIN",
  });

  return result.result;
}

// --- Screenshot ---

async function cmdTakeScreenshot() {
  const tab = await getActiveTab();
  if (!tab) return { success: false, error: "No active tab found" };

  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
    format: "png",
  });

  return { success: true, data: dataUrl };
}

// --- File upload ---

async function cmdUploadFile({ selector, filePaths }) {
  const tab = await getActiveTab();
  if (!tab) return { success: false, error: "No active tab found" };

  // Get the DOM node ID via debugger
  try {
    await chrome.debugger.attach({ tabId: tab.id }, "1.3");
  } catch (e) {
    if (!e.message?.includes("Already attached")) {
      return { success: false, error: `Debugger attach failed: ${e.message}` };
    }
  }

  try {
    const doc = await chrome.debugger.sendCommand(
      { tabId: tab.id },
      "DOM.getDocument",
      {}
    );

    const node = await chrome.debugger.sendCommand(
      { tabId: tab.id },
      "DOM.querySelector",
      { nodeId: doc.root.nodeId, selector }
    );

    if (!node.nodeId) {
      return { success: false, error: `Element not found: ${selector}` };
    }

    const paths = Array.isArray(filePaths) ? filePaths : [filePaths];

    await chrome.debugger.sendCommand(
      { tabId: tab.id },
      "DOM.setFileInputFiles",
      { nodeId: node.nodeId, files: paths }
    );

    return {
      success: true,
      data: `Uploaded ${paths.length} file(s): ${paths.map((p) => p.split("/").pop()).join(", ")}`,
    };
  } finally {
    try {
      await chrome.debugger.detach({ tabId: tab.id });
    } catch {}
  }
}

// --- Tab management ---

async function cmdListTabs() {
  const tabs = await chrome.tabs.query({});
  const data = tabs.map((t) => ({
    tabId: t.id,
    index: t.index,
    url: t.url,
    title: t.title,
    active: t.active,
    windowId: t.windowId,
  }));
  return { success: true, data };
}

async function cmdSwitchTab({ tabId, urlPattern }) {
  let tab;
  if (tabId) {
    tab = await chrome.tabs.get(tabId);
  } else if (urlPattern) {
    const allTabs = await chrome.tabs.query({});
    const pattern = urlPattern.toLowerCase();
    tab = allTabs.find(
      (t) =>
        t.url?.toLowerCase().includes(pattern) ||
        t.title?.toLowerCase().includes(pattern)
    );
    if (!tab) return { success: false, error: `No tab matching: ${urlPattern}` };
  } else {
    return { success: false, error: "Provide tabId or urlPattern" };
  }

  await chrome.tabs.update(tab.id, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
  return {
    success: true,
    data: { tabId: tab.id, url: tab.url, title: tab.title },
  };
}

// --- Extension management ---

let lastReloadTime = 0;
const RELOAD_COOLDOWN_MS = 10000;

async function cmdReloadExtension() {
  const now = Date.now();
  if (now - lastReloadTime < RELOAD_COOLDOWN_MS) {
    return { success: false, error: `Reload throttled — wait ${Math.ceil((RELOAD_COOLDOWN_MS - (now - lastReloadTime)) / 1000)}s` };
  }
  lastReloadTime = now;
  setTimeout(() => chrome.runtime.reload(), 200);
  return { success: true, data: "Extension reloading..." };
}

// --- Close dialogs/modals/popups ---

async function cmdCloseDialogs({ strategy }) {
  const tab = await getActiveTab();
  if (!tab) return { success: false, error: "No active tab found" };

  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (strategy) => {
      var closed = [];

      if (!strategy || strategy === "escape") {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true }));
        document.dispatchEvent(new KeyboardEvent("keyup", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true }));
        closed.push("escape_key");
      }

      if (!strategy || strategy === "buttons") {
        var closeSelectors = [
          '[aria-label*="close" i]', '[aria-label*="dismiss" i]', '[aria-label*="discard" i]',
          '[title*="close" i]', '[title*="dismiss" i]',
          'button.close', '.modal-close', '.dialog-close', '.popup-close',
          '[data-dismiss="modal"]', '[data-dismiss="alert"]',
          '.modal .btn-close', '.modal [aria-label="Close"]',
          'dialog [aria-label="Close"]',
        ];
        closeSelectors.forEach(function(sel) {
          try {
            document.querySelectorAll(sel).forEach(function(el) {
              var rect = el.getBoundingClientRect();
              if (rect.width > 0 && rect.height > 0) {
                el.click();
                closed.push(sel);
              }
            });
          } catch (e) {}
        });
      }

      if (!strategy || strategy === "overlays") {
        document.querySelectorAll('[class*="overlay"], [class*="backdrop"], [class*="modal-bg"]').forEach(function(el) {
          var style = window.getComputedStyle(el);
          if (style.position === "fixed" || style.position === "absolute") {
            el.click();
            closed.push("overlay:" + (el.className || "").substring(0, 40));
          }
        });
      }

      if (!strategy || strategy === "dialogs") {
        document.querySelectorAll("dialog[open]").forEach(function(d) {
          d.close();
          closed.push("dialog:closed");
        });
      }

      return { success: true, data: { closed: closed, count: closed.length } };
    },
    args: [strategy || null],
    world: "MAIN",
  });

  return result.result;
}

// --- Keyboard ---

async function cmdPressKey({ key, modifiers, selector }) {
  const tab = await getActiveTab();
  if (!tab) return { success: false, error: "No active tab found" };

  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (key, modifiers, selector) => {
      var mods = modifiers || {};
      var target = selector ? document.querySelector(selector) : document.activeElement || document.body;
      if (selector && !target) return { success: false, error: "Element not found: " + selector };

      var keyMap = {
        "Enter": { code: "Enter", keyCode: 13 },
        "Tab": { code: "Tab", keyCode: 9 },
        "Escape": { code: "Escape", keyCode: 27 },
        "Backspace": { code: "Backspace", keyCode: 8 },
        "Delete": { code: "Delete", keyCode: 46 },
        "ArrowUp": { code: "ArrowUp", keyCode: 38 },
        "ArrowDown": { code: "ArrowDown", keyCode: 40 },
        "ArrowLeft": { code: "ArrowLeft", keyCode: 37 },
        "ArrowRight": { code: "ArrowRight", keyCode: 39 },
        "Space": { code: "Space", keyCode: 32 },
      };

      var mapped = keyMap[key] || { code: "Key" + key.toUpperCase(), keyCode: key.charCodeAt(0) };
      var opts = {
        key: key, code: mapped.code, keyCode: mapped.keyCode,
        bubbles: true, cancelable: true,
        ctrlKey: !!mods.ctrl, shiftKey: !!mods.shift,
        altKey: !!mods.alt, metaKey: !!mods.meta,
      };

      target.dispatchEvent(new KeyboardEvent("keydown", opts));
      target.dispatchEvent(new KeyboardEvent("keypress", opts));
      target.dispatchEvent(new KeyboardEvent("keyup", opts));

      return { success: true, data: "Pressed " + key + (Object.keys(mods).length ? " with " + JSON.stringify(mods) : "") };
    },
    args: [key, modifiers || null, selector || null],
    world: "MAIN",
  });

  return result.result;
}

// --- Hover ---

async function cmdHoverElement({ selector }) {
  const tab = await getActiveTab();
  if (!tab) return { success: false, error: "No active tab found" };

  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (selector) => {
      var el = document.querySelector(selector);
      if (!el) return { success: false, error: "Element not found: " + selector };
      el.scrollIntoView({ behavior: "instant", block: "center" });
      el.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
      el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      return { success: true, data: "Hovered " + selector };
    },
    args: [selector],
    world: "MAIN",
  });

  return result.result;
}

// --- Element attributes ---

async function cmdGetElementAttributes({ selector }) {
  const tab = await getActiveTab();
  if (!tab) return { success: false, error: "No active tab found" };

  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (selector) => {
      var el = document.querySelector(selector);
      if (!el) return { success: false, error: "Element not found: " + selector };
      var attrs = {};
      for (var i = 0; i < el.attributes.length; i++) {
        attrs[el.attributes[i].name] = el.attributes[i].value;
      }
      var rect = el.getBoundingClientRect();
      return {
        success: true,
        data: {
          tag: el.tagName.toLowerCase(), attributes: attrs,
          text: (el.innerText || "").substring(0, 500),
          boundingRect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          visible: rect.width > 0 && rect.height > 0,
          childCount: el.children.length,
        },
      };
    },
    args: [selector],
    world: "MAIN",
  });

  return result.result;
}

// --- Find elements ---

async function cmdFindElements({ selector, text, limit }) {
  const tab = await getActiveTab();
  if (!tab) return { success: false, error: "No active tab found" };

  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (selector, text, limit) => {
      var maxResults = limit || 20;
      var elements = [];

      if (selector) {
        document.querySelectorAll(selector).forEach(function(el, i) {
          if (i >= maxResults) return;
          var rect = el.getBoundingClientRect();
          elements.push({
            index: i, tag: el.tagName.toLowerCase(),
            id: el.id || null, className: (el.className || "").toString().substring(0, 100),
            text: (el.innerText || "").substring(0, 100),
            visible: rect.width > 0 && rect.height > 0,
            selector: el.id ? "#" + el.id : null,
          });
        });
      }

      if (text) {
        var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
        var textLower = text.toLowerCase();
        var count = 0;
        while (walker.nextNode() && count < maxResults) {
          if (walker.currentNode.textContent.toLowerCase().includes(textLower)) {
            var parent = walker.currentNode.parentElement;
            if (parent) {
              var rect = parent.getBoundingClientRect();
              elements.push({
                index: count, tag: parent.tagName.toLowerCase(),
                id: parent.id || null, className: (parent.className || "").toString().substring(0, 100),
                text: walker.currentNode.textContent.substring(0, 100),
                visible: rect.width > 0 && rect.height > 0,
                selector: parent.id ? "#" + parent.id : null,
              });
              count++;
            }
          }
        }
      }

      return { success: true, data: { count: elements.length, elements: elements } };
    },
    args: [selector || null, text || null, limit || 20],
    world: "MAIN",
  });

  return result.result;
}

// --- Navigation: back/forward ---

async function cmdGoBack() {
  const tab = await getActiveTab();
  if (!tab) return { success: false, error: "No active tab found" };
  await chrome.tabs.goBack(tab.id);
  return { success: true, data: "Navigated back" };
}

async function cmdGoForward() {
  const tab = await getActiveTab();
  if (!tab) return { success: false, error: "No active tab found" };
  await chrome.tabs.goForward(tab.id);
  return { success: true, data: "Navigated forward" };
}

// --- Tab management: new/close ---

async function cmdNewTab({ url }) {
  const tab = await chrome.tabs.create({ url: url || "about:blank" });
  return { success: true, data: { tabId: tab.id, url: tab.url || url } };
}

async function cmdCloseTab({ tabId }) {
  const tab = tabId ? { id: tabId } : await getActiveTab();
  if (!tab) return { success: false, error: "No active tab found" };
  await chrome.tabs.remove(tab.id);
  return { success: true, data: "Closed tab " + tab.id };
}

// --- Viewport ---

async function cmdSetViewport({ width, height }) {
  const tab = await getActiveTab();
  if (!tab) return { success: false, error: "No active tab found" };
  await chrome.windows.update(tab.windowId, { width, height });
  return { success: true, data: "Set viewport to " + width + "x" + height };
}

// --- Cookie management ---

async function cmdGetCookies() {
  const tab = await getActiveTab();
  if (!tab) return { success: false, error: "No active tab found" };
  if (!tab.url) return { success: false, error: "Cannot access cookies for this tab" };

  const cookies = await chrome.cookies.getAll({ url: tab.url });
  return { success: true, data: cookies };
}

async function cmdGetCookie({ name }) {
  const tab = await getActiveTab();
  if (!tab) return { success: false, error: "No active tab found" };
  if (!tab.url) return { success: false, error: "Cannot access cookies for this tab" };

  const cookies = await chrome.cookies.getAll({ url: tab.url, name });
  if (cookies.length === 0) {
    return { success: false, error: `Cookie "${name}" not found for ${tab.url}` };
  }
  return { success: true, data: cookies[0] };
}

async function cmdSetCookie({ url, name, value, domain, path, expirationDate, httpOnly, secure, sameSite }) {
  const tab = await getActiveTab();
  const cookieUrl = url || tab?.url;
  if (!cookieUrl) return { success: false, error: "No URL provided and no active tab found" };

  const details = { url: cookieUrl, name, value };
  if (domain !== undefined) details.domain = domain;
  if (path !== undefined) details.path = path;
  if (expirationDate !== undefined) details.expirationDate = expirationDate;
  if (httpOnly !== undefined) details.httpOnly = httpOnly;
  if (secure !== undefined) details.secure = secure;
  if (sameSite !== undefined) details.sameSite = sameSite;

  const cookie = await chrome.cookies.set(details);
  if (!cookie) {
    return { success: false, error: `Failed to set cookie "${name}"` };
  }
  return { success: true, data: cookie };
}

async function cmdDeleteCookie({ name, url }) {
  const tab = await getActiveTab();
  const cookieUrl = url || tab?.url;
  if (!cookieUrl) return { success: false, error: "No URL provided and no active tab found" };

  const result = await chrome.cookies.remove({ url: cookieUrl, name });
  if (!result) {
    return { success: false, error: `Cookie "${name}" not found at ${cookieUrl}` };
  }
  return { success: true, data: `Deleted cookie "${name}" from ${cookieUrl}` };
}

async function cmdClearCookies({ domain }) {
  const tab = await getActiveTab();
  let cookies;

  if (domain) {
    cookies = await chrome.cookies.getAll({ domain });
  } else if (tab?.url) {
    cookies = await chrome.cookies.getAll({ url: tab.url });
  } else {
    return { success: false, error: "No domain provided and no active tab found" };
  }

  let removed = 0;
  for (const cookie of cookies) {
    const protocol = cookie.secure ? "https" : "http";
    const cookieUrl = `${protocol}://${cookie.domain.replace(/^\./, "")}${cookie.path}`;
    await chrome.cookies.remove({ url: cookieUrl, name: cookie.name });
    removed++;
  }

  return { success: true, data: `Cleared ${removed} cookie(s)` };
}

// --- Clipboard ---

async function cmdReadClipboard() {
  const tab = await getActiveTab();
  if (!tab) return { success: false, error: "No active tab found" };

  try {
    await chrome.debugger.attach({ tabId: tab.id }, "1.3");
  } catch (e) {
    if (!e.message?.includes("Already attached")) {
      return { success: false, error: `Debugger attach failed: ${e.message}` };
    }
  }

  try {
    const result = await chrome.debugger.sendCommand(
      { tabId: tab.id },
      "Runtime.evaluate",
      {
        expression: "navigator.clipboard.readText()",
        returnByValue: true,
        awaitPromise: true,
        userGesture: true,
      }
    );

    if (result.exceptionDetails) {
      return {
        success: false,
        error: result.exceptionDetails.text ||
          result.exceptionDetails.exception?.description ||
          "Clipboard read failed",
      };
    }

    return { success: true, data: result.result?.value ?? "" };
  } finally {
    try {
      await chrome.debugger.detach({ tabId: tab.id });
    } catch {}
  }
}

async function cmdWriteClipboard({ text }) {
  const tab = await getActiveTab();
  if (!tab) return { success: false, error: "No active tab found" };

  try {
    await chrome.debugger.attach({ tabId: tab.id }, "1.3");
  } catch (e) {
    if (!e.message?.includes("Already attached")) {
      return { success: false, error: `Debugger attach failed: ${e.message}` };
    }
  }

  try {
    const result = await chrome.debugger.sendCommand(
      { tabId: tab.id },
      "Runtime.evaluate",
      {
        expression: `navigator.clipboard.writeText(${JSON.stringify(text)})`,
        returnByValue: true,
        awaitPromise: true,
        userGesture: true,
      }
    );

    if (result.exceptionDetails) {
      return {
        success: false,
        error: result.exceptionDetails.text ||
          result.exceptionDetails.exception?.description ||
          "Clipboard write failed",
      };
    }

    return { success: true, data: `Wrote ${text.length} chars to clipboard` };
  } finally {
    try {
      await chrome.debugger.detach({ tabId: tab.id });
    } catch {}
  }
}

async function cmdReadClipboardHtml() {
  const tab = await getActiveTab();
  if (!tab) return { success: false, error: "No active tab found" };

  try {
    await chrome.debugger.attach({ tabId: tab.id }, "1.3");
  } catch (e) {
    if (!e.message?.includes("Already attached")) {
      return { success: false, error: `Debugger attach failed: ${e.message}` };
    }
  }

  try {
    const result = await chrome.debugger.sendCommand(
      { tabId: tab.id },
      "Runtime.evaluate",
      {
        expression: `(async () => {
  const items = await navigator.clipboard.read();
  for (const item of items) {
    if (item.types.includes("text/html")) {
      const blob = await item.getType("text/html");
      return { html: await blob.text(), types: item.types };
    }
  }
  if (items.length > 0 && items[0].types.includes("text/plain")) {
    const blob = await items[0].getType("text/plain");
    return { text: await blob.text(), types: items[0].types, html: null };
  }
  return { text: null, html: null, types: items[0]?.types || [] };
})()`,
        returnByValue: true,
        awaitPromise: true,
        userGesture: true,
      }
    );

    if (result.exceptionDetails) {
      return {
        success: false,
        error: result.exceptionDetails.text ||
          result.exceptionDetails.exception?.description ||
          "Clipboard HTML read failed",
      };
    }

    return { success: true, data: result.result?.value ?? null };
  } finally {
    try {
      await chrome.debugger.detach({ tabId: tab.id });
    } catch {}
  }
}

// --- Network monitoring ---

async function cmdGetNetworkRequests({ durationMs }) {
  const tab = await getActiveTab();
  if (!tab) return { success: false, error: "No active tab found" };

  const duration = durationMs || 5000;

  try {
    await chrome.debugger.attach({ tabId: tab.id }, "1.3");
  } catch (e) {
    if (!e.message?.includes("Already attached")) {
      return { success: false, error: `Debugger attach failed: ${e.message}` };
    }
  }

  try {
    await chrome.debugger.sendCommand({ tabId: tab.id }, "Network.enable", {});

    const requests = new Map();

    const listener = (source, method, params) => {
      if (source.tabId !== tab.id) return;

      if (method === "Network.requestWillBeSent") {
        requests.set(params.requestId, {
          requestId: params.requestId,
          url: params.request.url,
          method: params.request.method,
          type: params.type || null,
          timestamp: params.timestamp,
          status: null,
          statusText: null,
          mimeType: null,
          encodedDataLength: null,
          timing: null,
        });
      } else if (method === "Network.responseReceived") {
        const req = requests.get(params.requestId);
        if (req) {
          req.status = params.response.status;
          req.statusText = params.response.statusText;
          req.mimeType = params.response.mimeType;
          req.timing = params.response.timing || null;
        }
      } else if (method === "Network.loadingFinished") {
        const req = requests.get(params.requestId);
        if (req) {
          req.encodedDataLength = params.encodedDataLength;
        }
      }
    };

    chrome.debugger.onEvent.addListener(listener);

    await new Promise((r) => setTimeout(r, duration));

    chrome.debugger.onEvent.removeListener(listener);
    await chrome.debugger.sendCommand({ tabId: tab.id }, "Network.disable", {});

    return {
      success: true,
      data: {
        durationMs: duration,
        count: requests.size,
        requests: Array.from(requests.values()),
      },
    };
  } finally {
    try {
      await chrome.debugger.detach({ tabId: tab.id });
    } catch {}
  }
}

async function cmdWaitForNetworkRequest({ urlPattern, timeoutMs }) {
  const tab = await getActiveTab();
  if (!tab) return { success: false, error: "No active tab found" };

  if (!urlPattern) return { success: false, error: "urlPattern is required" };

  const timeout = timeoutMs || 15000;

  try {
    await chrome.debugger.attach({ tabId: tab.id }, "1.3");
  } catch (e) {
    if (!e.message?.includes("Already attached")) {
      return { success: false, error: `Debugger attach failed: ${e.message}` };
    }
  }

  try {
    await chrome.debugger.sendCommand({ tabId: tab.id }, "Network.enable", {});

    const pending = new Map();

    const matchPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        chrome.debugger.onEvent.removeListener(listener);
        reject(new Error(`No request matching "${urlPattern}" within ${timeout}ms`));
      }, timeout);

      var listener = (source, method, params) => {
        if (source.tabId !== tab.id) return;

        if (method === "Network.requestWillBeSent") {
          if (params.request.url.includes(urlPattern)) {
            pending.set(params.requestId, {
              requestId: params.requestId,
              url: params.request.url,
              method: params.request.method,
              type: params.type || null,
            });
          }
        } else if (method === "Network.responseReceived") {
          const req = pending.get(params.requestId);
          if (req) {
            clearTimeout(timer);
            chrome.debugger.onEvent.removeListener(listener);
            resolve({
              ...req,
              status: params.response.status,
              statusText: params.response.statusText,
              mimeType: params.response.mimeType,
              headers: params.response.headers,
              timing: params.response.timing || null,
            });
          }
        }
      };

      chrome.debugger.onEvent.addListener(listener);
    });

    const result = await matchPromise;

    return { success: true, data: result };
  } catch (e) {
    return { success: false, error: e.message };
  } finally {
    try {
      await chrome.debugger.sendCommand({ tabId: tab.id }, "Network.disable", {});
    } catch {}
    try {
      await chrome.debugger.detach({ tabId: tab.id });
    } catch {}
  }
}


// --- Visual debugging: highlights and annotations ---

async function cmdHighlightElement({ selector, color, label }) {
  if (color && !/^#[0-9a-fA-F]{3,8}$/.test(color)) {
    return { success: false, error: "Invalid color: must be a hex color like #ff0000" };
  }
  const tab = await getActiveTab();
  if (!tab) return { success: false, error: "No active tab found" };

  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (selector, color, label) => {
      var el = document.querySelector(selector);
      if (!el) return { success: false, error: "Element not found: " + selector };

      var rect = el.getBoundingClientRect();
      var borderColor = color || "#ff0000";
      var bgColor = borderColor + "40";

      var overlay = document.createElement("div");
      overlay.setAttribute("data-mcp-highlight", "true");
      overlay.style.cssText = "position:fixed;pointer-events:none;z-index:999999;" +
        "border:2px solid " + borderColor + ";" +
        "background:" + bgColor + ";" +
        "left:" + rect.left + "px;top:" + rect.top + "px;" +
        "width:" + rect.width + "px;height:" + rect.height + "px;box-sizing:border-box;";

      if (label) {
        var lbl = document.createElement("span");
        lbl.textContent = label;
        lbl.style.cssText = "position:absolute;top:0;left:0;background:" + borderColor + ";" +
          "color:white;font:bold 11px/1.4 monospace;padding:1px 5px;white-space:nowrap;border-radius:0 0 3px 0;";
        overlay.appendChild(lbl);
      }

      document.body.appendChild(overlay);
      return { success: true, data: { selector: selector, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, label: label || null } };
    },
    args: [selector, color || null, label || null],
    world: "MAIN",
  });

  return result.result;
}

async function cmdHighlightAll({ selector, colors }) {
  if (colors) {
    for (const c of colors) {
      if (!/^#[0-9a-fA-F]{3,8}$/.test(c)) {
        return { success: false, error: `Invalid color "${c}": must be a hex color like #ff0000` };
      }
    }
  }
  const tab = await getActiveTab();
  if (!tab) return { success: false, error: "No active tab found" };

  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (selector, colors) => {
      var borderPalette = colors || ["#ff0000", "#00ff00", "#0000ff", "#ff00ff", "#ffff00"];
      var els = document.querySelectorAll(selector);
      if (els.length === 0) return { success: false, error: "No elements found: " + selector };

      var highlighted = [];
      els.forEach(function(el, i) {
        var rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return;

        var colorIdx = i % borderPalette.length;
        var borderColor = borderPalette[colorIdx];

        var overlay = document.createElement("div");
        overlay.setAttribute("data-mcp-highlight", "true");
        overlay.style.cssText = "position:fixed;pointer-events:none;z-index:999999;" +
          "border:2px solid " + borderColor + ";" +
          "background:" + borderColor + "40;" +
          "left:" + rect.left + "px;top:" + rect.top + "px;" +
          "width:" + rect.width + "px;height:" + rect.height + "px;box-sizing:border-box;";

        var lbl = document.createElement("span");
        lbl.textContent = i;
        lbl.style.cssText = "position:absolute;top:0;left:0;background:" + borderColor + ";" +
          "color:white;font:bold 11px/1.4 monospace;padding:1px 5px;border-radius:0 0 3px 0;";
        overlay.appendChild(lbl);

        document.body.appendChild(overlay);
        highlighted.push({ index: i, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } });
      });

      return { success: true, data: { selector: selector, count: highlighted.length, elements: highlighted } };
    },
    args: [selector, colors || null],
    world: "MAIN",
  });

  return result.result;
}

async function cmdClearHighlights() {
  const tab = await getActiveTab();
  if (!tab) return { success: false, error: "No active tab found" };

  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      var overlays = document.querySelectorAll("[data-mcp-highlight]");
      var count = overlays.length;
      overlays.forEach(function(el) { el.remove(); });
      return { success: true, data: { removed: count } };
    },
    args: [],
    world: "MAIN",
  });

  return result.result;
}

async function cmdAnnotateElement({ selector, text, position }) {
  const tab = await getActiveTab();
  if (!tab) return { success: false, error: "No active tab found" };

  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (selector, text, position) => {
      var el = document.querySelector(selector);
      if (!el) return { success: false, error: "Element not found: " + selector };

      var rect = el.getBoundingClientRect();
      var pos = position || "top";
      var annotation = document.createElement("div");
      annotation.setAttribute("data-mcp-highlight", "true");
      annotation.textContent = text;
      annotation.style.cssText = "position:fixed;pointer-events:none;z-index:999999;" +
        "background:#222;color:#fff;font:12px/1.4 monospace;padding:4px 8px;" +
        "border-radius:4px;max-width:300px;white-space:pre-wrap;box-shadow:0 2px 8px rgba(0,0,0,0.3);";

      switch (pos) {
        case "bottom":
          annotation.style.left = rect.left + "px";
          annotation.style.top = (rect.bottom + 4) + "px";
          break;
        case "left":
          annotation.style.right = (window.innerWidth - rect.left + 4) + "px";
          annotation.style.top = rect.top + "px";
          break;
        case "right":
          annotation.style.left = (rect.right + 4) + "px";
          annotation.style.top = rect.top + "px";
          break;
        default:
          annotation.style.left = rect.left + "px";
          annotation.style.top = (rect.top - 28) + "px";
          break;
      }

      document.body.appendChild(annotation);
      return { success: true, data: { selector: selector, text: text, position: pos } };
    },
    args: [selector, text, position || null],
    world: "MAIN",
  });

  return result.result;
}

// --- Audio playback ---

async function cmdPlayTone({ notes, waveform, volume, tempo }) {
  const tab = await getActiveTab();
  if (!tab) return { success: false, error: "No active tab found" };

  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (notes, waveform, volume, tempo) => {
      var NOTE_SEMI = {
        "C":0,"C#":1,"Db":1,"D":2,"D#":3,"Eb":3,"E":4,"F":5,
        "F#":6,"Gb":6,"G":7,"G#":8,"Ab":8,"A":9,"A#":10,"Bb":10,"B":11
      };

      function toFreq(n) {
        if (typeof n === "number") return n;
        if (!n || n === "rest" || n === "-" || n === "R") return 0;
        var m = String(n).match(/^([A-Ga-g][#b]?)(\d)$/);
        if (!m) return 0;
        var name = m[1].charAt(0).toUpperCase() + m[1].slice(1);
        var semi = NOTE_SEMI[name];
        if (semi === undefined) return 0;
        return 440 * Math.pow(2, (semi - 9) / 12 + (parseInt(m[2]) - 4));
      }

      var ctx = new AudioContext();
      var vol = typeof volume === "number" ? volume : 0.3;
      var wave = waveform || "triangle";
      var t = ctx.currentTime + 0.05;
      var total = 0;

      for (var i = 0; i < notes.length; i++) {
        var freq = toFreq(notes[i].note);
        var dur = notes[i].duration || 0.2;
        if (tempo > 0) dur = (60 / tempo) * dur;

        if (freq <= 0) { t += dur; total += dur; continue; }

        var osc = ctx.createOscillator();
        var gain = ctx.createGain();
        osc.type = wave;
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(vol, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
        osc.connect(gain).connect(ctx.destination);
        osc.start(t);
        osc.stop(t + dur + 0.02);
        t += dur;
        total += dur;
      }

      return {
        success: true,
        data: { notesPlayed: notes.length, durationMs: Math.round(total * 1000), waveform: wave },
      };
    },
    args: [notes, waveform || null, volume ?? null, tempo ?? null],
    world: "MAIN",
  });

  return result.result;
}

// --- Structured data extraction ---

async function cmdExtractTable({ selector, includeHeaders }) {
  const tab = await getActiveTab();
  if (!tab) return { success: false, error: "No active tab found" };

  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (selector, includeHeaders) => {
      var table = document.querySelector(selector || "table");
      if (!table) return { success: false, error: "Table not found" + (selector ? ": " + selector : "") };

      var headers = [];
      var rows = [];

      if (includeHeaders) {
        var headerRow = table.querySelector("thead tr");
        var headerCells = headerRow ? headerRow.querySelectorAll("th, td") : null;
        if (!headerCells || headerCells.length === 0) {
          var firstRow = table.querySelector("tr");
          if (firstRow) {
            var ths = firstRow.querySelectorAll("th");
            if (ths.length > 0) headerCells = ths;
          }
        }
        if (headerCells) {
          headerCells.forEach(function(c) { headers.push(c.innerText.trim()); });
        }
      }

      var bodyRows = table.querySelectorAll("tbody tr");
      if (bodyRows.length === 0) bodyRows = table.querySelectorAll("tr");

      var skip = (headers.length > 0 && !table.querySelector("thead")) ? 1 : 0;
      for (var i = skip; i < bodyRows.length; i++) {
        var cells = bodyRows[i].querySelectorAll("td, th");
        var row = [];
        cells.forEach(function(c) { row.push(c.innerText.trim()); });
        if (row.length > 0) rows.push(row);
      }

      return {
        success: true,
        data: { headers: headers, rows: rows, rowCount: rows.length, columnCount: headers.length || (rows[0] || []).length },
      };
    },
    args: [selector || null, includeHeaders !== false],
    world: "MAIN",
  });

  return result.result;
}

async function cmdGetLinks({ selector, includeHidden }) {
  const tab = await getActiveTab();
  if (!tab) return { success: false, error: "No active tab found" };

  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (selector, includeHidden) => {
      var container = selector ? document.querySelector(selector) : document;
      if (!container) return { success: false, error: "Container not found: " + selector };

      var links = [];
      container.querySelectorAll("a[href]").forEach(function(a) {
        var rect = a.getBoundingClientRect();
        var visible = rect.width > 0 && rect.height > 0;
        if (!includeHidden && !visible) return;
        links.push({
          href: a.href,
          text: (a.innerText || "").trim().substring(0, 200),
          title: a.title || null,
          rel: a.rel || null,
          target: a.target || null,
          visible: visible,
        });
      });

      return { success: true, data: { count: links.length, links: links } };
    },
    args: [selector || null, !!includeHidden],
    world: "MAIN",
  });

  return result.result;
}

async function cmdGetMetadata() {
  const tab = await getActiveTab();
  if (!tab) return { success: false, error: "No active tab found" };

  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      var meta = {
        title: document.title,
        url: location.href,
        charset: document.characterSet,
        lang: document.documentElement.lang || null,
      };

      var tags = {};
      document.querySelectorAll("meta[name], meta[property]").forEach(function(el) {
        var key = el.getAttribute("name") || el.getAttribute("property");
        if (key) tags[key] = el.getAttribute("content");
      });
      meta.meta = tags;

      var og = {};
      document.querySelectorAll('meta[property^="og:"]').forEach(function(el) {
        og[el.getAttribute("property").replace("og:", "")] = el.getAttribute("content");
      });
      if (Object.keys(og).length > 0) meta.openGraph = og;

      var twitter = {};
      document.querySelectorAll('meta[name^="twitter:"]').forEach(function(el) {
        twitter[el.getAttribute("name").replace("twitter:", "")] = el.getAttribute("content");
      });
      if (Object.keys(twitter).length > 0) meta.twitter = twitter;

      var canonical = document.querySelector('link[rel="canonical"]');
      if (canonical) meta.canonical = canonical.href;

      var jsonLd = [];
      document.querySelectorAll('script[type="application/ld+json"]').forEach(function(el) {
        try { jsonLd.push(JSON.parse(el.textContent)); } catch (e) {}
      });
      if (jsonLd.length > 0) meta.jsonLd = jsonLd;

      var icon = document.querySelector('link[rel="icon"], link[rel="shortcut icon"]');
      if (icon) meta.favicon = icon.href;

      return { success: true, data: meta };
    },
    args: [],
    world: "MAIN",
  });

  return result.result;
}

async function cmdQuerySelectorAll({ selector, attributes, limit }) {
  const tab = await getActiveTab();
  if (!tab) return { success: false, error: "No active tab found" };

  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (selector, attributes, limit) => {
      var els = document.querySelectorAll(selector);
      var max = limit || 50;
      var results = [];

      for (var i = 0; i < Math.min(els.length, max); i++) {
        var el = els[i];
        var item = { index: i, tag: el.tagName.toLowerCase(), text: (el.innerText || "").substring(0, 200) };

        if (attributes && attributes.length > 0) {
          var a = {};
          for (var j = 0; j < attributes.length; j++) {
            var v = el.getAttribute(attributes[j]);
            if (v !== null) a[attributes[j]] = v;
          }
          item.attributes = a;
        } else {
          var all = {};
          for (var k = 0; k < el.attributes.length; k++) all[el.attributes[k].name] = el.attributes[k].value;
          item.attributes = all;
        }

        var rect = el.getBoundingClientRect();
        item.visible = rect.width > 0 && rect.height > 0;
        item.rect = { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
        results.push(item);
      }

      return { success: true, data: { total: els.length, returned: results.length, elements: results } };
    },
    args: [selector, attributes || null, limit || 50],
    world: "MAIN",
  });

  return result.result;
}

// --- Browser storage ---

async function cmdGetStorage({ storageType, key }) {
  const tab = await getActiveTab();
  if (!tab) return { success: false, error: "No active tab found" };

  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (storageType, key) => {
      var storage = storageType === "session" ? sessionStorage : localStorage;
      if (key) {
        var val = storage.getItem(key);
        if (val === null) return { success: false, error: 'Key "' + key + '" not found in ' + storageType + 'Storage' };
        return { success: true, data: { key: key, value: val } };
      }
      var items = {};
      for (var i = 0; i < storage.length; i++) {
        var k = storage.key(i);
        items[k] = storage.getItem(k);
      }
      return { success: true, data: { type: storageType + "Storage", count: storage.length, items: items } };
    },
    args: [storageType || "local", key || null],
    world: "MAIN",
  });

  return result.result;
}

async function cmdSetStorage({ storageType, key, value }) {
  const tab = await getActiveTab();
  if (!tab) return { success: false, error: "No active tab found" };

  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (storageType, key, value) => {
      var storage = storageType === "session" ? sessionStorage : localStorage;
      storage.setItem(key, value);
      return { success: true, data: 'Set "' + key + '" in ' + storageType + 'Storage' };
    },
    args: [storageType || "local", key, value],
    world: "MAIN",
  });

  return result.result;
}

async function cmdRemoveStorage({ storageType, key }) {
  const tab = await getActiveTab();
  if (!tab) return { success: false, error: "No active tab found" };

  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (storageType, key) => {
      var storage = storageType === "session" ? sessionStorage : localStorage;
      var existed = storage.getItem(key) !== null;
      storage.removeItem(key);
      return { success: true, data: existed ? 'Removed "' + key + '"' : 'Key "' + key + '" was not present' };
    },
    args: [storageType || "local", key],
    world: "MAIN",
  });

  return result.result;
}

async function cmdClearStorage({ storageType }) {
  const tab = await getActiveTab();
  if (!tab) return { success: false, error: "No active tab found" };

  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (storageType) => {
      var storage = storageType === "session" ? sessionStorage : localStorage;
      var count = storage.length;
      storage.clear();
      return { success: true, data: "Cleared " + count + " items from " + storageType + "Storage" };
    },
    args: [storageType || "local"],
    world: "MAIN",
  });

  return result.result;
}

// --- Iframe interaction ---

async function cmdListFrames() {
  const tab = await getActiveTab();
  if (!tab) return { success: false, error: "No active tab found" };

  const frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id });
  const data = frames.map(f => ({
    frameId: f.frameId,
    parentFrameId: f.parentFrameId,
    url: f.url,
    frameType: f.frameType || (f.frameId === 0 ? "outermost_frame" : "sub_frame"),
  }));

  return { success: true, data: { count: data.length, frames: data } };
}

async function cmdFrameContent({ frameId, selector }) {
  const tab = await getActiveTab();
  if (!tab) return { success: false, error: "No active tab found" };

  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id, frameIds: [frameId] },
    func: (selector) => {
      var el = selector ? document.querySelector(selector) : document.body;
      if (!el) return { success: false, error: "Element not found: " + selector };
      return { success: true, data: { text: el.innerText.substring(0, 50000), url: location.href, title: document.title } };
    },
    args: [selector || null],
    world: "MAIN",
  });

  return result.result;
}

async function cmdFrameClick({ frameId, selector }) {
  const tab = await getActiveTab();
  if (!tab) return { success: false, error: "No active tab found" };

  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id, frameIds: [frameId] },
    func: (selector) => {
      var el = document.querySelector(selector);
      if (!el) return { success: false, error: "Element not found in frame: " + selector };
      el.scrollIntoView({ behavior: "instant", block: "center" });
      el.click();
      return { success: true, data: "Clicked " + selector + " in frame" };
    },
    args: [selector],
    world: "MAIN",
  });

  return result.result;
}

async function cmdFrameFill({ frameId, selector, value }) {
  const tab = await getActiveTab();
  if (!tab) return { success: false, error: "No active tab found" };

  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id, frameIds: [frameId] },
    func: (selector, value) => {
      var el = document.querySelector(selector);
      if (!el) return { success: false, error: "Element not found in frame: " + selector };

      el.focus();
      var nativeSetter = Object.getOwnPropertyDescriptor(
        el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value"
      )?.set;
      if (nativeSetter) nativeSetter.call(el, value);
      else el.value = value;

      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return { success: true, data: "Filled " + selector + " in frame with " + value.length + " chars" };
    },
    args: [selector, value],
    world: "MAIN",
  });

  return result.result;
}

async function cmdFrameExecuteJs({ frameId, code }) {
  const tab = await getActiveTab();
  if (!tab) return { success: false, error: "No active tab found" };

  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id, frameIds: [frameId] },
    func: (code) => {
      try {
        var r = eval(code);
        return { success: true, data: r ?? null };
      } catch (e) {
        return { success: false, error: e.message };
      }
    },
    args: [code],
    world: "MAIN",
  });

  return result.result;
}

// ============================================================
// Agentic event monitoring
// ============================================================

const activeMonitors = new Map();

function sendEvent(eventType, data) {
  chrome.runtime.sendMessage({
    type: "event", eventType, data, timestamp: Date.now(),
  }).catch(() => {});
}

function startMonitor(eventType, filter) {
  if (activeMonitors.has(eventType)) return;

  let cleanup;

  switch (eventType) {
    case "navigation": {
      const listener = (details) => {
        if (details.frameId !== 0) return;
        if (filter?.urlPattern && !details.url.includes(filter.urlPattern)) return;
        chrome.tabs.get(details.tabId).then((tab) => {
          sendEvent("navigation", {
            url: details.url, tabId: details.tabId, title: tab?.title || "",
          });
        }).catch(() => {
          sendEvent("navigation", { url: details.url, tabId: details.tabId });
        });
      };
      chrome.webNavigation.onCompleted.addListener(listener);
      cleanup = () => chrome.webNavigation.onCompleted.removeListener(listener);
      break;
    }

    case "tab_activated": {
      const listener = (info) => {
        chrome.tabs.get(info.tabId).then((tab) => {
          sendEvent("tab_activated", {
            tabId: info.tabId, windowId: info.windowId,
            url: tab?.url, title: tab?.title,
          });
        }).catch(() => {
          sendEvent("tab_activated", { tabId: info.tabId, windowId: info.windowId });
        });
      };
      chrome.tabs.onActivated.addListener(listener);
      cleanup = () => chrome.tabs.onActivated.removeListener(listener);
      break;
    }

    case "tab_created": {
      const listener = (tab) => {
        sendEvent("tab_created", {
          tabId: tab.id, url: tab.url || tab.pendingUrl, title: tab.title,
        });
      };
      chrome.tabs.onCreated.addListener(listener);
      cleanup = () => chrome.tabs.onCreated.removeListener(listener);
      break;
    }

    case "tab_removed": {
      const listener = (tabId, info) => {
        sendEvent("tab_removed", {
          tabId, windowId: info.windowId, isWindowClosing: info.isWindowClosing,
        });
      };
      chrome.tabs.onRemoved.addListener(listener);
      cleanup = () => chrome.tabs.onRemoved.removeListener(listener);
      break;
    }

    case "console": {
      let attached = false;
      let targetTabId = null;

      const eventListener = (source, method, params) => {
        if (source.tabId !== targetTabId) return;
        if (method !== "Runtime.consoleAPICalled") return;
        const level = params.type;
        if (filter?.level && level !== filter.level) return;
        const args = (params.args || []).map(a => a.value ?? a.description ?? String(a.type)).join(", ");
        sendEvent("console", { level, message: args, tabId: targetTabId });
      };

      const setup = async () => {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab) return;
        targetTabId = tab.id;
        try {
          await chrome.debugger.attach({ tabId: targetTabId }, "1.3");
          attached = true;
          await chrome.debugger.sendCommand({ tabId: targetTabId }, "Runtime.enable", {});
          chrome.debugger.onEvent.addListener(eventListener);
        } catch (e) {
          if (!e.message?.includes("Already attached")) {
            console.error("[BrowserControl] Console monitor attach failed:", e.message);
          }
        }
      };

      setup();

      cleanup = async () => {
        chrome.debugger.onEvent.removeListener(eventListener);
        if (attached && targetTabId) {
          try {
            await chrome.debugger.sendCommand({ tabId: targetTabId }, "Runtime.disable", {});
            await chrome.debugger.detach({ tabId: targetTabId });
          } catch {}
        }
      };
      break;
    }

    case "dom_mutation": {
      let targetTabId = null;

      const setup = async () => {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab) return;
        targetTabId = tab.id;

        await chrome.scripting.executeScript({
          target: { tabId: targetTabId },
          func: () => {
            if (window.__mcpMutationObserver) return;
            let pending = [];
            let timer = null;

            const flush = () => {
              if (pending.length === 0) return;
              const batch = pending.splice(0, 50);
              chrome.runtime.sendMessage({
                type: "dom_mutation_batch",
                mutations: batch,
                url: location.href,
              }).catch(() => {});
              timer = null;
            };

            window.__mcpMutationObserver = new MutationObserver((mutations) => {
              for (const m of mutations) {
                if (m.type === "childList") {
                  pending.push({
                    type: "childList",
                    addedCount: m.addedNodes.length,
                    removedCount: m.removedNodes.length,
                    target: m.target.tagName?.toLowerCase() || "unknown",
                  });
                } else if (m.type === "attributes") {
                  pending.push({
                    type: "attributes",
                    attributeName: m.attributeName,
                    target: m.target.tagName?.toLowerCase() || "unknown",
                  });
                }
              }
              if (!timer) timer = setTimeout(flush, 500);
            });

            window.__mcpMutationObserver.observe(document.body, {
              childList: true, attributes: true, subtree: true,
            });
          },
          args: [],
        }).catch((e) => {
          console.error("[BrowserControl] DOM mutation setup failed:", e.message);
        });
      };

      setup();

      cleanup = async () => {
        if (targetTabId) {
          await chrome.scripting.executeScript({
            target: { tabId: targetTabId },
            func: () => {
              if (window.__mcpMutationObserver) {
                window.__mcpMutationObserver.disconnect();
                window.__mcpMutationObserver = null;
              }
            },
            args: [],
          }).catch(() => {});
        }
      };
      break;
    }

    default:
      return;
  }

  activeMonitors.set(eventType, { cleanup });
}

function stopMonitor(eventType) {
  const monitor = activeMonitors.get(eventType);
  if (!monitor) return;
  const result = monitor.cleanup();
  if (result && typeof result.catch === "function") {
    result.catch(() => {});
  }
  activeMonitors.delete(eventType);
}


// ── DevTools Tools ──

async function cmdDevtoolsConsoleLog({ duration_ms }) {
  const tab = await getActiveTab();
  if (!tab) return { success: false, error: "No active tab found" };

  const duration = duration_ms || 5000;

  try {
    await chrome.debugger.attach({ tabId: tab.id }, "1.3");
  } catch (e) {
    if (!e.message?.includes("Already attached")) {
      return { success: false, error: "Debugger attach failed: " + e.message };
    }
  }

  try {
    await chrome.debugger.sendCommand({ tabId: tab.id }, "Runtime.enable", {});

    const messages = [];

    const listener = (source, method, params) => {
      if (source.tabId !== tab.id) return;
      if (method === "Runtime.consoleAPICalled") {
        const text = (params.args || [])
          .map((a) => a.value !== undefined ? JSON.stringify(a.value) : a.description || String(a.type))
          .join(" ");
        messages.push({
          level: params.type,
          text: text.substring(0, 2000),
          source: params.stackTrace?.callFrames?.[0]?.url || null,
          line: params.stackTrace?.callFrames?.[0]?.lineNumber || null,
          timestamp: params.timestamp || Date.now(),
        });
      } else if (method === "Runtime.exceptionThrown") {
        const ex = params.exceptionDetails;
        messages.push({
          level: "error",
          text: ex.text + (ex.exception?.description ? " — " + ex.exception.description : ""),
          source: ex.url || null,
          line: ex.lineNumber || null,
          timestamp: params.timestamp || Date.now(),
        });
      }
    };

    chrome.debugger.onEvent.addListener(listener);
    await new Promise((r) => setTimeout(r, duration));
    chrome.debugger.onEvent.removeListener(listener);

    await chrome.debugger.sendCommand({ tabId: tab.id }, "Runtime.disable", {});

    return { success: true, data: { messages, count: messages.length, duration_ms: duration } };
  } finally {
    try { await chrome.debugger.detach({ tabId: tab.id }); } catch {}
  }
}

async function cmdDevtoolsPerformanceMetrics() {
  const tab = await getActiveTab();
  if (!tab) return { success: false, error: "No active tab found" };

  try {
    await chrome.debugger.attach({ tabId: tab.id }, "1.3");
  } catch (e) {
    if (!e.message?.includes("Already attached")) {
      return { success: false, error: "Debugger attach failed: " + e.message };
    }
  }

  try {
    await chrome.debugger.sendCommand({ tabId: tab.id }, "Performance.enable", {});
    const result = await chrome.debugger.sendCommand({ tabId: tab.id }, "Performance.getMetrics", {});
    await chrome.debugger.sendCommand({ tabId: tab.id }, "Performance.disable", {});

    const metrics = {};
    for (const m of result.metrics) {
      metrics[m.name] = m.value;
    }

    return { success: true, data: { metrics } };
  } finally {
    try { await chrome.debugger.detach({ tabId: tab.id }); } catch {}
  }
}

async function cmdDevtoolsPerformanceTrace({ duration_ms, categories }) {
  const tab = await getActiveTab();
  if (!tab) return { success: false, error: "No active tab found" };

  const duration = duration_ms || 3000;
  const cats = categories || "devtools.timeline,v8.execute";

  try {
    await chrome.debugger.attach({ tabId: tab.id }, "1.3");
  } catch (e) {
    if (!e.message?.includes("Already attached")) {
      return { success: false, error: "Debugger attach failed: " + e.message };
    }
  }

  try {
    const traceEvents = [];

    const listener = (source, method, params) => {
      if (source.tabId !== tab.id) return;
      if (method === "Tracing.dataCollected" && params.value) {
        for (const evt of params.value) {
          traceEvents.push(evt);
        }
      }
    };

    chrome.debugger.onEvent.addListener(listener);

    await chrome.debugger.sendCommand({ tabId: tab.id }, "Tracing.start", {
      categories: cats,
      options: "sampling-frequency=10000",
    });

    await new Promise((r) => setTimeout(r, duration));

    // End tracing and wait for all data
    const endPromise = new Promise((resolve) => {
      const endListener = (source, method) => {
        if (source.tabId === tab.id && method === "Tracing.tracingComplete") {
          chrome.debugger.onEvent.removeListener(endListener);
          resolve();
        }
      };
      chrome.debugger.onEvent.addListener(endListener);
    });

    await chrome.debugger.sendCommand({ tabId: tab.id }, "Tracing.end", {});
    await Promise.race([endPromise, new Promise((r) => setTimeout(r, 5000))]);

    chrome.debugger.onEvent.removeListener(listener);

    // Summarize the trace data
    const categoryCount = {};
    const longestEvents = [];

    for (const evt of traceEvents) {
      const cat = evt.cat || "unknown";
      categoryCount[cat] = (categoryCount[cat] || 0) + 1;

      if (evt.dur && evt.dur > 0) {
        longestEvents.push({
          name: evt.name,
          category: cat,
          duration_us: evt.dur,
          duration_ms: Math.round(evt.dur / 1000 * 100) / 100,
        });
      }
    }

    longestEvents.sort((a, b) => b.duration_us - a.duration_us);

    return {
      success: true,
      data: {
        summary: {
          total_events: traceEvents.length,
          top_categories: categoryCount,
          longest_events: longestEvents.slice(0, 20),
        },
        duration_ms: duration,
      },
    };
  } finally {
    try { await chrome.debugger.detach({ tabId: tab.id }); } catch {}
  }
}

async function cmdDevtoolsDomTree({ selector, depth }) {
  const tab = await getActiveTab();
  if (!tab) return { success: false, error: "No active tab found" };

  const maxDepth = depth || 3;

  try {
    await chrome.debugger.attach({ tabId: tab.id }, "1.3");
  } catch (e) {
    if (!e.message?.includes("Already attached")) {
      return { success: false, error: "Debugger attach failed: " + e.message };
    }
  }

  try {
    await chrome.debugger.sendCommand({ tabId: tab.id }, "DOM.enable", {});

    const doc = await chrome.debugger.sendCommand({ tabId: tab.id }, "DOM.getDocument", {
      depth: 0,
    });

    let rootNodeId = doc.root.nodeId;

    if (selector) {
      const queryResult = await chrome.debugger.sendCommand({ tabId: tab.id }, "DOM.querySelector", {
        nodeId: rootNodeId,
        selector: selector,
      });
      if (!queryResult.nodeId) {
        return { success: false, error: "Element not found: " + selector };
      }
      rootNodeId = queryResult.nodeId;
    }

    // Request the subtree at the desired depth
    await chrome.debugger.sendCommand({ tabId: tab.id }, "DOM.requestChildNodes", {
      nodeId: rootNodeId,
      depth: maxDepth,
    });

    // Brief pause for the setChildNodes events to arrive
    await new Promise((r) => setTimeout(r, 200));

    // Describe the node to get full tree info
    const described = await chrome.debugger.sendCommand({ tabId: tab.id }, "DOM.describeNode", {
      nodeId: rootNodeId,
      depth: maxDepth,
    });

    function buildTree(node, currentDepth) {
      if (!node || currentDepth > maxDepth) return null;

      const result = {
        tag: (node.nodeName || "").toLowerCase(),
      };

      if (node.attributes && node.attributes.length > 0) {
        const attrs = {};
        for (let i = 0; i < node.attributes.length; i += 2) {
          attrs[node.attributes[i]] = node.attributes[i + 1];
        }
        result.attrs = attrs;
      }

      if (node.nodeValue) {
        result.text = node.nodeValue.trim().substring(0, 200);
      }

      if (node.children && node.children.length > 0 && currentDepth < maxDepth) {
        result.children = [];
        for (const child of node.children) {
          const childNode = buildTree(child, currentDepth + 1);
          if (childNode && childNode.tag !== "#comment") {
            result.children.push(childNode);
          }
        }
      } else if (node.childNodeCount > 0 && currentDepth >= maxDepth) {
        result.childCount = node.childNodeCount;
      }

      return result;
    }

    const tree = buildTree(described.node, 0);

    await chrome.debugger.sendCommand({ tabId: tab.id }, "DOM.disable", {});

    return { success: true, data: { tree } };
  } finally {
    try { await chrome.debugger.detach({ tabId: tab.id }); } catch {}
  }
}

async function cmdDevtoolsCssComputed({ selector }) {
  const tab = await getActiveTab();
  if (!tab) return { success: false, error: "No active tab found" };

  if (!selector) return { success: false, error: "selector is required" };

  try {
    await chrome.debugger.attach({ tabId: tab.id }, "1.3");
  } catch (e) {
    if (!e.message?.includes("Already attached")) {
      return { success: false, error: "Debugger attach failed: " + e.message };
    }
  }

  try {
    await chrome.debugger.sendCommand({ tabId: tab.id }, "DOM.enable", {});
    await chrome.debugger.sendCommand({ tabId: tab.id }, "CSS.enable", {});

    const doc = await chrome.debugger.sendCommand({ tabId: tab.id }, "DOM.getDocument", { depth: 0 });
    const queryResult = await chrome.debugger.sendCommand({ tabId: tab.id }, "DOM.querySelector", {
      nodeId: doc.root.nodeId,
      selector: selector,
    });

    if (!queryResult.nodeId) {
      return { success: false, error: "Element not found: " + selector };
    }

    const computed = await chrome.debugger.sendCommand({ tabId: tab.id }, "CSS.getComputedStyleForNode", {
      nodeId: queryResult.nodeId,
    });

    const styles = {};
    for (const prop of computed.computedStyle) {
      styles[prop.name] = prop.value;
    }

    await chrome.debugger.sendCommand({ tabId: tab.id }, "CSS.disable", {});
    await chrome.debugger.sendCommand({ tabId: tab.id }, "DOM.disable", {});

    return { success: true, data: { selector, styles } };
  } finally {
    try { await chrome.debugger.detach({ tabId: tab.id }); } catch {}
  }
}

async function cmdDevtoolsNetworkThrottle({ profile, download_kbps, upload_kbps, latency_ms }) {
  const tab = await getActiveTab();
  if (!tab) return { success: false, error: "No active tab found" };

  const presets = {
    slow3g: { download: 400 * 1024 / 8, upload: 400 * 1024 / 8, latency: 2000, offline: false },
    fast3g: { download: 1600 * 1024 / 8, upload: 750 * 1024 / 8, latency: 562, offline: false },
    offline: { download: 0, upload: 0, latency: 0, offline: true },
    none: { download: -1, upload: -1, latency: 0, offline: false },
  };

  let conditions;
  if (profile && presets[profile]) {
    conditions = presets[profile];
  } else if (download_kbps !== undefined || upload_kbps !== undefined || latency_ms !== undefined) {
    conditions = {
      download: (download_kbps || 0) * 1024 / 8,
      upload: (upload_kbps || 0) * 1024 / 8,
      latency: latency_ms || 0,
      offline: false,
    };
    profile = "custom";
  } else {
    return { success: false, error: "Provide a profile name or custom download_kbps/upload_kbps/latency_ms values" };
  }

  try {
    await chrome.debugger.attach({ tabId: tab.id }, "1.3");
  } catch (e) {
    if (!e.message?.includes("Already attached")) {
      return { success: false, error: "Debugger attach failed: " + e.message };
    }
  }

  try {
    await chrome.debugger.sendCommand({ tabId: tab.id }, "Network.enable", {});
    await chrome.debugger.sendCommand({ tabId: tab.id }, "Network.emulateNetworkConditions", {
      offline: conditions.offline,
      latency: conditions.latency,
      downloadThroughput: conditions.download,
      uploadThroughput: conditions.upload,
    });

    // Do NOT detach for active throttling — persists only while debugger is attached.
    // For "none" profile, disable and detach to clear.
    if (profile === "none") {
      await chrome.debugger.sendCommand({ tabId: tab.id }, "Network.disable", {});
      try { await chrome.debugger.detach({ tabId: tab.id }); } catch {}
    }

    return {
      success: true,
      data: {
        profile,
        conditions: {
          offline: conditions.offline,
          latency_ms: conditions.latency,
          download_bytes_per_sec: conditions.download,
          upload_bytes_per_sec: conditions.upload,
        },
        note: profile === "none" ? "Throttling cleared" : "Throttling active — debugger remains attached. Use profile 'none' to clear.",
      },
    };
  } catch (e) {
    try { await chrome.debugger.detach({ tabId: tab.id }); } catch {}
    return { success: false, error: "Network throttle failed: " + e.message };
  }
}

async function cmdDevtoolsCpuThrottle({ rate }) {
  const tab = await getActiveTab();
  if (!tab) return { success: false, error: "No active tab found" };

  const throttleRate = rate || 1;

  try {
    await chrome.debugger.attach({ tabId: tab.id }, "1.3");
  } catch (e) {
    if (!e.message?.includes("Already attached")) {
      return { success: false, error: "Debugger attach failed: " + e.message };
    }
  }

  try {
    await chrome.debugger.sendCommand({ tabId: tab.id }, "Emulation.setCPUThrottlingRate", {
      rate: throttleRate,
    });

    // For rate 1 (no throttle), detach to clean up
    if (throttleRate <= 1) {
      try { await chrome.debugger.detach({ tabId: tab.id }); } catch {}
    }

    return {
      success: true,
      data: {
        rate: throttleRate,
        note: throttleRate <= 1
          ? "CPU throttling cleared"
          : "CPU " + throttleRate + "x slowdown active — debugger remains attached. Use rate 1 to clear.",
      },
    };
  } catch (e) {
    try { await chrome.debugger.detach({ tabId: tab.id }); } catch {}
    return { success: false, error: "CPU throttle failed: " + e.message };
  }
}

async function cmdDevtoolsCoverage({ type, duration_ms }) {
  const tab = await getActiveTab();
  if (!tab) return { success: false, error: "No active tab found" };

  const coverageType = type || "both";
  const duration = duration_ms || 5000;

  try {
    await chrome.debugger.attach({ tabId: tab.id }, "1.3");
  } catch (e) {
    if (!e.message?.includes("Already attached")) {
      return { success: false, error: "Debugger attach failed: " + e.message };
    }
  }

  try {
    const doJs = coverageType === "js" || coverageType === "both";
    const doCss = coverageType === "css" || coverageType === "both";

    if (doJs) {
      await chrome.debugger.sendCommand({ tabId: tab.id }, "Profiler.enable", {});
      await chrome.debugger.sendCommand({ tabId: tab.id }, "Profiler.startPreciseCoverage", {
        callCount: false,
        detailed: true,
      });
    }

    if (doCss) {
      await chrome.debugger.sendCommand({ tabId: tab.id }, "CSS.enable", {});
      await chrome.debugger.sendCommand({ tabId: tab.id }, "CSS.startRuleUsageTracking", {});
    }

    await new Promise((r) => setTimeout(r, duration));

    const resources = [];
    let totalBytes = 0;
    let usedBytes = 0;

    if (doJs) {
      const jsCoverage = await chrome.debugger.sendCommand({ tabId: tab.id }, "Profiler.takePreciseCoverage", {});
      await chrome.debugger.sendCommand({ tabId: tab.id }, "Profiler.stopPreciseCoverage", {});
      await chrome.debugger.sendCommand({ tabId: tab.id }, "Profiler.disable", {});

      for (const script of jsCoverage.result) {
        if (!script.url || script.url.startsWith("extensions://")) continue;
        let scriptTotal = 0;
        let scriptUsed = 0;
        for (const func of script.functions) {
          for (const range of func.ranges) {
            const size = range.endOffset - range.startOffset;
            if (func.ranges.indexOf(range) === 0) {
              scriptTotal += size;
            }
            if (range.count > 0) {
              scriptUsed += size;
            }
          }
        }
        if (scriptTotal > 0) {
          resources.push({
            url: script.url.substring(0, 200),
            type: "js",
            total_bytes: scriptTotal,
            used_bytes: scriptUsed,
            coverage_pct: Math.round((scriptUsed / scriptTotal) * 10000) / 100,
          });
          totalBytes += scriptTotal;
          usedBytes += scriptUsed;
        }
      }
    }

    if (doCss) {
      const cssResult = await chrome.debugger.sendCommand({ tabId: tab.id }, "CSS.stopRuleUsageTracking", {});
      await chrome.debugger.sendCommand({ tabId: tab.id }, "CSS.disable", {});

      // Aggregate CSS rules by stylesheet
      const cssSheets = {};
      for (const rule of cssResult.ruleUsage) {
        const key = rule.styleSheetId;
        if (!cssSheets[key]) {
          cssSheets[key] = { total: 0, used: 0 };
        }
        const size = rule.endOffset - rule.startOffset;
        cssSheets[key].total += size;
        if (rule.used) {
          cssSheets[key].used += size;
        }
      }

      for (const [sheetId, info] of Object.entries(cssSheets)) {
        if (info.total > 0) {
          resources.push({
            url: "stylesheet:" + sheetId,
            type: "css",
            total_bytes: info.total,
            used_bytes: info.used,
            coverage_pct: Math.round((info.used / info.total) * 10000) / 100,
          });
          totalBytes += info.total;
          usedBytes += info.used;
        }
      }
    }

    return {
      success: true,
      data: {
        resources,
        summary: {
          total_bytes: totalBytes,
          used_bytes: usedBytes,
          total_unused_pct: totalBytes > 0 ? Math.round(((totalBytes - usedBytes) / totalBytes) * 10000) / 100 : 0,
          resource_count: resources.length,
        },
        duration_ms: duration,
        type: coverageType,
      },
    };
  } finally {
    try { await chrome.debugger.detach({ tabId: tab.id }); } catch {}
  }
}

async function cmdDevtoolsHeapSnapshot() {
  const tab = await getActiveTab();
  if (!tab) return { success: false, error: "No active tab found" };

  try {
    await chrome.debugger.attach({ tabId: tab.id }, "1.3");
  } catch (e) {
    if (!e.message?.includes("Already attached")) {
      return { success: false, error: "Debugger attach failed: " + e.message };
    }
  }

  try {
    await chrome.debugger.sendCommand({ tabId: tab.id }, "HeapProfiler.enable", {});

    // Collect snapshot chunks
    let snapshotData = "";
    const chunkListener = (source, method, params) => {
      if (source.tabId !== tab.id) return;
      if (method === "HeapProfiler.addHeapSnapshotChunk") {
        snapshotData += params.chunk;
      }
    };

    chrome.debugger.onEvent.addListener(chunkListener);

    await chrome.debugger.sendCommand({ tabId: tab.id }, "HeapProfiler.takeHeapSnapshot", {
      reportProgress: false,
    });

    chrome.debugger.onEvent.removeListener(chunkListener);
    await chrome.debugger.sendCommand({ tabId: tab.id }, "HeapProfiler.disable", {});

    // Parse the snapshot to extract a summary
    let snapshot;
    try {
      snapshot = JSON.parse(snapshotData);
    } catch (e) {
      return {
        success: true,
        data: {
          summary: {
            total_size: snapshotData.length,
            note: "Snapshot captured but too large to parse in detail",
            raw_size_bytes: snapshotData.length,
          },
        },
      };
    }

    // Extract node types and sizes from the snapshot
    const nodeFields = snapshot.snapshot?.meta?.node_fields || [];
    const typeIdx = nodeFields.indexOf("type");
    const nameIdx = nodeFields.indexOf("name");
    const selfSizeIdx = nodeFields.indexOf("self_size");
    const nodeFieldCount = nodeFields.length;

    const nodeTypes = snapshot.snapshot?.meta?.node_types?.[0] || [];
    const strings = snapshot.strings || [];
    const nodes = snapshot.nodes || [];

    const retainerMap = {};
    let totalSize = 0;

    for (let i = 0; i < nodes.length; i += nodeFieldCount) {
      const typeIndex = nodes[i + typeIdx];
      const nameIndex = nodes[i + nameIdx];
      const selfSize = nodes[i + selfSizeIdx];

      const typeName = nodeTypes[typeIndex] || "unknown";
      const name = strings[nameIndex] || typeName;
      totalSize += selfSize;

      const key = typeName === "object" ? name : typeName;
      if (!retainerMap[key]) {
        retainerMap[key] = { constructor: key, count: 0, size: 0 };
      }
      retainerMap[key].count++;
      retainerMap[key].size += selfSize;
    }

    const topRetainers = Object.values(retainerMap)
      .filter((r) => r.size > 0)
      .sort((a, b) => b.size - a.size)
      .slice(0, 30);

    return {
      success: true,
      data: {
        summary: {
          total_size: totalSize,
          total_nodes: nodes.length / nodeFieldCount,
          top_retainers: topRetainers,
        },
      },
    };
  } finally {
    try { await chrome.debugger.detach({ tabId: tab.id }); } catch {}
  }
}

async function cmdDevtoolsEmulateDevice({ device, width, height, device_scale, mobile, user_agent }) {
  const tab = await getActiveTab();
  if (!tab) return { success: false, error: "No active tab found" };

  const presets = {
    iphone14: { width: 390, height: 844, deviceScaleFactor: 3, mobile: true, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1" },
    ipad: { width: 820, height: 1180, deviceScaleFactor: 2, mobile: true, userAgent: "Mozilla/5.0 (iPad; CPU OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1" },
    pixel7: { width: 412, height: 915, deviceScaleFactor: 2.625, mobile: true, userAgent: "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Mobile Safari/537.36" },
    desktop1080p: { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false, userAgent: "" },
  };

  let config;
  if (device && device !== "custom" && presets[device]) {
    config = { ...presets[device] };
  } else {
    config = {
      width: width || 1920,
      height: height || 1080,
      deviceScaleFactor: device_scale || 1,
      mobile: mobile || false,
      userAgent: user_agent || "",
    };
    device = device || "custom";
  }

  try {
    await chrome.debugger.attach({ tabId: tab.id }, "1.3");
  } catch (e) {
    if (!e.message?.includes("Already attached")) {
      return { success: false, error: "Debugger attach failed: " + e.message };
    }
  }

  try {
    await chrome.debugger.sendCommand({ tabId: tab.id }, "Emulation.setDeviceMetricsOverride", {
      width: config.width,
      height: config.height,
      deviceScaleFactor: config.deviceScaleFactor,
      mobile: config.mobile,
    });

    if (config.userAgent) {
      await chrome.debugger.sendCommand({ tabId: tab.id }, "Emulation.setUserAgentOverride", {
        userAgent: config.userAgent,
      });
    }

    // Do NOT detach — emulation persists only while debugger is attached.

    return {
      success: true,
      data: {
        device,
        width: config.width,
        height: config.height,
        mobile: config.mobile,
        deviceScaleFactor: config.deviceScaleFactor,
        note: "Device emulation active — debugger remains attached. Navigate or reload to see effect.",
      },
    };
  } catch (e) {
    try { await chrome.debugger.detach({ tabId: tab.id }); } catch {}
    return { success: false, error: "Device emulation failed: " + e.message };
  }
}

// ── Keyboard Shortcut Tools ──

// Shared key-name-to-CDP-params mapping used by all keyboard tools
function resolveKeyParams(keyName) {
  var name = keyName.trim();
  var map = {
    "Enter":     { key: "Enter",     code: "Enter",      keyCode: 13 },
    "Return":    { key: "Enter",     code: "Enter",      keyCode: 13 },
    "Tab":       { key: "Tab",       code: "Tab",        keyCode: 9  },
    "Escape":    { key: "Escape",    code: "Escape",     keyCode: 27 },
    "Esc":       { key: "Escape",    code: "Escape",     keyCode: 27 },
    "Backspace": { key: "Backspace", code: "Backspace",  keyCode: 8  },
    "Delete":    { key: "Delete",    code: "Delete",     keyCode: 46 },
    "Space":     { key: " ",         code: "Space",      keyCode: 32 },
    "ArrowUp":   { key: "ArrowUp",   code: "ArrowUp",    keyCode: 38 },
    "ArrowDown": { key: "ArrowDown", code: "ArrowDown",  keyCode: 40 },
    "ArrowLeft": { key: "ArrowLeft", code: "ArrowLeft",  keyCode: 37 },
    "ArrowRight":{ key: "ArrowRight",code: "ArrowRight", keyCode: 39 },
    "Home":      { key: "Home",      code: "Home",       keyCode: 36 },
    "End":       { key: "End",       code: "End",        keyCode: 35 },
    "PageUp":    { key: "PageUp",    code: "PageUp",     keyCode: 33 },
    "PageDown":  { key: "PageDown",  code: "PageDown",   keyCode: 34 },
    "Insert":    { key: "Insert",    code: "Insert",     keyCode: 45 },
    "Control":   { key: "Control",   code: "ControlLeft", keyCode: 17 },
    "Ctrl":      { key: "Control",   code: "ControlLeft", keyCode: 17 },
    "Shift":     { key: "Shift",     code: "ShiftLeft",  keyCode: 16 },
    "Alt":       { key: "Alt",       code: "AltLeft",    keyCode: 18 },
    "Option":    { key: "Alt",       code: "AltLeft",    keyCode: 18 },
    "Meta":      { key: "Meta",      code: "MetaLeft",   keyCode: 91 },
    "Cmd":       { key: "Meta",      code: "MetaLeft",   keyCode: 91 },
    "Command":   { key: "Meta",      code: "MetaLeft",   keyCode: 91 },
  };

  // F1-F12
  var fMatch = name.match(/^F(\d+)$/i);
  if (fMatch) {
    var fn = parseInt(fMatch[1], 10);
    return { key: "F" + fn, code: "F" + fn, keyCode: 111 + fn };
  }

  // Look up in the map (case-insensitive)
  for (var k in map) {
    if (k.toLowerCase() === name.toLowerCase()) return map[k];
  }

  // Single character
  if (name.length === 1) {
    var ch = name;
    var upper = ch.toUpperCase();
    var code = "Key" + upper;
    if (/[0-9]/.test(ch)) code = "Digit" + ch;
    return { key: ch, code: code, keyCode: upper.charCodeAt(0) };
  }

  // Fallback
  return { key: name, code: name, keyCode: 0 };
}

function buildModifiers(ctrl, alt, shift, meta) {
  var m = 0;
  if (alt)   m |= 1;
  if (ctrl)  m |= 2;
  if (meta)  m |= 4;
  if (shift) m |= 8;
  return m;
}

async function cdpKeyDown(tabId, keyParams, modifiers) {
  var isModifier = ["Control", "Shift", "Alt", "Meta"].indexOf(keyParams.key) !== -1;
  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", {
    type: isModifier ? "rawKeyDown" : "keyDown",
    key: keyParams.key,
    code: keyParams.code,
    windowsVirtualKeyCode: keyParams.keyCode,
    nativeVirtualKeyCode: keyParams.keyCode,
    modifiers: modifiers || 0,
  });
  // For printable characters, also send a char event
  if (!isModifier && keyParams.key.length === 1 && modifiers === 0) {
    await chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", {
      type: "char",
      text: keyParams.key,
      key: keyParams.key,
      code: keyParams.code,
      modifiers: 0,
    });
  }
}

async function cdpKeyUp(tabId, keyParams, modifiers) {
  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", {
    type: "keyUp",
    key: keyParams.key,
    code: keyParams.code,
    windowsVirtualKeyCode: keyParams.keyCode,
    nativeVirtualKeyCode: keyParams.keyCode,
    modifiers: modifiers || 0,
  });
}

// Parse a shortcut string like "Ctrl+Shift+P" into { modifiers: {...}, key: "p" }
function parseShortcutChord(chord) {
  var parts = chord.split("+").map(function (s) { return s.trim(); });
  var mods = { ctrl: false, shift: false, alt: false, meta: false };
  var key = null;

  for (var i = 0; i < parts.length; i++) {
    var p = parts[i].toLowerCase();
    if (p === "ctrl" || p === "control") { mods.ctrl = true; }
    else if (p === "cmd" || p === "command" || p === "meta") { mods.meta = true; }
    else if (p === "shift") { mods.shift = true; }
    else if (p === "alt" || p === "option") { mods.alt = true; }
    else { key = parts[i]; }
  }

  return { modifiers: mods, key: key };
}

async function cmdKeyboardShortcut({ shortcut, selector }) {
  var tab = await getActiveTab();
  if (!tab) return { success: false, error: "No active tab found" };
  if (!shortcut) return { success: false, error: "shortcut parameter is required" };

  // Focus element if selector is provided
  if (selector) {
    var [focusResult] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: function (sel) {
        var el = document.querySelector(sel);
        if (!el) return { success: false, error: "Element not found: " + sel };
        el.focus();
        return { success: true };
      },
      args: [selector],
      world: "MAIN",
    });
    if (!focusResult.result.success) return focusResult.result;
  }

  try {
    await chrome.debugger.attach({ tabId: tab.id }, "1.3");
  } catch (e) {
    if (!e.message?.includes("Already attached")) {
      return { success: false, error: "Debugger attach failed: " + e.message };
    }
  }

  try {
    // Split space-separated sequences: "Ctrl+A Ctrl+C"
    var chords = shortcut.split(/\s+/);
    var keysPressed = [];

    for (var ci = 0; ci < chords.length; ci++) {
      var parsed = parseShortcutChord(chords[ci]);
      if (!parsed.key) {
        return { success: false, error: "No key found in chord: " + chords[ci] };
      }

      var keyParams = resolveKeyParams(parsed.key);
      var mods = parsed.modifiers;
      var modBits = buildModifiers(mods.ctrl, mods.alt, mods.shift, mods.meta);

      // Press modifier keys down
      if (mods.ctrl)  await cdpKeyDown(tab.id, resolveKeyParams("Control"), 0);
      if (mods.alt)   await cdpKeyDown(tab.id, resolveKeyParams("Alt"), buildModifiers(mods.ctrl, false, false, false));
      if (mods.shift) await cdpKeyDown(tab.id, resolveKeyParams("Shift"), buildModifiers(mods.ctrl, mods.alt, false, false));
      if (mods.meta)  await cdpKeyDown(tab.id, resolveKeyParams("Meta"), buildModifiers(mods.ctrl, mods.alt, mods.shift, false));

      // Press and release the main key
      await cdpKeyDown(tab.id, keyParams, modBits);
      await cdpKeyUp(tab.id, keyParams, modBits);

      // Release modifiers in reverse order
      if (mods.meta)  await cdpKeyUp(tab.id, resolveKeyParams("Meta"), buildModifiers(mods.ctrl, mods.alt, mods.shift, false));
      if (mods.shift) await cdpKeyUp(tab.id, resolveKeyParams("Shift"), buildModifiers(mods.ctrl, mods.alt, false, false));
      if (mods.alt)   await cdpKeyUp(tab.id, resolveKeyParams("Alt"), buildModifiers(mods.ctrl, false, false, false));
      if (mods.ctrl)  await cdpKeyUp(tab.id, resolveKeyParams("Control"), 0);

      keysPressed.push(chords[ci]);

      // Brief pause between chords in a sequence
      if (ci < chords.length - 1) {
        await new Promise(function (r) { setTimeout(r, 50); });
      }
    }

    return {
      success: true,
      data: { shortcut: shortcut, keys_pressed: keysPressed },
    };
  } finally {
    try { await chrome.debugger.detach({ tabId: tab.id }); } catch {}
  }
}

async function cmdKeyboardTypeText({ text, delay_ms, selector }) {
  var tab = await getActiveTab();
  if (!tab) return { success: false, error: "No active tab found" };
  if (!text) return { success: false, error: "text parameter is required" };
  var delay = delay_ms || 50;

  // Focus element if selector is provided
  if (selector) {
    var [focusResult] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: function (sel) {
        var el = document.querySelector(sel);
        if (!el) return { success: false, error: "Element not found: " + sel };
        el.focus();
        return { success: true };
      },
      args: [selector],
      world: "MAIN",
    });
    if (!focusResult.result.success) return focusResult.result;
  }

  try {
    await chrome.debugger.attach({ tabId: tab.id }, "1.3");
  } catch (e) {
    if (!e.message?.includes("Already attached")) {
      return { success: false, error: "Debugger attach failed: " + e.message };
    }
  }

  try {
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      var keyParams = resolveKeyParams(ch);

      // keyDown
      await chrome.debugger.sendCommand({ tabId: tab.id }, "Input.dispatchKeyEvent", {
        type: "keyDown",
        key: ch,
        code: keyParams.code,
        text: ch,
        unmodifiedText: ch,
        windowsVirtualKeyCode: keyParams.keyCode,
        nativeVirtualKeyCode: keyParams.keyCode,
      });

      // char
      await chrome.debugger.sendCommand({ tabId: tab.id }, "Input.dispatchKeyEvent", {
        type: "char",
        text: ch,
        key: ch,
        code: keyParams.code,
        unmodifiedText: ch,
      });

      // keyUp
      await chrome.debugger.sendCommand({ tabId: tab.id }, "Input.dispatchKeyEvent", {
        type: "keyUp",
        key: ch,
        code: keyParams.code,
        windowsVirtualKeyCode: keyParams.keyCode,
        nativeVirtualKeyCode: keyParams.keyCode,
      });

      if (i < text.length - 1) {
        await new Promise(function (r) { setTimeout(r, delay); });
      }
    }

    return { success: true, data: { characters_typed: text.length } };
  } finally {
    try { await chrome.debugger.detach({ tabId: tab.id }); } catch {}
  }
}

async function cmdKeyboardHoldKey({ key, duration_ms }) {
  var tab = await getActiveTab();
  if (!tab) return { success: false, error: "No active tab found" };
  if (!key) return { success: false, error: "key parameter is required" };
  var duration = duration_ms || 500;

  try {
    await chrome.debugger.attach({ tabId: tab.id }, "1.3");
  } catch (e) {
    if (!e.message?.includes("Already attached")) {
      return { success: false, error: "Debugger attach failed: " + e.message };
    }
  }

  try {
    var keyParams = resolveKeyParams(key);

    // keyDown
    await cdpKeyDown(tab.id, keyParams, 0);

    // Hold for the specified duration
    await new Promise(function (r) { setTimeout(r, duration); });

    // keyUp
    await cdpKeyUp(tab.id, keyParams, 0);

    return { success: true, data: { key: key, held_ms: duration } };
  } finally {
    try { await chrome.debugger.detach({ tabId: tab.id }); } catch {}
  }
}

async function cmdKeyboardCombo({ keys }) {
  var tab = await getActiveTab();
  if (!tab) return { success: false, error: "No active tab found" };
  if (!keys || keys.length === 0) return { success: false, error: "keys array is required and must not be empty" };

  try {
    await chrome.debugger.attach({ tabId: tab.id }, "1.3");
  } catch (e) {
    if (!e.message?.includes("Already attached")) {
      return { success: false, error: "Debugger attach failed: " + e.message };
    }
  }

  try {
    var resolvedKeys = keys.map(function (k) { return resolveKeyParams(k); });

    // Track which modifiers are held for the modifiers bitmask
    var ctrl = false, alt = false, shift = false, meta = false;

    // Press all keys down in order
    for (var i = 0; i < resolvedKeys.length; i++) {
      var kp = resolvedKeys[i];
      if (kp.key === "Control") ctrl = true;
      else if (kp.key === "Alt") alt = true;
      else if (kp.key === "Shift") shift = true;
      else if (kp.key === "Meta") meta = true;
      var modBits = buildModifiers(ctrl, alt, shift, meta);
      await cdpKeyDown(tab.id, kp, modBits);
    }

    // Release all keys in reverse order
    for (var j = resolvedKeys.length - 1; j >= 0; j--) {
      var kp2 = resolvedKeys[j];
      if (kp2.key === "Control") ctrl = false;
      else if (kp2.key === "Alt") alt = false;
      else if (kp2.key === "Shift") shift = false;
      else if (kp2.key === "Meta") meta = false;
      var modBits2 = buildModifiers(ctrl, alt, shift, meta);
      await cdpKeyUp(tab.id, kp2, modBits2);
    }

    return { success: true, data: { keys: keys } };
  } finally {
    try { await chrome.debugger.detach({ tabId: tab.id }); } catch {}
  }
}

async function cmdKeyboardShortcutsList() {
  var tab = await getActiveTab();
  if (!tab) return { success: false, error: "No active tab found" };

  var [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: function () {
      var shortcuts = [];

      // 1. Find elements with accesskey attributes
      var accessKeyEls = document.querySelectorAll("[accesskey]");
      for (var i = 0; i < accessKeyEls.length; i++) {
        var el = accessKeyEls[i];
        var key = el.getAttribute("accesskey");
        var text = (el.innerText || el.getAttribute("aria-label") || el.title || "").trim().substring(0, 100);
        var sel = el.id ? "#" + el.id : (el.tagName.toLowerCase() + "[accesskey='" + key + "']");
        shortcuts.push({
          key: "Alt+" + key,
          description: text || "accesskey element",
          element_selector: sel,
          source: "accesskey",
        });
      }

      // 2. Find elements with aria-keyshortcuts
      var ariaShortcutEls = document.querySelectorAll("[aria-keyshortcuts]");
      for (var j = 0; j < ariaShortcutEls.length; j++) {
        var el2 = ariaShortcutEls[j];
        var shortcutStr = el2.getAttribute("aria-keyshortcuts");
        var desc = (el2.innerText || el2.getAttribute("aria-label") || el2.title || "").trim().substring(0, 100);
        var sel2 = el2.id ? "#" + el2.id : null;
        shortcuts.push({
          key: shortcutStr,
          description: desc || "aria-keyshortcuts element",
          element_selector: sel2,
          source: "aria-keyshortcuts",
        });
      }

      // 3. Find elements with title attributes containing shortcut notation
      var shortcutPattern = /\b(Ctrl|Cmd|Alt|Shift|Meta|Option)\s*[+\-]\s*\S/i;
      var titledEls = document.querySelectorAll("[title]");
      for (var k = 0; k < titledEls.length; k++) {
        var title = titledEls[k].getAttribute("title") || "";
        if (shortcutPattern.test(title)) {
          var match = title.match(/\(([^)]*(?:Ctrl|Cmd|Alt|Shift|Meta|Option)[^)]*)\)/i) || [null, title];
          shortcuts.push({
            key: (match[1] || title).trim(),
            description: (titledEls[k].innerText || titledEls[k].getAttribute("aria-label") || "").trim().substring(0, 100),
            element_selector: titledEls[k].id ? "#" + titledEls[k].id : null,
            source: "title_attribute",
          });
        }
      }

      // 4. Find data-shortcut or data-hotkey attributes
      var dataShortcutEls = document.querySelectorAll("[data-shortcut], [data-hotkey], [data-keyboard-shortcut]");
      for (var d = 0; d < dataShortcutEls.length; d++) {
        var el3 = dataShortcutEls[d];
        var shortcutVal = el3.getAttribute("data-shortcut") || el3.getAttribute("data-hotkey") || el3.getAttribute("data-keyboard-shortcut");
        shortcuts.push({
          key: shortcutVal,
          description: (el3.innerText || el3.getAttribute("aria-label") || "").trim().substring(0, 100),
          element_selector: el3.id ? "#" + el3.id : null,
          source: "data_attribute",
        });
      }

      // 5. Scan for shortcut documentation sections
      var sectionKeywords = /keyboard\s*shortcuts?|hotkeys?|key\s*bindings?|shortcut\s*keys?/i;
      var headings = document.querySelectorAll("h1, h2, h3, h4, h5, h6, [role='heading']");
      for (var h = 0; h < headings.length; h++) {
        if (sectionKeywords.test(headings[h].innerText || "")) {
          // Found a shortcut documentation section; extract items from the next sibling or parent container
          var container = headings[h].nextElementSibling || headings[h].parentElement;
          if (container) {
            var rows = container.querySelectorAll("tr, li, dt, [class*='shortcut'], [class*='hotkey']");
            for (var r = 0; r < Math.min(rows.length, 30); r++) {
              var rowText = (rows[r].innerText || "").trim();
              if (rowText.length > 2 && rowText.length < 200) {
                shortcuts.push({
                  key: null,
                  description: rowText.substring(0, 150),
                  element_selector: null,
                  source: "documentation_section",
                });
              }
            }
          }
        }
      }

      // 6. Check <kbd> elements which often contain shortcut info
      var kbdEls = document.querySelectorAll("kbd");
      var kbdSeen = {};
      for (var kb = 0; kb < kbdEls.length; kb++) {
        var kbdText = (kbdEls[kb].innerText || "").trim();
        if (kbdText && !kbdSeen[kbdText]) {
          kbdSeen[kbdText] = true;
          var parent = kbdEls[kb].closest("li, tr, p, div, span");
          var context = parent ? (parent.innerText || "").trim().substring(0, 150) : kbdText;
          shortcuts.push({
            key: kbdText,
            description: context !== kbdText ? context : "",
            element_selector: null,
            source: "kbd_element",
          });
        }
      }

      return { success: true, data: { shortcuts: shortcuts, count: shortcuts.length } };
    },
    args: [],
    world: "MAIN",
  });

  return result.result;
}

// ── Phase 1: Core Interaction Tools ──

async function getElementCenter(tabId, selector) {
  var [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: function (sel) {
      var el = document.querySelector(sel);
      if (!el) return { found: false };
      el.scrollIntoView({ behavior: "instant", block: "center", inline: "center" });
      var r = el.getBoundingClientRect();
      return { found: true, x: r.x + r.width / 2, y: r.y + r.height / 2, width: r.width, height: r.height };
    },
    args: [selector],
    world: "MAIN",
  });
  return result.result;
}

async function cdpMouseEvent(tabId, type, x, y, button, clickCount, modifiers) {
  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
    type: type, x: x, y: y, button: button || "left", clickCount: clickCount || 1, modifiers: modifiers || 0,
  });
}

async function cmdRightClick({ selector, x, y }) {
  var tab = await getActiveTab();
  if (!tab) return { success: false, error: "No active tab found" };
  var cx = x, cy = y;
  if (selector) {
    var pos = await getElementCenter(tab.id, selector);
    if (!pos || !pos.found) return { success: false, error: "Element not found: " + selector };
    cx = pos.x; cy = pos.y;
  }
  if (cx == null || cy == null) return { success: false, error: "Provide selector or x/y coordinates" };
  await acquireDebugger(tab.id);
  try {
    await cdpMouseEvent(tab.id, "mousePressed", cx, cy, "right", 1);
    await cdpMouseEvent(tab.id, "mouseReleased", cx, cy, "right", 1);
    return { success: true, data: { x: cx, y: cy, button: "right" } };
  } finally { await releaseDebugger(tab.id); }
}

async function cmdMiddleClick({ selector, x, y }) {
  var tab = await getActiveTab();
  if (!tab) return { success: false, error: "No active tab found" };
  var cx = x, cy = y;
  if (selector) {
    var pos = await getElementCenter(tab.id, selector);
    if (!pos || !pos.found) return { success: false, error: "Element not found: " + selector };
    cx = pos.x; cy = pos.y;
  }
  if (cx == null || cy == null) return { success: false, error: "Provide selector or x/y coordinates" };
  await acquireDebugger(tab.id);
  try {
    await cdpMouseEvent(tab.id, "mousePressed", cx, cy, "middle", 1);
    await cdpMouseEvent(tab.id, "mouseReleased", cx, cy, "middle", 1);
    return { success: true, data: { x: cx, y: cy, button: "middle" } };
  } finally { await releaseDebugger(tab.id); }
}

async function cmdDoubleClick({ selector, x, y }) {
  var tab = await getActiveTab();
  if (!tab) return { success: false, error: "No active tab found" };
  var cx = x, cy = y;
  if (selector) {
    var pos = await getElementCenter(tab.id, selector);
    if (!pos || !pos.found) return { success: false, error: "Element not found: " + selector };
    cx = pos.x; cy = pos.y;
  }
  if (cx == null || cy == null) return { success: false, error: "Provide selector or x/y coordinates" };
  await acquireDebugger(tab.id);
  try {
    await cdpMouseEvent(tab.id, "mousePressed", cx, cy, "left", 1);
    await cdpMouseEvent(tab.id, "mouseReleased", cx, cy, "left", 1);
    await cdpMouseEvent(tab.id, "mousePressed", cx, cy, "left", 2);
    await cdpMouseEvent(tab.id, "mouseReleased", cx, cy, "left", 2);
    return { success: true, data: { x: cx, y: cy, clickCount: 2 } };
  } finally { await releaseDebugger(tab.id); }
}

async function cmdTripleClick({ selector, x, y }) {
  var tab = await getActiveTab();
  if (!tab) return { success: false, error: "No active tab found" };
  var cx = x, cy = y;
  if (selector) {
    var pos = await getElementCenter(tab.id, selector);
    if (!pos || !pos.found) return { success: false, error: "Element not found: " + selector };
    cx = pos.x; cy = pos.y;
  }
  if (cx == null || cy == null) return { success: false, error: "Provide selector or x/y coordinates" };
  await acquireDebugger(tab.id);
  try {
    await cdpMouseEvent(tab.id, "mousePressed", cx, cy, "left", 1);
    await cdpMouseEvent(tab.id, "mouseReleased", cx, cy, "left", 1);
    await cdpMouseEvent(tab.id, "mousePressed", cx, cy, "left", 2);
    await cdpMouseEvent(tab.id, "mouseReleased", cx, cy, "left", 2);
    await cdpMouseEvent(tab.id, "mousePressed", cx, cy, "left", 3);
    await cdpMouseEvent(tab.id, "mouseReleased", cx, cy, "left", 3);
    return { success: true, data: { x: cx, y: cy, clickCount: 3 } };
  } finally { await releaseDebugger(tab.id); }
}

async function cmdDragAndDrop({ sourceSelector, targetSelector, fromX, fromY, toX, toY, steps }) {
  var tab = await getActiveTab();
  if (!tab) return { success: false, error: "No active tab found" };
  var sx = fromX, sy = fromY, tx = toX, ty = toY;
  var numSteps = steps || 10;
  if (sourceSelector) {
    var sp = await getElementCenter(tab.id, sourceSelector);
    if (!sp || !sp.found) return { success: false, error: "Source element not found: " + sourceSelector };
    sx = sp.x; sy = sp.y;
  }
  if (targetSelector) {
    var tp = await getElementCenter(tab.id, targetSelector);
    if (!tp || !tp.found) return { success: false, error: "Target element not found: " + targetSelector };
    tx = tp.x; ty = tp.y;
  }
  if (sx == null || sy == null || tx == null || ty == null) return { success: false, error: "Provide sourceSelector/targetSelector or fromX/fromY/toX/toY" };
  await acquireDebugger(tab.id);
  try {
    await cdpMouseEvent(tab.id, "mouseMoved", sx, sy, "none", 0);
    await cdpMouseEvent(tab.id, "mousePressed", sx, sy, "left", 1);
    for (var i = 1; i <= numSteps; i++) {
      var mx = sx + (tx - sx) * (i / numSteps);
      var my = sy + (ty - sy) * (i / numSteps);
      await cdpMouseEvent(tab.id, "mouseMoved", mx, my, "left", 0);
    }
    await cdpMouseEvent(tab.id, "mouseReleased", tx, ty, "left", 1);
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: function (sx, sy, tx, ty) {
        var srcEl = document.elementFromPoint(sx, sy);
        var tgtEl = document.elementFromPoint(tx, ty);
        if (srcEl && tgtEl) {
          var dt = new DataTransfer();
          srcEl.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: dt }));
          tgtEl.dispatchEvent(new DragEvent("dragenter", { bubbles: true, dataTransfer: dt }));
          tgtEl.dispatchEvent(new DragEvent("dragover", { bubbles: true, dataTransfer: dt }));
          tgtEl.dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer: dt }));
          srcEl.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer: dt }));
        }
      },
      args: [sx, sy, tx, ty],
      world: "MAIN",
    });
    return { success: true, data: { from: { x: sx, y: sy }, to: { x: tx, y: ty }, steps: numSteps } };
  } finally { await releaseDebugger(tab.id); }
}

async function cmdSelectText({ selector, startOffset, endOffset }) {
  var tab = await getActiveTab();
  if (!tab) return { success: false, error: "No active tab found" };
  var [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: function (sel, sOff, eOff) {
      var el = document.querySelector(sel);
      if (!el) return { success: false, error: "Element not found: " + sel };
      if (el.select && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) {
        el.focus(); el.select();
        if (sOff != null) el.setSelectionRange(sOff, eOff != null ? eOff : el.value.length);
        return { success: true, data: { selected: el.value.substring(sOff || 0, eOff || el.value.length) } };
      }
      var range = document.createRange();
      if (sOff != null && el.firstChild) {
        var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        var charCount = 0, startNode = null, startNodeOff = 0, endNode = null, endNodeOff = 0;
        var endTarget = eOff != null ? eOff : el.textContent.length;
        while (walker.nextNode()) {
          var node = walker.currentNode, len = node.textContent.length;
          if (!startNode && charCount + len > sOff) { startNode = node; startNodeOff = sOff - charCount; }
          if (!endNode && charCount + len >= endTarget) { endNode = node; endNodeOff = endTarget - charCount; }
          charCount += len;
          if (startNode && endNode) break;
        }
        if (startNode) range.setStart(startNode, startNodeOff);
        if (endNode) range.setEnd(endNode, endNodeOff);
      } else { range.selectNodeContents(el); }
      var s = window.getSelection(); s.removeAllRanges(); s.addRange(range);
      return { success: true, data: { selected: s.toString() } };
    },
    args: [selector, startOffset || null, endOffset || null],
    world: "MAIN",
  });
  return result.result;
}

async function cmdGetSelection() {
  var tab = await getActiveTab();
  if (!tab) return { success: false, error: "No active tab found" };
  var [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: function () {
      var sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return { success: true, data: { text: "", rangeCount: 0 } };
      var range = sel.getRangeAt(0);
      var rect = range.getBoundingClientRect();
      return { success: true, data: { text: sel.toString(), rangeCount: sel.rangeCount, isCollapsed: sel.isCollapsed, boundingRect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } } };
    },
    args: [],
    world: "MAIN",
  });
  return result.result;
}

async function cmdTouchEvent({ gesture, x, y, toX, toY, duration_ms, selector }) {
  var tab = await getActiveTab();
  if (!tab) return { success: false, error: "No active tab found" };
  var cx = x || 0, cy = y || 0;
  if (selector) {
    var pos = await getElementCenter(tab.id, selector);
    if (!pos || !pos.found) return { success: false, error: "Element not found: " + selector };
    cx = pos.x; cy = pos.y;
  }
  var dur = duration_ms || 300;
  gesture = gesture || "tap";
  await acquireDebugger(tab.id);
  try {
    if (gesture === "tap") {
      await chrome.debugger.sendCommand({ tabId: tab.id }, "Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: cx, y: cy }] });
      await new Promise(function (r) { setTimeout(r, 50); });
      await chrome.debugger.sendCommand({ tabId: tab.id }, "Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    } else if (gesture === "long_press") {
      await chrome.debugger.sendCommand({ tabId: tab.id }, "Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: cx, y: cy }] });
      await new Promise(function (r) { setTimeout(r, dur); });
      await chrome.debugger.sendCommand({ tabId: tab.id }, "Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    } else if (gesture === "swipe") {
      var endX = toX != null ? toX : cx, endY = toY != null ? toY : cy;
      var steps = 10;
      await chrome.debugger.sendCommand({ tabId: tab.id }, "Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: cx, y: cy }] });
      for (var i = 1; i <= steps; i++) {
        await chrome.debugger.sendCommand({ tabId: tab.id }, "Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: cx + (endX - cx) * (i / steps), y: cy + (endY - cy) * (i / steps) }] });
        await new Promise(function (r) { setTimeout(r, dur / steps); });
      }
      await chrome.debugger.sendCommand({ tabId: tab.id }, "Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    } else if (gesture === "pinch") {
      var spread = 50, steps = 10;
      await chrome.debugger.sendCommand({ tabId: tab.id }, "Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: cx - spread, y: cy }, { x: cx + spread, y: cy }] });
      for (var i = 1; i <= steps; i++) {
        var s = spread + ((toX != null ? toX : 100) - spread) * (i / steps);
        await chrome.debugger.sendCommand({ tabId: tab.id }, "Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: cx - s, y: cy }, { x: cx + s, y: cy }] });
        await new Promise(function (r) { setTimeout(r, dur / steps); });
      }
      await chrome.debugger.sendCommand({ tabId: tab.id }, "Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    } else { return { success: false, error: "Unknown gesture: " + gesture }; }
    return { success: true, data: { gesture: gesture, x: cx, y: cy } };
  } finally { await releaseDebugger(tab.id); }
}

// ── Phase 2: Tab & Window Management ──

async function cmdPinTab({ tabId, pinned }) {
  var tid = tabId;
  if (!tid) { var tab = await getActiveTab(); if (!tab) return { success: false, error: "No active tab found" }; tid = tab.id; }
  var pin = pinned !== false;
  await chrome.tabs.update(tid, { pinned: pin });
  return { success: true, data: { tabId: tid, pinned: pin } };
}

async function cmdMuteTab({ tabId, muted }) {
  var tid = tabId;
  if (!tid) { var tab = await getActiveTab(); if (!tab) return { success: false, error: "No active tab found" }; tid = tab.id; }
  var m = muted !== false;
  await chrome.tabs.update(tid, { muted: m });
  return { success: true, data: { tabId: tid, muted: m } };
}

async function cmdDuplicateTab({ tabId }) {
  var tid = tabId;
  if (!tid) { var tab = await getActiveTab(); if (!tab) return { success: false, error: "No active tab found" }; tid = tab.id; }
  var newTab = await chrome.tabs.duplicate(tid);
  return { success: true, data: { originalTabId: tid, newTabId: newTab.id, url: newTab.url } };
}

async function cmdMoveTab({ tabId, windowId, index }) {
  var tid = tabId;
  if (!tid) { var tab = await getActiveTab(); if (!tab) return { success: false, error: "No active tab found" }; tid = tab.id; }
  var moved = await chrome.tabs.move(tid, { windowId: windowId || undefined, index: index != null ? index : -1 });
  return { success: true, data: { tabId: moved.id, windowId: moved.windowId, index: moved.index } };
}

async function cmdCreateWindow({ url, type, width, height, left, top, state, incognito }) {
  var opts = {};
  if (url) opts.url = url;
  if (type) opts.type = type;
  if (width != null) opts.width = width;
  if (height != null) opts.height = height;
  if (left != null) opts.left = left;
  if (top != null) opts.top = top;
  if (state) opts.state = state;
  if (incognito) opts.incognito = incognito;
  var win = await chrome.windows.create(opts);
  return { success: true, data: { windowId: win.id, tabs: win.tabs?.map(function (t) { return t.id; }) || [], state: win.state } };
}

async function cmdCloseWindow({ windowId }) {
  if (!windowId) { var win = await chrome.windows.getCurrent(); windowId = win.id; }
  await chrome.windows.remove(windowId);
  return { success: true, data: { closed: windowId } };
}

async function cmdResizeWindow({ windowId, width, height, left, top, state }) {
  if (!windowId) { var win = await chrome.windows.getCurrent(); windowId = win.id; }
  var opts = {};
  if (width != null) opts.width = width;
  if (height != null) opts.height = height;
  if (left != null) opts.left = left;
  if (top != null) opts.top = top;
  if (state) opts.state = state;
  var updated = await chrome.windows.update(windowId, opts);
  return { success: true, data: { windowId: updated.id, width: updated.width, height: updated.height, left: updated.left, top: updated.top, state: updated.state } };
}

async function cmdListWindows() {
  var wins = await chrome.windows.getAll({ populate: true });
  return { success: true, data: wins.map(function (w) {
    return { id: w.id, focused: w.focused, state: w.state, type: w.type, width: w.width, height: w.height, left: w.left, top: w.top, tabCount: w.tabs ? w.tabs.length : 0, tabs: w.tabs ? w.tabs.map(function (t) { return { id: t.id, url: t.url, title: t.title, active: t.active }; }) : [] };
  }) };
}

// ── Phase 3: Page Features ──

async function cmdReloadPage({ hard }) {
  var tab = await getActiveTab();
  if (!tab) return { success: false, error: "No active tab found" };
  await chrome.tabs.reload(tab.id, { bypassCache: !!hard });
  return { success: true, data: { reloaded: true, bypassCache: !!hard } };
}

async function cmdStopLoading() {
  var tab = await getActiveTab();
  if (!tab) return { success: false, error: "No active tab found" };
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: function () { window.stop(); }, args: [], world: "MAIN" });
  return { success: true, data: "Page loading stopped" };
}

async function cmdFindText({ query, caseSensitive, highlightColor }) {
  var tab = await getActiveTab();
  if (!tab) return { success: false, error: "No active tab found" };
  if (!query) return { success: false, error: "query parameter is required" };
  var [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: function (q, cs, color) {
      document.querySelectorAll("[data-bc-find-highlight]").forEach(function (el) { el.replaceWith(el.textContent); });
      document.normalize();
      var matches = [], walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT), nodes = [];
      while (walker.nextNode()) {
        var text = cs ? walker.currentNode.textContent : walker.currentNode.textContent.toLowerCase();
        if (text.indexOf(cs ? q : q.toLowerCase()) !== -1) nodes.push(walker.currentNode);
      }
      var hc = color || "rgba(255, 230, 0, 0.5)";
      for (var ni = 0; ni < nodes.length; ni++) {
        var node = nodes[ni], text = cs ? node.textContent : node.textContent.toLowerCase(), sq = cs ? q : q.toLowerCase(), idx = text.indexOf(sq);
        while (idx !== -1) {
          var range = document.createRange(); range.setStart(node, idx); range.setEnd(node, idx + q.length);
          var span = document.createElement("span"); span.style.backgroundColor = hc; span.style.borderRadius = "2px"; span.setAttribute("data-bc-find-highlight", "true");
          range.surroundContents(span);
          var rect = span.getBoundingClientRect();
          matches.push({ index: matches.length, x: rect.x, y: rect.y, text: span.textContent });
          node = span.nextSibling; if (!node) break;
          text = cs ? node.textContent : node.textContent.toLowerCase(); idx = text.indexOf(sq);
        }
      }
      if (matches.length > 0) { var first = document.querySelector("[data-bc-find-highlight]"); if (first) first.scrollIntoView({ behavior: "smooth", block: "center" }); }
      return { success: true, data: { query: q, matchCount: matches.length, matches: matches.slice(0, 50) } };
    },
    args: [query, !!caseSensitive, highlightColor || null],
    world: "MAIN",
  });
  return result.result;
}

async function cmdSetZoom({ level, action }) {
  var tab = await getActiveTab();
  if (!tab) return { success: false, error: "No active tab found" };
  var act = action || (level != null ? "set" : "get");
  if (act === "get") { var z = await chrome.tabs.getZoom(tab.id); return { success: true, data: { zoom: z } }; }
  if (act === "reset") { await chrome.tabs.setZoom(tab.id, 0); return { success: true, data: { zoom: 1.0, reset: true } }; }
  await chrome.tabs.setZoom(tab.id, level || 1.0);
  return { success: true, data: { zoom: level || 1.0 } };
}

async function cmdSavePdf({ landscape, printBackground, scale, format }) {
  var tab = await getActiveTab();
  if (!tab) return { success: false, error: "No active tab found" };
  await acquireDebugger(tab.id);
  try {
    var pw = 8.5, ph = 11;
    if (format === "a4") { pw = 8.27; ph = 11.69; } else if (format === "legal") { pw = 8.5; ph = 14; }
    var result = await chrome.debugger.sendCommand({ tabId: tab.id }, "Page.printToPDF", {
      landscape: !!landscape, printBackground: printBackground !== false, scale: scale || 1,
      paperWidth: pw, paperHeight: ph, marginTop: 0.4, marginBottom: 0.4, marginLeft: 0.4, marginRight: 0.4,
    });
    return { success: true, data: { base64: result.data, size_bytes: Math.round(result.data.length * 0.75) } };
  } finally { await releaseDebugger(tab.id); }
}

async function cmdSaveHtml() {
  var tab = await getActiveTab();
  if (!tab) return { success: false, error: "No active tab found" };
  var [result] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: function () { return { success: true, data: { html: document.documentElement.outerHTML, url: location.href, title: document.title } }; }, args: [], world: "MAIN" });
  return result.result;
}

// ── Phase 4: Media Control ──

async function cmdMediaControl({ action, selector }) {
  var tab = await getActiveTab();
  if (!tab) return { success: false, error: "No active tab found" };
  var [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: function (act, sel) {
      var el = sel ? document.querySelector(sel) : (document.querySelector("video") || document.querySelector("audio"));
      if (!el) return { success: false, error: "No media element found" };
      if (act === "play") { el.play(); return { success: true, data: { action: "play" } }; }
      if (act === "pause") { el.pause(); return { success: true, data: { action: "pause" } }; }
      if (act === "stop") { el.pause(); el.currentTime = 0; return { success: true, data: { action: "stop" } }; }
      if (act === "toggle") { if (el.paused) { el.play(); return { success: true, data: { action: "play" } }; } else { el.pause(); return { success: true, data: { action: "pause" } }; } }
      return { success: false, error: "Unknown action: " + act };
    },
    args: [action || "toggle", selector || null],
    world: "MAIN",
  });
  return result.result;
}

async function cmdMediaVolume({ volume, muted, selector }) {
  var tab = await getActiveTab();
  if (!tab) return { success: false, error: "No active tab found" };
  var [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: function (vol, m, sel) {
      var el = sel ? document.querySelector(sel) : (document.querySelector("video") || document.querySelector("audio"));
      if (!el) return { success: false, error: "No media element found" };
      if (vol != null) el.volume = Math.max(0, Math.min(1, vol));
      if (m != null) el.muted = m;
      return { success: true, data: { volume: el.volume, muted: el.muted } };
    },
    args: [volume != null ? volume : null, muted != null ? muted : null, selector || null],
    world: "MAIN",
  });
  return result.result;
}

async function cmdMediaSeek({ time, relative, selector }) {
  var tab = await getActiveTab();
  if (!tab) return { success: false, error: "No active tab found" };
  var [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: function (t, rel, sel) {
      var el = sel ? document.querySelector(sel) : (document.querySelector("video") || document.querySelector("audio"));
      if (!el) return { success: false, error: "No media element found" };
      if (rel) el.currentTime = Math.max(0, el.currentTime + t); else el.currentTime = Math.max(0, t);
      return { success: true, data: { currentTime: el.currentTime, duration: el.duration } };
    },
    args: [time || 0, !!relative, selector || null],
    world: "MAIN",
  });
  return result.result;
}

async function cmdMediaPlaybackRate({ rate, selector }) {
  var tab = await getActiveTab();
  if (!tab) return { success: false, error: "No active tab found" };
  var [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: function (r, sel) {
      var el = sel ? document.querySelector(sel) : (document.querySelector("video") || document.querySelector("audio"));
      if (!el) return { success: false, error: "No media element found" };
      el.playbackRate = r;
      return { success: true, data: { playbackRate: el.playbackRate } };
    },
    args: [rate || 1.0, selector || null],
    world: "MAIN",
  });
  return result.result;
}

async function cmdMediaPip({ action, selector }) {
  var tab = await getActiveTab();
  if (!tab) return { success: false, error: "No active tab found" };
  var [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: async function (act, sel) {
      var el = sel ? document.querySelector(sel) : document.querySelector("video");
      if (!el) return { success: false, error: "No video element found" };
      try {
        if (act === "enter" || (act === "toggle" && document.pictureInPictureElement !== el)) { await el.requestPictureInPicture(); return { success: true, data: { pip: true } }; }
        else { await document.exitPictureInPicture(); return { success: true, data: { pip: false } }; }
      } catch (e) { return { success: false, error: e.message }; }
    },
    args: [action || "toggle", selector || null],
    world: "MAIN",
  });
  return result.result;
}

async function cmdMediaState({ selector }) {
  var tab = await getActiveTab();
  if (!tab) return { success: false, error: "No active tab found" };
  var [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: function (sel) {
      var els = sel ? [document.querySelector(sel)] : Array.from(document.querySelectorAll("video, audio"));
      els = els.filter(Boolean);
      if (!els.length) return { success: true, data: { mediaElements: [] } };
      return { success: true, data: { mediaElements: els.map(function (el) {
        return { tag: el.tagName.toLowerCase(), src: el.currentSrc || el.src || "", duration: el.duration, currentTime: el.currentTime, paused: el.paused, ended: el.ended, volume: el.volume, muted: el.muted, playbackRate: el.playbackRate, loop: el.loop, readyState: el.readyState, pip: document.pictureInPictureElement === el, width: el.videoWidth || null, height: el.videoHeight || null };
      }) } };
    },
    args: [selector || null],
    world: "MAIN",
  });
  return result.result;
}

// ── Phase 5: Emulation & Overrides ──

async function cmdOverrideGeolocation({ latitude, longitude, accuracy }) {
  var tab = await getActiveTab();
  if (!tab) return { success: false, error: "No active tab found" };
  await acquireDebugger(tab.id);
  try {
    if (latitude == null && longitude == null) {
      await chrome.debugger.sendCommand({ tabId: tab.id }, "Emulation.clearGeolocationOverride", {});
      await releaseDebugger(tab.id);
      return { success: true, data: { cleared: true } };
    }
    await chrome.debugger.sendCommand({ tabId: tab.id }, "Emulation.setGeolocationOverride", { latitude: latitude, longitude: longitude, accuracy: accuracy || 100 });
    markDebuggerPersistent(tab.id);
    return { success: true, data: { latitude: latitude, longitude: longitude, accuracy: accuracy || 100 } };
  } catch (e) { await releaseDebugger(tab.id); return { success: false, error: e.message }; }
}

async function cmdOverrideTimezone({ timezone }) {
  var tab = await getActiveTab();
  if (!tab) return { success: false, error: "No active tab found" };
  if (!timezone) return { success: false, error: "timezone parameter is required" };
  await acquireDebugger(tab.id);
  try {
    await chrome.debugger.sendCommand({ tabId: tab.id }, "Emulation.setTimezoneOverride", { timezoneId: timezone });
    markDebuggerPersistent(tab.id);
    return { success: true, data: { timezone: timezone } };
  } catch (e) { await releaseDebugger(tab.id); return { success: false, error: e.message }; }
}

async function cmdOverrideLocale({ locale }) {
  var tab = await getActiveTab();
  if (!tab) return { success: false, error: "No active tab found" };
  if (!locale) return { success: false, error: "locale parameter is required" };
  await acquireDebugger(tab.id);
  try {
    await chrome.debugger.sendCommand({ tabId: tab.id }, "Emulation.setLocaleOverride", { locale: locale });
    markDebuggerPersistent(tab.id);
    return { success: true, data: { locale: locale } };
  } catch (e) { await releaseDebugger(tab.id); return { success: false, error: e.message }; }
}

async function cmdOverrideUserAgent({ userAgent, platform, acceptLanguage }) {
  var tab = await getActiveTab();
  if (!tab) return { success: false, error: "No active tab found" };
  if (!userAgent) return { success: false, error: "userAgent parameter is required" };
  await acquireDebugger(tab.id);
  try {
    var p = { userAgent: userAgent };
    if (platform) p.platform = platform;
    if (acceptLanguage) p.acceptLanguage = acceptLanguage;
    await chrome.debugger.sendCommand({ tabId: tab.id }, "Emulation.setUserAgentOverride", p);
    markDebuggerPersistent(tab.id);
    return { success: true, data: p };
  } catch (e) { await releaseDebugger(tab.id); return { success: false, error: e.message }; }
}

async function cmdOverrideMedia({ colorScheme, reducedMotion, forcedColors }) {
  var tab = await getActiveTab();
  if (!tab) return { success: false, error: "No active tab found" };
  await acquireDebugger(tab.id);
  try {
    var features = [];
    if (colorScheme) features.push({ name: "prefers-color-scheme", value: colorScheme });
    if (reducedMotion) features.push({ name: "prefers-reduced-motion", value: reducedMotion });
    if (forcedColors) features.push({ name: "forced-colors", value: forcedColors });
    await chrome.debugger.sendCommand({ tabId: tab.id }, "Emulation.setEmulatedMedia", { features: features });
    markDebuggerPersistent(tab.id);
    return { success: true, data: { colorScheme: colorScheme, reducedMotion: reducedMotion, forcedColors: forcedColors } };
  } catch (e) { await releaseDebugger(tab.id); return { success: false, error: e.message }; }
}

async function cmdOverrideVision({ type }) {
  var tab = await getActiveTab();
  if (!tab) return { success: false, error: "No active tab found" };
  var t = type || "none";
  await acquireDebugger(tab.id);
  try {
    await chrome.debugger.sendCommand({ tabId: tab.id }, "Emulation.setEmulatedVisionDeficiency", { type: t });
    if (t === "none") await releaseDebugger(tab.id); else markDebuggerPersistent(tab.id);
    return { success: true, data: { visionDeficiency: t } };
  } catch (e) { await releaseDebugger(tab.id); return { success: false, error: e.message }; }
}

async function cmdOverridePermission({ name, setting }) {
  var tab = await getActiveTab();
  if (!tab) return { success: false, error: "No active tab found" };
  if (!name) return { success: false, error: "name parameter is required" };
  await acquireDebugger(tab.id);
  try {
    var origin = new URL(tab.url).origin;
    await chrome.debugger.sendCommand({ tabId: tab.id }, "Browser.setPermission", { permission: { name: name }, setting: setting || "granted", origin: origin });
    return { success: true, data: { permission: name, setting: setting || "granted", origin: origin } };
  } finally { await releaseDebugger(tab.id); }
}

async function cmdClearOverrides() {
  var tab = await getActiveTab();
  if (!tab) return { success: false, error: "No active tab found" };
  if (!debuggerSessions.has(tab.id)) return { success: true, data: { message: "No active overrides" } };
  try { await chrome.debugger.sendCommand({ tabId: tab.id }, "Emulation.clearDeviceMetricsOverride", {}); } catch {}
  try { await chrome.debugger.sendCommand({ tabId: tab.id }, "Emulation.clearGeolocationOverride", {}); } catch {}
  try { await chrome.debugger.sendCommand({ tabId: tab.id }, "Emulation.setEmulatedMedia", { features: [] }); } catch {}
  try { await chrome.debugger.sendCommand({ tabId: tab.id }, "Emulation.setEmulatedVisionDeficiency", { type: "none" }); } catch {}
  await releasePersistentDebugger(tab.id);
  return { success: true, data: { cleared: true } };
}

// ── Phase 7: Accessibility ──

async function cmdAccessibilityTree({ depth }) {
  var tab = await getActiveTab();
  if (!tab) return { success: false, error: "No active tab found" };
  await acquireDebugger(tab.id);
  try {
    await chrome.debugger.sendCommand({ tabId: tab.id }, "Accessibility.enable", {});
    var result = await chrome.debugger.sendCommand({ tabId: tab.id }, "Accessibility.getFullAXTree", { depth: depth || 3 });
    await chrome.debugger.sendCommand({ tabId: tab.id }, "Accessibility.disable", {});
    var nodes = (result.nodes || []).map(function (n) {
      return { nodeId: n.nodeId, role: n.role?.value, name: n.name?.value, description: n.description?.value, value: n.value?.value, childIds: n.childIds, properties: (n.properties || []).map(function (p) { return { name: p.name, value: p.value?.value }; }) };
    });
    return { success: true, data: { nodeCount: nodes.length, nodes: nodes.slice(0, 500) } };
  } finally { await releaseDebugger(tab.id); }
}

async function cmdAccessibilityInfo({ selector }) {
  var tab = await getActiveTab();
  if (!tab) return { success: false, error: "No active tab found" };
  if (!selector) return { success: false, error: "selector parameter is required" };
  await acquireDebugger(tab.id);
  try {
    var doc = await chrome.debugger.sendCommand({ tabId: tab.id }, "DOM.getDocument", { depth: 0 });
    var node = await chrome.debugger.sendCommand({ tabId: tab.id }, "DOM.querySelector", { nodeId: doc.root.nodeId, selector: selector });
    if (!node || !node.nodeId) return { success: false, error: "Element not found: " + selector };
    await chrome.debugger.sendCommand({ tabId: tab.id }, "Accessibility.enable", {});
    var ax = await chrome.debugger.sendCommand({ tabId: tab.id }, "Accessibility.getPartialAXTree", { nodeId: node.nodeId, fetchRelatives: true });
    await chrome.debugger.sendCommand({ tabId: tab.id }, "Accessibility.disable", {});
    return { success: true, data: { selector: selector, nodes: (ax.nodes || []).map(function (n) { return { nodeId: n.nodeId, role: n.role?.value, name: n.name?.value, description: n.description?.value, value: n.value?.value, properties: (n.properties || []).map(function (p) { return { name: p.name, value: p.value?.value }; }) }; }) } };
  } finally { await releaseDebugger(tab.id); }
}

async function cmdAriaCheck({ selector }) {
  var tab = await getActiveTab();
  if (!tab) return { success: false, error: "No active tab found" };
  var [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: function (sel) {
      var root = sel ? document.querySelector(sel) : document.body;
      if (!root) return { success: false, error: "Element not found" };
      var issues = [];
      root.querySelectorAll("img").forEach(function (img) { if (!img.alt && !img.getAttribute("aria-label") && img.getAttribute("role") !== "presentation") issues.push({ type: "missing-alt", element: "img", src: (img.src || "").substring(0, 100) }); });
      root.querySelectorAll("button, a[href], input, select, textarea").forEach(function (el) { var text = (el.textContent || "").trim(); if (!text && !el.getAttribute("aria-label") && !el.getAttribute("aria-labelledby") && el.tagName !== "INPUT") issues.push({ type: "missing-label", element: el.tagName.toLowerCase() }); });
      root.querySelectorAll("input:not([type='hidden']), select, textarea").forEach(function (el) { var id = el.id; var label = id ? document.querySelector("label[for='" + id + "']") : null; if (!label && !el.getAttribute("aria-label") && !el.getAttribute("aria-labelledby") && !el.closest("label")) issues.push({ type: "unlabelled-input", element: el.tagName.toLowerCase(), inputType: el.type }); });
      return { success: true, data: { issueCount: issues.length, issues: issues.slice(0, 50) } };
    },
    args: [selector || null],
    world: "MAIN",
  });
  return result.result;
}

// ── Phase 8: Advanced Storage ──

async function cmdIndexeddbList() {
  var tab = await getActiveTab();
  if (!tab) return { success: false, error: "No active tab found" };
  var [result] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: async function () { try { var dbs = await indexedDB.databases(); return { success: true, data: { databases: dbs.map(function (d) { return { name: d.name, version: d.version }; }) } }; } catch (e) { return { success: false, error: e.message }; } }, args: [], world: "MAIN" });
  return result.result;
}

async function cmdIndexeddbQuery({ database, objectStore, limit, key }) {
  var tab = await getActiveTab();
  if (!tab) return { success: false, error: "No active tab found" };
  if (!database || !objectStore) return { success: false, error: "database and objectStore parameters are required" };
  var [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: function (dbName, storeName, lim, keyVal) {
      return new Promise(function (resolve) {
        var req = indexedDB.open(dbName);
        req.onerror = function () { resolve({ success: false, error: "Failed to open database: " + dbName }); };
        req.onsuccess = function () {
          var db = req.result;
          try {
            var tx = db.transaction(storeName, "readonly"); var store = tx.objectStore(storeName);
            var info = { name: store.name, keyPath: store.keyPath, indexNames: Array.from(store.indexNames) };
            var records = [], max = lim || 50;
            if (keyVal != null) {
              var gr = store.get(keyVal);
              gr.onsuccess = function () { if (gr.result) records.push(gr.result); db.close(); resolve({ success: true, data: { store: info, records: records, count: records.length } }); };
              gr.onerror = function () { db.close(); resolve({ success: false, error: "Key lookup failed" }); };
            } else {
              var cr = store.openCursor();
              cr.onsuccess = function (e) { var c = e.target.result; if (c && records.length < max) { records.push({ key: c.key, value: c.value }); c.continue(); } else { db.close(); resolve({ success: true, data: { store: info, records: records, count: records.length } }); } };
              cr.onerror = function () { db.close(); resolve({ success: false, error: "Cursor failed" }); };
            }
          } catch (e) { db.close(); resolve({ success: false, error: e.message }); }
        };
      });
    },
    args: [database, objectStore, limit || 50, key || null],
    world: "MAIN",
  });
  return result.result;
}

async function cmdIndexeddbClear({ database, objectStore }) {
  var tab = await getActiveTab();
  if (!tab) return { success: false, error: "No active tab found" };
  if (!database || !objectStore) return { success: false, error: "database and objectStore required" };
  var [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: function (dbName, storeName) {
      return new Promise(function (resolve) {
        var req = indexedDB.open(dbName);
        req.onerror = function () { resolve({ success: false, error: "Failed to open database" }); };
        req.onsuccess = function () { var db = req.result; try { var tx = db.transaction(storeName, "readwrite"); tx.objectStore(storeName).clear().onsuccess = function () { db.close(); resolve({ success: true, data: { cleared: storeName } }); }; } catch (e) { db.close(); resolve({ success: false, error: e.message }); } };
      });
    },
    args: [database, objectStore],
    world: "MAIN",
  });
  return result.result;
}

async function cmdCacheList() {
  var tab = await getActiveTab();
  if (!tab) return { success: false, error: "No active tab found" };
  var [result] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: async function () { try { return { success: true, data: { caches: await caches.keys() } }; } catch (e) { return { success: false, error: e.message }; } }, args: [], world: "MAIN" });
  return result.result;
}

async function cmdCacheQuery({ cacheName, limit }) {
  var tab = await getActiveTab();
  if (!tab) return { success: false, error: "No active tab found" };
  if (!cacheName) return { success: false, error: "cacheName required" };
  var [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: async function (name, lim) { try { var c = await caches.open(name); var k = await c.keys(); return { success: true, data: { cacheName: name, entryCount: k.length, entries: k.slice(0, lim || 50).map(function (r) { return { url: r.url, method: r.method }; }) } }; } catch (e) { return { success: false, error: e.message }; } },
    args: [cacheName, limit || 50],
    world: "MAIN",
  });
  return result.result;
}

async function cmdCacheClear({ cacheName }) {
  var tab = await getActiveTab();
  if (!tab) return { success: false, error: "No active tab found" };
  if (!cacheName) return { success: false, error: "cacheName required" };
  var [result] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: async function (name) { try { return { success: true, data: { cacheName: name, deleted: await caches.delete(name) } }; } catch (e) { return { success: false, error: e.message }; } }, args: [cacheName], world: "MAIN" });
  return result.result;
}

// ── Phase 9: Service Workers ──

async function cmdListServiceWorkers() {
  var tab = await getActiveTab();
  if (!tab) return { success: false, error: "No active tab found" };
  var [result] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: async function () { try { var regs = await navigator.serviceWorker.getRegistrations(); return { success: true, data: { workers: regs.map(function (r) { var sw = r.active || r.waiting || r.installing; return { scope: r.scope, state: sw ? sw.state : "none", scriptURL: sw ? sw.scriptURL : null }; }) } }; } catch (e) { return { success: false, error: e.message }; } }, args: [], world: "MAIN" });
  return result.result;
}

async function cmdUnregisterServiceWorker({ scope }) {
  var tab = await getActiveTab();
  if (!tab) return { success: false, error: "No active tab found" };
  var [result] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: async function (s) { try { var regs = await navigator.serviceWorker.getRegistrations(); var u = []; for (var i = 0; i < regs.length; i++) { if (!s || regs[i].scope === s) { await regs[i].unregister(); u.push(regs[i].scope); } } return { success: true, data: { unregistered: u } }; } catch (e) { return { success: false, error: e.message }; } }, args: [scope || null], world: "MAIN" });
  return result.result;
}

async function cmdUpdateServiceWorker({ scope }) {
  var tab = await getActiveTab();
  if (!tab) return { success: false, error: "No active tab found" };
  var [result] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: async function (s) { try { var regs = await navigator.serviceWorker.getRegistrations(); var u = []; for (var i = 0; i < regs.length; i++) { if (!s || regs[i].scope === s) { await regs[i].update(); u.push(regs[i].scope); } } return { success: true, data: { updated: u } }; } catch (e) { return { success: false, error: e.message }; } }, args: [scope || null], world: "MAIN" });
  return result.result;
}

// ── Phase 10: WebSocket Monitoring ──

async function cmdWebsocketMonitor({ duration_ms, urlFilter }) {
  var tab = await getActiveTab();
  if (!tab) return { success: false, error: "No active tab found" };
  var dur = duration_ms || 5000;
  await acquireDebugger(tab.id);
  try {
    await chrome.debugger.sendCommand({ tabId: tab.id }, "Network.enable", {});
    var frames = [], connections = [];
    var listener = function (source, method, params) {
      if (source.tabId !== tab.id) return;
      if (method === "Network.webSocketCreated") connections.push({ requestId: params.requestId, url: params.url });
      else if (method === "Network.webSocketFrameSent" || method === "Network.webSocketFrameReceived") {
        if (!urlFilter || connections.some(function (c) { return c.requestId === params.requestId && c.url.indexOf(urlFilter) !== -1; }))
          frames.push({ direction: method.includes("Sent") ? "sent" : "received", requestId: params.requestId, data: params.response?.payloadData, timestamp: Date.now() });
      }
    };
    chrome.debugger.onEvent.addListener(listener);
    await new Promise(function (r) { setTimeout(r, dur); });
    chrome.debugger.onEvent.removeListener(listener);
    await chrome.debugger.sendCommand({ tabId: tab.id }, "Network.disable", {});
    return { success: true, data: { connections: connections, frames: frames.slice(0, 200), duration_ms: dur } };
  } finally { await releaseDebugger(tab.id); }
}

async function cmdWebsocketList() {
  var tab = await getActiveTab();
  if (!tab) return { success: false, error: "No active tab found" };
  var [result] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: function () { if (!window.__bcWebSockets) return { success: true, data: { connections: [], note: "Use websocket_monitor to capture." } }; return { success: true, data: { connections: window.__bcWebSockets.map(function (ws) { return { url: ws.url, readyState: ws.readyState, protocol: ws.protocol }; }) } }; }, args: [], world: "MAIN" });
  return result.result;
}

// ── Phase 12: CSS & Animation Control ──

async function cmdAnimationControl({ action, playbackRate, selector }) {
  var tab = await getActiveTab();
  if (!tab) return { success: false, error: "No active tab found" };
  var [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: function (act, rate, sel) {
      var root = sel ? document.querySelector(sel) : document.documentElement;
      if (!root) return { success: false, error: "Element not found" };
      var anims = root === document.documentElement ? document.getAnimations() : root.getAnimations({ subtree: true });
      if (act === "list") return { success: true, data: { animations: anims.map(function (a) { return { id: a.id || null, playState: a.playState, currentTime: a.currentTime, playbackRate: a.playbackRate }; }), count: anims.length } };
      if (act === "pause") anims.forEach(function (a) { a.pause(); });
      else if (act === "resume" || act === "play") anims.forEach(function (a) { a.play(); });
      else if (act === "cancel") anims.forEach(function (a) { a.cancel(); });
      else if (act === "finish") anims.forEach(function (a) { a.finish(); });
      if (rate != null) anims.forEach(function (a) { a.playbackRate = rate; });
      return { success: true, data: { action: act, affected: anims.length, playbackRate: rate } };
    },
    args: [action || "list", playbackRate || null, selector || null],
    world: "MAIN",
  });
  return result.result;
}

// ── Phase 13: Focus Management ──

async function cmdFocusElement({ selector, action }) {
  var tab = await getActiveTab();
  if (!tab) return { success: false, error: "No active tab found" };
  if (!selector) return { success: false, error: "selector parameter is required" };
  var [result] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: function (sel, act) { var el = document.querySelector(sel); if (!el) return { success: false, error: "Element not found: " + sel }; if (act === "blur") { el.blur(); return { success: true, data: { action: "blur", selector: sel } }; } el.focus(); return { success: true, data: { action: "focus", selector: sel, tag: el.tagName.toLowerCase() } }; }, args: [selector, action || "focus"], world: "MAIN" });
  return result.result;
}

async function cmdTabFocus({ count, reverse }) {
  var tab = await getActiveTab();
  if (!tab) return { success: false, error: "No active tab found" };
  var n = count || 1;
  await acquireDebugger(tab.id);
  try {
    for (var i = 0; i < n; i++) {
      var kp = resolveKeyParams("Tab"); var mods = reverse ? 8 : 0;
      if (reverse) await cdpKeyDown(tab.id, resolveKeyParams("Shift"), 0);
      await cdpKeyDown(tab.id, kp, mods);
      await cdpKeyUp(tab.id, kp, mods);
      if (reverse) await cdpKeyUp(tab.id, resolveKeyParams("Shift"), 0);
      if (i < n - 1) await new Promise(function (r) { setTimeout(r, 50); });
    }
    return { success: true, data: { tabPresses: n, reverse: !!reverse } };
  } finally { await releaseDebugger(tab.id); }
}

async function cmdGetFocusedElement() {
  var tab = await getActiveTab();
  if (!tab) return { success: false, error: "No active tab found" };
  var [result] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: function () { var el = document.activeElement; if (!el || el === document.body) return { success: true, data: { focused: null } }; var r = el.getBoundingClientRect(); return { success: true, data: { focused: { tag: el.tagName.toLowerCase(), id: el.id || null, className: el.className || null, type: el.type || null, name: el.name || null, rect: { x: r.x, y: r.y, width: r.width, height: r.height } } } }; }, args: [], world: "MAIN" });
  return result.result;
}

// ── Phase 14: Notifications & Dialogs ──

async function cmdDialogHandle({ action, promptText, timeout_ms }) {
  var tab = await getActiveTab();
  if (!tab) return { success: false, error: "No active tab found" };
  var act = action || "read";
  await acquireDebugger(tab.id);
  try {
    await chrome.debugger.sendCommand({ tabId: tab.id }, "Page.enable", {});
    var dialogInfo = null;
    var listener = function (source, method, params) {
      if (source.tabId === tab.id && method === "Page.javascriptDialogOpening") dialogInfo = { type: params.type, message: params.message, defaultPrompt: params.defaultPrompt || null };
    };
    chrome.debugger.onEvent.addListener(listener);
    await new Promise(function (r) { setTimeout(r, Math.min(timeout_ms || 5000, 1000)); });
    chrome.debugger.onEvent.removeListener(listener);
    if (!dialogInfo) { await chrome.debugger.sendCommand({ tabId: tab.id }, "Page.disable", {}); return { success: true, data: { dialogPresent: false } }; }
    if (act === "read") return { success: true, data: { dialogPresent: true, type: dialogInfo.type, message: dialogInfo.message, defaultPrompt: dialogInfo.defaultPrompt } };
    var p = { accept: act === "accept" };
    if (promptText != null) p.promptText = promptText;
    await chrome.debugger.sendCommand({ tabId: tab.id }, "Page.handleJavaScriptDialog", p);
    await chrome.debugger.sendCommand({ tabId: tab.id }, "Page.disable", {});
    return { success: true, data: { handled: true, action: act, type: dialogInfo.type, message: dialogInfo.message } };
  } finally { await releaseDebugger(tab.id); }
}

async function cmdNotificationMonitor({ duration_ms }) {
  var tab = await getActiveTab();
  if (!tab) return { success: false, error: "No active tab found" };
  var dur = duration_ms || 5000;
  var [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: function (dur) {
      return new Promise(function (resolve) {
        var notifications = [];
        var Orig = window.Notification;
        window.Notification = function (title, opts) { notifications.push({ title: title, body: opts?.body || null, icon: opts?.icon || null, timestamp: Date.now() }); return new Orig(title, opts); };
        window.Notification.permission = Orig.permission;
        window.Notification.requestPermission = Orig.requestPermission.bind(Orig);
        setTimeout(function () { window.Notification = Orig; resolve({ success: true, data: { notifications: notifications, count: notifications.length } }); }, dur);
      });
    },
    args: [dur],
    world: "MAIN",
  });
  return result.result;
}


ensureOffscreen();

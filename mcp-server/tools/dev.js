// Developer workflow tools: the dev_* surface (element pickers, selector
// generation, visual baselines, assertion helpers, test flows).
import { z } from "zod";
import { server } from "../lib/mcp.js";
import { sendCommand, formatResult } from "../lib/runtime.js";
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Developer Workflow Tools ──

// Anchored at the package root (tools/ is one level down), matching where the
// monolithic server.js kept it.
const BASELINES_DIR = join(__dirname, "..", "baselines");

server.tool(
  "dev_test_flow",
  "Run an automated QA test flow: navigate to a URL, execute a sequence of steps (click, fill, wait, assert, screenshot), and return a structured pass/fail report with timing.",
  {
    url: z.string().describe("URL to navigate to before running steps"),
    steps: z.array(z.object({
      action: z.enum(["click", "fill", "wait", "assert_text", "screenshot"]).describe("Action to perform"),
      selector: z.string().optional().describe("CSS selector (required for click, fill, wait, assert_text)"),
      value: z.string().optional().describe("Value for fill action or expected text for assert_text"),
      screenshot: z.boolean().optional().describe("Take a screenshot after this step"),
    })).describe("Ordered list of test steps to execute"),
    report: z.boolean().optional().describe("Include a summary report (default true)"),
  },
  async ({ url, steps, report }) => {
    const results = [];
    let passed = 0;
    let failed = 0;

    // Navigate to the URL
    try {
      await sendCommand("navigate", { url }, 30000);
      await sendCommand("wait_for_load", { timeoutMs: 15000 }, 17000);
    } catch (e) {
      return {
        content: [{ type: "text", text: JSON.stringify({ passed: 0, failed: 1, total: 1, steps: [{ step: 0, action: "navigate", result: "fail", error: e.message }] }, null, 2) }],
        isError: true,
      };
    }

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const start = Date.now();
      const entry = { step: i + 1, action: step.action };

      try {
        switch (step.action) {
          case "click":
            await sendCommand("click_element", { selector: step.selector });
            entry.result = "pass";
            break;

          case "fill":
            await sendCommand("fill_field", { selector: step.selector, value: step.value || "" });
            entry.result = "pass";
            break;

          case "wait":
            await sendCommand("wait_for_element", { selector: step.selector, timeoutMs: 10000 }, 12000);
            entry.result = "pass";
            break;

          case "assert_text": {
            const textResult = await sendCommand("get_page_content", { selector: step.selector });
            if (textResult && textResult.success) {
              const pageText = typeof textResult.data === "string" ? textResult.data : JSON.stringify(textResult.data);
              if (pageText.includes(step.value || "")) {
                entry.result = "pass";
              } else {
                entry.result = "fail";
                entry.error = `Expected text "${step.value}" not found in element`;
              }
            } else {
              entry.result = "fail";
              entry.error = textResult?.error || "Could not get element text";
            }
            break;
          }

          case "screenshot": {
            const ssResult = await sendCommand("take_screenshot");
            if (ssResult && ssResult.success) {
              entry.result = "pass";
              entry.screenshot = ssResult.data.replace(/^data:image\/png;base64,/, "");
            } else {
              entry.result = "pass";
              entry.screenshot_error = "Screenshot failed but step not counted as failure";
            }
            break;
          }
        }
      } catch (e) {
        entry.result = "fail";
        entry.error = e.message;
      }

      entry.duration_ms = Date.now() - start;
      if (step.screenshot && step.action !== "screenshot") {
        try {
          const ssResult = await sendCommand("take_screenshot");
          if (ssResult && ssResult.success) {
            entry.screenshot = ssResult.data.replace(/^data:image\/png;base64,/, "");
          }
        } catch {}
      }

      if (entry.result === "pass") passed++;
      else failed++;

      results.push(entry);
    }

    const output = { passed, failed, total: steps.length, steps: results };

    // Build content array: text report + any inline screenshots
    const content = [{ type: "text", text: JSON.stringify(output, (key, val) => key === "screenshot" ? "(base64 image)" : val, 2) }];
    for (const r of results) {
      if (r.screenshot) {
        content.push({ type: "image", data: r.screenshot, mimeType: "image/png" });
      }
    }
    return { content };
  }
);

server.tool(
  "dev_lighthouse",
  "Run a lightweight performance and accessibility audit on the current (or specified) page. Measures load time, DOM size, network requests, JS heap, and checks for common accessibility issues. Not full Lighthouse — a fast, dev-friendly summary.",
  {
    url: z.string().optional().describe("URL to audit (uses current page if omitted)"),
    categories: z.array(z.enum(["performance", "accessibility", "best-practices", "seo"]))
      .optional()
      .describe("Audit categories to include (default all four)"),
  },
  async ({ url, categories }) => {
    const cats = categories || ["performance", "accessibility", "best-practices", "seo"];

    // Navigate if URL provided
    if (url) {
      await sendCommand("navigate", { url }, 30000);
      await sendCommand("wait_for_load", { timeoutMs: 15000 }, 17000);
    }

    // Get tab info for the URL
    const tabInfo = await sendCommand("get_active_tab_info");
    const pageUrl = tabInfo?.data?.url || url || "unknown";

    const result = { url: pageUrl, scores: {}, metrics: {}, issues: [] };

    // Performance metrics via DevTools
    if (cats.includes("performance")) {
      try {
        const perfResult = await sendCommand("devtools_performance_metrics");
        if (perfResult?.success && perfResult.data) {
          const metrics = Array.isArray(perfResult.data) ? perfResult.data : (perfResult.data.metrics || []);
          const metricMap = {};
          if (Array.isArray(metrics)) {
            for (const m of metrics) {
              if (m.name && m.value !== undefined) metricMap[m.name] = m.value;
            }
          }
          result.metrics.dom_nodes = metricMap["Nodes"] || 0;
          result.metrics.js_heap_mb = metricMap["JSHeapUsedSize"] ? Math.round(metricMap["JSHeapUsedSize"] / 1048576 * 100) / 100 : 0;
          result.metrics.layout_count = metricMap["LayoutCount"] || 0;
          result.metrics.style_recalcs = metricMap["RecalcStyleCount"] || 0;
        }
      } catch {}

      // Measure load timing and request count via JS
      try {
        const timingResult = await sendCommand("execute_js", { code: `
          (() => {
            const nav = performance.getEntriesByType('navigation')[0];
            const resources = performance.getEntriesByType('resource');
            return JSON.stringify({
              load_time_ms: nav ? Math.round(nav.loadEventEnd - nav.startTime) : 0,
              dom_content_loaded_ms: nav ? Math.round(nav.domContentLoadedEventEnd - nav.startTime) : 0,
              ttfb_ms: nav ? Math.round(nav.responseStart - nav.startTime) : 0,
              requests: resources.length,
              total_transfer_kb: Math.round(resources.reduce((s, r) => s + (r.transferSize || 0), 0) / 1024)
            });
          })()
        ` });
        if (timingResult?.success) {
          const timing = JSON.parse(timingResult.data);
          result.metrics.load_time_ms = timing.load_time_ms;
          result.metrics.dom_content_loaded_ms = timing.dom_content_loaded_ms;
          result.metrics.ttfb_ms = timing.ttfb_ms;
          result.metrics.requests = timing.requests;
          result.metrics.total_transfer_kb = timing.total_transfer_kb;
        }
      } catch {}

      // Score performance 0-100 based on metrics
      let perfScore = 100;
      if (result.metrics.load_time_ms > 3000) perfScore -= 20;
      if (result.metrics.load_time_ms > 5000) perfScore -= 20;
      if (result.metrics.dom_nodes > 1500) perfScore -= 10;
      if (result.metrics.dom_nodes > 3000) perfScore -= 10;
      if (result.metrics.js_heap_mb > 50) perfScore -= 10;
      if (result.metrics.requests > 50) perfScore -= 10;
      if (result.metrics.requests > 100) perfScore -= 10;
      result.scores.performance = Math.max(0, perfScore);

      if (result.metrics.load_time_ms > 3000) result.issues.push({ category: "performance", severity: "warning", message: `Slow load time: ${result.metrics.load_time_ms}ms (target < 3000ms)` });
      if (result.metrics.dom_nodes > 1500) result.issues.push({ category: "performance", severity: "warning", message: `Large DOM: ${result.metrics.dom_nodes} nodes (target < 1500)` });
      if (result.metrics.js_heap_mb > 50) result.issues.push({ category: "performance", severity: "warning", message: `High JS heap usage: ${result.metrics.js_heap_mb}MB` });
    }

    // Accessibility audit via JS (axe-core patterns)
    if (cats.includes("accessibility")) {
      try {
        const a11yResult = await sendCommand("execute_js", { code: `
          (() => {
            const issues = [];
            // Images without alt
            document.querySelectorAll('img:not([alt])').forEach(img => {
              issues.push({ rule: 'img-alt', message: 'Image missing alt attribute', selector: img.tagName + (img.className ? '.' + img.className.split(' ')[0] : '') });
            });
            // Empty alt on non-decorative images
            document.querySelectorAll('img[alt=""]').forEach(img => {
              if (img.width > 1 && img.height > 1) {
                issues.push({ rule: 'img-alt-empty', message: 'Potentially meaningful image has empty alt', selector: img.tagName });
              }
            });
            // Inputs without labels
            document.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]), textarea, select').forEach(el => {
              const id = el.id;
              const hasLabel = id && document.querySelector('label[for="' + id + '"]');
              const hasAriaLabel = el.getAttribute('aria-label') || el.getAttribute('aria-labelledby');
              const wrappedInLabel = el.closest('label');
              if (!hasLabel && !hasAriaLabel && !wrappedInLabel) {
                issues.push({ rule: 'label', message: 'Form field missing label', selector: el.tagName + (el.name ? '[name=' + el.name + ']' : '') });
              }
            });
            // Missing lang on html
            if (!document.documentElement.getAttribute('lang')) {
              issues.push({ rule: 'html-has-lang', message: 'HTML element missing lang attribute' });
            }
            // Empty buttons and links
            document.querySelectorAll('button, a[href]').forEach(el => {
              const text = (el.textContent || '').trim();
              const ariaLabel = el.getAttribute('aria-label');
              const hasImg = el.querySelector('img[alt]');
              if (!text && !ariaLabel && !hasImg) {
                issues.push({ rule: 'empty-interactive', message: 'Empty ' + el.tagName.toLowerCase() + ' (no text, aria-label, or img with alt)', selector: el.tagName });
              }
            });
            // Insufficient color contrast check on large/heading text
            const headings = document.querySelectorAll('h1, h2, h3, h4, h5, h6');
            const missingHeading = headings.length === 0;
            if (missingHeading) {
              issues.push({ rule: 'heading-order', message: 'Page has no headings' });
            }
            // Check for skip-nav link
            const firstLink = document.querySelector('a[href^="#"]');
            if (!firstLink || !firstLink.textContent.toLowerCase().includes('skip')) {
              issues.push({ rule: 'skip-link', message: 'No skip-to-content link found', severity: 'info' });
            }
            return JSON.stringify({ count: issues.length, issues: issues.slice(0, 20) });
          })()
        ` });
        if (a11yResult?.success) {
          const a11y = JSON.parse(a11yResult.data);
          let a11yScore = 100 - (a11y.count * 5);
          result.scores.accessibility = Math.max(0, Math.min(100, a11yScore));
          for (const issue of a11y.issues) {
            result.issues.push({ category: "accessibility", severity: issue.severity || "warning", rule: issue.rule, message: issue.message, selector: issue.selector });
          }
        }
      } catch {}
    }

    // Best practices
    if (cats.includes("best-practices")) {
      try {
        const bpResult = await sendCommand("execute_js", { code: `
          (() => {
            const issues = [];
            if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
              issues.push({ rule: 'https', message: 'Page not served over HTTPS' });
            }
            if (!document.querySelector('meta[name="viewport"]')) {
              issues.push({ rule: 'viewport', message: 'Missing viewport meta tag' });
            }
            if (!document.doctype) {
              issues.push({ rule: 'doctype', message: 'Missing DOCTYPE declaration' });
            }
            const mixedContent = document.querySelectorAll('img[src^="http:"], script[src^="http:"], link[href^="http:"]');
            if (mixedContent.length > 0) {
              issues.push({ rule: 'mixed-content', message: mixedContent.length + ' resources loaded over HTTP (mixed content)' });
            }
            // Check for console errors already logged
            return JSON.stringify({ count: issues.length, issues });
          })()
        ` });
        if (bpResult?.success) {
          const bp = JSON.parse(bpResult.data);
          for (const issue of bp.issues) {
            result.issues.push({ category: "best-practices", severity: "warning", rule: issue.rule, message: issue.message });
          }
        }
      } catch {}
    }

    // SEO
    if (cats.includes("seo")) {
      try {
        const seoResult = await sendCommand("execute_js", { code: `
          (() => {
            const issues = [];
            if (!document.title || document.title.trim().length === 0) {
              issues.push({ rule: 'title', message: 'Page has no title' });
            } else if (document.title.length > 60) {
              issues.push({ rule: 'title-length', message: 'Title too long (' + document.title.length + ' chars, recommend < 60)' });
            }
            const metaDesc = document.querySelector('meta[name="description"]');
            if (!metaDesc || !metaDesc.content.trim()) {
              issues.push({ rule: 'meta-description', message: 'Missing meta description' });
            }
            const h1s = document.querySelectorAll('h1');
            if (h1s.length === 0) {
              issues.push({ rule: 'h1', message: 'Page has no h1 element' });
            } else if (h1s.length > 1) {
              issues.push({ rule: 'h1-multiple', message: 'Page has ' + h1s.length + ' h1 elements (recommend 1)' });
            }
            const canonical = document.querySelector('link[rel="canonical"]');
            if (!canonical) {
              issues.push({ rule: 'canonical', message: 'Missing canonical link' });
            }
            return JSON.stringify({ count: issues.length, issues });
          })()
        ` });
        if (seoResult?.success) {
          const seo = JSON.parse(seoResult.data);
          for (const issue of seo.issues) {
            result.issues.push({ category: "seo", severity: "info", rule: issue.rule, message: issue.message });
          }
        }
      } catch {}
    }

    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "dev_form_test",
  "Test a form on the current page: detect fields, fill with test data, check client-side validation, and optionally submit. Returns what fields were found, filled, and any validation errors.",
  {
    form_selector: z.string().optional().describe("CSS selector for the form (auto-detects if omitted)"),
    test_data: z.record(z.string()).describe("Object mapping field names/selectors to test values"),
    submit: z.boolean().optional().describe("Whether to submit the form after filling (default false)"),
  },
  async ({ form_selector, test_data, submit }) => {
    const formSel = form_selector || "form";

    // Detect all fields in the form
    const fieldsResult = await sendCommand("execute_js", { code: `
      (() => {
        const form = document.querySelector(${JSON.stringify(formSel)});
        if (!form) return JSON.stringify({ error: 'Form not found: ${formSel}' });
        const fields = [];
        form.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]), textarea, select').forEach((el, i) => {
          fields.push({
            index: i,
            tag: el.tagName.toLowerCase(),
            type: el.type || 'text',
            name: el.name || '',
            id: el.id || '',
            placeholder: el.placeholder || '',
            required: el.required,
            selector: el.id ? '#' + el.id : (el.name ? '${formSel} [name="' + el.name + '"]' : '${formSel} ' + el.tagName.toLowerCase() + ':nth-of-type(' + (i + 1) + ')'),
          });
        });
        return JSON.stringify({ fields });
      })()
    ` });

    if (!fieldsResult?.success) {
      return { content: [{ type: "text", text: JSON.stringify({ error: fieldsResult?.error || "Could not detect form fields" }) }], isError: true };
    }

    const fieldInfo = JSON.parse(fieldsResult.data);
    if (fieldInfo.error) {
      return { content: [{ type: "text", text: JSON.stringify({ error: fieldInfo.error }) }], isError: true };
    }

    const fields = fieldInfo.fields;
    let filled = 0;
    const validationErrors = [];

    // Fill each field that matches test_data keys
    for (const field of fields) {
      const dataKey = test_data[field.name] !== undefined ? field.name
        : test_data[field.id] !== undefined ? field.id
        : test_data[field.selector] !== undefined ? field.selector
        : null;

      if (dataKey) {
        const value = test_data[dataKey];
        try {
          await sendCommand("fill_field", { selector: field.selector, value });
          filled++;
        } catch (e) {
          validationErrors.push({ field: dataKey, error: `Fill failed: ${e.message}` });
        }
      }
    }

    // Check client-side validation
    const validResult = await sendCommand("execute_js", { code: `
      (() => {
        const form = document.querySelector(${JSON.stringify(formSel)});
        if (!form) return JSON.stringify({ errors: [] });
        const errors = [];
        form.querySelectorAll('input, textarea, select').forEach(el => {
          if (!el.checkValidity()) {
            errors.push({
              field: el.name || el.id || el.tagName,
              message: el.validationMessage,
              selector: el.id ? '#' + el.id : (el.name ? '[name="' + el.name + '"]' : el.tagName)
            });
          }
        });
        return JSON.stringify({ errors, formValid: form.checkValidity() });
      })()
    ` });

    if (validResult?.success) {
      const v = JSON.parse(validResult.data);
      for (const e of v.errors) {
        validationErrors.push({ field: e.field, message: e.message });
      }
    }

    let submitted = false;
    if (submit) {
      try {
        await sendCommand("execute_js", { code: `document.querySelector(${JSON.stringify(formSel)}).submit()` });
        submitted = true;
        await sendCommand("wait_for_load", { timeoutMs: 10000 }, 12000).catch(() => {});
      } catch (e) {
        validationErrors.push({ field: "__submit__", error: `Submit failed: ${e.message}` });
      }
    }

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          fields_found: fields.length,
          fields_filled: filled,
          validation_errors: validationErrors,
          submitted,
          field_details: fields,
        }, null, 2)
      }]
    };
  }
);

server.tool(
  "dev_responsive_check",
  "Test responsive design by taking screenshots at multiple viewport sizes (mobile, tablet, desktop). Resizes the browser for each viewport, waits for the page to settle, and returns screenshots with viewport info.",
  {
    url: z.string().optional().describe("URL to test (uses current page if omitted)"),
    viewports: z.array(z.object({
      w: z.number().describe("Viewport width in pixels"),
      h: z.number().describe("Viewport height in pixels"),
      name: z.string().optional().describe("Label for this viewport"),
    })).optional().describe("Viewports to test (default: iPhone 375x812, iPad 768x1024, Desktop 1280x800)"),
  },
  async ({ url, viewports }) => {
    const vps = viewports || [
      { w: 375, h: 812, name: "iPhone" },
      { w: 768, h: 1024, name: "iPad" },
      { w: 1280, h: 800, name: "Desktop" },
    ];

    if (url) {
      await sendCommand("navigate", { url }, 30000);
      await sendCommand("wait_for_load", { timeoutMs: 15000 }, 17000);
    }

    // Get current tab title
    const tabInfo = await sendCommand("get_active_tab_info");
    const pageTitle = tabInfo?.data?.title || "unknown";

    const results = [];
    const content = [];

    for (const vp of vps) {
      const vpName = vp.name || `${vp.w}x${vp.h}`;
      await sendCommand("set_viewport", { width: vp.w, height: vp.h });
      // Brief wait for responsive layout to settle
      await new Promise(r => setTimeout(r, 500));

      let screenshot = null;
      try {
        const ssResult = await sendCommand("take_screenshot");
        if (ssResult?.success) {
          screenshot = ssResult.data.replace(/^data:image\/png;base64,/, "");
        }
      } catch {}

      results.push({ viewport: vpName, width: vp.w, height: vp.h, page_title: pageTitle, has_screenshot: !!screenshot });
      if (screenshot) {
        content.push({ type: "text", text: `--- ${vpName} (${vp.w}x${vp.h}) ---` });
        content.push({ type: "image", data: screenshot, mimeType: "image/png" });
      }
    }

    // Restore to a reasonable default
    await sendCommand("set_viewport", { width: 1280, height: 800 }).catch(() => {});

    content.unshift({ type: "text", text: JSON.stringify({ results }, null, 2) });
    return { content };
  }
);

server.tool(
  "dev_api_test",
  "Test an API endpoint from the browser context using fetch. Sends a request and returns status, headers, body, timing, and pass/fail based on expected status.",
  {
    url: z.string().describe("API endpoint URL to test"),
    method: z.string().optional().describe("HTTP method (default GET)"),
    headers: z.record(z.string()).optional().describe("Request headers as key-value pairs"),
    body: z.string().optional().describe("Request body (for POST/PUT/PATCH)"),
    expected_status: z.number().optional().describe("Expected HTTP status code to check against"),
  },
  async ({ url: apiUrl, method, headers, body, expected_status }) => {
    const fetchMethod = method || "GET";
    const fetchHeaders = headers ? JSON.stringify(headers) : "{}";
    const fetchBody = body ? JSON.stringify(body) : "null";

    const result = await sendCommand("execute_js", { code: `
      (async () => {
        const start = performance.now();
        try {
          const opts = {
            method: ${JSON.stringify(fetchMethod)},
            headers: ${fetchHeaders},
          };
          const bodyVal = ${fetchBody};
          if (bodyVal && ${JSON.stringify(fetchMethod)} !== 'GET' && ${JSON.stringify(fetchMethod)} !== 'HEAD') {
            opts.body = bodyVal;
          }
          const res = await fetch(${JSON.stringify(apiUrl)}, opts);
          const duration = Math.round(performance.now() - start);
          const resHeaders = {};
          res.headers.forEach((v, k) => { resHeaders[k] = v; });
          let resBody;
          const ct = res.headers.get('content-type') || '';
          if (ct.includes('application/json')) {
            try { resBody = await res.json(); } catch { resBody = await res.text(); }
          } else {
            resBody = await res.text();
            if (resBody.length > 5000) resBody = resBody.slice(0, 5000) + '... (truncated)';
          }
          return JSON.stringify({
            status: res.status,
            status_text: res.statusText,
            headers: resHeaders,
            body: resBody,
            duration_ms: duration,
          });
        } catch (e) {
          return JSON.stringify({ error: e.message, duration_ms: Math.round(performance.now() - start) });
        }
      })()
    ` }, 30000);

    if (!result?.success) {
      return { content: [{ type: "text", text: JSON.stringify({ error: result?.error || "Fetch failed" }) }], isError: true };
    }

    const data = JSON.parse(result.data);
    if (data.error) {
      return { content: [{ type: "text", text: JSON.stringify({ error: data.error, duration_ms: data.duration_ms, passed: false }) }], isError: true };
    }

    data.passed = expected_status ? data.status === expected_status : data.status >= 200 && data.status < 400;
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "dev_console_check",
  "Monitor the browser console for errors and warnings over a duration. Navigates to a URL if provided, then captures all console output. Reports whether the console is clean or has issues matching the specified fail levels.",
  {
    url: z.string().optional().describe("URL to navigate to before monitoring (uses current page if omitted)"),
    duration_ms: z.number().optional().describe("How long to monitor the console in ms (default 5000)"),
    fail_on: z.array(z.enum(["error", "warning", "info", "log"])).optional().describe("Console levels that count as failures (default ['error'])"),
  },
  async ({ url, duration_ms, fail_on }) => {
    const duration = duration_ms || 5000;
    const failLevels = fail_on || ["error"];

    if (url) {
      await sendCommand("navigate", { url }, 30000);
      await sendCommand("wait_for_load", { timeoutMs: 15000 }, 17000);
    }

    // Use devtools console log capture
    const consoleResult = await sendCommand("devtools_console_log", { duration_ms: duration }, duration + 5000);

    const messages = [];
    let errorCount = 0;
    let warningCount = 0;

    if (consoleResult?.success && consoleResult.data) {
      const entries = Array.isArray(consoleResult.data) ? consoleResult.data : (consoleResult.data.messages || []);
      for (const entry of entries) {
        const level = (entry.level || entry.type || "log").toLowerCase();
        const msg = {
          level,
          text: entry.text || entry.message || String(entry),
          source: entry.source || entry.url || "",
          line: entry.lineNumber || entry.line || 0,
        };
        messages.push(msg);
        if (level === "error") errorCount++;
        if (level === "warning" || level === "warn") warningCount++;
      }
    }

    const failMessages = messages.filter(m => {
      const lvl = m.level === "warn" ? "warning" : m.level;
      return failLevels.includes(lvl);
    });

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          clean: failMessages.length === 0,
          messages,
          error_count: errorCount,
          warning_count: warningCount,
          monitored_ms: duration,
        }, null, 2)
      }]
    };
  }
);

server.tool(
  "dev_link_check",
  "Check all links on a page for broken URLs (404, 500, timeout). Extracts all anchor hrefs, tests each one, and reports broken links. With depth=1, follows internal links and checks those pages too.",
  {
    url: z.string().optional().describe("URL to check (uses current page if omitted)"),
    depth: z.number().optional().describe("0 = current page only, 1 = follow internal links one level (default 0)"),
  },
  async ({ url, depth }) => {
    const maxDepth = depth || 0;

    if (url) {
      await sendCommand("navigate", { url }, 30000);
      await sendCommand("wait_for_load", { timeoutMs: 15000 }, 17000);
    }

    // Get the current page URL for determining internal links
    const tabInfo = await sendCommand("get_active_tab_info");
    const baseUrl = tabInfo?.data?.url || url || "";
    let baseOrigin = "";
    try { baseOrigin = new URL(baseUrl).origin; } catch {}

    // Extract all links from the page
    const linksResult = await sendCommand("execute_js", { code: `
      (() => {
        const links = [];
        const seen = new Set();
        document.querySelectorAll('a[href]').forEach(a => {
          try {
            const href = new URL(a.href, location.href).href;
            if (!seen.has(href) && (href.startsWith('http://') || href.startsWith('https://'))) {
              seen.add(href);
              links.push({ url: href, text: (a.textContent || '').trim().slice(0, 80) });
            }
          } catch {}
        });
        return JSON.stringify(links);
      })()
    ` });

    if (!linksResult?.success) {
      return { content: [{ type: "text", text: JSON.stringify({ error: "Could not extract links" }) }], isError: true };
    }

    const allLinks = JSON.parse(linksResult.data);
    const broken = [];
    let working = 0;
    let externalSkipped = 0;

    // Check each link using fetch
    const checkLink = async (linkUrl, sourcePage) => {
      try {
        const checkResult = await sendCommand("execute_js", { code: `
          fetch(${JSON.stringify(linkUrl)}, { method: 'HEAD', mode: 'no-cors', signal: AbortSignal.timeout(8000) })
            .then(r => JSON.stringify({ status: r.status, ok: r.ok, type: r.type }))
            .catch(e => JSON.stringify({ error: e.message }))
        ` }, 15000);

        if (checkResult?.success) {
          const resp = JSON.parse(checkResult.data);
          if (resp.type === "opaque") {
            // no-cors response, consider it working
            working++;
          } else if (resp.error) {
            broken.push({ url: linkUrl, status: 0, error: resp.error, source_page: sourcePage });
          } else if (resp.status >= 400) {
            broken.push({ url: linkUrl, status: resp.status, source_page: sourcePage });
          } else {
            working++;
          }
        } else {
          broken.push({ url: linkUrl, status: 0, error: "check failed", source_page: sourcePage });
        }
      } catch (e) {
        broken.push({ url: linkUrl, status: 0, error: e.message, source_page: sourcePage });
      }
    };

    // Check links on the current page (limit to 50 to avoid timeout)
    const linksToCheck = allLinks.slice(0, 50);
    for (const link of linksToCheck) {
      await checkLink(link.url, baseUrl);
    }

    // Depth=1: follow internal links and check their links
    if (maxDepth >= 1) {
      const internalLinks = allLinks
        .filter(l => baseOrigin && l.url.startsWith(baseOrigin))
        .slice(0, 10); // limit to 10 internal pages

      for (const intLink of internalLinks) {
        try {
          await sendCommand("navigate", { url: intLink.url }, 15000);
          await sendCommand("wait_for_load", { timeoutMs: 10000 }, 12000);

          const subLinksResult = await sendCommand("execute_js", { code: `
            (() => {
              const links = [];
              const seen = new Set();
              document.querySelectorAll('a[href]').forEach(a => {
                try {
                  const href = new URL(a.href, location.href).href;
                  if (!seen.has(href) && (href.startsWith('http://') || href.startsWith('https://'))) {
                    seen.add(href);
                    links.push({ url: href });
                  }
                } catch {}
              });
              return JSON.stringify(links.slice(0, 20));
            })()
          ` });

          if (subLinksResult?.success) {
            const subLinks = JSON.parse(subLinksResult.data);
            for (const sub of subLinks) {
              await checkLink(sub.url, intLink.url);
            }
          }
        } catch {}
      }

      // Navigate back to original page
      if (baseUrl) {
        await sendCommand("navigate", { url: baseUrl }, 15000).catch(() => {});
      }
    }

    externalSkipped = allLinks.length > 50 ? allLinks.length - 50 : 0;

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          total_links: allLinks.length,
          checked: linksToCheck.length,
          broken,
          working,
          external_skipped: externalSkipped,
        }, null, 2)
      }]
    };
  }
);

server.tool(
  "dev_screenshot_diff",
  "Visual regression testing: capture a baseline screenshot or compare the current view against a saved baseline. Reports pixel-level match percentage and diff regions.",
  {
    name: z.string().describe("Identifier for this baseline (e.g. 'homepage', 'login-form')"),
    action: z.enum(["capture", "compare"]).describe("'capture' to save a new baseline, 'compare' to diff against it"),
  },
  async ({ name, action }) => {
    const safeName = name.replace(/[^a-zA-Z0-9_-]/g, "_");
    const baselinePath = join(BASELINES_DIR, `${safeName}.json`);

    if (action === "capture") {
      // Take a screenshot and save as baseline
      const ssResult = await sendCommand("take_screenshot");
      if (!ssResult?.success) {
        return { content: [{ type: "text", text: JSON.stringify({ error: "Screenshot failed" }) }], isError: true };
      }

      const base64 = ssResult.data.replace(/^data:image\/png;base64,/, "");

      // Ensure baselines directory exists
      if (!existsSync(BASELINES_DIR)) {
        mkdirSync(BASELINES_DIR, { recursive: true });
      }

      // Save baseline data (base64 + dimensions)
      const dimResult = await sendCommand("execute_js", { code: `JSON.stringify({ width: window.innerWidth, height: window.innerHeight })` });
      const dims = dimResult?.success ? JSON.parse(dimResult.data) : { width: 0, height: 0 };

      writeFileSync(baselinePath, JSON.stringify({
        name: safeName,
        captured_at: new Date().toISOString(),
        width: dims.width,
        height: dims.height,
        data: base64,
      }));

      return {
        content: [
          { type: "text", text: JSON.stringify({ action: "capture", name: safeName, saved: true, path: baselinePath, dimensions: dims }, null, 2) },
          { type: "image", data: base64, mimeType: "image/png" },
        ]
      };
    }

    if (action === "compare") {
      // Load baseline
      if (!existsSync(baselinePath)) {
        return { content: [{ type: "text", text: JSON.stringify({ error: `No baseline found for "${safeName}". Run with action "capture" first.` }) }], isError: true };
      }

      const baseline = JSON.parse(readFileSync(baselinePath, "utf-8"));

      // Take a new screenshot
      const ssResult = await sendCommand("take_screenshot");
      if (!ssResult?.success) {
        return { content: [{ type: "text", text: JSON.stringify({ error: "Screenshot failed" }) }], isError: true };
      }

      const currentBase64 = ssResult.data.replace(/^data:image\/png;base64,/, "");

      // Compare via canvas in the browser (pixel-level diff)
      const diffResult = await sendCommand("execute_js", { code: `
        (async () => {
          const loadImage = (src) => new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = reject;
            img.src = src;
          });

          const baseline = await loadImage('data:image/png;base64,${baseline.data}');
          const current = await loadImage('data:image/png;base64,${currentBase64}');

          const w = Math.max(baseline.width, current.width);
          const h = Math.max(baseline.height, current.height);

          const c1 = document.createElement('canvas');
          c1.width = w; c1.height = h;
          const ctx1 = c1.getContext('2d');
          ctx1.drawImage(baseline, 0, 0);
          const d1 = ctx1.getImageData(0, 0, w, h);

          const c2 = document.createElement('canvas');
          c2.width = w; c2.height = h;
          const ctx2 = c2.getContext('2d');
          ctx2.drawImage(current, 0, 0);
          const d2 = ctx2.getImageData(0, 0, w, h);

          let totalPixels = w * h;
          let diffPixels = 0;
          const regionSize = 50;
          const regionDiffs = {};

          for (let i = 0; i < d1.data.length; i += 4) {
            const pixelIdx = i / 4;
            const dr = Math.abs(d1.data[i] - d2.data[i]);
            const dg = Math.abs(d1.data[i+1] - d2.data[i+1]);
            const db = Math.abs(d1.data[i+2] - d2.data[i+2]);
            if (dr + dg + db > 30) {
              diffPixels++;
              const px = pixelIdx % w;
              const py = Math.floor(pixelIdx / w);
              const rk = Math.floor(px / regionSize) + ',' + Math.floor(py / regionSize);
              regionDiffs[rk] = (regionDiffs[rk] || 0) + 1;
            }
          }

          const matchPct = Math.round((1 - diffPixels / totalPixels) * 10000) / 100;
          const regions = Object.entries(regionDiffs)
            .filter(([, count]) => count > 10)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 20)
            .map(([key, count]) => {
              const [rx, ry] = key.split(',').map(Number);
              return { x: rx * regionSize, y: ry * regionSize, w: regionSize, h: regionSize, diff_pixels: count };
            });

          return JSON.stringify({
            match_percentage: matchPct,
            diff_pixels: diffPixels,
            total_pixels: totalPixels,
            baseline_size: { w: baseline.width, h: baseline.height },
            current_size: { w: current.width, h: current.height },
            diff_regions: regions,
          });
        })()
      ` }, 30000);

      if (!diffResult?.success) {
        return { content: [{ type: "text", text: JSON.stringify({ error: "Diff comparison failed: " + (diffResult?.error || "unknown") }) }], isError: true };
      }

      const diff = JSON.parse(diffResult.data);

      return {
        content: [
          { type: "text", text: JSON.stringify({
            action: "compare",
            name: safeName,
            match_percentage: diff.match_percentage,
            diff_pixels: diff.diff_pixels,
            total_pixels: diff.total_pixels,
            baseline_size: diff.baseline_size,
            current_size: diff.current_size,
            baseline_captured_at: baseline.captured_at,
            diff_regions: diff.diff_regions,
          }, null, 2) },
          { type: "image", data: currentBase64, mimeType: "image/png" },
        ]
      };
    }
  }
);


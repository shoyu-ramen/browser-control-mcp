import { z } from "zod";

const EVENT_TYPES = ["navigation", "tab_activated", "tab_created", "tab_removed", "console", "dom_mutation"];

export function registerAgentTools(server, { eventBus, subscriptions, workflows, sessionState, sendCommand }) {

  // --- Event Subscriptions ---

  server.tool(
    "agent_subscribe",
    "Subscribe to real-time browser events. Events are buffered and retrieved with agent_get_events. Supported types: navigation (page loads), tab_activated (tab switch), tab_created, tab_removed, console (console messages on active tab), dom_mutation (DOM changes on active tab).",
    {
      eventType: z.enum(EVENT_TYPES).describe("Type of event to subscribe to"),
      filter: z.object({
        urlPattern: z.string().optional().describe("Only capture events from URLs matching this substring"),
        level: z.enum(["log", "warn", "error", "info"]).optional().describe("Console log level filter (for console events only)"),
      }).optional().describe("Optional filter to narrow which events are captured"),
    },
    async ({ eventType, filter }) => {
      const sub = subscriptions.subscribe(eventType, filter || {});
      sessionState.recordAction({ type: "subscribe", eventType, subscriptionId: sub.id });
      return { content: [{ type: "text", text: JSON.stringify(sub, null, 2) }] };
    }
  );

  server.tool(
    "agent_unsubscribe",
    "Remove an event subscription by ID",
    {
      subscriptionId: z.string().describe("Subscription ID to remove (e.g. 'sub_1')"),
    },
    async ({ subscriptionId }) => {
      const removed = subscriptions.unsubscribe(subscriptionId);
      return { content: [{ type: "text", text: removed ? `Unsubscribed ${subscriptionId}` : `Subscription ${subscriptionId} not found` }] };
    }
  );

  server.tool(
    "agent_list_subscriptions",
    "List all active event subscriptions",
    {},
    async () => {
      const subs = subscriptions.list();
      return { content: [{ type: "text", text: JSON.stringify(subs, null, 2) }] };
    }
  );

  server.tool(
    "agent_get_events",
    "Get buffered events from active subscriptions. By default, events are removed from the buffer after retrieval (drain). Use peek=true to view without removing.",
    {
      type: z.enum(EVENT_TYPES).optional().describe("Filter by event type"),
      limit: z.number().optional().describe("Max events to return (default: all)"),
      peek: z.boolean().optional().describe("If true, view events without removing them from the buffer (default false)"),
    },
    async ({ type, limit, peek }) => {
      const filter = {};
      if (type) filter.type = type;
      if (limit) filter.limit = limit;
      const events = peek ? eventBus.get(filter) : eventBus.drain(filter);
      return { content: [{ type: "text", text: JSON.stringify({ count: events.length, events }, null, 2) }] };
    }
  );

  server.tool(
    "agent_clear_events",
    "Clear all buffered events, optionally filtered by type",
    {
      type: z.enum(EVENT_TYPES).optional().describe("Only clear events of this type"),
    },
    async ({ type }) => {
      const before = eventBus.size;
      eventBus.clear(type ? { type } : {});
      return { content: [{ type: "text", text: `Cleared ${before - eventBus.size} events (${eventBus.size} remaining)` }] };
    }
  );

  // --- Multi-step Workflows ---

  const conditionSchema = z.object({
    type: z.enum(["element_exists", "url_matches", "variable_equals"]).describe("Condition type"),
    selector: z.string().optional().describe("CSS selector (for element_exists)"),
    pattern: z.string().optional().describe("URL substring (for url_matches)"),
    name: z.string().optional().describe("Variable name (for variable_equals)"),
    value: z.string().optional().describe("Expected value (for variable_equals)"),
  });

  const stepSchema = z.object({
    command: z.string().describe("Browser command to execute (e.g. 'navigate', 'click_element', 'fill_field', 'wait_for_element', 'get_page_content')"),
    params: z.record(z.any()).optional().describe("Parameters for the command"),
    delayMs: z.number().optional().describe("Wait this many ms before executing the step"),
    timeoutMs: z.number().optional().describe("Timeout for this step in ms (default 15000)"),
    maxRetries: z.number().optional().describe("Number of retries on failure (default 0)"),
    retryDelayMs: z.number().optional().describe("Delay between retries in ms (default 1000)"),
    onError: z.enum(["fail", "skip"]).optional().describe("'fail' (default) stops the workflow, 'skip' continues to next step"),
    condition: conditionSchema.optional().describe("Condition that must be true for this step to execute"),
  });

  server.tool(
    "agent_run_workflow",
    "Execute a multi-step browser workflow asynchronously. Steps run sequentially with optional conditions, retries, delays, and error handling. Returns a workflow ID — poll with agent_workflow_status to track progress. Commands are the same as browser extension commands: navigate, click_element, fill_field, wait_for_element, wait_for_load, get_page_content, select_option, scroll_to, take_screenshot, etc.",
    {
      steps: z.array(stepSchema).min(1).describe("Ordered list of workflow steps to execute"),
      name: z.string().optional().describe("Optional name for the workflow"),
    },
    async ({ steps, name }) => {
      const result = await workflows.execute(steps, { name });
      sessionState.recordAction({ type: "workflow_started", workflowId: result.id, stepCount: steps.length, name });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "agent_workflow_status",
    "Get the current status of a workflow including which step it's on, results so far, and any errors",
    {
      workflowId: z.string().describe("Workflow ID (e.g. 'wf_1')"),
    },
    async ({ workflowId }) => {
      const status = workflows.getStatus(workflowId);
      if (!status) return { content: [{ type: "text", text: `Workflow ${workflowId} not found` }], isError: true };
      return { content: [{ type: "text", text: JSON.stringify(status, null, 2) }] };
    }
  );

  server.tool(
    "agent_cancel_workflow",
    "Cancel a running workflow. The workflow will stop after its current step completes.",
    {
      workflowId: z.string().describe("Workflow ID to cancel"),
    },
    async ({ workflowId }) => {
      const cancelled = workflows.cancel(workflowId);
      return { content: [{ type: "text", text: cancelled ? `Cancelled ${workflowId}` : `Cannot cancel ${workflowId} (not running or not found)` }] };
    }
  );

  server.tool(
    "agent_list_workflows",
    "List all workflows and their current statuses",
    {},
    async () => {
      const list = workflows.list();
      return { content: [{ type: "text", text: JSON.stringify(list, null, 2) }] };
    }
  );

  // --- Session State ---

  server.tool(
    "agent_get_session",
    "Get the current agent session context: session duration, pages visited, actions performed, stored data keys, variables, and recent activity. Useful for understanding what has been done so far.",
    {},
    async () => {
      return { content: [{ type: "text", text: JSON.stringify(sessionState.getContext(), null, 2) }] };
    }
  );

  server.tool(
    "agent_store_data",
    "Store a key-value pair in the session. Use for extracted data, intermediate results, or any information that should persist across tool calls within this session.",
    {
      key: z.string().describe("Storage key"),
      value: z.any().describe("Value to store (string, number, object, array)"),
    },
    async ({ key, value }) => {
      sessionState.storeData(key, value);
      return { content: [{ type: "text", text: `Stored "${key}"` }] };
    }
  );

  server.tool(
    "agent_get_data",
    "Retrieve stored data by key, or get all stored data if no key is provided",
    {
      key: z.string().optional().describe("Key to retrieve (omit to get all stored data)"),
    },
    async ({ key }) => {
      if (key) {
        const value = sessionState.getData(key);
        if (value === undefined) return { content: [{ type: "text", text: `Key "${key}" not found` }], isError: true };
        return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] };
      }
      return { content: [{ type: "text", text: JSON.stringify(sessionState.getAllData(), null, 2) }] };
    }
  );

  server.tool(
    "agent_set_variable",
    "Set a session variable. Variables can be used in workflow conditions (variable_equals) and persist across tool calls within this session.",
    {
      name: z.string().describe("Variable name"),
      value: z.string().describe("Variable value"),
    },
    async ({ name, value }) => {
      sessionState.setVariable(name, value);
      return { content: [{ type: "text", text: `Set ${name} = "${value}"` }] };
    }
  );

  server.tool(
    "agent_get_action_log",
    "Get the log of recent actions performed in this session including browser commands, subscriptions, and workflow steps",
    {
      limit: z.number().optional().describe("Max entries to return (default 50)"),
    },
    async ({ limit }) => {
      const log = sessionState.getActionLog(limit || 50);
      return { content: [{ type: "text", text: JSON.stringify(log, null, 2) }] };
    }
  );

  // ── Agentic Network Enhancements ──

  // Catalog of available tools with their categories and typical parameters.
  // Used by agent_plan to generate structured plans from high-level goals.
  const TOOL_CATALOG = {
    // Navigation
    navigate: { category: "navigation", params: ["url"] },
    wait_for_load: { category: "navigation", params: ["timeoutMs"] },
    wait_for_element: { category: "navigation", params: ["selector", "timeoutMs"] },
    go_back: { category: "navigation", params: [] },
    go_forward: { category: "navigation", params: [] },
    // Interaction
    click_element: { category: "interaction", params: ["selector"] },
    fill_field: { category: "interaction", params: ["selector", "value"] },
    fill_password: { category: "interaction", params: ["selector", "password"] },
    select_option: { category: "interaction", params: ["selector", "value"] },
    press_key: { category: "interaction", params: ["key", "modifiers", "selector"] },
    hover_element: { category: "interaction", params: ["selector"] },
    scroll_to: { category: "interaction", params: ["selector"] },
    scroll_by: { category: "interaction", params: ["direction", "amount", "selector"] },
    close_dialogs: { category: "interaction", params: ["strategy"] },
    // Reading
    get_page_content: { category: "reading", params: ["selector"] },
    get_active_tab_info: { category: "reading", params: [] },
    get_form_fields: { category: "reading", params: [] },
    find_elements: { category: "reading", params: ["selector", "text", "limit"] },
    get_element_attributes: { category: "reading", params: ["selector"] },
    get_links: { category: "reading", params: ["selector"] },
    get_metadata: { category: "reading", params: [] },
    extract_table: { category: "reading", params: ["selector"] },
    query_selector_all: { category: "reading", params: ["selector", "attributes", "limit"] },
    execute_js: { category: "reading", params: ["code"] },
    // Screenshot
    take_screenshot: { category: "visual", params: [] },
    // Auth
    login_detect: { category: "auth", params: [] },
    google_oauth_select_account: { category: "auth", params: ["email"] },
    google_oauth_consent: { category: "auth", params: ["action"] },
    google_oauth_flow: { category: "auth", params: ["email", "timeoutMs"] },
    signup_detect: { category: "auth", params: [] },
    mfa_detect: { category: "auth", params: [] },
    auth_session_check: { category: "auth", params: [] },
    auth_sso_detect: { category: "auth", params: [] },
    // CAPTCHA
    captcha_detect: { category: "captcha", params: [] },
    captcha_click_checkbox: { category: "captcha", params: [] },
    captcha_wait_for_solve: { category: "captcha", params: ["timeoutMs"] },
    // Tabs
    list_tabs: { category: "tabs", params: [] },
    switch_tab: { category: "tabs", params: ["tabId", "urlPattern"] },
    new_tab: { category: "tabs", params: ["url"] },
    close_tab: { category: "tabs", params: ["tabId"] },
    // Cookies
    get_cookies: { category: "cookies", params: [] },
    set_cookie: { category: "cookies", params: ["name", "value"] },
    clear_cookies: { category: "cookies", params: ["domain"] },
    // Gmail
    gmail_search: { category: "gmail", params: ["query"] },
    gmail_open_email: { category: "gmail", params: ["index"] },
    gmail_read_email: { category: "gmail", params: [] },
    gmail_compose: { category: "gmail", params: ["to", "subject", "body"] },
    gmail_send: { category: "gmail", params: [] },
    gmail_find_verification_link: { category: "gmail", params: ["sender", "subject_pattern"] },
  };

  // Goal-to-tool mapping patterns for plan generation.
  const GOAL_PATTERNS = [
    {
      match: /log\s*in|sign\s*in|authenticate|login/i,
      tools: ["get_active_tab_info", "login_detect", "fill_field", "fill_password", "click_element", "wait_for_load"],
      hint: "Detect login form, fill credentials, submit, verify success",
    },
    {
      match: /sign\s*up|register|create\s*account/i,
      tools: ["get_active_tab_info", "signup_detect", "fill_field", "fill_password", "click_element", "wait_for_load"],
      hint: "Detect signup form, fill registration fields, submit",
    },
    {
      match: /navigate|go\s*to|open|visit/i,
      tools: ["navigate", "wait_for_load", "get_active_tab_info"],
      hint: "Navigate to URL, wait for page load, confirm arrival",
    },
    {
      match: /fill|form|submit|enter/i,
      tools: ["get_form_fields", "fill_field", "click_element", "wait_for_load"],
      hint: "Discover form fields, fill them, submit the form",
    },
    {
      match: /click|press|tap/i,
      tools: ["find_elements", "click_element", "wait_for_load"],
      hint: "Find the target element, click it, wait for result",
    },
    {
      match: /read|extract|scrape|get.*text|content/i,
      tools: ["get_active_tab_info", "get_page_content", "find_elements"],
      hint: "Get page info, extract text content or elements",
    },
    {
      match: /screenshot|capture|see|look/i,
      tools: ["take_screenshot", "get_active_tab_info"],
      hint: "Take a screenshot and get tab info for context",
    },
    {
      match: /search|find|look\s*for/i,
      tools: ["get_active_tab_info", "find_elements", "get_page_content"],
      hint: "Search for elements or text on the page",
    },
    {
      match: /email|gmail|inbox/i,
      tools: ["navigate", "wait_for_load", "gmail_search", "gmail_open_email", "gmail_read_email"],
      hint: "Navigate to Gmail, search emails, read content",
    },
    {
      match: /oauth|google\s*sign|social\s*login/i,
      tools: ["login_detect", "google_oauth_flow", "wait_for_load", "get_active_tab_info"],
      hint: "Detect OAuth options, run OAuth flow, verify completion",
    },
    {
      match: /captcha|recaptcha|verify.*human/i,
      tools: ["captcha_detect", "captcha_click_checkbox", "captcha_wait_for_solve"],
      hint: "Detect CAPTCHA type, attempt checkbox click, wait for solve",
    },
    {
      match: /buy|purchase|checkout|add.*cart|shop/i,
      tools: ["get_active_tab_info", "login_detect", "find_elements", "click_element", "fill_field", "wait_for_load"],
      hint: "May need to login first, then find product, add to cart, fill checkout form",
    },
    {
      match: /scroll|down|up|bottom|top/i,
      tools: ["scroll_by", "get_scroll_position", "get_page_content"],
      hint: "Scroll the page and read content at the new position",
    },
    {
      match: /tab|window|switch/i,
      tools: ["list_tabs", "switch_tab", "get_active_tab_info"],
      hint: "List open tabs, switch to target tab, confirm",
    },
    {
      match: /cookie|storage|cache/i,
      tools: ["get_cookies", "set_cookie", "clear_cookies"],
      hint: "Read, set, or clear cookies",
    },
    {
      match: /wait|until|condition|check/i,
      tools: ["wait_for_element", "wait_for_load", "execute_js"],
      hint: "Wait for a condition to be met on the page",
    },
  ];

  // Destructive commands that should not be retried by error recovery.
  const DESTRUCTIVE_COMMANDS = new Set([
    "navigate", "fill_field", "fill_password", "click_element",
    "select_option", "close_tab", "clear_cookies", "clear_storage",
    "gmail_send", "gmail_compose",
  ]);


  // ── 1. agent_plan ──

  server.tool(
    "agent_plan",
    "Analyze a goal and return a structured step-by-step plan using available browser tools. The plan is NOT executed — it is a JSON blueprint for what tools to call and in what order. Understands tool dependencies (e.g., login before checkout, navigate before interact). Use agent_execute_plan to run the plan.",
    {
      goal: z.string().describe("What the agent wants to accomplish (e.g. 'log into github.com', 'fill out the contact form', 'read the latest email in Gmail')"),
      context: z.string().optional().describe("Current state info: page URL, what has already been done, relevant details"),
    },
    async ({ goal, context }) => {
      sessionState.recordAction({ type: "plan", goal, context });

      // Determine which goal patterns match
      const matchedPatterns = GOAL_PATTERNS.filter(p => p.match.test(goal));
      const toolsNeeded = new Set();
      const hints = [];

      if (matchedPatterns.length > 0) {
        for (const pattern of matchedPatterns) {
          pattern.tools.forEach(t => toolsNeeded.add(t));
          hints.push(pattern.hint);
        }
      } else {
        // Default exploration plan
        toolsNeeded.add("get_active_tab_info");
        toolsNeeded.add("get_page_content");
        toolsNeeded.add("find_elements");
        toolsNeeded.add("take_screenshot");
        hints.push("No specific pattern matched — plan starts with page exploration");
      }

      // Build structured plan steps
      const plan = [];
      let stepNum = 0;

      // Always start with understanding current state
      plan.push({
        step: stepNum++,
        tool: "get_active_tab_info",
        params_template: {},
        depends_on: [],
        description: "Get current page URL and title to understand starting state",
      });

      // If context mentions a URL or goal implies navigation, add navigate step
      const urlMatch = goal.match(/https?:\/\/\S+/) || context?.match(/https?:\/\/\S+/);
      if (urlMatch || /navigate|go\s*to|open|visit/i.test(goal)) {
        plan.push({
          step: stepNum++,
          tool: "navigate",
          params_template: { url: urlMatch ? urlMatch[0] : "<target_url>" },
          depends_on: [0],
          description: "Navigate to the target page",
        });
        plan.push({
          step: stepNum++,
          tool: "wait_for_load",
          params_template: { timeoutMs: 15000 },
          depends_on: [stepNum - 2],
          description: "Wait for the page to finish loading",
        });
        toolsNeeded.add("navigate");
        toolsNeeded.add("wait_for_load");
      }

      // Auth-related steps
      if (/log\s*in|sign\s*in|authenticate|login/i.test(goal)) {
        const authStart = stepNum;
        plan.push({
          step: stepNum++,
          tool: "login_detect",
          params_template: {},
          depends_on: [authStart - 1],
          description: "Detect login form fields and options on the page",
        });
        plan.push({
          step: stepNum++,
          tool: "fill_field",
          params_template: { selector: "<username_selector>", value: "<username>" },
          depends_on: [authStart],
          description: "Fill the username/email field (selector from login_detect result)",
        });
        plan.push({
          step: stepNum++,
          tool: "fill_password",
          params_template: { selector: "<password_selector>", password: "<password>" },
          depends_on: [authStart],
          description: "Fill the password field (selector from login_detect result)",
        });
        plan.push({
          step: stepNum++,
          tool: "click_element",
          params_template: { selector: "<submit_selector>" },
          depends_on: [stepNum - 2, stepNum - 3],
          description: "Click the login/submit button",
        });
        plan.push({
          step: stepNum++,
          tool: "wait_for_load",
          params_template: { timeoutMs: 15000 },
          depends_on: [stepNum - 2],
          description: "Wait for post-login navigation to complete",
        });
        plan.push({
          step: stepNum++,
          tool: "get_active_tab_info",
          params_template: {},
          depends_on: [stepNum - 2],
          description: "Verify login succeeded by checking the resulting page URL",
        });
      }

      // Form filling steps
      if (/fill|form|submit/i.test(goal) && !/log\s*in|sign\s*in/i.test(goal)) {
        const formStart = stepNum;
        plan.push({
          step: stepNum++,
          tool: "get_form_fields",
          params_template: {},
          depends_on: [formStart - 1],
          description: "Discover all form fields on the page",
        });
        plan.push({
          step: stepNum++,
          tool: "fill_field",
          params_template: { selector: "<field_selector>", value: "<value>" },
          depends_on: [formStart],
          description: "Fill form fields with appropriate values (repeat for each field)",
        });
        plan.push({
          step: stepNum++,
          tool: "click_element",
          params_template: { selector: "<submit_selector>" },
          depends_on: [stepNum - 2],
          description: "Click the form submit button",
        });
        plan.push({
          step: stepNum++,
          tool: "wait_for_load",
          params_template: { timeoutMs: 15000 },
          depends_on: [stepNum - 2],
          description: "Wait for form submission to complete",
        });
      }

      // Reading/extraction steps
      if (/read|extract|scrape|get.*text|content/i.test(goal)) {
        plan.push({
          step: stepNum++,
          tool: "get_page_content",
          params_template: { selector: null },
          depends_on: [0],
          description: "Extract the text content from the page",
        });
      }

      // Screenshot step (often useful at the end)
      if (/screenshot|capture|see|look|verify/i.test(goal) || matchedPatterns.length === 0) {
        plan.push({
          step: stepNum++,
          tool: "take_screenshot",
          params_template: {},
          depends_on: [stepNum - 2],
          description: "Take a screenshot to visually verify the result",
        });
      }

      const result = {
        goal,
        context: context || null,
        plan,
        estimated_steps: plan.length,
        tools_needed: [...toolsNeeded],
        hints,
        note: "Template params in angle brackets (<...>) must be filled with actual values before execution.",
      };

      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );


  // ── 2. agent_execute_plan ──

  server.tool(
    "agent_execute_plan",
    "Sequentially execute a plan (array of step objects from agent_plan). After each step, evaluates the result and adapts — e.g., if a step reveals the need for 2FA, CAPTCHA, or an alternative approach, the plan adjusts. Records all results. Use stop_on_error=false to continue past failures.",
    {
      plan: z.array(z.object({
        step: z.number().describe("Step index"),
        tool: z.string().describe("Extension command name (e.g. 'navigate', 'click_element', 'fill_field')"),
        params_template: z.record(z.any()).describe("Parameters for the command"),
        depends_on: z.array(z.number()).optional().describe("Steps this depends on (for reference)"),
        description: z.string().optional().describe("What this step does"),
      })).min(1).describe("Ordered list of plan steps to execute"),
      stop_on_error: z.boolean().optional().describe("Stop execution on first error (default true)"),
    },
    async ({ plan, stop_on_error }) => {
      const stopOnError = stop_on_error !== false;
      const results = [];
      let completed = true;
      let error = null;

      sessionState.recordAction({ type: "execute_plan_start", stepCount: plan.length });

      for (let i = 0; i < plan.length; i++) {
        const step = plan[i];

        // Skip steps with unresolved template params
        const paramsStr = JSON.stringify(step.params_template);
        if (paramsStr.includes("<") && paramsStr.includes(">")) {
          results.push({
            step: step.step,
            tool: step.tool,
            skipped: true,
            reason: "Unresolved template parameters — fill in actual values before execution",
          });
          if (stopOnError) {
            completed = false;
            error = { step: step.step, message: "Unresolved template parameters in step" };
            break;
          }
          continue;
        }

        try {
          const result = await sendCommand(step.tool, step.params_template || {}, 30000);

          results.push({
            step: step.step,
            tool: step.tool,
            success: result?.success ?? true,
            result: result,
          });

          sessionState.recordAction({
            type: "execute_plan_step",
            step: step.step,
            tool: step.tool,
            success: result?.success ?? true,
          });

          // Adaptive behavior: check if the result suggests additional steps are needed
          if (result?.success && result?.data) {
            const data = result.data;

            // If login_detect reveals CAPTCHA, flag it
            if (step.tool === "login_detect" && data.has_captcha) {
              results.push({
                step: step.step,
                tool: "adaptive_note",
                note: "CAPTCHA detected on login page — may need captcha_detect + captcha_click_checkbox",
                adaptive: true,
              });
            }

            // If login_detect reveals OAuth options
            if (step.tool === "login_detect" && data.has_oauth?.length > 0) {
              results.push({
                step: step.step,
                tool: "adaptive_note",
                note: `OAuth providers available: ${data.has_oauth.join(", ")} — consider using google_oauth_flow`,
                adaptive: true,
              });
            }

            // If a navigation revealed an unexpected URL (redirect)
            if (step.tool === "get_active_tab_info" && data.url) {
              const url = data.url;
              if (/login|signin|auth|sso/i.test(url) && !/login|sign\s*in|auth/i.test(plan[0]?.description || "")) {
                results.push({
                  step: step.step,
                  tool: "adaptive_note",
                  note: `Redirected to auth page (${url}) — login may be required before continuing`,
                  adaptive: true,
                });
              }
            }
          }

          // Handle failed result from extension (success: false in result body)
          if (result && result.success === false) {
            if (stopOnError) {
              completed = false;
              error = { step: step.step, tool: step.tool, message: result.error || "Command returned success=false" };
              break;
            }
          }

        } catch (err) {
          results.push({
            step: step.step,
            tool: step.tool,
            success: false,
            error: err.message,
          });

          if (stopOnError) {
            completed = false;
            error = { step: step.step, tool: step.tool, message: err.message };
            break;
          }
        }

        // Small delay between steps to let the page settle
        if (i < plan.length - 1) {
          await new Promise(r => setTimeout(r, 300));
        }
      }

      sessionState.recordAction({
        type: "execute_plan_end",
        completed,
        stepsExecuted: results.filter(r => !r.adaptive).length,
      });

      const output = {
        completed,
        steps_executed: results.filter(r => !r.adaptive).length,
        results,
        error,
      };

      return { content: [{ type: "text", text: JSON.stringify(output, null, 2) }] };
    }
  );


  // ── 3. agent_observe ──

  server.tool(
    "agent_observe",
    "Observe the current browser state to answer a question. Combines tab info, page text, and element detection to build a comprehensive picture. Use for questions like 'is the user logged in?', 'did the form submit?', 'what page are we on?', 'is there an error message?'. Returns a structured observation.",
    {
      check: z.string().describe("What to observe — e.g. 'is the user logged in?', 'did the form submit succeed?', 'what page are we on?', 'are there any error messages?'"),
    },
    async ({ check }) => {
      sessionState.recordAction({ type: "observe", check });

      const observation = {
        check,
        url: null,
        title: null,
        text_summary: null,
        key_elements: [],
        indicators: [],
      };

      // Get tab info
      try {
        const tabInfo = await sendCommand("get_active_tab_info", {}, 5000);
        if (tabInfo?.success) {
          observation.url = tabInfo.data.url;
          observation.title = tabInfo.data.title;
        }
      } catch (e) {
        observation.indicators.push({ type: "error", detail: "Could not get tab info: " + e.message });
      }

      // Get page text (first 500 chars for summary)
      try {
        const textResult = await sendCommand("get_page_content", { selector: null }, 10000);
        if (textResult?.success) {
          const fullText = typeof textResult.data === "string" ? textResult.data : JSON.stringify(textResult.data);
          observation.text_summary = fullText.substring(0, 500);
        }
      } catch (e) {
        observation.indicators.push({ type: "error", detail: "Could not get page text: " + e.message });
      }

      // Search for relevant elements based on the check question
      const checkLower = check.toLowerCase();

      // Check for error messages
      if (/error|fail|wrong|invalid|problem|issue/i.test(checkLower)) {
        try {
          const errorElements = await sendCommand("find_elements", {
            selector: '[class*="error"], [class*="alert"], [class*="danger"], [class*="warning"], [role="alert"]',
            limit: 5,
          }, 5000);
          if (errorElements?.success && errorElements.data?.elements?.length > 0) {
            observation.key_elements.push({
              type: "error_messages",
              elements: errorElements.data.elements,
            });
            observation.indicators.push({ type: "errors_found", count: errorElements.data.elements.length });
          } else {
            observation.indicators.push({ type: "no_errors_found" });
          }
        } catch (e) { /* non-critical */ }
      }

      // Check for login/auth state
      if (/log\s*in|log\s*out|sign|auth|account/i.test(checkLower)) {
        try {
          const authElements = await sendCommand("find_elements", {
            selector: '[class*="user"], [class*="avatar"], [class*="account"], [class*="profile"], [data-testid*="user"], [data-testid*="avatar"]',
            limit: 5,
          }, 5000);
          if (authElements?.success && authElements.data?.elements?.length > 0) {
            observation.key_elements.push({
              type: "auth_indicators",
              elements: authElements.data.elements,
            });
            observation.indicators.push({ type: "user_elements_found", count: authElements.data.elements.length });
          }
        } catch (e) { /* non-critical */ }

        // Check for login form presence
        try {
          const loginForm = await sendCommand("find_elements", {
            selector: 'input[type="password"], form[action*="login"], form[action*="signin"]',
            limit: 3,
          }, 5000);
          if (loginForm?.success && loginForm.data?.elements?.length > 0) {
            observation.indicators.push({ type: "login_form_present" });
          } else {
            observation.indicators.push({ type: "no_login_form" });
          }
        } catch (e) { /* non-critical */ }
      }

      // Check for form submission results
      if (/submit|form|success|confirm|thank/i.test(checkLower)) {
        try {
          const successElements = await sendCommand("find_elements", {
            selector: '[class*="success"], [class*="confirm"], [class*="thank"], [class*="complete"]',
            limit: 5,
          }, 5000);
          if (successElements?.success && successElements.data?.elements?.length > 0) {
            observation.key_elements.push({
              type: "success_indicators",
              elements: successElements.data.elements,
            });
            observation.indicators.push({ type: "success_elements_found", count: successElements.data.elements.length });
          }
        } catch (e) { /* non-critical */ }
      }

      // Check for buttons/actions available
      if (/button|action|click|can\s+i|what.*do/i.test(checkLower)) {
        try {
          const buttons = await sendCommand("find_elements", {
            selector: 'button:not([disabled]), a[href], [role="button"]:not([disabled]), input[type="submit"]',
            limit: 10,
          }, 5000);
          if (buttons?.success && buttons.data?.elements?.length > 0) {
            observation.key_elements.push({
              type: "available_actions",
              elements: buttons.data.elements,
            });
          }
        } catch (e) { /* non-critical */ }
      }

      // Build a concise observation summary
      const parts = [];
      if (observation.url) parts.push(`Page: ${observation.url}`);
      if (observation.title) parts.push(`Title: "${observation.title}"`);
      if (observation.indicators.length > 0) {
        parts.push(`Indicators: ${observation.indicators.map(i => i.type).join(", ")}`);
      }
      observation.summary = parts.join(" | ");

      return { content: [{ type: "text", text: JSON.stringify(observation, null, 2) }] };
    }
  );


  // ── 4. agent_retry ──

  server.tool(
    "agent_retry",
    "Execute a browser command with retry logic. Retries on failure with configurable delay between attempts. Optionally evaluates a success condition (JavaScript expression) against the result to determine if the command truly succeeded.",
    {
      command: z.string().describe("Extension command name to execute (e.g. 'click_element', 'find_elements', 'wait_for_element')"),
      params: z.record(z.any()).optional().describe("Parameters for the command"),
      max_retries: z.number().optional().describe("Maximum number of retry attempts (default 3)"),
      delay_ms: z.number().optional().describe("Delay between retries in milliseconds (default 2000)"),
      success_condition: z.string().optional().describe("JavaScript expression evaluated against the result object (e.g. 'result.data.count > 0', 'result.data.url.includes(\"dashboard\")'). Must return truthy for success."),
    },
    async ({ command, params, max_retries, delay_ms, success_condition }) => {
      const maxRetries = max_retries ?? 3;
      const delayMs = delay_ms ?? 2000;
      let finalResult = null;
      let lastError = null;
      let attempts = 0;

      sessionState.recordAction({ type: "retry_start", command, maxRetries });

      for (let i = 0; i <= maxRetries; i++) {
        attempts = i + 1;

        try {
          const result = await sendCommand(command, params || {}, 30000);
          finalResult = result;

          // Check if the extension command itself succeeded
          if (result && result.success === false) {
            lastError = result.error || "Command returned success=false";
            if (i < maxRetries) {
              await new Promise(r => setTimeout(r, delayMs));
              continue;
            }
            break;
          }

          // Evaluate custom success condition if provided
          if (success_condition) {
            try {
              // Safely evaluate the condition against the result
              const condFn = new Function("result", `return !!(${success_condition})`);
              const condMet = condFn(result);
              if (!condMet) {
                lastError = `Success condition not met: ${success_condition}`;
                if (i < maxRetries) {
                  await new Promise(r => setTimeout(r, delayMs));
                  continue;
                }
                break;
              }
            } catch (evalErr) {
              lastError = `Success condition evaluation error: ${evalErr.message}`;
              if (i < maxRetries) {
                await new Promise(r => setTimeout(r, delayMs));
                continue;
              }
              break;
            }
          }

          // Success
          sessionState.recordAction({ type: "retry_success", command, attempts });
          return {
            content: [{
              type: "text",
              text: JSON.stringify({ success: true, attempts, final_result: result }, null, 2),
            }],
          };

        } catch (err) {
          lastError = err.message;
          finalResult = null;
          if (i < maxRetries) {
            await new Promise(r => setTimeout(r, delayMs));
          }
        }
      }

      sessionState.recordAction({ type: "retry_failed", command, attempts, error: lastError });
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: false,
            attempts,
            final_result: finalResult,
            error: lastError,
          }, null, 2),
        }],
      };
    }
  );


  // ── 5. agent_wait_for_condition ──

  server.tool(
    "agent_wait_for_condition",
    "Poll the browser by executing JavaScript on the page until a condition is met or a timeout occurs. Useful for waiting for dynamic content, AJAX results, animations to complete, modals to appear, etc.",
    {
      condition: z.string().describe("Human-readable description of what to wait for (for logging)"),
      check_js: z.string().describe("JavaScript code to evaluate on the page. Must return a truthy value when the condition is met (e.g. 'document.querySelector(\".results\")?.children.length > 0')"),
      timeout_ms: z.number().optional().describe("Maximum time to wait in ms (default 30000)"),
      poll_ms: z.number().optional().describe("How often to check in ms (default 2000)"),
    },
    async ({ condition, check_js, timeout_ms, poll_ms }) => {
      const timeoutMs = timeout_ms ?? 30000;
      const pollMs = poll_ms ?? 2000;
      const start = Date.now();

      sessionState.recordAction({ type: "wait_for_condition_start", condition, timeoutMs });

      while (Date.now() - start < timeoutMs) {
        try {
          const result = await sendCommand("execute_js", { code: check_js }, 10000);

          if (result?.success && result.data) {
            const elapsed = Date.now() - start;
            sessionState.recordAction({ type: "wait_for_condition_met", condition, elapsedMs: elapsed });
            return {
              content: [{
                type: "text",
                text: JSON.stringify({
                  met: true,
                  value: result.data,
                  elapsed_ms: elapsed,
                  condition,
                }, null, 2),
              }],
            };
          }
        } catch (e) {
          // JS execution failed — might be a page transition; keep polling
        }

        await new Promise(r => setTimeout(r, pollMs));
      }

      const elapsed = Date.now() - start;
      sessionState.recordAction({ type: "wait_for_condition_timeout", condition, elapsedMs: elapsed });
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            met: false,
            value: null,
            elapsed_ms: elapsed,
            condition,
          }, null, 2),
        }],
      };
    }
  );


  // ── 6. agent_page_context ──

  server.tool(
    "agent_page_context",
    "Build a comprehensive context snapshot of the current page state. Returns URL, title, text summary, detected page type (login, dashboard, form, error, etc.), available actions (forms, buttons, links count), and auth state indicators. Helps the AI decide what to do next.",
    {},
    async () => {
      sessionState.recordAction({ type: "page_context" });

      const ctx = {
        url: null,
        title: null,
        text_summary: null,
        page_type: "unknown",
        has_forms: false,
        form_fields: [],
        buttons_count: 0,
        links_count: 0,
        auth_state: "unknown",
        detected_features: [],
        errors_on_page: [],
      };

      // Get tab info
      try {
        const tabInfo = await sendCommand("get_active_tab_info", {}, 5000);
        if (tabInfo?.success) {
          ctx.url = tabInfo.data.url;
          ctx.title = tabInfo.data.title;
        }
      } catch (e) { /* non-critical */ }

      // Get page text summary
      try {
        const textResult = await sendCommand("get_page_content", { selector: null }, 10000);
        if (textResult?.success) {
          const fullText = typeof textResult.data === "string" ? textResult.data : JSON.stringify(textResult.data);
          ctx.text_summary = fullText.substring(0, 500);
        }
      } catch (e) { /* non-critical */ }

      // Detect page type via JS to minimize round trips
      try {
        const detectResult = await sendCommand("execute_js", {
          code: `(function() {
  var result = { pageType: 'unknown', hasLoginForm: false, hasForms: false, formCount: 0,
    buttonCount: 0, linkCount: 0, hasErrors: false, errorTexts: [],
    hasUserMenu: false, hasSearchBar: false, hasTable: false, hasModal: false };

  // Count elements
  result.formCount = document.forms.length;
  result.hasForms = result.formCount > 0;
  result.buttonCount = document.querySelectorAll('button, [role="button"], input[type="submit"]').length;
  result.linkCount = document.querySelectorAll('a[href]').length;
  result.hasTable = document.querySelectorAll('table').length > 0;
  result.hasModal = document.querySelectorAll('dialog[open], [class*="modal"][style*="display"], [role="dialog"]').length > 0;

  // Detect login form
  var pwFields = document.querySelectorAll('input[type="password"]');
  result.hasLoginForm = pwFields.length > 0;

  // Detect error messages
  var errorEls = document.querySelectorAll('[class*="error"], [class*="alert-danger"], [class*="alert-error"], [role="alert"]');
  for (var i = 0; i < Math.min(errorEls.length, 3); i++) {
    var txt = (errorEls[i].innerText || '').trim().substring(0, 150);
    if (txt) { result.hasErrors = true; result.errorTexts.push(txt); }
  }

  // Detect user/profile indicators
  result.hasUserMenu = document.querySelectorAll('[class*="user-menu"], [class*="avatar"], [class*="profile"], [data-testid*="user"], [aria-label*="account" i]').length > 0;
  result.hasSearchBar = document.querySelectorAll('input[type="search"], [role="search"], input[placeholder*="search" i]').length > 0;

  // Page type heuristic
  var url = location.href.toLowerCase();
  var title = document.title.toLowerCase();
  if (result.hasLoginForm && !result.hasUserMenu) result.pageType = 'login';
  else if (/signup|register|create.account/i.test(url + ' ' + title)) result.pageType = 'signup';
  else if (/dashboard|overview|home/i.test(url + ' ' + title) && result.hasUserMenu) result.pageType = 'dashboard';
  else if (/settings|preferences|profile/i.test(url + ' ' + title)) result.pageType = 'settings';
  else if (/search|results/i.test(url)) result.pageType = 'search_results';
  else if (result.hasErrors) result.pageType = 'error';
  else if (result.hasForms && !result.hasLoginForm) result.pageType = 'form';
  else if (result.hasTable) result.pageType = 'data_table';
  else if (result.linkCount > 20) result.pageType = 'content';
  else result.pageType = 'other';

  return JSON.stringify(result);
})()`,
        }, 10000);

        if (detectResult?.success && detectResult.data) {
          let parsed;
          try {
            parsed = typeof detectResult.data === "string" ? JSON.parse(detectResult.data) : detectResult.data;
          } catch (e) { parsed = null; }

          if (parsed) {
            ctx.page_type = parsed.pageType;
            ctx.has_forms = parsed.hasForms;
            ctx.buttons_count = parsed.buttonCount;
            ctx.links_count = parsed.linkCount;
            ctx.errors_on_page = parsed.errorTexts || [];

            if (parsed.hasLoginForm) ctx.detected_features.push("login_form");
            if (parsed.hasUserMenu) ctx.detected_features.push("user_menu");
            if (parsed.hasSearchBar) ctx.detected_features.push("search_bar");
            if (parsed.hasTable) ctx.detected_features.push("data_table");
            if (parsed.hasModal) ctx.detected_features.push("open_modal");
            if (parsed.hasErrors) ctx.detected_features.push("error_messages");

            // Auth state
            if (parsed.hasUserMenu && !parsed.hasLoginForm) ctx.auth_state = "logged_in";
            else if (parsed.hasLoginForm && !parsed.hasUserMenu) ctx.auth_state = "logged_out";
            else ctx.auth_state = "unclear";
          }
        }
      } catch (e) { /* non-critical — fall back to basic info */ }

      // Get form fields if forms are present
      if (ctx.has_forms) {
        try {
          const formResult = await sendCommand("get_form_fields", {}, 5000);
          if (formResult?.success && Array.isArray(formResult.data)) {
            ctx.form_fields = formResult.data.slice(0, 15).map(f => ({
              tag: f.tag, type: f.type, name: f.name, id: f.id,
              label: f.label || f.ariaLabel || f.placeholder || null,
              selector: f.selector,
            }));
          }
        } catch (e) { /* non-critical */ }
      }

      return { content: [{ type: "text", text: JSON.stringify(ctx, null, 2) }] };
    }
  );


  // ── 7. agent_error_recover ──

  server.tool(
    "agent_error_recover",
    "Analyze a failed tool result and attempt automatic recovery. Handles common failure modes: element not found (waits and retries with alternative selectors), network/timeout errors (retries), auth errors (attempts re-login detection), CAPTCHA blocking, and page navigation issues. Conservative by default — does not retry destructive actions.",
    {
      error: z.object({
        message: z.string().describe("The error message from the failed tool"),
        code: z.string().optional().describe("Error code if available"),
      }).describe("The error object from the failed tool call"),
      original_tool: z.string().describe("The tool command that failed (e.g. 'click_element', 'fill_field')"),
      original_params: z.record(z.any()).optional().describe("The parameters that were passed to the failed tool"),
    },
    async ({ error, original_tool, original_params }) => {
      sessionState.recordAction({ type: "error_recover_start", tool: original_tool, error: error.message });

      const errorMsg = error.message.toLowerCase();
      const params = original_params || {};
      let recovered = false;
      let recoveryAction = "none";
      let result = null;

      // ── Category 1: Element not found ──
      if (errorMsg.includes("not found") || errorMsg.includes("no element") || errorMsg.includes("null")) {
        recoveryAction = "element_not_found_recovery";

        // Strategy A: Wait for the element to appear
        if (params.selector) {
          try {
            const waitResult = await sendCommand("wait_for_element", {
              selector: params.selector,
              timeoutMs: 5000,
            }, 8000);

            if (waitResult?.success) {
              // Element appeared — retry the original command (if not destructive or if it's a read)
              if (!DESTRUCTIVE_COMMANDS.has(original_tool) || ["click_element", "fill_field"].includes(original_tool)) {
                result = await sendCommand(original_tool, params, 15000);
                recovered = result?.success === true;
                recoveryAction = "waited_and_retried";
              } else {
                recoveryAction = "element_found_after_wait_but_destructive_skipped";
                result = waitResult;
                recovered = true;
              }
            }
          } catch (e) { /* wait failed, try strategy B */ }
        }

        // Strategy B: Try broader selector alternatives
        if (!recovered && params.selector) {
          const altSelectors = [];
          const sel = params.selector;

          // If ID-based, try class-based or attribute-based
          if (sel.startsWith("#")) {
            const id = sel.substring(1);
            altSelectors.push(`[id*="${id}"]`);
            altSelectors.push(`[name="${id}"]`);
            altSelectors.push(`[data-testid="${id}"]`);
          }
          // If class-based, try partial match
          else if (sel.startsWith(".")) {
            const cls = sel.substring(1);
            altSelectors.push(`[class*="${cls}"]`);
          }
          // If attribute-based with name, try other name formats
          else if (sel.includes('[name="')) {
            const nameMatch = sel.match(/\[name="([^"]+)"\]/);
            if (nameMatch) {
              altSelectors.push(`[id="${nameMatch[1]}"]`);
              altSelectors.push(`[data-testid="${nameMatch[1]}"]`);
              altSelectors.push(`[aria-label*="${nameMatch[1]}"]`);
            }
          }

          for (const altSel of altSelectors) {
            try {
              const findResult = await sendCommand("find_elements", { selector: altSel, limit: 1 }, 5000);
              if (findResult?.success && findResult.data?.count > 0) {
                const newParams = { ...params, selector: altSel };
                if (!DESTRUCTIVE_COMMANDS.has(original_tool) || ["click_element", "fill_field"].includes(original_tool)) {
                  result = await sendCommand(original_tool, newParams, 15000);
                  recovered = result?.success === true;
                  if (recovered) {
                    recoveryAction = `alternative_selector: ${altSel}`;
                    break;
                  }
                }
              }
            } catch (e) { continue; }
          }
        }
      }

      // ── Category 2: Timeout / Network error ──
      else if (errorMsg.includes("timed out") || errorMsg.includes("timeout") || errorMsg.includes("network") || errorMsg.includes("disconnected")) {
        recoveryAction = "timeout_retry";

        // Wait a moment and retry once
        await new Promise(r => setTimeout(r, 2000));

        try {
          result = await sendCommand(original_tool, params, 30000);
          recovered = result?.success !== false;
          recoveryAction = recovered ? "timeout_retry_succeeded" : "timeout_retry_failed";
        } catch (e) {
          recoveryAction = "timeout_retry_failed: " + e.message;
        }
      }

      // ── Category 3: Auth / permission error ──
      else if (errorMsg.includes("auth") || errorMsg.includes("permission") || errorMsg.includes("forbidden") || errorMsg.includes("401") || errorMsg.includes("403")) {
        recoveryAction = "auth_error_detection";

        try {
          const loginCheck = await sendCommand("login_detect", {}, 10000);
          if (loginCheck?.success && loginCheck.data?.is_login_page) {
            recoveryAction = "auth_redirect_detected";
            result = {
              success: false,
              recovery_suggestion: "Page redirected to login — use login_flow or auth_flow to authenticate, then retry the original action",
              login_page: loginCheck.data,
            };
            recovered = false; // We detected the issue but cannot auto-resolve without credentials
          } else {
            // Check if we're on an error page
            const tabInfo = await sendCommand("get_active_tab_info", {}, 5000);
            result = {
              success: false,
              recovery_suggestion: "Auth/permission error — verify you are logged in with the correct account",
              current_url: tabInfo?.data?.url,
            };
          }
        } catch (e) {
          recoveryAction = "auth_detection_failed: " + e.message;
        }
      }

      // ── Category 4: CAPTCHA blocking ──
      else if (errorMsg.includes("captcha") || errorMsg.includes("robot") || errorMsg.includes("verify")) {
        recoveryAction = "captcha_detection";

        try {
          const captchaResult = await sendCommand("captcha_detect", {}, 10000);
          if (captchaResult?.success && captchaResult.data) {
            result = {
              success: false,
              captcha_detected: true,
              captcha_info: captchaResult.data,
              recovery_suggestion: "CAPTCHA detected — use captcha_click_checkbox for reCAPTCHA checkbox, or captcha_screenshot for manual solving",
            };

            // If it's a simple checkbox CAPTCHA, try clicking it
            if (captchaResult.data.type === "recaptcha_v2" || captchaResult.data.has_checkbox) {
              try {
                const clickResult = await sendCommand("captcha_click_checkbox", {}, 10000);
                if (clickResult?.success) {
                  // Wait for solve
                  const solveResult = await sendCommand("captcha_wait_for_solve", { timeoutMs: 10000 }, 15000);
                  if (solveResult?.success) {
                    recoveryAction = "captcha_auto_solved";
                    recovered = true;
                    result = solveResult;
                  }
                }
              } catch (e) { /* CAPTCHA auto-solve failed, leave suggestion */ }
            }
          }
        } catch (e) {
          recoveryAction = "captcha_detection_failed: " + e.message;
        }
      }

      // ── Category 5: Page navigation / wrong page ──
      else if (errorMsg.includes("no active tab") || errorMsg.includes("frame") || errorMsg.includes("context")) {
        recoveryAction = "page_context_recovery";

        try {
          // Check if we have an active tab at all
          const tabInfo = await sendCommand("get_active_tab_info", {}, 5000);
          if (tabInfo?.success) {
            // Tab exists but maybe the page changed — wait for load
            await sendCommand("wait_for_load", { timeoutMs: 5000 }, 8000);
            recoveryAction = "waited_for_page_load";

            // Retry if not destructive
            if (!DESTRUCTIVE_COMMANDS.has(original_tool)) {
              result = await sendCommand(original_tool, params, 15000);
              recovered = result?.success !== false;
              recoveryAction = recovered ? "page_reload_retry_succeeded" : "page_reload_retry_failed";
            }
          } else {
            result = {
              success: false,
              recovery_suggestion: "No active tab found — a tab may need to be opened or switched to",
            };
          }
        } catch (e) {
          recoveryAction = "page_context_recovery_failed: " + e.message;
        }
      }

      // ── Default: Unknown error ──
      if (recoveryAction === "none") {
        recoveryAction = "unknown_error_no_recovery";
        result = {
          success: false,
          recovery_suggestion: "No automatic recovery available for this error type. Consider: checking the page state with agent_observe, taking a screenshot, or retrying manually.",
        };
      }

      sessionState.recordAction({
        type: "error_recover_end",
        tool: original_tool,
        recovered,
        recoveryAction,
      });

      return {
        content: [{
          type: "text",
          text: JSON.stringify({ recovered, recovery_action: recoveryAction, result }, null, 2),
        }],
      };
    }
  );

}

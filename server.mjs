#!/usr/bin/env node
/**
 * Lightweight Chrome CDP MCP server.
 * Connects to Chrome via DevToolsActivePort (or a specific --port / --profile),
 * attaches to targets using Target.attachToTarget (works across all Chrome profiles),
 * and exposes tools for debugging without attaching to every tab.
 *
 * Usage:
 *   node server.mjs                          # auto-detect from default Chrome
 *   node server.mjs --port 9222              # connect to a specific debugging port
 *   node server.mjs --profile "Profile 3"    # read DevToolsActivePort for a profile dir
 *   CDP_PORT=9222 node server.mjs            # env var alternative
 */
import { readFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import WebSocket from 'ws';

// ── CLI args / env ──────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && args[i + 1]) opts.port = args[++i];
    if (args[i] === '--profile' && args[i + 1]) opts.profile = args[++i];
  }
  return opts;
}

const cliOpts = parseArgs();

// ── CDP helpers ──────────────────────────────────────────────────────────────

function getDevToolsEndpoint() {
  // 1. Explicit port (CLI or env)
  const explicitPort = cliOpts.port || process.env.CDP_PORT;
  if (explicitPort) {
    return { port: explicitPort, wsPath: null };
  }

  // 2. Profile-specific DevToolsActivePort
  const chromeBase = join(homedir(), 'Library/Application Support/Google/Chrome');
  let file;
  if (cliOpts.profile) {
    // Try exact profile directory name first, then as a subdirectory
    const profileDir = join(chromeBase, cliOpts.profile);
    const parentFile = join(chromeBase, 'DevToolsActivePort');
    // Chrome only writes one DevToolsActivePort at the top level, not per-profile.
    // But if a --profile is specified we still use the main file, just for discovery.
    file = parentFile;
    if (!existsSync(file)) {
      throw new Error(`DevToolsActivePort not found at ${file}. Is Chrome running?`);
    }
  } else {
    file = join(chromeBase, 'DevToolsActivePort');
  }

  const lines = readFileSync(file, 'utf8').trim().split('\n');
  return { port: lines[0], wsPath: lines[1] };
}

function cdpSend(ws, method, params = {}, sessionId = undefined) {
  return new Promise((resolve, reject) => {
    const id = ++cdpSend._id;
    const timeout = setTimeout(() => reject(new Error(`CDP timeout: ${method}`)), 15000);
    function handler(raw) {
      const msg = JSON.parse(raw);
      if (msg.id === id) {
        clearTimeout(timeout);
        ws.off('message', handler);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    }
    ws.on('message', handler);
    const message = { id, method, params };
    if (sessionId) message.sessionId = sessionId;
    ws.send(JSON.stringify(message));
  });
}
cdpSend._id = 0;

let browserWs = null;
let selectedSessionId = null;
let selectedPageInfo = null;

async function getBrowserWs() {
  if (browserWs && browserWs.readyState === WebSocket.OPEN) return browserWs;
  const { port, wsPath } = getDevToolsEndpoint();

  // If we have a wsPath from DevToolsActivePort, use it directly.
  // If only a port (explicit --port), discover via /json/version.
  let url;
  if (wsPath) {
    url = `ws://127.0.0.1:${port}${wsPath}`;
  } else {
    // Fetch browser websocket URL from the HTTP endpoint
    const http = await import('http');
    const versionJson = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}/json/version`, (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
      }).on('error', reject);
    });
    url = versionJson.webSocketDebuggerUrl;
    if (!url) throw new Error('Could not get webSocketDebuggerUrl from /json/version');
  }

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.on('open', () => { browserWs = ws; resolve(ws); });
    ws.on('error', reject);
    setTimeout(() => reject(new Error('Browser WS timeout')), 10000);
  });
}

async function listPages() {
  const ws = await getBrowserWs();
  const result = await cdpSend(ws, 'Target.getTargets');
  return (result.targetInfos || []).filter(t => t.type === 'page');
}

async function attachToTarget(targetId) {
  // Detach from previous target if any
  if (selectedSessionId) {
    try {
      const ws = await getBrowserWs();
      await cdpSend(ws, 'Target.detachFromTarget', { sessionId: selectedSessionId });
    } catch { /* best-effort */ }
    selectedSessionId = null;
  }

  const ws = await getBrowserWs();

  // Use Target.attachToTarget with flatten: true.
  // This works across ALL Chrome profiles (unlike direct /devtools/page/ connections).
  const result = await cdpSend(ws, 'Target.attachToTarget', {
    targetId,
    flatten: true
  });

  selectedSessionId = result.sessionId;

  // Enable Runtime and Console on the attached target
  await cdpSend(ws, 'Runtime.enable', {}, selectedSessionId).catch(() => {});
  await cdpSend(ws, 'Console.enable', {}, selectedSessionId).catch(() => {});

  // Set up console capture
  setupConsoleCapture(ws, selectedSessionId);

  return selectedSessionId;
}

// ── Console message buffer ──────────────────────────────────────────────────

let consoleMessages = [];
const MAX_CONSOLE = 200;

function setupConsoleCapture(ws, sessionId) {
  consoleMessages = [];
  // Remove any previous listener
  if (ws._cdpConsoleHandler) ws.off('message', ws._cdpConsoleHandler);

  const handler = (raw) => {
    const msg = JSON.parse(raw);
    if (msg.method === 'Runtime.consoleAPICalled' && msg.sessionId === sessionId) {
      const entry = {
        type: msg.params.type,
        text: (msg.params.args || []).map(a => a.value ?? a.description ?? JSON.stringify(a)).join(' '),
        timestamp: msg.params.timestamp
      };
      consoleMessages.push(entry);
      if (consoleMessages.length > MAX_CONSOLE) consoleMessages.shift();
    }
  };
  ws._cdpConsoleHandler = handler;
  ws.on('message', handler);
}

// Helper: send CDP command to the selected page (via session)
async function sendToPage(method, params = {}) {
  if (!selectedSessionId) throw new Error('No page selected. Use cdp_select_page first.');
  const ws = await getBrowserWs();
  return cdpSend(ws, method, params, selectedSessionId);
}

// ── MCP protocol (JSON-RPC over stdio) ───────────────────────────────────────

const TOOLS = [
  {
    name: 'cdp_list_pages',
    description: 'List all open Chrome pages (tabs). Returns title and URL for each.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'cdp_select_page',
    description: 'Select a page by index (from cdp_list_pages) to debug. Attaches to that tab only.',
    inputSchema: {
      type: 'object',
      properties: { index: { type: 'number', description: 'Page index from cdp_list_pages' } },
      required: ['index'],
      additionalProperties: false
    }
  },
  {
    name: 'cdp_evaluate',
    description: 'Evaluate JavaScript in the selected page. Returns the result.',
    inputSchema: {
      type: 'object',
      properties: { expression: { type: 'string', description: 'JavaScript expression to evaluate' } },
      required: ['expression'],
      additionalProperties: false
    }
  },
  {
    name: 'cdp_console_messages',
    description: 'Get console messages from the selected page (captured since selection).',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'Max messages to return (default 50)' } },
      additionalProperties: false
    }
  },
  {
    name: 'cdp_navigate',
    description: 'Navigate the selected page to a URL.',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'URL to navigate to' } },
      required: ['url'],
      additionalProperties: false
    }
  },
  {
    name: 'cdp_snapshot',
    description: 'Get the DOM snapshot (outerHTML) of the selected page, or a CSS selector subset.',
    inputSchema: {
      type: 'object',
      properties: { selector: { type: 'string', description: 'CSS selector (default: body). Use a specific selector to avoid huge output.' } },
      additionalProperties: false
    }
  },
  {
    name: 'cdp_url',
    description: 'Get the current URL and title of the selected page.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  }
];

let cachedPages = [];

async function handleToolCall(name, args) {
  try {
    if (name === 'cdp_list_pages') {
      const pages = await listPages();
      cachedPages = pages;
      const lines = pages.map((p, i) => `${i}: ${p.title?.slice(0, 60)}  ${p.url?.slice(0, 100)}`);
      return lines.join('\n') || 'No pages found.';
    }

    if (name === 'cdp_select_page') {
      if (!cachedPages.length) {
        const pages = await listPages();
        cachedPages = pages;
      }
      const page = cachedPages[args.index];
      if (!page) return `Error: index ${args.index} out of range (0-${cachedPages.length - 1})`;
      await attachToTarget(page.targetId);
      selectedPageInfo = page;
      return `Selected: ${page.title}\n${page.url}`;
    }

    if (name === 'cdp_evaluate') {
      const result = await sendToPage('Runtime.evaluate', {
        expression: args.expression,
        returnByValue: true,
        awaitPromise: true
      });
      if (result.exceptionDetails) {
        return `Error: ${result.exceptionDetails.text || result.exceptionDetails.exception?.description || 'Unknown error'}`;
      }
      const val = result.result;
      if (val.type === 'undefined') return 'undefined';
      if (val.value !== undefined) return typeof val.value === 'string' ? val.value : JSON.stringify(val.value, null, 2);
      return val.description || JSON.stringify(val);
    }

    if (name === 'cdp_console_messages') {
      const limit = args.limit || 50;
      const msgs = consoleMessages.slice(-limit);
      if (!msgs.length) return 'No console messages captured. Make sure a page is selected.';
      return msgs.map(m => `[${m.type}] ${m.text}`).join('\n');
    }

    if (name === 'cdp_navigate') {
      await sendToPage('Page.enable');
      await sendToPage('Page.navigate', { url: args.url });
      return `Navigating to ${args.url}`;
    }

    if (name === 'cdp_snapshot') {
      const selector = args.selector || 'body';
      const result = await sendToPage('Runtime.evaluate', {
        expression: `document.querySelector(${JSON.stringify(selector)})?.outerHTML?.slice(0, 50000) || 'Element not found: ${selector}'`,
        returnByValue: true
      });
      return result.result?.value || 'No result';
    }

    if (name === 'cdp_url') {
      const result = await sendToPage('Runtime.evaluate', {
        expression: 'JSON.stringify({url: location.href, title: document.title})',
        returnByValue: true
      });
      return result.result?.value || 'No result';
    }

    return `Unknown tool: ${name}`;
  } catch (err) {
    return `Error: ${err.message}`;
  }
}

// ── Stdio JSON-RPC transport ─────────────────────────────────────────────────

let inputBuffer = '';

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  inputBuffer += chunk;
  // Process complete JSON-RPC messages (newline-delimited)
  let newlineIdx;
  while ((newlineIdx = inputBuffer.indexOf('\n')) !== -1) {
    const line = inputBuffer.slice(0, newlineIdx).trim();
    inputBuffer = inputBuffer.slice(newlineIdx + 1);
    if (line) processMessage(line);
  }
  // Also try parsing buffer as complete JSON (no trailing newline)
  if (inputBuffer.trim()) {
    try {
      JSON.parse(inputBuffer.trim());
      const line = inputBuffer.trim();
      inputBuffer = '';
      processMessage(line);
    } catch { /* incomplete, wait for more data */ }
  }
});

async function processMessage(line) {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }

  // Notifications (no id) - just acknowledge
  if (msg.method === 'notifications/initialized') return;

  if (msg.method === 'initialize') {
    send({
      jsonrpc: '2.0', id: msg.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'chrome-cdp', version: '1.1.0' }
      }
    });
    return;
  }

  if (msg.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } });
    return;
  }

  if (msg.method === 'tools/call') {
    const { name, arguments: args } = msg.params;
    const text = await handleToolCall(name, args || {});
    send({
      jsonrpc: '2.0', id: msg.id,
      result: { content: [{ type: 'text', text }] }
    });
    return;
  }

  // Unknown method
  if (msg.id) {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Unknown method: ${msg.method}` } });
  }
}

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

// Keep alive
process.stdin.on('end', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

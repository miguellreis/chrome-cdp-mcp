#!/usr/bin/env node
/**
 * Lightweight Chrome CDP MCP server.
 * Reads DevToolsActivePort, connects to a single target page,
 * and exposes tools for debugging without attaching to every tab.
 */
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import WebSocket from 'ws';

// ── CDP helpers ──────────────────────────────────────────────────────────────

function getDevToolsEndpoint() {
  const file = join(homedir(), 'Library/Application Support/Google/Chrome/DevToolsActivePort');
  const lines = readFileSync(file, 'utf8').trim().split('\n');
  return { port: lines[0], wsPath: lines[1] };
}

function cdpSend(ws, method, params = {}) {
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
    ws.send(JSON.stringify({ id, method, params }));
  });
}
cdpSend._id = 0;

let browserWs = null;
let selectedPageWs = null;
let selectedPageInfo = null;

async function getBrowserWs() {
  if (browserWs && browserWs.readyState === WebSocket.OPEN) return browserWs;
  const { port, wsPath } = getDevToolsEndpoint();
  const url = `ws://127.0.0.1:${port}${wsPath}`;
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

async function connectToPage(targetId) {
  if (selectedPageWs) { try { selectedPageWs.close(); } catch {} }
  const { port } = getDevToolsEndpoint();
  const url = `ws://127.0.0.1:${port}/devtools/page/${targetId}`;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.on('open', async () => {
      selectedPageWs = ws;
      // Enable Runtime and Console
      await cdpSend(ws, 'Runtime.enable').catch(() => {});
      await cdpSend(ws, 'Console.enable').catch(() => {});
      resolve(ws);
    });
    ws.on('error', reject);
    setTimeout(() => reject(new Error('Page WS timeout')), 10000);
  });
}

// ── Console message buffer ──────────────────────────────────────────────────

let consoleMessages = [];
const MAX_CONSOLE = 200;

function setupConsoleCapture(ws) {
  consoleMessages = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    if (msg.method === 'Runtime.consoleAPICalled') {
      const entry = {
        type: msg.params.type,
        text: (msg.params.args || []).map(a => a.value ?? a.description ?? JSON.stringify(a)).join(' '),
        timestamp: msg.params.timestamp
      };
      consoleMessages.push(entry);
      if (consoleMessages.length > MAX_CONSOLE) consoleMessages.shift();
    }
  });
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
      const ws = await connectToPage(page.targetId);
      setupConsoleCapture(ws);
      selectedPageInfo = page;
      return `Selected: ${page.title}\n${page.url}`;
    }

    if (name === 'cdp_evaluate') {
      if (!selectedPageWs || selectedPageWs.readyState !== WebSocket.OPEN)
        return 'Error: No page selected. Use cdp_select_page first.';
      const result = await cdpSend(selectedPageWs, 'Runtime.evaluate', {
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
      if (!selectedPageWs || selectedPageWs.readyState !== WebSocket.OPEN)
        return 'Error: No page selected. Use cdp_select_page first.';
      await cdpSend(selectedPageWs, 'Page.enable');
      await cdpSend(selectedPageWs, 'Page.navigate', { url: args.url });
      return `Navigating to ${args.url}`;
    }

    if (name === 'cdp_snapshot') {
      if (!selectedPageWs || selectedPageWs.readyState !== WebSocket.OPEN)
        return 'Error: No page selected. Use cdp_select_page first.';
      const selector = args.selector || 'body';
      const result = await cdpSend(selectedPageWs, 'Runtime.evaluate', {
        expression: `document.querySelector(${JSON.stringify(selector)})?.outerHTML?.slice(0, 50000) || 'Element not found: ${selector}'`,
        returnByValue: true
      });
      return result.result?.value || 'No result';
    }

    if (name === 'cdp_url') {
      if (!selectedPageWs || selectedPageWs.readyState !== WebSocket.OPEN)
        return 'Error: No page selected. Use cdp_select_page first.';
      const result = await cdpSend(selectedPageWs, 'Runtime.evaluate', {
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
        serverInfo: { name: 'chrome-cdp', version: '1.0.0' }
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

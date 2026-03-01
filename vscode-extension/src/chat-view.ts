/**
 * Copilot Bridge — Chat Sidebar View
 *
 * A WebviewViewProvider that renders a live chat UI in VS Code's sidebar,
 * similar to the Copilot Chat panel. Shows all incoming prompts from
 * external platforms (Telegram, CLI, etc.) and Copilot's responses,
 * including agent actions (file creation, commands, approvals).
 */

import * as vscode from "vscode";
import { EventEmitter } from "events";

// ── Message Types ───────────────────────────────────────────────

export interface ChatViewMessage {
  id: string;
  timestamp: number;
  type: "user" | "assistant" | "action" | "system" | "approval";
  source?: string;       // e.g. "Telegram", "CLI", "API"
  content: string;
  actions?: ChatViewAction[];
  pending?: boolean;      // true if awaiting approval
  taskId?: string;
}

export interface ChatViewAction {
  type: string;
  path?: string;
  command?: string;
  status: string;
  output?: string;
}

// ── Event Bus ───────────────────────────────────────────────────

export const chatEvents = new EventEmitter();

export function emitChatMessage(msg: ChatViewMessage) {
  chatEvents.emit("message", msg);
}

// ── Webview View Provider ───────────────────────────────────────

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = "copilotBridge.chatView";

  private webviewView?: vscode.WebviewView;
  private messages: ChatViewMessage[] = [];

  constructor(private extensionUri: vscode.Uri) {
    // Listen for new messages
    chatEvents.on("message", (msg: ChatViewMessage) => {
      this.messages.push(msg);
      this.postToWebview({ type: "addMessage", message: msg });
    });
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this.webviewView = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
    };

    webviewView.webview.html = this.getHtml();

    // Send existing messages on load
    webviewView.webview.onDidReceiveMessage((msg) => {
      if (msg.type === "ready") {
        for (const m of this.messages) {
          this.postToWebview({ type: "addMessage", message: m });
        }
      }
      if (msg.type === "clear") {
        this.messages = [];
      }
    });
  }

  private postToWebview(data: any) {
    this.webviewView?.webview.postMessage(data);
  }

  // ── HTML Template ─────────────────────────────────────────────

  private getHtml(): string {
    return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  :root {
    --bg: var(--vscode-editor-background);
    --fg: var(--vscode-editor-foreground);
    --border: var(--vscode-panel-border, #333);
    --user-bg: var(--vscode-button-background, #0e639c);
    --user-fg: var(--vscode-button-foreground, #fff);
    --assistant-bg: var(--vscode-editorWidget-background, #252526);
    --action-bg: var(--vscode-editorInfo-background, #1e3a5f);
    --approval-bg: var(--vscode-editorWarning-foreground, #cca700);
    --system-fg: var(--vscode-descriptionForeground, #888);
    --font: var(--vscode-font-family, 'Segoe UI', sans-serif);
    --font-size: var(--vscode-font-size, 13px);
    --mono: var(--vscode-editor-font-family, 'Menlo', monospace);
  }

  * { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    font-family: var(--font);
    font-size: var(--font-size);
    color: var(--fg);
    background: var(--bg);
    display: flex;
    flex-direction: column;
    height: 100vh;
    overflow: hidden;
  }

  #header {
    padding: 8px 12px;
    border-bottom: 1px solid var(--border);
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-shrink: 0;
  }
  #header h3 {
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    opacity: 0.7;
  }
  #header button {
    background: none;
    border: none;
    color: var(--fg);
    cursor: pointer;
    font-size: 12px;
    opacity: 0.6;
    padding: 2px 6px;
    border-radius: 3px;
  }
  #header button:hover { opacity: 1; background: var(--border); }

  #messages {
    flex: 1;
    overflow-y: auto;
    padding: 8px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .msg {
    max-width: 95%;
    padding: 8px 12px;
    border-radius: 8px;
    line-height: 1.5;
    word-wrap: break-word;
    white-space: pre-wrap;
    font-size: 12.5px;
  }

  .msg.user {
    align-self: flex-end;
    background: var(--user-bg);
    color: var(--user-fg);
    border-bottom-right-radius: 2px;
  }

  .msg.assistant {
    align-self: flex-start;
    background: var(--assistant-bg);
    border-bottom-left-radius: 2px;
  }

  .msg.action {
    align-self: flex-start;
    background: transparent;
    border-left: 3px solid var(--user-bg);
    padding: 6px 10px;
    font-family: var(--mono);
    font-size: 11.5px;
    opacity: 0.85;
  }

  .msg.approval {
    align-self: center;
    background: transparent;
    border: 1px solid var(--approval-bg);
    color: var(--approval-bg);
    text-align: center;
    font-size: 11.5px;
    padding: 6px 14px;
    border-radius: 12px;
  }

  .msg.system {
    align-self: center;
    color: var(--system-fg);
    font-size: 11px;
    text-align: center;
    padding: 4px;
  }

  .msg-source {
    font-size: 10px;
    opacity: 0.5;
    margin-bottom: 2px;
  }

  .msg-time {
    font-size: 10px;
    opacity: 0.4;
    margin-top: 3px;
    text-align: right;
  }

  .action-item {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 1px 0;
  }
  .action-icon { font-size: 12px; }

  pre {
    background: rgba(0,0,0,0.2);
    padding: 6px 8px;
    border-radius: 4px;
    overflow-x: auto;
    font-size: 11px;
    margin: 4px 0;
    font-family: var(--mono);
  }

  #empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    opacity: 0.4;
    text-align: center;
    padding: 20px;
    gap: 8px;
  }
  #empty .icon { font-size: 32px; }
  #empty .hint { font-size: 11px; }

  .pending-pulse {
    animation: pulse 1.5s ease-in-out infinite;
  }
  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.5; }
  }
</style>
</head>
<body>
  <div id="header">
    <h3>🌉 Bridge Chat</h3>
    <button id="clearBtn" title="Clear chat">🗑️ Clear</button>
  </div>
  <div id="messages">
    <div id="empty">
      <div class="icon">🤖</div>
      <div>No messages yet</div>
      <div class="hint">Send a message from Telegram or any connected platform</div>
    </div>
  </div>

<script>
  const vscode = acquireVsCodeApi();
  const messagesEl = document.getElementById('messages');
  const emptyEl = document.getElementById('empty');
  const clearBtn = document.getElementById('clearBtn');
  let msgCount = 0;

  // Tell extension we're ready
  vscode.postMessage({ type: 'ready' });

  clearBtn.addEventListener('click', () => {
    messagesEl.innerHTML = '';
    msgCount = 0;
    messagesEl.appendChild(emptyEl);
    emptyEl.style.display = 'flex';
    vscode.postMessage({ type: 'clear' });
  });

  window.addEventListener('message', (event) => {
    const data = event.data;
    if (data.type === 'addMessage') {
      addMessage(data.message);
    }
  });

  function addMessage(msg) {
    if (msgCount === 0) {
      emptyEl.style.display = 'none';
    }
    msgCount++;

    const el = document.createElement('div');
    el.className = 'msg ' + msg.type;

    if (msg.pending) {
      el.classList.add('pending-pulse');
    }

    let html = '';

    // Source label
    if (msg.source) {
      html += '<div class="msg-source">via ' + escapeHtml(msg.source) + '</div>';
    }

    // Content
    if (msg.type === 'action' && msg.actions) {
      html += formatActions(msg.actions);
    } else {
      html += formatContent(msg.content);
    }

    // Timestamp
    const time = new Date(msg.timestamp).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
    html += '<div class="msg-time">' + time + '</div>';

    el.innerHTML = html;
    messagesEl.appendChild(el);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function formatContent(text) {
    // Basic markdown-like formatting
    let s = escapeHtml(text);
    // Code blocks
    s = s.replace(/\`\`\`([\\s\\S]*?)\`\`\`/g, '<pre>$1</pre>');
    // Inline code
    s = s.replace(/\`([^\`]+)\`/g, '<code style="background:rgba(0,0,0,0.2);padding:1px 4px;border-radius:3px;font-family:var(--mono);font-size:11px">$1</code>');
    // Bold
    s = s.replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>');
    s = s.replace(/\\*(.+?)\\*/g, '<strong>$1</strong>');
    return s;
  }

  function formatActions(actions) {
    let html = '';
    for (const a of actions) {
      const icon = a.status === 'completed' ? '✅'
        : a.status === 'pending_approval' ? '⏳'
        : a.status === 'denied' ? '🚫' : '❌';

      let label = '';
      switch (a.type) {
        case 'create_file': label = 'Create ' + escapeHtml(a.path || ''); break;
        case 'edit_file': label = 'Edit ' + escapeHtml(a.path || ''); break;
        case 'read_file': label = 'Read ' + escapeHtml(a.path || ''); break;
        case 'list_dir': label = 'List ' + escapeHtml(a.path || ''); break;
        case 'run_command': label = escapeHtml(a.command || ''); break;
        default: label = a.type;
      }

      html += '<div class="action-item"><span class="action-icon">' + icon + '</span> ' + label + '</div>';
      if (a.output && a.status === 'completed' && a.type === 'run_command') {
        html += '<pre>' + escapeHtml(a.output.slice(0, 500)) + '</pre>';
      }
    }
    return html;
  }

  function escapeHtml(s) {
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }
</script>
</body>
</html>`;
  }
}

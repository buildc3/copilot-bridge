/**
 * Chat Panel — Live Webview
 *
 * Shows all Copilot Bridge conversations in real-time inside VS Code.
 * Displays user prompts and Copilot responses as a chat feed.
 */

import * as vscode from "vscode";

export interface ChatEvent {
  type: "user" | "assistant" | "system";
  conversationId?: string;
  content: string;
  model?: string;
  durationMs?: number;
  timestamp: number;
}

export class ChatPanel {
  public static currentPanel: ChatPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];

  private constructor(panel: vscode.WebviewPanel) {
    this.panel = panel;
    this.panel.webview.html = this.getHtml();

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  /** Show or focus the chat panel */
  static show(extensionUri?: vscode.Uri) {
    if (ChatPanel.currentPanel) {
      ChatPanel.currentPanel.panel.reveal(vscode.ViewColumn.Beside);
      return ChatPanel.currentPanel;
    }

    const panel = vscode.window.createWebviewPanel(
      "copilotBridgeChat",
      "🌉 Copilot Bridge Chat",
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true }
    );

    ChatPanel.currentPanel = new ChatPanel(panel);
    return ChatPanel.currentPanel;
  }

  /** Push a chat event to the webview */
  addEvent(event: ChatEvent) {
    this.panel.webview.postMessage({ type: "chatEvent", event });
  }

  dispose() {
    ChatPanel.currentPanel = undefined;
    this.panel.dispose();
    while (this.disposables.length) {
      const d = this.disposables.pop();
      if (d) d.dispose();
    }
  }

  private getHtml(): string {
    return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Copilot Bridge Chat</title>
<style>
  :root {
    --bg: #1e1e1e;
    --surface: #252526;
    --border: #3c3c3c;
    --text: #cccccc;
    --text-dim: #808080;
    --user-bg: #264f78;
    --assistant-bg: #2d2d2d;
    --system-bg: #1a3a1a;
    --accent: #569cd6;
  }

  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    font-size: 13px;
    background: var(--bg);
    color: var(--text);
    height: 100vh;
    display: flex;
    flex-direction: column;
  }

  .header {
    padding: 12px 16px;
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: center;
    justify-content: space-between;
    background: var(--surface);
  }

  .header h2 {
    font-size: 14px;
    font-weight: 600;
    color: var(--accent);
  }

  .header .badge {
    font-size: 11px;
    background: var(--accent);
    color: #fff;
    padding: 2px 8px;
    border-radius: 10px;
  }

  .chat-feed {
    flex: 1;
    overflow-y: auto;
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .msg {
    max-width: 90%;
    padding: 10px 14px;
    border-radius: 12px;
    line-height: 1.5;
    position: relative;
    word-wrap: break-word;
    white-space: pre-wrap;
  }

  .msg.user {
    align-self: flex-end;
    background: var(--user-bg);
    border-bottom-right-radius: 4px;
  }

  .msg.assistant {
    align-self: flex-start;
    background: var(--assistant-bg);
    border: 1px solid var(--border);
    border-bottom-left-radius: 4px;
  }

  .msg.system {
    align-self: center;
    background: var(--system-bg);
    border: 1px solid #2a5a2a;
    font-size: 12px;
    color: #6a9955;
    border-radius: 8px;
    text-align: center;
  }

  .msg-meta {
    font-size: 10px;
    color: var(--text-dim);
    margin-top: 4px;
  }

  .msg-label {
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-bottom: 4px;
    opacity: 0.7;
  }

  .msg.user .msg-label { color: #9cdcfe; }
  .msg.assistant .msg-label { color: #dcdcaa; }

  .empty-state {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--text-dim);
    text-align: center;
    padding: 40px;
    line-height: 1.8;
  }

  .empty-state .icon {
    font-size: 48px;
    margin-bottom: 16px;
  }

  /* Scrollbar */
  .chat-feed::-webkit-scrollbar { width: 6px; }
  .chat-feed::-webkit-scrollbar-track { background: transparent; }
  .chat-feed::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }

  code {
    background: rgba(255,255,255,0.1);
    padding: 1px 4px;
    border-radius: 3px;
    font-size: 12px;
  }

  pre {
    background: #1a1a1a;
    padding: 8px 12px;
    border-radius: 6px;
    overflow-x: auto;
    margin: 6px 0;
    font-size: 12px;
  }
</style>
</head>
<body>
  <div class="header">
    <h2>🌉 Copilot Bridge — Live Chat</h2>
    <span class="badge" id="msgCount">0 messages</span>
  </div>
  <div class="chat-feed" id="feed">
    <div class="empty-state" id="emptyState">
      <div>
        <div class="icon">🌉</div>
        <div>Waiting for messages...<br><br>
        Send a message from Telegram or any<br>connected client to see it here live.</div>
      </div>
    </div>
  </div>

  <script>
    const feed = document.getElementById('feed');
    const emptyState = document.getElementById('emptyState');
    const msgCountEl = document.getElementById('msgCount');
    let msgCount = 0;

    function formatTime(ts) {
      const d = new Date(ts);
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }

    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }

    function addMessage(event) {
      if (emptyState) emptyState.remove();

      const div = document.createElement('div');
      div.classList.add('msg', event.type);

      let label = '';
      if (event.type === 'user') label = '👤 User';
      else if (event.type === 'assistant') label = '🤖 Copilot';
      else label = '⚙️ System';

      let meta = formatTime(event.timestamp);
      if (event.conversationId) meta += ' · ' + event.conversationId.slice(0, 12);
      if (event.model) meta += ' · ' + event.model;
      if (event.durationMs) meta += ' · ' + event.durationMs + 'ms';

      div.innerHTML =
        '<div class="msg-label">' + label + '</div>' +
        '<div>' + escapeHtml(event.content) + '</div>' +
        '<div class="msg-meta">' + meta + '</div>';

      feed.appendChild(div);

      // Auto-scroll
      feed.scrollTop = feed.scrollHeight;

      msgCount++;
      msgCountEl.textContent = msgCount + ' message' + (msgCount !== 1 ? 's' : '');
    }

    // Listen for messages from the extension
    window.addEventListener('message', (e) => {
      const msg = e.data;
      if (msg.type === 'chatEvent') {
        addMessage(msg.event);
      }
    });
  </script>
</body>
</html>`;
  }
}

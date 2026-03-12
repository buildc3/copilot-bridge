/**
 * Copilot Bridge - VS Code Extension
 *
 * Exposes GitHub Copilot's Language Model API as an HTTP server
 * so external platforms (Telegram, Slack, CLI, etc.) can send prompts
 * and receive AI-generated responses.
 */

import * as vscode from "vscode";
import { BridgeServer } from "./server";
import { ChatViewProvider } from "./chat-view";

let server: BridgeServer | undefined;

export function activate(context: vscode.ExtensionContext) {
  const outputChannel = vscode.window.createOutputChannel("Copilot Bridge");
  const chatLog = vscode.window.createOutputChannel("Copilot Bridge — Chat");

  // ── Start Server ──────────────────────────────────────────────
  const startCmd = vscode.commands.registerCommand(
    "copilotBridge.start",
    async () => {
      if (server?.isRunning) {
        vscode.window.showInformationMessage(
          `Copilot Bridge is already running on port ${server.port}`
        );
        return;
      }

      const config = vscode.workspace.getConfiguration("copilotBridge");
      const port = config.get<number>("port", 7842);
      const host = config.get<string>("host", "127.0.0.1");
      const apiKey = config.get<string>("apiKey", "");

      const wsRoot = await pickWorkspaceRoot();
      if (!wsRoot) {
        vscode.window.showWarningMessage("Copilot Bridge: No folder selected — server not started.");
        return;
      }
      server = new BridgeServer(port, host, apiKey, outputChannel, chatLog, wsRoot);

      try {
        await server.start();
        vscode.window.showInformationMessage(
          `✅ Copilot Bridge running → http://${host}:${port}`
        );
        outputChannel.appendLine(
          `[${ts()}] Server started on http://${host}:${port}`
        );
      } catch (err: any) {
        vscode.window.showErrorMessage(
          `Failed to start Copilot Bridge: ${err.message}`
        );
        outputChannel.appendLine(`[${ts()}] ERROR: ${err.message}`);
      }
    }
  );

  // ── Stop Server ───────────────────────────────────────────────
  const stopCmd = vscode.commands.registerCommand(
    "copilotBridge.stop",
    async () => {
      if (!server?.isRunning) {
        vscode.window.showInformationMessage("Copilot Bridge is not running.");
        return;
      }
      await server.stop();
      vscode.window.showInformationMessage("Copilot Bridge stopped.");
      outputChannel.appendLine(`[${ts()}] Server stopped`);
    }
  );

  // ── Status ────────────────────────────────────────────────────
  const statusCmd = vscode.commands.registerCommand(
    "copilotBridge.status",
    () => {
      if (server?.isRunning) {
        vscode.window.showInformationMessage(
          `Copilot Bridge is running on http://${server.host}:${server.port} | Active conversations: ${server.conversationCount}`
        );
      } else {
        vscode.window.showInformationMessage("Copilot Bridge is not running.");
      }
    }
  );

  // ── Show Chat Log ─────────────────────────────────────────────
  const showChatCmd = vscode.commands.registerCommand(
    "copilotBridge.showChat",
    () => {
      chatLog.show(true);
    }
  );

  // ── Sidebar Chat View ──────────────────────────────────────────
  const chatViewProvider = new ChatViewProvider(context.extensionUri);
  const chatViewDisposable = vscode.window.registerWebviewViewProvider(
    ChatViewProvider.viewId,
    chatViewProvider
  );

  context.subscriptions.push(startCmd, stopCmd, statusCmd, showChatCmd, chatViewDisposable, outputChannel, chatLog);

  // Auto-start the server on activation
  outputChannel.appendLine(`[${ts()}] Copilot Bridge extension activated`);
  (async () => {
    const config = vscode.workspace.getConfiguration("copilotBridge");
    const port = config.get<number>("port", 7842);
    const host = config.get<string>("host", "127.0.0.1");
    const apiKey = config.get<string>("apiKey", "");
    const wsRoot = await pickWorkspaceRoot();
    if (!wsRoot) {
      outputChannel.appendLine(`[${ts()}] No folder selected — skipping auto-start`);
      return;
    }
    server = new BridgeServer(port, host, apiKey, outputChannel, chatLog, wsRoot);
    server.start().then(() => {
      outputChannel.appendLine(`[${ts()}] Server auto-started on http://${host}:${port}`);
      vscode.window.showInformationMessage(`✅ Copilot Bridge running → http://${host}:${port}`);
    }).catch((err: any) => {
      outputChannel.appendLine(`[${ts()}] Auto-start failed: ${err.message}`);
    });
  })();
}

export function deactivate() {
  server?.stop();
}

async function pickWorkspaceRoot(): Promise<string | undefined> {
  const folders = vscode.workspace.workspaceFolders?.map(f => f.uri.fsPath) ?? [];

  // If there's exactly one workspace folder, offer it as a quick option alongside "Browse…"
  const items: vscode.QuickPickItem[] = folders.map(f => ({ label: f }));
  items.push({ label: "$(folder) Browse…", description: "Choose a folder from disk" });

  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: "Which folder should Copilot Bridge work in?",
    title: "Copilot Bridge — Select Workspace Folder",
  });

  if (!pick) { return undefined; }

  if (pick.label === "$(folder) Browse…") {
    const uris = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: "Select Workspace Folder",
    });
    return uris?.[0]?.fsPath;
  }

  return pick.label;
}

function ts(): string {
  return new Date().toISOString().slice(11, 19);
}

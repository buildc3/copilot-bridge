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
let currentWorkspaceRoot: string | undefined;

/**
 * Show a folder picker and return the selected path, or undefined if cancelled.
 */
async function pickWorkspaceFolder(): Promise<string | undefined> {
  const result = await vscode.window.showOpenDialog({
    canSelectFolders: true,
    canSelectFiles: false,
    canSelectMany: false,
    openLabel: "Select Workspace Folder",
    title: "Copilot Bridge — Choose workspace root for the agent",
  });
  return result?.[0]?.fsPath;
}

/**
 * Resolve the workspace root: prompt with folder picker if configured,
 * otherwise fall back to config / VS Code workspace.
 */
async function resolveWorkspaceRoot(): Promise<string | undefined> {
  const config = vscode.workspace.getConfiguration("copilotBridge");
  const promptForWs = config.get<boolean>("promptForWorkspace", true);
  const configuredRoot = config.get<string>("workspaceRoot", "") || undefined;

  if (promptForWs) {
    const picked = await pickWorkspaceFolder();
    if (!picked) {
      return undefined; // user cancelled
    }
    currentWorkspaceRoot = picked;
    return picked;
  }

  currentWorkspaceRoot = configuredRoot;
  return configuredRoot;
}

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

      const wsRoot = await resolveWorkspaceRoot();
      if (wsRoot === undefined && vscode.workspace.getConfiguration("copilotBridge").get<boolean>("promptForWorkspace", true)) {
        vscode.window.showWarningMessage("Copilot Bridge: No workspace folder selected — server start cancelled.");
        return;
      }

      const config = vscode.workspace.getConfiguration("copilotBridge");
      const port = config.get<number>("port", 7842);
      const host = config.get<string>("host", "127.0.0.1");
      const apiKey = config.get<string>("apiKey", "");
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

  // ── Select Workspace Folder ────────────────────────────────────
  const selectWsCmd = vscode.commands.registerCommand(
    "copilotBridge.selectWorkspace",
    async () => {
      const picked = await pickWorkspaceFolder();
      if (picked) {
        currentWorkspaceRoot = picked;
        vscode.window.showInformationMessage(`Copilot Bridge workspace set to: ${picked}`);
        outputChannel.appendLine(`[${ts()}] Workspace root changed to: ${picked}`);

        // If server is running, restart it with the new workspace
        if (server?.isRunning) {
          const config = vscode.workspace.getConfiguration("copilotBridge");
          const port = config.get<number>("port", 7842);
          const host = config.get<string>("host", "127.0.0.1");
          const apiKey = config.get<string>("apiKey", "");
          await server.stop();
          server = new BridgeServer(port, host, apiKey, outputChannel, chatLog, picked);
          await server.start();
          vscode.window.showInformationMessage(`✅ Copilot Bridge restarted with new workspace → http://${host}:${port}`);
        }
      }
    }
  );

  context.subscriptions.push(startCmd, stopCmd, statusCmd, showChatCmd, selectWsCmd, chatViewDisposable, outputChannel, chatLog);

  // Auto-start the server on activation
  outputChannel.appendLine(`[${ts()}] Copilot Bridge extension activated`);
  (async () => {
    const wsRoot = await resolveWorkspaceRoot();
    if (wsRoot === undefined && vscode.workspace.getConfiguration("copilotBridge").get<boolean>("promptForWorkspace", true)) {
      outputChannel.appendLine(`[${ts()}] Auto-start skipped — no workspace folder selected`);
      return;
    }

    const config = vscode.workspace.getConfiguration("copilotBridge");
    const port = config.get<number>("port", 7842);
    const host = config.get<string>("host", "127.0.0.1");
    const apiKey = config.get<string>("apiKey", "");
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

function ts(): string {
  return new Date().toISOString().slice(11, 19);
}

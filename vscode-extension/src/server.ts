/**
 * Bridge HTTP Server
 *
 * Lightweight HTTP server (zero dependencies — uses Node's built-in `http`)
 * that exposes Copilot functionality over REST endpoints.
 *
 * Endpoints:
 *   POST /v1/chat          — Send a prompt (single-turn or multi-turn)
 *   GET  /v1/models        — List available language models
 *   GET  /v1/health        — Health check
 *   POST /v1/conversations — Create a new persistent conversation
 *   POST /v1/conversations/:id/message — Send message in a conversation
 *   GET  /v1/conversations/:id         — Get conversation history
 *   DELETE /v1/conversations/:id       — Delete a conversation
 */

import * as http from "http";
import * as vscode from "vscode";
import {
  askCopilot,
  listModels,
  Conversation,
  ChatMessage,
  CopilotRequest,
} from "./copilot-handler";
import { Agent } from "./agent";
import { emitChatMessage, ChatViewMessage, ChatViewAction } from "./chat-view";

export class BridgeServer {
  private server: http.Server | undefined;
  private conversations = new Map<string, Conversation>();
  private agent: Agent;

  constructor(
    public port: number,
    public host: string,
    private apiKey: string,
    private log: vscode.OutputChannel,
    private chatLog?: vscode.OutputChannel,
    workspaceRoot?: string
  ) {
    const wsRoot = workspaceRoot ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    this.agent = new Agent(wsRoot, log, chatLog);
  }

  get isRunning(): boolean {
    return this.server?.listening ?? false;
  }

  get conversationCount(): number {
    return this.conversations.size;
  }

  // ── Lifecycle ─────────────────────────────────────────────────

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) =>
        this.handleRequest(req, res)
      );

      this.server.on("error", (err) => reject(err));
      this.server.listen(this.port, this.host, () => resolve());
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
      this.server = undefined;
    });
  }

  // ── Request Router ────────────────────────────────────────────

  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ) {
    // CORS headers for browser-based clients
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, X-API-Key"
    );

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // Auth check
    if (this.apiKey && !this.checkAuth(req)) {
      this.json(res, 401, {
        error: "Unauthorized",
        message: 'Provide API key via "X-API-Key" header or "Authorization: Bearer <key>"',
      });
      return;
    }

    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const path = url.pathname;
    const method = req.method ?? "GET";

    this.log.appendLine(`[http] ${method} ${path}`);

    try {
      // Route matching
      if (method === "GET" && path === "/v1/health") {
        return this.handleHealth(res);
      }
      if (method === "GET" && path === "/v1/models") {
        return await this.handleListModels(res);
      }
      if (method === "POST" && path === "/v1/chat") {
        return await this.handleChat(req, res);
      }
      if (method === "POST" && path === "/v1/conversations") {
        return this.handleCreateConversation(res);
      }

      // ── Agent routes ──
      if (method === "POST" && path === "/v1/agent") {
        return await this.handleAgent(req, res);
      }
      const approveMatch = path.match(/^\/v1\/agent\/([^/]+)\/approve$/);
      if (method === "POST" && approveMatch) {
        return await this.handleAgentApprove(approveMatch[1], req, res);
      }
      const statusMatch = path.match(/^\/v1\/agent\/([^/]+)\/status$/);
      if (method === "GET" && statusMatch) {
        return this.handleAgentStatus(statusMatch[1], res);
      }

      // Conversation routes: /v1/conversations/:id[/message]
      const convMatch = path.match(/^\/v1\/conversations\/([^/]+)(\/message)?$/);
      if (convMatch) {
        const convId = convMatch[1];
        const isMessage = !!convMatch[2];

        if (method === "GET" && !isMessage) {
          return this.handleGetConversation(convId, res);
        }
        if (method === "DELETE" && !isMessage) {
          return this.handleDeleteConversation(convId, res);
        }
        if (method === "POST" && isMessage) {
          return await this.handleConversationMessage(convId, req, res);
        }
      }

      this.json(res, 404, { error: "Not found" });
    } catch (err: any) {
      this.log.appendLine(`[http] ERROR: ${err.message}`);
      this.json(res, 500, { error: err.message });
    }
  }

  // ── Auth ──────────────────────────────────────────────────────

  private checkAuth(req: http.IncomingMessage): boolean {
    const headerKey = req.headers["x-api-key"] as string | undefined;
    if (headerKey === this.apiKey) return true;

    const auth = req.headers["authorization"];
    if (auth?.startsWith("Bearer ") && auth.slice(7) === this.apiKey) return true;

    return false;
  }

  // ── Handlers ──────────────────────────────────────────────────

  private handleHealth(res: http.ServerResponse) {
    this.json(res, 200, {
      status: "ok",
      conversations: this.conversations.size,
      uptime: process.uptime(),
    });
  }

  private async handleListModels(res: http.ServerResponse) {
    const models = await listModels();
    this.json(res, 200, { models });
  }

  /**
   * Single-shot chat — no persistent conversation state.
   * Body: { prompt, systemPrompt?, maxTokens?, model?, history? }
   */
  private async handleChat(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ) {
    const body = await this.readBody<CopilotRequest>(req);

    if (!body.prompt) {
      return this.json(res, 400, {
        error: 'Missing required field "prompt"',
      });
    }

    const result = await askCopilot(body, this.log);

    // Log to the live chat panel in VS Code
    this.logChat("[Single Chat]", body.prompt, result.text, result.model, result.durationMs);

    // Emit to sidebar webview
    emitChatMessage({
      id: `msg_${Date.now().toString(36)}`,
      timestamp: Date.now(),
      type: "user",
      source: "API",
      content: body.prompt,
    });
    emitChatMessage({
      id: `msg_${Date.now().toString(36)}_r`,
      timestamp: Date.now(),
      type: "assistant",
      content: result.text,
    });

    this.json(res, 200, {
      response: result.text,
      model: result.model,
      durationMs: result.durationMs,
    });
  }

  // ── Conversation Endpoints ────────────────────────────────────

  private handleCreateConversation(res: http.ServerResponse) {
    const id = this.generateId();
    const conv = new Conversation(id);
    this.conversations.set(id, conv);
    this.log.appendLine(`[conv] Created conversation ${id}`);
    this.json(res, 201, { conversationId: id });
  }

  private handleGetConversation(id: string, res: http.ServerResponse) {
    const conv = this.conversations.get(id);
    if (!conv) return this.json(res, 404, { error: "Conversation not found" });

    this.json(res, 200, {
      conversationId: conv.id,
      history: conv.history,
      createdAt: conv.createdAt,
    });
  }

  private handleDeleteConversation(id: string, res: http.ServerResponse) {
    if (!this.conversations.has(id)) {
      return this.json(res, 404, { error: "Conversation not found" });
    }
    this.conversations.delete(id);
    this.log.appendLine(`[conv] Deleted conversation ${id}`);
    this.json(res, 200, { deleted: true });
  }

  /**
   * Send a message in an existing conversation.
   * Automatically maintains history for multi-turn context.
   * Body: { prompt, systemPrompt?, maxTokens?, model? }
   */
  private async handleConversationMessage(
    id: string,
    req: http.IncomingMessage,
    res: http.ServerResponse
  ) {
    const conv = this.conversations.get(id);
    if (!conv) return this.json(res, 404, { error: "Conversation not found" });

    const body = await this.readBody<CopilotRequest>(req);
    if (!body.prompt) {
      return this.json(res, 400, { error: 'Missing required field "prompt"' });
    }

    // Build request with conversation history
    const copilotReq: CopilotRequest = {
      ...body,
      history: conv.history,
    };

    const result = await askCopilot(copilotReq, this.log);

    // Update conversation history
    conv.history.push({ role: "user", content: body.prompt });
    conv.history.push({ role: "assistant", content: result.text });

    // Log to the live chat panel in VS Code
    this.logChat(`[Conversation ${id.slice(0, 12)}…]`, body.prompt, result.text, result.model, result.durationMs);

    // Emit to sidebar webview
    emitChatMessage({
      id: `msg_${Date.now().toString(36)}`,
      timestamp: Date.now(),
      type: "user",
      source: `Conv ${id.slice(0, 8)}`,
      content: body.prompt,
    });
    emitChatMessage({
      id: `msg_${Date.now().toString(36)}_r`,
      timestamp: Date.now(),
      type: "assistant",
      content: result.text,
    });

    this.json(res, 200, {
      conversationId: id,
      response: result.text,
      model: result.model,
      durationMs: result.durationMs,
      historyLength: conv.history.length,
    });
  }

  // ── Agent Handlers ────────────────────────────────────────────

  /**
   * POST /v1/agent — Run a prompt in agent mode.
   * Body: { prompt }
   * Returns task status, completed actions, and pending approvals.
   */
  private async handleAgent(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ) {
    const body = await this.readBody<{ prompt: string; model?: string }>(req);
    if (!body.prompt) {
      return this.json(res, 400, { error: 'Missing required field "prompt"' });
    }

    const task = await this.agent.run(body.prompt, body.model);

    // Emit to sidebar webview
    emitChatMessage({
      id: `msg_${Date.now().toString(36)}_agent`,
      timestamp: Date.now(),
      type: "user",
      source: "Agent",
      content: body.prompt,
    });
    emitChatMessage({
      id: `msg_${Date.now().toString(36)}_ar`,
      timestamp: Date.now(),
      type: task.status === "awaiting_approval" ? "approval" : "assistant",
      content: task.message || (task.status === "awaiting_approval" ? `⏳ Awaiting approval: ${task.pendingCommand}` : "Agent task completed."),
      actions: task.actions.map((a): ChatViewAction => ({
        type: a.type,
        path: a.path,
        command: a.command,
        status: a.status,
        output: a.output?.slice(0, 500),
      })),
      pending: task.status === "awaiting_approval",
      taskId: task.id,
    });

    this.json(res, 200, {
      taskId: task.id,
      status: task.status,
      message: task.message,
      pendingCommand: task.pendingCommand ?? null,
      actions: task.actions.map((a) => ({
        type: a.type,
        path: a.path,
        command: a.command,
        status: a.status,
        output: a.output?.slice(0, 2000),
      })),
    });
  }

  /**
   * POST /v1/agent/:taskId/approve — Approve or deny a pending command.
   * Body: { approved: boolean }
   */
  private async handleAgentApprove(
    taskId: string,
    req: http.IncomingMessage,
    res: http.ServerResponse
  ) {
    const body = await this.readBody<{ approved: boolean }>(req);
    if (typeof body.approved !== "boolean") {
      return this.json(res, 400, {
        error: 'Missing required field "approved" (boolean)',
      });
    }

    const task = await this.agent.approveTask(taskId, body.approved);
    if (!task) {
      return this.json(res, 404, {
        error: "Task not found or not awaiting approval",
      });
    }

    // Emit approval result to sidebar webview
    emitChatMessage({
      id: `msg_${Date.now().toString(36)}_appr`,
      timestamp: Date.now(),
      type: "approval",
      content: body.approved ? `✅ Command approved` : `🚫 Command denied`,
      taskId,
    });
    if (task.message) {
      emitChatMessage({
        id: `msg_${Date.now().toString(36)}_aresult`,
        timestamp: Date.now(),
        type: "assistant",
        content: task.message,
        actions: task.actions.map((a): ChatViewAction => ({
          type: a.type,
          path: a.path,
          command: a.command,
          status: a.status,
          output: a.output?.slice(0, 500),
        })),
      });
    }

    this.json(res, 200, {
      taskId: task.id,
      status: task.status,
      message: task.message,
      pendingCommand: task.pendingCommand ?? null,
      actions: task.actions.map((a) => ({
        type: a.type,
        path: a.path,
        command: a.command,
        status: a.status,
        output: a.output?.slice(0, 2000),
      })),
    });
  }

  /**
   * GET /v1/agent/:taskId/status — Check status of an agent task.
   */
  private handleAgentStatus(taskId: string, res: http.ServerResponse) {
    const task = this.agent.getTask(taskId);
    if (!task) {
      return this.json(res, 404, { error: "Task not found" });
    }

    this.json(res, 200, {
      taskId: task.id,
      status: task.status,
      message: task.message,
      pendingCommand: task.pendingCommand ?? null,
      actions: task.actions.map((a) => ({
        type: a.type,
        path: a.path,
        command: a.command,
        status: a.status,
        output: a.output?.slice(0, 2000),
      })),
    });
  }

  // ── Utilities ─────────────────────────────────────────────────

  private json(res: http.ServerResponse, status: number, data: any) {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data, null, 2));
  }

  private readBody<T>(req: http.IncomingMessage): Promise<T> {
    return new Promise((resolve, reject) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        try {
          resolve(raw ? JSON.parse(raw) : ({} as T));
        } catch {
          reject(new Error("Invalid JSON body"));
        }
      });
      req.on("error", reject);
    });
  }

  /**
   * Log a conversation exchange to the VS Code "Copilot Bridge — Chat" output panel.
   * Auto-reveals the panel so the user sees it live.
   */
  private logChat(tag: string, prompt: string, response: string, model: string, durationMs: number) {
    if (!this.chatLog) return;

    const time = new Date().toLocaleTimeString();
    const separator = "━".repeat(60);

    this.chatLog.appendLine(separator);
    this.chatLog.appendLine(`${tag}  ${time}  (${model}, ${durationMs}ms)`);
    this.chatLog.appendLine(separator);
    this.chatLog.appendLine("");
    this.chatLog.appendLine(`  🧑 USER:`);
    this.chatLog.appendLine("");
    for (const line of prompt.split("\n")) {
      this.chatLog.appendLine(`     ${line}`);
    }
    this.chatLog.appendLine("");
    this.chatLog.appendLine(`  🤖 COPILOT:`);
    this.chatLog.appendLine("");
    for (const line of response.split("\n")) {
      this.chatLog.appendLine(`     ${line}`);
    }
    this.chatLog.appendLine("");

    // Auto-reveal the chat log panel
    this.chatLog.show(true);
  }

  private generateId(): string {
    return `conv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }
}

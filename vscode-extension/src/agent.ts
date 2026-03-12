/**
 * Copilot Bridge — Agent Mode (Native Tool Calling)
 *
 * Uses VS Code's Language Model API native tool-calling support to let
 * Copilot directly create files, edit code, read files, list directories,
 * and run terminal commands — exactly like VS Code Copilot's built-in
 * agent mode.
 *
 * Instead of fragile custom markers, the model calls typed tools
 * (createFile, editFile, runCommand, etc.) and we execute them.
 * Terminal commands pause for user approval (e.g. Telegram buttons).
 */

import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as cp from "child_process";

// ── Types ───────────────────────────────────────────────────────

export interface AgentAction {
  type: "create_file" | "edit_file" | "read_file" | "list_dir" | "run_command";
  path?: string;
  content?: string;
  oldText?: string;
  newText?: string;
  command?: string;
  output?: string;
  status: "completed" | "pending_approval" | "denied" | "error";
  error?: string;
}

export interface AgentTask {
  id: string;
  prompt: string;
  status: "running" | "awaiting_approval" | "completed" | "error";
  actions: AgentAction[];
  pendingCommand?: string;
  message: string;

  // ── Internal state for tool-call continuation ──
  /** @internal */ _messages?: vscode.LanguageModelChatMessage[];
  /** @internal */ _assistantParts?: (vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart)[];
  /** @internal */ _toolResults?: Map<string, string>;
  /** @internal */ _pendingToolCall?: vscode.LanguageModelToolCallPart;
  /** @internal */ _remainingToolCalls?: vscode.LanguageModelToolCallPart[];
}

// ── Tool Definitions (same idea as Copilot Chat's agent tools) ──

const AGENT_TOOLS: vscode.LanguageModelChatTool[] = [
  {
    name: "createFile",
    description:
      "Create or overwrite a file in the workspace. Always use this when asked to create, write, build, or make code, configs, documentation, etc. The file is written to disk immediately.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "File path relative to workspace root (e.g. 'src/app.py', 'index.html')",
        },
        content: {
          type: "string",
          description: "Complete file content to write",
        },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "editFile",
    description: "Edit an existing file by finding and replacing a specific substring.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to workspace root" },
        oldText: { type: "string", description: "Exact text to find in the file" },
        newText: { type: "string", description: "Replacement text" },
      },
      required: ["path", "oldText", "newText"],
    },
  },
  {
    name: "readFile",
    description: "Read the full contents of a file in the workspace.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to workspace root" },
      },
      required: ["path"],
    },
  },
  {
    name: "listDirectory",
    description: "List files and subdirectories in a workspace directory.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Directory path relative to workspace root. Use '.' for the root.",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "runCommand",
    description:
      "Execute a shell command in the workspace terminal. This requires explicit user approval before execution. Use for installing packages, running scripts, building, testing, etc.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to execute" },
      },
      required: ["command"],
    },
  },
];

// ── System Prompt ───────────────────────────────────────────────

const SYSTEM_PROMPT = `You have tools to create/edit/read files, list directories, and run terminal commands in the user's workspace. Use them when appropriate. Workspace root: `;

// ── Constants ───────────────────────────────────────────────────

const MAX_TOOL_ROUNDS = 20;

// ── Agent Class ─────────────────────────────────────────────────

export class Agent {
  private tasks = new Map<string, AgentTask>();

  constructor(
    private workspaceRoot: string,
    private log: vscode.OutputChannel,
    private chatLog?: vscode.OutputChannel
  ) {}

  getTask(id: string): AgentTask | undefined {
    return this.tasks.get(id);
  }

  // ── Run ─────────────────────────────────────────────────────

  async run(prompt: string, modelOverride?: string): Promise<AgentTask> {
    const taskId = `task_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const task: AgentTask = {
      id: taskId,
      prompt,
      status: "running",
      actions: [],
      message: "",
    };
    this.tasks.set(taskId, task);

    try {
      const model = await this.getModel(modelOverride);

      // Build initial messages
      const messages: vscode.LanguageModelChatMessage[] = [
        vscode.LanguageModelChatMessage.User(SYSTEM_PROMPT + this.workspaceRoot),
        vscode.LanguageModelChatMessage.User(prompt),
      ];
      task._messages = messages;

      // Enter the tool-calling loop
      await this.toolCallLoop(task, model);
      return task;
    } catch (err: any) {
      task.status = "error";
      task.message = `Error: ${err.message}`;
      this.log.appendLine(`[agent] Error: ${err.message}`);
      return task;
    }
  }

  // ── Approve / Deny ──────────────────────────────────────────

  async approveTask(taskId: string, approved: boolean): Promise<AgentTask | undefined> {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== "awaiting_approval") return undefined;

    const pendingAction = task.actions.find((a) => a.status === "pending_approval");
    const pendingToolCall = task._pendingToolCall;
    if (!pendingAction || !pendingToolCall) return undefined;

    // Execute or deny the command
    if (approved) {
      try {
        const output = await this.runShellCommand(pendingAction.command!);
        pendingAction.output = output;
        pendingAction.status = "completed";
        task._toolResults!.set(pendingToolCall.callId, output);
        this.log.appendLine(`[agent] Command approved: ${pendingAction.command}`);
      } catch (err: any) {
        pendingAction.output = err.message;
        pendingAction.status = "error";
        pendingAction.error = err.message;
        task._toolResults!.set(pendingToolCall.callId, `Error: ${err.message}`);
      }
    } else {
      pendingAction.status = "denied";
      pendingAction.output = "Denied by user";
      task._toolResults!.set(pendingToolCall.callId, "Command denied by user.");
      this.log.appendLine(`[agent] Command denied: ${pendingAction.command}`);
    }

    task.pendingCommand = undefined;
    task._pendingToolCall = undefined;
    task.status = "running";

    // Process remaining tool calls from this turn
    const remaining = task._remainingToolCalls || [];
    for (let i = 0; i < remaining.length; i++) {
      const toolCall = remaining[i];
      const result = await this.processToolCall(task, toolCall);

      if (result === null) {
        // Another terminal command needs approval
        task._remainingToolCalls = remaining.slice(i + 1);
        this.logToChat(task);
        return task;
      }
    }
    task._remainingToolCalls = undefined;

    // All tool calls in this turn are processed — add messages and continue
    this.addToolResultMessages(task);

    try {
      const model = await this.getModel();
      await this.toolCallLoop(task, model);
    } catch (err: any) {
      task.status = "error";
      task.message += `\nError: ${err.message}`;
    }

    return task;
  }

  // ── Core Tool-Calling Loop ──────────────────────────────────

  private async toolCallLoop(
    task: AgentTask,
    model: vscode.LanguageModelChat
  ): Promise<void> {
    const messages = task._messages!;
    const config = vscode.workspace.getConfiguration("copilotBridge");
    const maxTokens = config.get<number>("maxTokens", 4096);

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      this.log.appendLine(
        `[agent] Round ${round + 1}/${MAX_TOOL_ROUNDS} — ${messages.length} messages`
      );

      const response = await model.sendRequest(messages, {
        tools: AGENT_TOOLS,
        modelOptions: { maxTokens },
      } as vscode.LanguageModelChatRequestOptions);

      // Collect all parts from the stream
      const parts: (vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart)[] = [];
      for await (const part of response.stream) {
        if (part instanceof vscode.LanguageModelTextPart || part instanceof vscode.LanguageModelToolCallPart) {
          parts.push(part);
        }
      }

      // Separate text and tool calls
      const textChunks: string[] = [];
      const toolCalls: vscode.LanguageModelToolCallPart[] = [];

      for (const part of parts) {
        if (part instanceof vscode.LanguageModelTextPart) {
          textChunks.push(part.value);
        } else if (part instanceof vscode.LanguageModelToolCallPart) {
          toolCalls.push(part);
        }
      }

      const responseText = textChunks.join("");

      this.log.appendLine(
        `[agent] Got ${textChunks.length} text parts, ${toolCalls.length} tool calls`
      );

      // ── No tool calls → the model is done ──
      if (toolCalls.length === 0) {
        task.status = "completed";
        task.message =
          responseText || this.buildActionsSummary(task.actions);
        this.logToChat(task);
        return;
      }

      // ── Process tool calls ──
      task._assistantParts = parts;
      task._toolResults = new Map();

      for (let i = 0; i < toolCalls.length; i++) {
        const toolCall = toolCalls[i];
        const result = await this.processToolCall(task, toolCall);

        if (result === null) {
          // Terminal command needs user approval — save remaining calls and return
          task._remainingToolCalls = toolCalls.slice(i + 1);
          this.logToChat(task);
          return;
        }
      }

      // All tool calls in this turn processed — add to conversation and loop
      this.addToolResultMessages(task);

      if (responseText) {
        this.log.appendLine(
          `[agent] Text alongside tools: ${responseText.slice(0, 200)}`
        );
      }
    }

    // Max rounds reached
    task.status = "completed";
    task.message =
      task.message ||
      this.buildActionsSummary(task.actions) +
        "\n\n(Reached maximum tool rounds)";
    this.logToChat(task);
  }

  // ── Process a single tool call ──────────────────────────────

  /**
   * Returns the result string, or `null` if approval is needed.
   */
  private async processToolCall(
    task: AgentTask,
    toolCall: vscode.LanguageModelToolCallPart
  ): Promise<string | null> {
    const { name, callId, input } = toolCall;
    const args = input as Record<string, string>;

    this.log.appendLine(
      `[agent] Tool: ${name}(${JSON.stringify(args).slice(0, 300)})`
    );

    let result: string;
    let action: AgentAction;

    switch (name) {
      case "createFile": {
        action = {
          type: "create_file",
          path: args.path,
          content: args.content,
          status: "completed",
        };
        try {
          await this.createFile(args.path, args.content);
          result = `File created successfully: ${args.path}`;
          action.output = result;
        } catch (err: any) {
          result = `Error creating file: ${err.message}`;
          action.status = "error";
          action.error = err.message;
        }
        task.actions.push(action);
        task._toolResults!.set(callId, result);
        return result;
      }

      case "editFile": {
        action = {
          type: "edit_file",
          path: args.path,
          oldText: args.oldText,
          newText: args.newText,
          status: "completed",
        };
        try {
          await this.editFile(args.path, args.oldText, args.newText);
          result = `File edited successfully: ${args.path}`;
          action.output = result;
        } catch (err: any) {
          result = `Error editing file: ${err.message}`;
          action.status = "error";
          action.error = err.message;
        }
        task.actions.push(action);
        task._toolResults!.set(callId, result);
        return result;
      }

      case "readFile": {
        action = { type: "read_file", path: args.path, status: "completed" };
        try {
          const content = await this.readFileContent(args.path);
          result = content;
          action.output = `Read ${content.length} chars`;
          action.content = content;
        } catch (err: any) {
          result = `Error reading file: ${err.message}`;
          action.status = "error";
          action.error = err.message;
        }
        task.actions.push(action);
        task._toolResults!.set(callId, result);
        return result;
      }

      case "listDirectory": {
        action = { type: "list_dir", path: args.path, status: "completed" };
        try {
          const items = await this.listDir(args.path);
          result = items.join("\n");
          action.output = result;
        } catch (err: any) {
          result = `Error listing directory: ${err.message}`;
          action.status = "error";
          action.error = err.message;
        }
        task.actions.push(action);
        task._toolResults!.set(callId, result);
        return result;
      }

      case "runCommand": {
        action = {
          type: "run_command",
          command: args.command,
          status: "pending_approval",
        };
        task.actions.push(action);
        task.pendingCommand = args.command;
        task.status = "awaiting_approval";
        task._pendingToolCall = toolCall;

        const doneText = this.buildActionsSummary(
          task.actions.filter((a) => a.status === "completed")
        );
        task.message = doneText
          ? `${doneText}\n\n⚠️ I need to run a command:\n\`${args.command}\`\n\nApprove or deny?`
          : `⚠️ I need to run a command:\n\`${args.command}\`\n\nApprove or deny?`;

        return null; // Pause for approval
      }

      default: {
        result = `Unknown tool: ${name}`;
        task._toolResults!.set(callId, result);
        return result;
      }
    }
  }

  // ── Add tool results to conversation ────────────────────────

  private addToolResultMessages(task: AgentTask): void {
    const messages = task._messages!;
    const assistantParts = task._assistantParts!;
    const toolResults = task._toolResults!;

    // Assistant message (text + tool call parts as produced by the model)
    messages.push(vscode.LanguageModelChatMessage.Assistant(assistantParts));

    // Tool results — one message per tool call
    for (const [callId, result] of toolResults) {
      messages.push(
        vscode.LanguageModelChatMessage.User([
          new vscode.LanguageModelToolResultPart(callId, [
            new vscode.LanguageModelTextPart(result),
          ]),
        ])
      );
    }

    // Clear turn-level state
    task._assistantParts = undefined;
    task._toolResults = undefined;
  }

  // ── Model Selection ─────────────────────────────────────────

  private async getModel(override?: string): Promise<vscode.LanguageModelChat> {
    const config = vscode.workspace.getConfiguration("copilotBridge");
    const modelId = override ?? config.get<string>("model", "copilot-gpt-4o");

    let models = await vscode.lm.selectChatModels({ family: modelId });
    if (models.length === 0) {
      models = await vscode.lm.selectChatModels();
      if (models.length === 0) {
        throw new Error(
          "No language models available. Make sure GitHub Copilot is installed and signed in."
        );
      }
      this.log.appendLine(
        `[agent] Model "${modelId}" not found, using "${models[0].id}"`
      );
    }
    return models[0];
  }

  // ── File System Operations ──────────────────────────────────

  private async createFile(relPath: string, content: string): Promise<void> {
    const absPath = path.resolve(this.workspaceRoot, relPath);
    const dir = path.dirname(absPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(absPath, content, "utf-8");
    this.log.appendLine(`[agent] Created file: ${absPath}`);
  }

  private async readFileContent(relPath: string): Promise<string> {
    const absPath = path.resolve(this.workspaceRoot, relPath);
    return fs.readFileSync(absPath, "utf-8");
  }

  private async listDir(relPath: string): Promise<string[]> {
    const absPath = path.resolve(this.workspaceRoot, relPath);
    const entries = fs.readdirSync(absPath, { withFileTypes: true });
    return entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
  }

  private async editFile(
    relPath: string,
    oldText: string,
    newText: string
  ): Promise<void> {
    const absPath = path.resolve(this.workspaceRoot, relPath);
    let content = fs.readFileSync(absPath, "utf-8");
    if (!content.includes(oldText)) {
      throw new Error(`Could not find text to replace in ${relPath}`);
    }
    content = content.replace(oldText, newText);
    fs.writeFileSync(absPath, content, "utf-8");
    this.log.appendLine(`[agent] Edited file: ${absPath}`);
  }

  // ── Terminal Command Execution ──────────────────────────────

  private runShellCommand(command: string): Promise<string> {
    return new Promise((resolve, reject) => {
      cp.exec(
        command,
        {
          cwd: this.workspaceRoot,
          timeout: 60000, // 60s timeout
          maxBuffer: 2 * 1024 * 1024, // 2MB
          env: { ...process.env, FORCE_COLOR: "0" },
        },
        (err, stdout, stderr) => {
          if (err && !stdout && !stderr) {
            reject(new Error(err.message));
            return;
          }
          const output = [stdout, stderr].filter(Boolean).join("\n").trim();
          resolve(output || "(no output)");
        }
      );
    });
  }

  // ── Summary Building ────────────────────────────────────────

  private buildActionsSummary(actions: AgentAction[]): string {
    if (actions.length === 0) return "No actions performed.";

    const lines: string[] = [];
    for (const a of actions) {
      switch (a.type) {
        case "create_file":
          lines.push(`📄 Created \`${a.path}\``);
          break;
        case "edit_file":
          lines.push(`✏️ Edited \`${a.path}\``);
          break;
        case "read_file":
          lines.push(`📖 Read \`${a.path}\``);
          break;
        case "list_dir":
          lines.push(`📁 Listed \`${a.path}\``);
          break;
        case "run_command": {
          const icon =
            a.status === "completed"
              ? "✅"
              : a.status === "denied"
                ? "🚫"
                : "❌";
          lines.push(`${icon} \`${a.command}\` → ${a.status}`);
          if (a.output && a.status === "completed") {
            lines.push(`   Output: ${a.output.slice(0, 500)}`);
          }
          break;
        }
      }
    }
    return lines.join("\n");
  }

  // ── Chat Logging ────────────────────────────────────────────

  private logToChat(task: AgentTask) {
    if (!this.chatLog) return;

    const time = new Date().toLocaleTimeString();
    const sep = "━".repeat(60);

    this.chatLog.appendLine(sep);
    this.chatLog.appendLine(
      `🤖 AGENT [${task.id.slice(0, 16)}]  ${time}  Status: ${task.status.toUpperCase()}`
    );
    this.chatLog.appendLine(sep);
    this.chatLog.appendLine("");
    this.chatLog.appendLine(`  🧑 USER: ${task.prompt}`);
    this.chatLog.appendLine("");

    for (const action of task.actions) {
      const icon =
        action.status === "completed"
          ? "✅"
          : action.status === "pending_approval"
            ? "⏳"
            : action.status === "denied"
              ? "🚫"
              : "❌";

      if (action.type === "create_file") {
        this.chatLog.appendLine(`  ${icon} CREATE ${action.path}`);
      } else if (action.type === "edit_file") {
        this.chatLog.appendLine(`  ${icon} EDIT ${action.path}`);
      } else if (action.type === "read_file") {
        this.chatLog.appendLine(`  ${icon} READ ${action.path}`);
      } else if (action.type === "list_dir") {
        this.chatLog.appendLine(`  ${icon} LIST ${action.path}`);
      } else if (action.type === "run_command") {
        this.chatLog.appendLine(
          `  ${icon} RUN: ${action.command}  [${action.status}]`
        );
        if (action.output) {
          this.chatLog.appendLine(`      → ${action.output.slice(0, 200)}`);
        }
      }
    }

    this.chatLog.appendLine("");
    if (task.message) {
      this.chatLog.appendLine(
        `  💬 ${task.message.split("\n").join("\n     ")}`
      );
    }
    this.chatLog.appendLine("");

    this.chatLog.show(true);
  }
}

/**
 * Copilot Handler
 *
 * Wraps VS Code's Language Model API (`vscode.lm`) to send prompts
 * to Copilot and stream responses back.
 */

import * as vscode from "vscode";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface CopilotRequest {
  /** The user's prompt */
  prompt: string;
  /** Optional conversation history for multi-turn chat */
  history?: ChatMessage[];
  /** Optional system prompt override */
  systemPrompt?: string;
  /** Max tokens for this specific request */
  maxTokens?: number;
  /** Model override for this request */
  model?: string;
}

export interface CopilotResponse {
  text: string;
  model: string;
  tokensUsed?: number;
  durationMs: number;
}

/**
 * Holds per-conversation state so we can do multi-turn.
 */
export class Conversation {
  id: string;
  history: ChatMessage[] = [];
  createdAt = Date.now();

  constructor(id: string) {
    this.id = id;
  }
}

/**
 * Send a prompt to Copilot via the VS Code Language Model API.
 */
export async function askCopilot(
  request: CopilotRequest,
  log: vscode.OutputChannel
): Promise<CopilotResponse> {
  const config = vscode.workspace.getConfiguration("copilotBridge");
  const defaultModel = config.get<string>("model", "copilot-gpt-4o");
  const defaultMaxTokens = config.get<number>("maxTokens", 4096);
  const defaultSystemPrompt = config.get<string>("systemPrompt", "");

  const modelId = request.model ?? defaultModel;
  const maxTokens = request.maxTokens ?? defaultMaxTokens;
  const systemPrompt = request.systemPrompt ?? defaultSystemPrompt;

  // ── Find available model ──────────────────────────────────────
  const models = await vscode.lm.selectChatModels({ family: modelId });

  if (models.length === 0) {
    // Fallback: try any available model
    const allModels = await vscode.lm.selectChatModels();
    if (allModels.length === 0) {
      throw new Error(
        "No language models available. Make sure GitHub Copilot is installed and signed in."
      );
    }
    log.appendLine(
      `[copilot] Model "${modelId}" not found, falling back to "${allModels[0].id}"`
    );
    return runWithModel(allModels[0], request, systemPrompt, maxTokens, log);
  }

  return runWithModel(models[0], request, systemPrompt, maxTokens, log);
}

async function runWithModel(
  model: vscode.LanguageModelChat,
  request: CopilotRequest,
  systemPrompt: string,
  maxTokens: number,
  log: vscode.OutputChannel
): Promise<CopilotResponse> {
  const start = Date.now();

  // Build message array
  const messages: vscode.LanguageModelChatMessage[] = [];

  // System prompt (only if set)
  if (systemPrompt) {
    messages.push(vscode.LanguageModelChatMessage.User(systemPrompt));
  }

  // Conversation history
  if (request.history) {
    for (const msg of request.history) {
      if (msg.role === "user") {
        messages.push(vscode.LanguageModelChatMessage.User(msg.content));
      } else {
        messages.push(vscode.LanguageModelChatMessage.Assistant(msg.content));
      }
    }
  }

  // Current prompt
  messages.push(vscode.LanguageModelChatMessage.User(request.prompt));

  log.appendLine(
    `[copilot] Sending ${messages.length} messages to model "${model.id}" (maxTokens: ${maxTokens})`
  );

  // Send request
  const response = await model.sendRequest(messages, {
    modelOptions: { maxTokens },
  } as vscode.LanguageModelChatRequestOptions);

  // Stream and collect the full response
  let fullText = "";
  for await (const chunk of response.text) {
    fullText += chunk;
  }

  const durationMs = Date.now() - start;
  log.appendLine(
    `[copilot] Response received (${fullText.length} chars, ${durationMs}ms)`
  );

  return {
    text: fullText,
    model: model.id,
    durationMs,
  };
}

/**
 * List available language models.
 */
export async function listModels(): Promise<
  Array<{ id: string; family: string; vendor: string; version: string }>
> {
  const models = await vscode.lm.selectChatModels();
  return models.map((m) => ({
    id: m.id,
    family: m.family,
    vendor: m.vendor,
    version: m.version,
  }));
}

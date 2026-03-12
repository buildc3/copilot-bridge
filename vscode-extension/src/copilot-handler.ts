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
 * Known credit multipliers for GitHub Copilot models.
 * Based on GitHub Copilot pricing (premium requests).
 * Models not listed here default to 1x.
 */
const CREDIT_MULTIPLIERS: Record<string, number> = {
  // GPT-4o family
  "gpt-4o":           1,
  "copilot-gpt-4o":   1,
  "gpt-4o-mini":      0.25,
  "copilot-gpt-4o-mini": 0.25,

  // GPT-4.1 family
  "gpt-4.1":          1,
  "gpt-4.1-mini":     0.25,
  "gpt-4.1-nano":     0,

  // o-series (reasoning)
  "o1":               3,
  "o1-mini":          1,
  "o1-preview":       3,
  "o3":               3,
  "o3-mini":          1,
  "o4-mini":          1,

  // Claude
  "claude-3.5-sonnet":  1,
  "claude-sonnet-4":    1,
  "claude-3.7-sonnet":  1,
  "claude-sonnet":      1,
  "claude-opus-4":      3,

  // Gemini
  "gemini-2.0-flash":   0.25,
  "gemini-2.5-pro":     1,
  "gemini-exp":         1,
};

function getCreditMultiplier(family: string): number {
  // Exact match first
  if (family in CREDIT_MULTIPLIERS) return CREDIT_MULTIPLIERS[family];
  // Lowercase match
  const lower = family.toLowerCase();
  for (const [key, val] of Object.entries(CREDIT_MULTIPLIERS)) {
    if (lower === key.toLowerCase()) return val;
    if (lower.includes(key.toLowerCase())) return val;
  }
  return 1; // default
}

/**
 * List available language models.
 */
export async function listModels(): Promise<
  Array<{ id: string; family: string; vendor: string; version: string; credits: number }>
> {
  const models = await vscode.lm.selectChatModels();
  return models.map((m) => ({
    id: m.id,
    family: m.family,
    vendor: m.vendor,
    version: m.version,
    credits: getCreditMultiplier(m.family),
  }));
}

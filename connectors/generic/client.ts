/**
 * Copilot Bridge — Generic REST Client
 *
 * A zero-dependency TypeScript/JavaScript client for the Copilot Bridge API.
 * Use this from any Node.js app, Deno, Bun, or even the browser.
 *
 * Usage:
 *   import { CopilotBridge } from './client';
 *
 *   const bridge = new CopilotBridge('http://127.0.0.1:7842', 'your-api-key');
 *
 *   // Single-shot
 *   const answer = await bridge.chat('What is TypeScript?');
 *
 *   // Multi-turn conversation
 *   const conv = await bridge.createConversation();
 *   const r1 = await conv.send('Explain closures in JavaScript');
 *   const r2 = await conv.send('Give me an example');
 */

export interface ChatResponse {
  response: string;
  model: string;
  durationMs: number;
}

export interface ConversationResponse extends ChatResponse {
  conversationId: string;
  historyLength: number;
}

export interface ModelInfo {
  id: string;
  family: string;
  vendor: string;
  version: string;
}

export interface ChatOptions {
  systemPrompt?: string;
  maxTokens?: number;
  model?: string;
  history?: Array<{ role: "user" | "assistant"; content: string }>;
}

export class CopilotBridgeConversation {
  constructor(
    public readonly id: string,
    private bridge: CopilotBridge
  ) {}

  /** Send a message in this conversation (maintains history automatically) */
  async send(
    prompt: string,
    options?: Omit<ChatOptions, "history">
  ): Promise<ConversationResponse> {
    return this.bridge.fetch<ConversationResponse>(
      `/v1/conversations/${this.id}/message`,
      "POST",
      { prompt, ...options }
    );
  }

  /** Get the conversation history */
  async getHistory(): Promise<{
    conversationId: string;
    history: Array<{ role: string; content: string }>;
    createdAt: number;
  }> {
    return this.bridge.fetch(`/v1/conversations/${this.id}`);
  }

  /** Delete this conversation */
  async delete(): Promise<void> {
    await this.bridge.fetch(`/v1/conversations/${this.id}`, "DELETE");
  }
}

export class CopilotBridge {
  private baseUrl: string;
  private headers: Record<string, string>;

  constructor(baseUrl: string = "http://127.0.0.1:7842", apiKey?: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.headers = { "Content-Type": "application/json" };
    if (apiKey) {
      this.headers["X-API-Key"] = apiKey;
    }
  }

  // ── Core Methods ────────────────────────────────────────────────

  /** Single-shot chat (no persistent conversation) */
  async chat(prompt: string, options?: ChatOptions): Promise<ChatResponse> {
    return this.fetch<ChatResponse>("/v1/chat", "POST", {
      prompt,
      ...options,
    });
  }

  /** Create a new persistent conversation */
  async createConversation(): Promise<CopilotBridgeConversation> {
    const data = await this.fetch<{ conversationId: string }>(
      "/v1/conversations",
      "POST"
    );
    return new CopilotBridgeConversation(data.conversationId, this);
  }

  /** List available language models */
  async listModels(): Promise<ModelInfo[]> {
    const data = await this.fetch<{ models: ModelInfo[] }>("/v1/models");
    return data.models;
  }

  /** Health check */
  async isHealthy(): Promise<boolean> {
    try {
      await this.fetch("/v1/health");
      return true;
    } catch {
      return false;
    }
  }

  // ── Internal ────────────────────────────────────────────────────

  /** @internal */
  async fetch<T>(endpoint: string, method = "GET", body?: any): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;
    const options: RequestInit = { method, headers: this.headers };
    if (body) options.body = JSON.stringify(body);

    const res = await fetch(url, options);
    const data = await res.json();

    if (!res.ok) {
      throw new Error(
        (data as any).error ?? `HTTP ${res.status}: ${res.statusText}`
      );
    }

    return data as T;
  }
}

// ── Quick CLI Demo ────────────────────────────────────────────────

async function main() {
  const bridge = new CopilotBridge(
    process.env.BRIDGE_URL ?? "http://127.0.0.1:7842",
    process.env.BRIDGE_API_KEY
  );

  console.log("🔍 Checking Copilot Bridge health...");
  const healthy = await bridge.isHealthy();
  if (!healthy) {
    console.error(
      '❌ Bridge is not reachable. Start VS Code and run "Copilot Bridge: Start Server"'
    );
    process.exit(1);
  }
  console.log("✅ Bridge is running!\n");

  // List models
  const models = await bridge.listModels();
  console.log(
    "📋 Available models:",
    models.map((m) => m.family).join(", "),
    "\n"
  );

  // Single-shot chat
  console.log("💬 Single-shot chat:");
  const r1 = await bridge.chat("What's the difference between let and const in JavaScript?");
  console.log(`   Response (${r1.durationMs}ms): ${r1.response.slice(0, 200)}...\n`);

  // Multi-turn conversation
  console.log("🔁 Multi-turn conversation:");
  const conv = await bridge.createConversation();
  const r2 = await conv.send("Explain Python decorators in 2 sentences");
  console.log(`   [1] ${r2.response.slice(0, 200)}\n`);
  const r3 = await conv.send("Now show me a simple example");
  console.log(`   [2] ${r3.response.slice(0, 200)}\n`);

  // Cleanup
  await conv.delete();
  console.log("✅ Done!");
}

// Run if executed directly
if (typeof require !== "undefined" && require.main === module) {
  main().catch(console.error);
}

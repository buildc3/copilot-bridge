/**
 * Copilot Bridge — Telegram Bot Connector
 *
 * A Telegram bot that forwards messages to the Copilot Bridge API
 * running inside VS Code, and sends back AI responses.
 *
 * Features:
 *   - Multi-turn conversations (persistent per chat)
 *   - /new command to start fresh conversation
 *   - /models command to list available models
 *   - /help command
 *   - User allowlist support
 *   - Typing indicators while waiting for response
 *
 * Setup:
 *   1. Copy .env.example → .env and fill in your values
 *   2. npm install
 *   3. npm run dev  (or npm run build && npm start)
 */

import TelegramBot from "node-telegram-bot-api";
import * as fs from "fs";
import * as path from "path";

// ── Config ────────────────────────────────────────────────────────
// Load .env file manually (zero-dep)
function loadEnv() {
  const envPath = path.join(__dirname, ".env");
  // Check both current dir and parent dir (for when running from dist/)
  const paths = [envPath, path.join(__dirname, "..", ".env")];
  for (const p of paths) {
    if (fs.existsSync(p)) {
      const lines = fs.readFileSync(p, "utf-8").split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eqIdx = trimmed.indexOf("=");
        if (eqIdx === -1) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        const val = trimmed.slice(eqIdx + 1).trim();
        if (!process.env[key]) process.env[key] = val;
      }
      break;
    }
  }
}
loadEnv();

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";
const BRIDGE_URL = process.env.BRIDGE_URL ?? "http://127.0.0.1:7842";
const BRIDGE_API_KEY = process.env.BRIDGE_API_KEY ?? "";
const ALLOWED_USERS = process.env.ALLOWED_USERS
  ? process.env.ALLOWED_USERS.split(",").map((id) => parseInt(id.trim(), 10))
  : [];

if (!TELEGRAM_TOKEN) {
  console.error(
    "❌ TELEGRAM_BOT_TOKEN is required. Copy .env.example → .env and set it."
  );
  process.exit(1);
}

// ── Bridge API Client ─────────────────────────────────────────────

const headers: Record<string, string> = {
  "Content-Type": "application/json",
};
if (BRIDGE_API_KEY) {
  headers["X-API-Key"] = BRIDGE_API_KEY;
}

async function bridgeFetch(
  endpoint: string,
  method: string = "GET",
  body?: any
): Promise<any> {
  const url = `${BRIDGE_URL}${endpoint}`;
  const options: RequestInit = { method, headers };
  if (body) options.body = JSON.stringify(body);

  const res = await fetch(url, options);
  const data = await res.json();

  if (!res.ok) {
    throw new Error(data.error ?? `HTTP ${res.status}`);
  }
  return data;
}

async function createConversation(): Promise<string> {
  const data = await bridgeFetch("/v1/conversations", "POST");
  return data.conversationId;
}

async function sendMessage(
  conversationId: string,
  prompt: string
): Promise<string> {
  const data = await bridgeFetch(
    `/v1/conversations/${conversationId}/message`,
    "POST",
    { prompt }
  );
  return data.response;
}

async function getModels(): Promise<
  Array<{ id: string; family: string; vendor: string }>
> {
  const data = await bridgeFetch("/v1/models");
  return data.models;
}

async function healthCheck(): Promise<boolean> {
  try {
    await bridgeFetch("/v1/health");
    return true;
  } catch {
    return false;
  }
}

// ── Conversation State ────────────────────────────────────────────
// Map from Telegram chatId → Bridge conversationId
const chatConversations = new Map<number, string>();

async function getOrCreateConversation(chatId: number): Promise<string> {
  let convId = chatConversations.get(chatId);
  if (!convId) {
    convId = await createConversation();
    chatConversations.set(chatId, convId);
  }
  return convId;
}

// ── Bot Setup ─────────────────────────────────────────────────────

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

console.log("🤖 Copilot Bridge Telegram Bot starting...");
console.log(`   Bridge URL: ${BRIDGE_URL}`);
console.log(
  `   Allowed users: ${ALLOWED_USERS.length ? ALLOWED_USERS.join(", ") : "ALL"}`
);

// ── Auth Middleware ────────────────────────────────────────────────

function isAllowed(userId: number | undefined): boolean {
  if (ALLOWED_USERS.length === 0) return true;
  return userId !== undefined && ALLOWED_USERS.includes(userId);
}

// ── Commands ──────────────────────────────────────────────────────

bot.onText(/\/start/, async (msg) => {
  if (!isAllowed(msg.from?.id)) return;

  const chatId = msg.chat.id;
  bot.sendMessage(
    chatId,
    `👋 *Welcome to Copilot Bridge!*

I forward your messages to GitHub Copilot running in VS Code and send back the responses.

*Commands:*
/new — Start a new conversation
/models — List available AI models
/status — Check connection to VS Code
/help — Show this message

Just send me any message to chat with Copilot!`,
    { parse_mode: "Markdown" }
  );
});

bot.onText(/\/help/, async (msg) => {
  if (!isAllowed(msg.from?.id)) return;

  bot.sendMessage(
    msg.chat.id,
    `*Copilot Bridge Commands:*

/new — Start fresh conversation (clears history)
/models — List available AI models
/status — Check if VS Code bridge is running
/help — Show this message

*Tips:*
• Conversations remember context — follow-up questions work!
• Use /new when you want to switch topics
• Make sure VS Code is open with the Copilot Bridge extension running`,
    { parse_mode: "Markdown" }
  );
});

bot.onText(/\/new/, async (msg) => {
  if (!isAllowed(msg.from?.id)) return;

  const chatId = msg.chat.id;
  chatConversations.delete(chatId);
  bot.sendMessage(chatId, "🔄 New conversation started! Send me a message.");
});

bot.onText(/\/models/, async (msg) => {
  if (!isAllowed(msg.from?.id)) return;

  const chatId = msg.chat.id;
  try {
    const models = await getModels();
    const list = models
      .map((m) => `• *${m.family}* (${m.vendor})`)
      .join("\n");
    bot.sendMessage(chatId, `*Available Models:*\n${list || "None found"}`, {
      parse_mode: "Markdown",
    });
  } catch (err: any) {
    bot.sendMessage(
      chatId,
      `❌ Failed to fetch models: ${err.message}\n\nMake sure VS Code and the Copilot Bridge extension are running.`
    );
  }
});

bot.onText(/\/status/, async (msg) => {
  if (!isAllowed(msg.from?.id)) return;

  const chatId = msg.chat.id;
  const ok = await healthCheck();
  if (ok) {
    bot.sendMessage(chatId, "✅ Connected to Copilot Bridge in VS Code!");
  } else {
    bot.sendMessage(
      chatId,
      '❌ Cannot reach Copilot Bridge.\n\n1. Open VS Code\n2. Run "Copilot Bridge: Start Server" from the command palette\n3. Try /status again'
    );
  }
});

// ── Message Handler ───────────────────────────────────────────────

bot.on("message", async (msg) => {
  // Skip commands
  if (msg.text?.startsWith("/")) return;
  if (!msg.text) return;
  if (!isAllowed(msg.from?.id)) return;

  const chatId = msg.chat.id;

  // Show typing indicator
  bot.sendChatAction(chatId, "typing");

  // Keep typing indicator alive during long responses
  const typingInterval = setInterval(() => {
    bot.sendChatAction(chatId, "typing");
  }, 4000);

  try {
    const convId = await getOrCreateConversation(chatId);
    const response = await sendMessage(convId, msg.text);

    clearInterval(typingInterval);

    // Telegram has a 4096 char limit per message — split if needed
    if (response.length <= 4096) {
      await bot.sendMessage(chatId, response, { parse_mode: "Markdown" }).catch(() => {
        // If Markdown fails, send as plain text
        bot.sendMessage(chatId, response);
      });
    } else {
      // Split into chunks
      const chunks = splitMessage(response, 4096);
      for (const chunk of chunks) {
        await bot.sendMessage(chatId, chunk, { parse_mode: "Markdown" }).catch(() => {
          bot.sendMessage(chatId, chunk);
        });
      }
    }
  } catch (err: any) {
    clearInterval(typingInterval);

    if (err.message.includes("ECONNREFUSED")) {
      bot.sendMessage(
        chatId,
        '❌ Cannot connect to VS Code.\n\nMake sure VS Code is open and run "Copilot Bridge: Start Server" from the command palette.'
      );
    } else {
      bot.sendMessage(chatId, `❌ Error: ${err.message}`);
    }
  }
});

// ── Helpers ───────────────────────────────────────────────────────

function splitMessage(text: string, maxLen: number): string[] {
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    // Try to split at a newline
    let splitIdx = remaining.lastIndexOf("\n", maxLen);
    if (splitIdx === -1 || splitIdx < maxLen * 0.5) {
      // Fall back to space
      splitIdx = remaining.lastIndexOf(" ", maxLen);
    }
    if (splitIdx === -1 || splitIdx < maxLen * 0.5) {
      splitIdx = maxLen;
    }

    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).trimStart();
  }

  return chunks;
}

// ── Graceful Shutdown ─────────────────────────────────────────────

process.on("SIGINT", () => {
  console.log("\n👋 Shutting down Telegram bot...");
  bot.stopPolling();
  process.exit(0);
});

process.on("SIGTERM", () => {
  bot.stopPolling();
  process.exit(0);
});

console.log("✅ Telegram bot is running! Send messages to your bot.");

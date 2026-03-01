/**
 * Copilot Bridge — Telegram Bot Connector (Agent Mode)
 *
 * A Telegram bot that sends prompts to the Copilot Bridge Agent API.
 * The agent can create files, edit code, and run commands.
 * Terminal commands require approval via inline keyboard buttons.
 *
 * Commands:
 *   /start   — Welcome message
 *   /new     — Reset conversation
 *   /chat    — Switch to simple chat mode (no file/command actions)
 *   /agent   — Switch to agent mode (default — can create files, run commands)
 *   /models  — List available AI models
 *   /status  — Check VS Code connection
 *   /help    — Show help
 */

import TelegramBot from "node-telegram-bot-api";
import * as fs from "fs";
import * as path from "path";

// ── Config ────────────────────────────────────────────────────────

function loadEnv() {
  const paths = [
    path.join(__dirname, ".env"),
    path.join(__dirname, "..", ".env"),
  ];
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

const apiHeaders: Record<string, string> = {
  "Content-Type": "application/json",
};
if (BRIDGE_API_KEY) {
  apiHeaders["X-API-Key"] = BRIDGE_API_KEY;
}

async function bridgeFetch(
  endpoint: string,
  method: string = "GET",
  body?: any
): Promise<any> {
  const url = `${BRIDGE_URL}${endpoint}`;
  const options: RequestInit = { method, headers: apiHeaders };
  if (body) options.body = JSON.stringify(body);

  const res = await fetch(url, options);
  const data = await res.json();

  if (!res.ok) {
    throw new Error(data.error ?? `HTTP ${res.status}`);
  }
  return data;
}

// Agent API
async function agentRun(
  prompt: string
): Promise<{
  taskId: string;
  status: string;
  message: string;
  pendingCommand: string | null;
  actions: any[];
}> {
  return bridgeFetch("/v1/agent", "POST", { prompt });
}

async function agentApprove(
  taskId: string,
  approved: boolean
): Promise<{
  taskId: string;
  status: string;
  message: string;
  pendingCommand: string | null;
  actions: any[];
}> {
  return bridgeFetch(`/v1/agent/${taskId}/approve`, "POST", { approved });
}

// Conversation API (chat mode)
async function createConversation(): Promise<string> {
  const data = await bridgeFetch("/v1/conversations", "POST");
  return data.conversationId;
}

async function sendChatMessage(
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

// ── State ─────────────────────────────────────────────────────────

type BotMode = "agent" | "chat";

interface ChatState {
  mode: BotMode;
  conversationId?: string;
}

const chatStates = new Map<number, ChatState>();

function getState(chatId: number): ChatState {
  let state = chatStates.get(chatId);
  if (!state) {
    state = { mode: "agent" };
    chatStates.set(chatId, state);
  }
  return state;
}

// ── Bot Setup ─────────────────────────────────────────────────────

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

console.log("🤖 Copilot Bridge Telegram Bot starting (Agent Mode)...");
console.log(`   Bridge URL: ${BRIDGE_URL}`);
console.log(
  `   Allowed users: ${ALLOWED_USERS.length ? ALLOWED_USERS.join(", ") : "ALL"}`
);

// ── Auth ──────────────────────────────────────────────────────────

function isAllowed(userId: number | undefined): boolean {
  if (ALLOWED_USERS.length === 0) return true;
  return userId !== undefined && ALLOWED_USERS.includes(userId);
}

// ── Commands ──────────────────────────────────────────────────────

bot.onText(/\/start/, async (msg) => {
  if (!isAllowed(msg.from?.id)) return;
  const state = getState(msg.chat.id);

  bot.sendMessage(
    msg.chat.id,
    `👋 *Welcome to Copilot Bridge!*

I'm connected to GitHub Copilot running in VS Code.

🤖 *Agent Mode* (default):
• Create & edit files in your workspace
• Run terminal commands (with your approval)
• Write complete programs

💬 *Chat Mode*:
• Simple Q&A

*Commands:*
/agent — Switch to agent mode
/chat — Switch to chat mode
/new — Start fresh
/models — List AI models
/status — Check connection

Current mode: *${state.mode.toUpperCase()}*`,
    { parse_mode: "Markdown" }
  );
});

bot.onText(/\/help/, async (msg) => {
  if (!isAllowed(msg.from?.id)) return;
  const state = getState(msg.chat.id);

  bot.sendMessage(
    msg.chat.id,
    `*Copilot Bridge — Help*

🤖 /agent — Agent mode (creates files, runs commands)
💬 /chat — Simple chat mode
🔄 /new — Reset conversation
📋 /models — List available models
🔌 /status — Check VS Code connection

Current mode: *${state.mode.toUpperCase()}*

*Agent Mode Tips:*
• "Create a Python web server" → writes the file
• "Now run it" → asks for your approval first
• ✅ Approve / ❌ Deny buttons for terminal commands
• Files are created in the VS Code workspace`,
    { parse_mode: "Markdown" }
  );
});

bot.onText(/\/agent/, async (msg) => {
  if (!isAllowed(msg.from?.id)) return;
  const state = getState(msg.chat.id);
  state.mode = "agent";
  bot.sendMessage(
    msg.chat.id,
    "🤖 *Agent mode activated!*\n\nI can now create files, edit code, and run commands.\nSend me a task!",
    { parse_mode: "Markdown" }
  );
});

bot.onText(/\/chat/, async (msg) => {
  if (!isAllowed(msg.from?.id)) return;
  const state = getState(msg.chat.id);
  state.mode = "chat";
  state.conversationId = undefined;
  bot.sendMessage(
    msg.chat.id,
    "💬 *Chat mode activated!*\n\nSimple Q&A with Copilot. No file operations.",
    { parse_mode: "Markdown" }
  );
});

bot.onText(/\/new/, async (msg) => {
  if (!isAllowed(msg.from?.id)) return;
  const state = getState(msg.chat.id);
  state.conversationId = undefined;
  bot.sendMessage(msg.chat.id, "🔄 Fresh start! Send me a message.");
});

bot.onText(/\/models/, async (msg) => {
  if (!isAllowed(msg.from?.id)) return;
  try {
    const models = await getModels();
    const list = models.map((m) => `• *${m.family}* (${m.vendor})`).join("\n");
    bot.sendMessage(msg.chat.id, `*Available Models:*\n${list || "None found"}`, {
      parse_mode: "Markdown",
    });
  } catch (err: any) {
    bot.sendMessage(msg.chat.id, `❌ Failed: ${err.message}\n\nIs VS Code running?`);
  }
});

bot.onText(/\/status/, async (msg) => {
  if (!isAllowed(msg.from?.id)) return;
  const ok = await healthCheck();
  const state = getState(msg.chat.id);
  if (ok) {
    bot.sendMessage(
      msg.chat.id,
      `✅ Connected to Copilot Bridge!\nMode: *${state.mode.toUpperCase()}*`,
      { parse_mode: "Markdown" }
    );
  } else {
    bot.sendMessage(
      msg.chat.id,
      '❌ Cannot reach VS Code.\n\n1. Open VS Code\n2. Cmd+Shift+P → "Copilot Bridge: Start Server"\n3. Try /status again'
    );
  }
});

// ── Message Handler ───────────────────────────────────────────────

bot.on("message", async (msg) => {
  if (msg.text?.startsWith("/")) return;
  if (!msg.text) return;
  if (!isAllowed(msg.from?.id)) return;

  const chatId = msg.chat.id;
  const state = getState(chatId);

  bot.sendChatAction(chatId, "typing");
  const typingInterval = setInterval(() => {
    bot.sendChatAction(chatId, "typing");
  }, 4000);

  try {
    if (state.mode === "agent") {
      await handleAgentMessage(chatId, msg.text, typingInterval);
    } else {
      await handleChatMessage(chatId, msg.text, state, typingInterval);
    }
  } catch (err: any) {
    clearInterval(typingInterval);
    if (err.message.includes("ECONNREFUSED")) {
      bot.sendMessage(
        chatId,
        '❌ Cannot connect to VS Code.\n\nRun "Copilot Bridge: Start Server" from the command palette.'
      );
    } else {
      bot.sendMessage(chatId, `❌ Error: ${err.message}`);
    }
  }
});

// ── Agent Message Handling ────────────────────────────────────────

async function handleAgentMessage(
  chatId: number,
  prompt: string,
  typingInterval: ReturnType<typeof setInterval>
) {
  const result = await agentRun(prompt);
  clearInterval(typingInterval);

  // Build response with action summary
  const actionsSummary = formatActions(result.actions);
  let responseText = "";

  if (actionsSummary) {
    responseText += `*Actions:*\n${actionsSummary}\n\n`;
  }

  if (result.status === "awaiting_approval" && result.pendingCommand) {
    responseText += result.message
      ? `${result.message}\n\n`
      : "⚠️ *Terminal command requires approval:*\n\n";
    responseText += `\`${result.pendingCommand}\``;

    await safeSend(chatId, responseText, {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "✅ Approve", callback_data: `approve:${result.taskId}` },
            { text: "❌ Deny", callback_data: `deny:${result.taskId}` },
          ],
        ],
      },
    });
  } else {
    responseText += result.message || "Done!";
    await safeSend(chatId, responseText, { parse_mode: "Markdown" });
  }
}

// ── Chat Message Handling ─────────────────────────────────────────

async function handleChatMessage(
  chatId: number,
  text: string,
  state: ChatState,
  typingInterval: ReturnType<typeof setInterval>
) {
  if (!state.conversationId) {
    state.conversationId = await createConversation();
  }

  const response = await sendChatMessage(state.conversationId, text);
  clearInterval(typingInterval);

  await safeSend(chatId, response, { parse_mode: "Markdown" });
}

// ── Callback Query Handler (Approve / Deny) ──────────────────────

bot.on("callback_query", async (query) => {
  if (!query.data || !query.message) return;

  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const [action, taskId] = query.data.split(":");

  if (!taskId || (action !== "approve" && action !== "deny")) {
    bot.answerCallbackQuery(query.id, { text: "Unknown action" });
    return;
  }

  const approved = action === "approve";

  // Acknowledge button press
  bot.answerCallbackQuery(query.id, {
    text: approved ? "✅ Approved!" : "❌ Denied",
  });

  // Remove buttons from original message
  try {
    bot.editMessageReplyMarkup(
      { inline_keyboard: [] },
      { chat_id: chatId, message_id: messageId }
    );
  } catch {}

  // Show typing while command runs
  bot.sendChatAction(chatId, "typing");
  const typingInterval = setInterval(() => {
    bot.sendChatAction(chatId, "typing");
  }, 4000);

  try {
    const result = await agentApprove(taskId, approved);
    clearInterval(typingInterval);

    let responseText = approved ? "✅ *Command approved*\n\n" : "❌ *Command denied*\n\n";

    // Show command output
    const cmdActions = result.actions.filter(
      (a: any) => a.type === "run_command" && a.output
    );
    for (const cmd of cmdActions) {
      if (cmd.status === "completed" && cmd.output) {
        responseText += `*Output of* \`${cmd.command}\`:\n\`\`\`\n${cmd.output.slice(0, 3000)}\n\`\`\`\n\n`;
      }
    }

    if (result.status === "awaiting_approval" && result.pendingCommand) {
      // Another command needs approval
      responseText += `⚠️ *Next command requires approval:*\n\`${result.pendingCommand}\``;

      await safeSend(chatId, responseText, {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [
              { text: "✅ Approve", callback_data: `approve:${result.taskId}` },
              { text: "❌ Deny", callback_data: `deny:${result.taskId}` },
            ],
          ],
        },
      });
    } else {
      responseText += result.message || "Task complete!";
      await safeSend(chatId, responseText, { parse_mode: "Markdown" });
    }
  } catch (err: any) {
    clearInterval(typingInterval);
    bot.sendMessage(chatId, `❌ Error: ${err.message}`);
  }
});

// ── Helpers ───────────────────────────────────────────────────────

function formatActions(
  actions: Array<{ type: string; path?: string; command?: string; status: string }>
): string {
  if (!actions || actions.length === 0) return "";

  return actions
    .map((a) => {
      const icon =
        a.status === "completed"
          ? "✅"
          : a.status === "pending_approval"
            ? "⏳"
            : a.status === "denied"
              ? "🚫"
              : "❌";

      switch (a.type) {
        case "create_file":
          return `${icon} Created \`${a.path}\``;
        case "edit_file":
          return `${icon} Edited \`${a.path}\``;
        case "read_file":
          return `${icon} Read \`${a.path}\``;
        case "list_dir":
          return `${icon} Listed \`${a.path}\``;
        case "run_command":
          return `${icon} \`${a.command}\``;
        default:
          return `${icon} ${a.type}`;
      }
    })
    .join("\n");
}

async function safeSend(chatId: number, text: string, options: any = {}) {
  const maxLen = 4096;

  if (text.length <= maxLen) {
    try {
      await bot.sendMessage(chatId, text, options);
    } catch {
      const { parse_mode, ...rest } = options;
      await bot.sendMessage(chatId, text, rest);
    }
    return;
  }

  const chunks = splitMessage(text, maxLen);
  for (let i = 0; i < chunks.length; i++) {
    const opts = { ...options };
    if (i < chunks.length - 1) delete opts.reply_markup;
    try {
      await bot.sendMessage(chatId, chunks[i], opts);
    } catch {
      const { parse_mode, ...rest } = opts;
      await bot.sendMessage(chatId, chunks[i], rest);
    }
  }
}

function splitMessage(text: string, maxLen: number): string[] {
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    let splitIdx = remaining.lastIndexOf("\n", maxLen);
    if (splitIdx === -1 || splitIdx < maxLen * 0.5) {
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
  console.log("\n👋 Shutting down...");
  bot.stopPolling();
  process.exit(0);
});
process.on("SIGTERM", () => {
  bot.stopPolling();
  process.exit(0);
});

console.log("✅ Telegram bot running in AGENT MODE!");

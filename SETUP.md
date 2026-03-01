# Copilot Bridge — Setup Guide

Step-by-step instructions to get Copilot Bridge running on your machine.

---

## Prerequisites

| Requirement | Minimum Version | Notes |
|---|---|---|
| **VS Code** | 1.90+ | [Download](https://code.visualstudio.com/) |
| **GitHub Copilot extension** | Latest | Must be installed and signed-in inside VS Code |
| **Copilot subscription** | Any tier | Individual, Business, or Enterprise |
| **Node.js** | 18+ | [Download](https://nodejs.org/) — needed for compilation and connectors |
| **npm** | Bundled with Node.js | Used for dependency installation |

---

## 1. Clone the Repository

```bash
git clone https://github.com/buildc3/copilot-bridge.git
cd copilot-bridge
```

---

## 2. Set Up the VS Code Extension

The extension is the core of Copilot Bridge — it runs an HTTP server inside VS Code that proxies requests to GitHub Copilot.

```bash
cd vscode-extension
npm install
npm run compile
```

### Load the Extension

**Option A — Extension Development Host (recommended for testing):**

1. Open the `vscode-extension/` folder in VS Code.
2. Press **F5** to launch the Extension Development Host.
3. A new VS Code window opens with the extension active.

**Option B — Install globally via VSIX:**

```bash
cd vscode-extension
npx @vscode/vsce package        # produces copilot-bridge-1.0.0.vsix
code --install-extension copilot-bridge-1.0.0.vsix
```

Then restart VS Code.

---

## 3. Start the Bridge Server

1. Open the **Command Palette** (`Cmd+Shift+P` on macOS / `Ctrl+Shift+P` on Windows/Linux).
2. Run **Copilot Bridge: Start Server**.
3. A notification confirms the server is running:
   ```
   ✅ Copilot Bridge running → http://127.0.0.1:7842
   ```

### Verify

```bash
curl http://127.0.0.1:7842/v1/health
```

Expected response:

```json
{ "status": "ok", "uptime": 5, "conversationCount": 0 }
```

---

## 4. (Optional) Connect the Telegram Bot

If you want to chat with Copilot via Telegram:

### 4a. Create a Telegram Bot

1. Open Telegram and message [@BotFather](https://t.me/BotFather).
2. Send `/newbot` and follow the prompts.
3. Copy the **bot token** you receive.

### 4b. Configure & Run

```bash
cd connectors/telegram
npm install
```

Create a `.env` file (or copy `.env.example` if it exists):

```env
TELEGRAM_BOT_TOKEN=your-telegram-bot-token-here
BRIDGE_URL=http://127.0.0.1:7842
# BRIDGE_API_KEY=your-api-key       # if you set one in VS Code settings
# ALLOWED_USERS=123456789,987654321 # restrict to specific Telegram user IDs
```

Start the bot:

```bash
npm run dev
```

### Telegram Bot Commands

| Command | Description |
|---|---|
| `/start` | Welcome message |
| `/new` | Start a new conversation |
| `/models` | List available AI models |
| `/status` | Check connection to the bridge |
| `/help` | Show help |

Send any text message to chat with Copilot.

---

## 5. (Optional) Use the Generic Clients

### Python Client

No dependencies required — uses Python's standard library only.

```bash
# Interactive CLI mode
python connectors/generic/client_python.py
```

Or use it as a library:

```python
from connectors.generic.client_python import CopilotBridge

bridge = CopilotBridge("http://127.0.0.1:7842")
result = bridge.chat("Explain recursion")
print(result["response"])
```

### TypeScript Client

```bash
cd connectors/generic
npm install
```

```typescript
import { CopilotBridge } from './client';

const bridge = new CopilotBridge('http://127.0.0.1:7842');
const answer = await bridge.chat('What is Rust?');
console.log(answer.response);
```

### cURL

```bash
# One-shot chat
curl -X POST http://127.0.0.1:7842/v1/chat \
  -H "Content-Type: application/json" \
  -d '{"prompt": "What is TypeScript?"}'
```

More examples in `connectors/generic/examples.sh`.

---

## 6. Configuration

Open VS Code Settings (`Cmd+,` / `Ctrl+,`) and search for **Copilot Bridge**:

| Setting | Default | Description |
|---|---|---|
| `copilotBridge.port` | `7842` | HTTP server port |
| `copilotBridge.host` | `127.0.0.1` | Bind address — use `0.0.0.0` for network access |
| `copilotBridge.apiKey` | *(empty)* | API key for request authentication |
| `copilotBridge.maxTokens` | `4096` | Maximum tokens per response |
| `copilotBridge.model` | `copilot-gpt-4o` | Default language model |
| `copilotBridge.systemPrompt` | *(default prompt)* | System prompt sent with every request |

---

## 7. Remote / Network Access

To expose the bridge outside localhost (e.g., for a Telegram bot running on a remote server):

1. Set `copilotBridge.host` to `0.0.0.0` in VS Code settings.
2. Set a strong `copilotBridge.apiKey`.
3. Open port `7842` on your firewall, **or** use a tunnel:

```bash
# ngrok
ngrok http 7842

# Cloudflare Tunnel
cloudflared tunnel --url http://localhost:7842
```

Use the tunnel URL as `BRIDGE_URL` in your connector's `.env`.

---

## Troubleshooting

| Problem | Solution |
|---|---|
| **"No language models available"** | Make sure GitHub Copilot is installed and you're signed in with an active subscription. |
| **Server won't start** | Check if port 7842 is already in use: `lsof -i :7842`. Change the port in settings if needed. |
| **Telegram bot can't connect** | Verify `BRIDGE_URL` in `.env` is correct. If running remotely, ensure the bridge host is `0.0.0.0` and the port is accessible. |
| **401 Unauthorized** | You set an API key in VS Code settings but didn't include it in the connector config. Add `BRIDGE_API_KEY` to your `.env`. |
| **Extension not activating** | Open the Output panel (`Cmd+Shift+U`) → select "Copilot Bridge" from the dropdown to see logs. |

---

## Quick Reference — API Endpoints

```
GET  /v1/health                         → Server status
GET  /v1/models                         → List models
POST /v1/chat                           → Single-shot chat
POST /v1/conversations                  → Create conversation
POST /v1/conversations/:id/message      → Send message in conversation
GET  /v1/conversations/:id              → Get conversation history
DELETE /v1/conversations/:id            → Delete conversation
```

---

## License

See [README.md](README.md) for more details on architecture and the full API reference.

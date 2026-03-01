# Copilot Bridge

> Expose GitHub Copilot's AI as an HTTP API — chat with Copilot from Telegram, Slack, CLI, or any platform.

## Architecture

```
┌─────────────────┐     HTTP      ┌──────────────────────────┐
│  Telegram Bot    │ ──────────►  │  VS Code Extension       │
│  Slack Bot       │              │  (Copilot Bridge Server)  │
│  CLI / cURL      │ ◄────────── │                          │
│  Python script   │   JSON       │  Uses vscode.lm API      │
│  Any HTTP client │              │  to talk to Copilot       │
└─────────────────┘              └──────────────────────────┘
```

**How it works:**

1. The **VS Code extension** starts an HTTP server on your machine
2. It receives prompts via REST API calls
3. It forwards them to **GitHub Copilot** using VS Code's Language Model API (`vscode.lm`)
4. It returns Copilot's response as JSON

## Quick Start

### 1. Install the VS Code Extension

```bash
cd copilot-bridge/vscode-extension
npm install
npm run compile
```

Then install it in VS Code:
- Open VS Code
- Press `Cmd+Shift+P` → "Extensions: Install from VSIX..." → or
- Press `F5` to launch in Extension Development Host (for testing)

### 2. Start the Bridge Server

1. Open VS Code Command Palette (`Cmd+Shift+P`)
2. Run **"Copilot Bridge: Start Server"**
3. You'll see: `✅ Copilot Bridge running → http://127.0.0.1:7842`

### 3. Test It

```bash
# Health check
curl http://127.0.0.1:7842/v1/health

# Chat with Copilot
curl -X POST http://127.0.0.1:7842/v1/chat \
  -H "Content-Type: application/json" \
  -d '{"prompt": "What is TypeScript?"}'
```

---

## API Reference

### `GET /v1/health`
Health check. Returns server status.

### `GET /v1/models`
List available language models.

### `POST /v1/chat`
Single-shot chat (no conversation history).

```json
{
  "prompt": "Your question here",
  "systemPrompt": "Optional system prompt override",
  "maxTokens": 4096,
  "model": "copilot-gpt-4o",
  "history": [
    { "role": "user", "content": "Previous question" },
    { "role": "assistant", "content": "Previous answer" }
  ]
}
```

Response:
```json
{
  "response": "Copilot's answer...",
  "model": "copilot-gpt-4o",
  "durationMs": 1234
}
```

### `POST /v1/conversations`
Create a new persistent conversation. Returns `{ conversationId }`.

### `POST /v1/conversations/:id/message`
Send a message in a conversation. History is managed automatically.

```json
{ "prompt": "Your message" }
```

### `GET /v1/conversations/:id`
Get conversation history.

### `DELETE /v1/conversations/:id`
Delete a conversation.

---

## Connectors

### Telegram Bot

Chat with Copilot directly from Telegram.

```bash
cd connectors/telegram
cp .env.example .env
# Edit .env — add your Telegram bot token (get from @BotFather)
npm install
npm run dev
```

**Bot commands:**
| Command   | Description                    |
| --------- | ------------------------------ |
| `/start`  | Welcome message                |
| `/new`    | Start a new conversation       |
| `/models` | List available AI models       |
| `/status` | Check connection to VS Code    |
| `/help`   | Show help                      |

Just send any message to chat with Copilot!

### Python Client

Zero-dependency Python client (stdlib only):

```python
from connectors.generic.client_python import CopilotBridge

bridge = CopilotBridge("http://127.0.0.1:7842")

# Single-shot
result = bridge.chat("Explain recursion")
print(result["response"])

# Multi-turn conversation
conv_id = bridge.create_conversation()
bridge.send_message(conv_id, "What is a binary tree?")
bridge.send_message(conv_id, "How do I traverse it?")  # remembers context
```

Interactive CLI mode:
```bash
python connectors/generic/client_python.py
```

### TypeScript/JavaScript Client

```typescript
import { CopilotBridge } from './connectors/generic/client';

const bridge = new CopilotBridge('http://127.0.0.1:7842');

// Single-shot
const answer = await bridge.chat('What is Rust?');

// Multi-turn
const conv = await bridge.createConversation();
await conv.send('Explain monads');
await conv.send('Show me an example in Haskell');
```

### cURL / Shell

```bash
bash connectors/generic/examples.sh
```

### Build Your Own Connector

Any language/platform that can make HTTP requests can use Copilot Bridge. The API is simple:

1. `POST /v1/chat` with `{ "prompt": "..." }` for one-off questions
2. `POST /v1/conversations` → get ID → `POST /v1/conversations/:id/message` for multi-turn

---

## Configuration

VS Code settings (`Cmd+,` → search "Copilot Bridge"):

| Setting                      | Default         | Description                                    |
| ---------------------------- | --------------- | ---------------------------------------------- |
| `copilotBridge.port`         | `7842`          | Server port                                    |
| `copilotBridge.host`         | `127.0.0.1`     | Bind address (`0.0.0.0` for network access)    |
| `copilotBridge.apiKey`       | *(empty)*       | API key for auth (recommended if exposed)      |
| `copilotBridge.maxTokens`    | `4096`          | Default max tokens per response                |
| `copilotBridge.model`        | `copilot-gpt-4o`| Default language model                         |
| `copilotBridge.systemPrompt` | *(see below)*   | System prompt sent with every request          |

### Security

- By default, the server only listens on `127.0.0.1` (localhost only)
- Set an **API key** if you expose the server to your network
- Use the `ALLOWED_USERS` env var in the Telegram bot to restrict access

### Remote Access

To access from another machine (e.g., for a Telegram bot on a server):

1. Set `copilotBridge.host` to `0.0.0.0`
2. Set a strong `copilotBridge.apiKey`
3. Use a tunnel like [ngrok](https://ngrok.com/) or [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)

```bash
# Example with ngrok
ngrok http 7842
# Then use the ngrok URL as BRIDGE_URL in your connector
```

---

## Project Structure

```
copilot-bridge/
├── vscode-extension/          # VS Code extension (the bridge server)
│   ├── src/
│   │   ├── extension.ts       # Extension entry point & commands
│   │   ├── server.ts          # HTTP server with REST API
│   │   └── copilot-handler.ts # Copilot LM API wrapper
│   ├── package.json
│   └── tsconfig.json
├── connectors/
│   ├── telegram/              # Telegram bot connector
│   │   ├── bot.ts
│   │   ├── .env.example
│   │   └── package.json
│   └── generic/               # Platform-agnostic clients
│       ├── client.ts          # TypeScript/JS client
│       ├── client_python.py   # Python client (zero-dep)
│       └── examples.sh        # cURL examples
└── README.md
```

## Requirements

- **VS Code** 1.90+ with **GitHub Copilot** extension installed and signed in
- **Node.js** 18+ (for Telegram bot and TypeScript compilation)
- A Copilot subscription (Individual, Business, or Enterprise)

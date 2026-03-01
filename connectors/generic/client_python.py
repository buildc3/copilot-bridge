"""
Copilot Bridge — Python Client

Zero-dependency Python client for the Copilot Bridge API.
Works with any Python 3.7+ (uses only urllib from stdlib).

Usage:
    from client_python import CopilotBridge

    bridge = CopilotBridge("http://127.0.0.1:7842", api_key="your-key")

    # Single-shot
    answer = bridge.chat("What is a closure?")
    print(answer["response"])

    # Multi-turn
    conv_id = bridge.create_conversation()
    r1 = bridge.send_message(conv_id, "Explain async/await")
    r2 = bridge.send_message(conv_id, "Show me an example in Python")
"""

import json
import urllib.request
import urllib.error
from typing import Any, Dict, List, Optional


class CopilotBridge:
    def __init__(self, base_url: str = "http://127.0.0.1:7842", api_key: str = ""):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key

    def _request(self, endpoint: str, method: str = "GET", body: Optional[dict] = None) -> dict:
        url = f"{self.base_url}{endpoint}"
        data = json.dumps(body).encode("utf-8") if body else None

        req = urllib.request.Request(url, data=data, method=method)
        req.add_header("Content-Type", "application/json")
        if self.api_key:
            req.add_header("X-API-Key", self.api_key)

        try:
            with urllib.request.urlopen(req) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            error_body = json.loads(e.read().decode("utf-8"))
            raise RuntimeError(error_body.get("error", f"HTTP {e.code}"))

    # ── Core Methods ───────────────────────────────────────────

    def health(self) -> dict:
        """Check if the bridge is running."""
        return self._request("/v1/health")

    def is_healthy(self) -> bool:
        """Returns True if the bridge is reachable."""
        try:
            self.health()
            return True
        except Exception:
            return False

    def list_models(self) -> List[dict]:
        """List available language models."""
        data = self._request("/v1/models")
        return data["models"]

    def chat(
        self,
        prompt: str,
        system_prompt: str = "",
        max_tokens: int = 0,
        model: str = "",
        history: Optional[List[dict]] = None,
    ) -> dict:
        """Single-shot chat (no persistent conversation)."""
        body: Dict[str, Any] = {"prompt": prompt}
        if system_prompt:
            body["systemPrompt"] = system_prompt
        if max_tokens:
            body["maxTokens"] = max_tokens
        if model:
            body["model"] = model
        if history:
            body["history"] = history
        return self._request("/v1/chat", "POST", body)

    # ── Conversations ──────────────────────────────────────────

    def create_conversation(self) -> str:
        """Create a new persistent conversation. Returns the conversation ID."""
        data = self._request("/v1/conversations", "POST")
        return data["conversationId"]

    def send_message(
        self,
        conversation_id: str,
        prompt: str,
        system_prompt: str = "",
        max_tokens: int = 0,
        model: str = "",
    ) -> dict:
        """Send a message in an existing conversation."""
        body: Dict[str, Any] = {"prompt": prompt}
        if system_prompt:
            body["systemPrompt"] = system_prompt
        if max_tokens:
            body["maxTokens"] = max_tokens
        if model:
            body["model"] = model
        return self._request(
            f"/v1/conversations/{conversation_id}/message", "POST", body
        )

    def get_conversation(self, conversation_id: str) -> dict:
        """Get conversation history."""
        return self._request(f"/v1/conversations/{conversation_id}")

    def delete_conversation(self, conversation_id: str) -> dict:
        """Delete a conversation."""
        return self._request(f"/v1/conversations/{conversation_id}", "DELETE")


# ── CLI Demo ─────────────────────────────────────────────────────

if __name__ == "__main__":
    import os
    import sys

    bridge = CopilotBridge(
        base_url=os.environ.get("BRIDGE_URL", "http://127.0.0.1:7842"),
        api_key=os.environ.get("BRIDGE_API_KEY", ""),
    )

    print("🔍 Checking Copilot Bridge health...")
    if not bridge.is_healthy():
        print("❌ Bridge is not reachable. Start VS Code and run 'Copilot Bridge: Start Server'")
        sys.exit(1)

    print("✅ Bridge is running!\n")

    # List models
    models = bridge.list_models()
    print("📋 Available models:", ", ".join(m["family"] for m in models), "\n")

    # Interactive mode
    print("💬 Interactive mode (type 'quit' to exit, 'new' for new conversation)\n")
    conv_id = bridge.create_conversation()
    print(f"   Conversation: {conv_id}\n")

    while True:
        try:
            prompt = input("You: ").strip()
        except (EOFError, KeyboardInterrupt):
            print("\n👋 Bye!")
            break

        if not prompt:
            continue
        if prompt.lower() == "quit":
            break
        if prompt.lower() == "new":
            conv_id = bridge.create_conversation()
            print(f"🔄 New conversation: {conv_id}\n")
            continue

        try:
            result = bridge.send_message(conv_id, prompt)
            print(f"\nCopilot: {result['response']}\n")
        except Exception as e:
            print(f"\n❌ Error: {e}\n")

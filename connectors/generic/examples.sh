#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────
# Copilot Bridge — cURL Examples
#
# These examples show how to interact with the Copilot Bridge API
# from the command line. Works from any platform that has curl.
# ─────────────────────────────────────────────────────────────────

BASE_URL="${BRIDGE_URL:-http://127.0.0.1:7842}"
API_KEY="${BRIDGE_API_KEY:-}"

# Header for API key auth (empty if no key)
AUTH_HEADER=""
if [ -n "$API_KEY" ]; then
  AUTH_HEADER="-H \"X-API-Key: $API_KEY\""
fi

echo "=== Copilot Bridge cURL Examples ==="
echo "Base URL: $BASE_URL"
echo ""

# ── 1. Health Check ──────────────────────────────────────────────
echo "--- Health Check ---"
curl -s "$BASE_URL/v1/health" \
  -H "X-API-Key: $API_KEY" | python3 -m json.tool
echo ""

# ── 2. List Models ──────────────────────────────────────────────
echo "--- List Models ---"
curl -s "$BASE_URL/v1/models" \
  -H "X-API-Key: $API_KEY" | python3 -m json.tool
echo ""

# ── 3. Single-Shot Chat ─────────────────────────────────────────
echo "--- Single-Shot Chat ---"
curl -s -X POST "$BASE_URL/v1/chat" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $API_KEY" \
  -d '{
    "prompt": "Explain the difference between TCP and UDP in 3 sentences"
  }' | python3 -m json.tool
echo ""

# ── 4. Create Conversation ──────────────────────────────────────
echo "--- Create Conversation ---"
CONV_ID=$(curl -s -X POST "$BASE_URL/v1/conversations" \
  -H "X-API-Key: $API_KEY" | python3 -c "import sys,json; print(json.load(sys.stdin)['conversationId'])")
echo "Conversation ID: $CONV_ID"
echo ""

# ── 5. Send Message in Conversation ─────────────────────────────
echo "--- Message 1 ---"
curl -s -X POST "$BASE_URL/v1/conversations/$CONV_ID/message" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $API_KEY" \
  -d '{
    "prompt": "What is a linked list?"
  }' | python3 -m json.tool
echo ""

echo "--- Message 2 (follow-up, remembers context) ---"
curl -s -X POST "$BASE_URL/v1/conversations/$CONV_ID/message" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $API_KEY" \
  -d '{
    "prompt": "How does it compare to an array?"
  }' | python3 -m json.tool
echo ""

# ── 6. Get Conversation History ─────────────────────────────────
echo "--- Conversation History ---"
curl -s "$BASE_URL/v1/conversations/$CONV_ID" \
  -H "X-API-Key: $API_KEY" | python3 -m json.tool
echo ""

# ── 7. Delete Conversation ──────────────────────────────────────
echo "--- Delete Conversation ---"
curl -s -X DELETE "$BASE_URL/v1/conversations/$CONV_ID" \
  -H "X-API-Key: $API_KEY" | python3 -m json.tool
echo ""

echo "=== Done ==="

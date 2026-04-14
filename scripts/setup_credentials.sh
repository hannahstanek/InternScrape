#!/bin/bash
# setup_credentials.sh
# Creates the SQLite and Gmail SMTP credentials in n8n via API.
# Run ONCE after you have:
#   1. Filled in .env (ALERT_GMAIL_USER and ALERT_GMAIL_APP_PASSWORD)
#   2. Logged into n8n at http://localhost:5678 and created an API key
#      (Settings → API → Add API Key → copy the key)
#
# Usage:
#   bash scripts/setup_credentials.sh YOUR_N8N_API_KEY

set -e

API_KEY="$1"
N8N_URL="http://localhost:5678"
ENV_FILE="$(dirname "$0")/../.env"

if [ -z "$API_KEY" ]; then
  echo "Error: API key required."
  echo "Usage: bash scripts/setup_credentials.sh YOUR_N8N_API_KEY"
  echo ""
  echo "Get your API key from: http://localhost:5678/settings/api"
  exit 1
fi

# Load specific values from .env (safe parser — handles spaces in values)
get_env() {
  grep "^${1}=" "$ENV_FILE" | head -1 | cut -d= -f2-
}

DB_PATH=$(get_env DB_PATH)
ALERT_GMAIL_USER=$(get_env ALERT_GMAIL_USER)
ALERT_GMAIL_APP_PASSWORD=$(get_env ALERT_GMAIL_APP_PASSWORD)

if [ -z "$DB_PATH" ]; then
  echo "Error: DB_PATH not set in .env"
  exit 1
fi

if [ -z "$ALERT_GMAIL_USER" ] || [ "$ALERT_GMAIL_USER" = "TODO_YOUR_EMAIL@gmail.com" ]; then
  echo "Error: Fill in ALERT_GMAIL_USER in .env before running this script"
  exit 1
fi

if [ -z "$ALERT_GMAIL_APP_PASSWORD" ] || [ "$ALERT_GMAIL_APP_PASSWORD" = "TODO_16_CHAR_APP_PASSWORD" ]; then
  echo "Error: Fill in ALERT_GMAIL_APP_PASSWORD in .env before running this script"
  exit 1
fi

echo "Creating SQLite credential (Jobs DB)..."
SQLITE_RESPONSE=$(curl -s -X POST "$N8N_URL/api/v1/credentials" \
  -H "X-N8N-API-KEY: $API_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"name\": \"Jobs DB\",
    \"type\": \"sqlite\",
    \"data\": {
      \"database\": \"$DB_PATH\"
    }
  }")

SQLITE_ID=$(echo "$SQLITE_RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('id',''))" 2>/dev/null)

if [ -z "$SQLITE_ID" ]; then
  echo "SQLite credential response: $SQLITE_RESPONSE"
  echo "Warning: Could not confirm SQLite credential creation. Check n8n UI."
else
  echo "  SQLite credential created: ID=$SQLITE_ID"
fi

echo "Creating Gmail SMTP credential..."
SMTP_RESPONSE=$(curl -s -X POST "$N8N_URL/api/v1/credentials" \
  -H "X-N8N-API-KEY: $API_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"name\": \"SMTP\",
    \"type\": \"smtp\",
    \"data\": {
      \"host\": \"smtp.gmail.com\",
      \"port\": 465,
      \"secure\": true,
      \"user\": \"$ALERT_GMAIL_USER\",
      \"password\": \"$ALERT_GMAIL_APP_PASSWORD\"
    }
  }")

SMTP_ID=$(echo "$SMTP_RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('id',''))" 2>/dev/null)

if [ -z "$SMTP_ID" ]; then
  echo "SMTP credential response: $SMTP_RESPONSE"
  echo "Warning: Could not confirm SMTP credential creation. Check n8n UI."
else
  echo "  SMTP credential created: ID=$SMTP_ID"
fi

echo ""
echo "Done. Next steps:"
echo "  1. Open http://localhost:5678"
echo "  2. Go to Workflows — activate '01 — Discovery Poller' and '07 — Maintenance & Safe-Stop'"
echo "  3. Fill in profile/applicant_01.json with your personal info"
echo "  4. The system will start running on its 4-hour schedule"

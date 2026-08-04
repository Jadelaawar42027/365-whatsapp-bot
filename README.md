# 365 Yachts WhatsApp Sales Assistant — Phase 1

WhatsApp ↔ Claude, no GHL yet. Hardcoded system prompt. This is the plumbing —
Phase 2 wires in your GHL MCP server, Phase 3 makes the prompt/knowledge editable.

## 1. Install

```bash
npm install
cp .env.example .env
```

Fill in `.env`:
- `WHATSAPP_TOKEN` / `WHATSAPP_PHONE_NUMBER_ID` — from Meta App Dashboard → WhatsApp → API Setup
- `WHATSAPP_VERIFY_TOKEN` — make up any random string, you'll enter this same string in the Meta dashboard
- `ANTHROPIC_API_KEY` — from console.anthropic.com

## 2. Run locally

```bash
npm run dev
```

Server starts on `http://localhost:3000`.

## 3. Expose it to the internet (Meta needs a public HTTPS URL)

For local testing, use ngrok:

```bash
npx ngrok http 3000
```

This gives you a URL like `https://abcd1234.ngrok-free.app`. Your webhook URL is:
```
https://abcd1234.ngrok-free.app/webhook
```

(Note: free ngrok URLs change every restart — fine for testing, but for anything
your team relies on daily, deploy to Railway/Render/Fly.io instead so the URL is stable.)

## 4. Register the webhook with Meta

In the Meta App Dashboard → WhatsApp → Configuration:
- **Callback URL**: `https://<your-domain>/webhook`
- **Verify token**: same string as `WHATSAPP_VERIFY_TOKEN` in your `.env`
- Click "Verify and Save" — if it fails, check your server logs; it means the
  GET request didn't get a 200 back (server not running, wrong token, or ngrok URL stale)
- Subscribe to the `messages` webhook field

## 5. Test it

From a phone number you've added as a **test recipient** in the Meta dashboard,
message your WhatsApp test number. You should see it logged in your server
console, and get a reply from Claude within a few seconds.

## What's hardcoded right now (fix in later phases)

- System prompt lives in `systemPrompt.js` — edit the string directly, restart to apply (Phase 3 replaces this)
- Conversation history is in-memory (`claude.js`) — wiped on restart, no GHL data (Phase 2)
- No sender permission/identity checks yet — anyone who messages the number gets the same assistant (Phase 4)

## Next: deploying somewhere permanent

Railway or Render both work well and are simple for a Node/Express app like this:
1. Push this folder to a GitHub repo
2. Connect the repo in Railway/Render
3. Set the same env vars from `.env` in their dashboard
4. Deploy — you'll get a stable `https://yourapp.up.railway.app` URL
5. Update the Meta webhook Callback URL to point at that instead of ngrok

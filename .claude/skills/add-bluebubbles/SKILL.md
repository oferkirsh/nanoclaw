---
name: add-bluebubbles
description: Add BlueBubbles iMessage channel to NanoClaw. Connects to a local BlueBubbles server via WebSocket (Socket.IO) to send and receive iMessages. Requires a running BlueBubbles server on macOS.
---

# Add BlueBubbles iMessage Channel

This skill adds iMessage support via a local [BlueBubbles](https://bluebubbles.app) server. BlueBubbles runs on a Mac with iMessage and exposes a WebSocket API. NanoClaw connects to it to receive and send iMessages.

## Phase 1: Pre-flight

### Check current state

Check if BlueBubbles is already configured:

```bash
grep -s BLUEBUBBLES_SERVER_URL .env && echo "Already configured" || echo "Not configured"
```

If already configured, skip to Phase 4 (Register a Chat).

### Check dependencies

```bash
ls src/channels/bluebubbles.ts 2>/dev/null && echo "Channel code present" || echo "Missing"
node -e "require('socket.io-client')" 2>/dev/null && echo "socket.io-client installed" || echo "Not installed"
```

### Ask the user

Use `AskUserQuestion`:

> What is the URL of your BlueBubbles server? (e.g., `http://192.168.1.100:1234` or `http://localhost:1234`)

Then:

> What is the BlueBubbles server password?

## Phase 2: Apply Code Changes

If `src/channels/bluebubbles.ts` is missing, this is a fresh install. The skill branch needs to be merged.

### Add the remote and merge

```bash
git remote -v
```

If a `bluebubbles` remote is missing:

```bash
git remote add bluebubbles https://github.com/qwibitai/nanoclaw-bluebubbles.git
```

Merge the skill branch:

```bash
git fetch bluebubbles main
git merge bluebubbles/main || {
  git checkout --theirs package-lock.json
  git add package-lock.json
  git merge --continue
}
```

This adds:
- `src/channels/bluebubbles.ts` — BlueBubblesChannel class with self-registration
- `import './bluebubbles.js'` in `src/channels/index.ts`
- `socket.io-client` dependency in `package.json`
- `BLUEBUBBLES_SERVER_URL` and `BLUEBUBBLES_PASSWORD` in `.env.example`

### Install and build

```bash
npm install && npm run build
```

## Phase 3: Configure Credentials

Add credentials to `.env`:

```bash
echo "BLUEBUBBLES_SERVER_URL=<URL from Phase 1>" >> .env
echo "BLUEBUBBLES_PASSWORD=<password from Phase 1>" >> .env
```

### Verify server connectivity

```bash
BB_URL=$(grep BLUEBUBBLES_SERVER_URL .env | cut -d= -f2)
BB_PASS=$(grep BLUEBUBBLES_PASSWORD .env | cut -d= -f2)
curl -s -H "password: $BB_PASS" "$BB_URL/api/v1/server/info" | head -c 200
```

A JSON response with `"status": 200` means the server is reachable and the password is correct.

## Phase 4: Register a Chat

List available chats from the BlueBubbles server:

```bash
BB_URL=$(grep BLUEBUBBLES_SERVER_URL .env | cut -d= -f2)
BB_PASS=$(grep BLUEBUBBLES_PASSWORD .env | cut -d= -f2)
curl -s -H "password: $BB_PASS" "$BB_URL/api/v1/chat" | \
  node -e "const d=require('fs').readFileSync('/dev/stdin','utf8'); \
    JSON.parse(d).data.slice(0,20).forEach(c => \
      console.log(c.guid, '-', c.displayName || c.participants?.[0]?.address || 'unknown'))"
```

Show the list to the user and ask which chat to use as the main group.

The chat JID in NanoClaw is `bb:<chatGuid>` — for example `bb:iMessage;-;+14155551234`.

Use `AskUserQuestion` to ask: Which chat should be the main NanoClaw group? (Copy the `bb:...` JID from the list above.)

Then register it:

```bash
npx tsx src/db.ts register-group \
  --jid "bb:<selected-guid>" \
  --name "<chat name>" \
  --folder "main" \
  --channel bluebubbles
```

If the `register-group` CLI is not available, instruct the user to run `npm run setup` and follow the prompts.

## Phase 5: Verify

Restart NanoClaw:

```bash
# macOS
launchctl kickstart -k gui/$(id -u)/com.nanoclaw

# Linux
systemctl --user restart nanoclaw
```

Then check logs for a successful connection:

```bash
tail -n 50 data/nanoclaw.log | grep -i bluebubbles
```

A successful connection looks like:

```
{"level":"info","msg":"Connected to BlueBubbles","serverUrl":"http://..."}
{"level":"info","count":N,"msg":"BlueBubbles chats synced"}
```

Send a test iMessage to the registered chat. NanoClaw should respond if the trigger word is included.

## Troubleshooting

**Connection refused:** Check that BlueBubbles server is running on the Mac and the URL/port are correct. On macOS, BlueBubbles defaults to port 1234.

**401 / wrong password:** Verify the password in BlueBubbles Settings → Server → Password matches `BLUEBUBBLES_PASSWORD` in `.env`.

**No messages arriving:** BlueBubbles must have notification access and Full Disk Access granted in macOS System Preferences. Recheck in System Preferences → Privacy & Security.

**Messages arrive but agent doesn't respond:** Confirm the chat JID is registered. Run `sqlite3 data/nanoclaw.db "SELECT jid, name FROM registered_groups;"` to list registered groups.

**Group chat GUIDs:** Direct messages use `iMessage;-;+E164NUMBER`. Group chats use `iMessage;+;RANDOM-UUID`. Both are prefixed with `bb:` in NanoClaw.

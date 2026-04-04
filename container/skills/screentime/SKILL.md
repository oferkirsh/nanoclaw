---
name: screentime
description: Report macOS Screen Time app usage for self or family members. Use when the user asks about screen time, app usage, what they/kids used today/yesterday, or how long someone spent on an app or device.
---

# Screen Time

## Your own usage (knowledgeC.db)

Query macOS app usage from the mounted knowledgeC.db.

```bash
bash /workspace/extra/screentime/screentime.sh [days]
```

- `days` — how many days back to include (default 1)
- Output: JSON array of `{ app, device, minutes }`

Examples:
```bash
bash /workspace/extra/screentime/screentime.sh 1   # today
bash /workspace/extra/screentime/screentime.sh 7   # last week
```

### Interpreting the output

- `app` is the bundle ID — map common ones: `com.google.Chrome` → Chrome, `com.apple.MobileSMS` → Messages, etc.
- `device` is `This Mac` for local usage, or a model string like `iPhone18,3` for synced device data
- `minutes` is total active foreground time for that app+device pair over the requested period

## Family member usage (UI automation via MCP tool)

For kids/family members (Noam, Omer, Ori), use the `get_family_screentime` MCP tool:

```
get_family_screentime({ member: "noam kirshenbaum" })
```

Family members available: ofer kirshenbaum, Omer Kirshenbaum, Ori Kirshenbaum, noam kirshenbaum

The tool runs on the host Mac via AppleScript UI automation (~10 seconds). Output is JSON: `{ member, total, categories: [{name, time}], apps: [{name, time}] }`

## Presenting results

Format as a readable summary:

```
📱 Screen Time — Noam — Today
Total: 1h 59m

Categories:
• Social         1h 20m
• Education      35m

Apps:
• TikTok         1h 16m
• Google Classroom 19m
• Toca Boca World  15m
• WhatsApp         4m
```

Skip apps under 1 minute. Group by device when multiple devices appear.

## If the script is not mounted

If `/workspace/extra/screentime/screentime.sh` does not exist, tell the user:
> Screen Time is not mounted. Ask the host to add the screentime mount to this group's config.

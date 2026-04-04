---
name: smartschool
description: Access the SmartSchool school portal — login, check grades, schedule, messages, and any other page. Handles reCAPTCHA automatically and persists session.
---

# SmartSchool Portal Integration

Use the `mcp__nanoclaw__smartschool_fetch` tool to access https://webtop.smartschool.co.il.

## First-time login

```
mcp__nanoclaw__smartschool_fetch(
  action="login",
  username="your_username",
  password="your_password",
  save_credentials=true
)
```

Set `save_credentials=true` to store credentials in the group folder — this allows the session to be automatically renewed when it expires (no re-login required).

The tool handles the reCAPTCHA v2 checkbox automatically using browser stealth settings.

## Fetching pages

After a successful login, fetch any page by path or URL:

```
mcp__nanoclaw__smartschool_fetch(action="fetch", url="/")
mcp__nanoclaw__smartschool_fetch(action="fetch", url="/grades")
mcp__nanoclaw__smartschool_fetch(action="fetch", url="/schedule")
mcp__nanoclaw__smartschool_fetch(action="fetch", url="/messages")
```

Returns `{ content, url, title }` where `content` is the full visible text of the page.

## Exploring the portal

If you're unsure which URLs to use, start with the homepage:

```
mcp__nanoclaw__smartschool_fetch(action="fetch", url="/")
```

The page text will contain navigation links and menu items. Use those paths for subsequent fetches.

## Session handling

- Session cookies are saved to `smartschool_session.json` in the group folder after every successful login or fetch.
- If you saved credentials (`save_credentials=true`), the session renews automatically when it expires.
- To force a re-login (e.g. after a password change), call the login action again.

## If reCAPTCHA fails

If the login reports a reCAPTCHA image challenge failure:
1. Ask the user if they have a 2captcha API key.
2. If yes, the key can be used to solve the challenge programmatically.
3. As a workaround, the user can also log in manually and export their session cookies.

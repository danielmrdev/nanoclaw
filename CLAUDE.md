# NanoClaw

Personal Claude assistant. See [README.md](README.md) for philosophy and setup. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions.

## Quick Context

Single Node.js process that connects to WhatsApp, routes messages to Claude Agent SDK running in containers (Linux VMs). Each group has isolated filesystem and memory.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/channels/whatsapp.ts` | WhatsApp connection, auth, send/receive |
| `src/ipc.ts` | IPC watcher and task processing |
| `src/router.ts` | Message formatting and outbound routing |
| `src/config.ts` | Trigger pattern, paths, intervals |
| `src/container-runner.ts` | Spawns agent containers with mounts |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/db.ts` | SQLite operations |
| `groups/{name}/CLAUDE.md` | Per-group memory (isolated) |
| `container/skills/agent-browser.md` | Browser automation tool (available to all agents via Bash) |

## Skills

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Container issues, logs, troubleshooting |

## Development

Run commands directly—don't tell the user to run them.

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
./container/build.sh # Rebuild agent container
```

Service management:
```bash
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
```

## Telegram Bot Commands

Commands are handled in `src/channels/telegram.ts`. There are two types:

**Direct handlers** (respond instantly without container, e.g. `/ping`, `/status`):
```typescript
this.bot.command('mycommand', (ctx) => { ctx.reply('...'); });
```

**Agent-routed commands** (need container/filesystem access, e.g. `/memory`):
```typescript
this.bot.command('mycommand', async (ctx) => {
  const chatJid = `tg:${ctx.chat.id}`;
  const group = this.opts.registeredGroups()[chatJid];
  if (!group || !ctx.message) return;
  this.opts.onMessage(chatJid, { ..., content: '/mycommand' });
});
```
Then intercept in `container/agent-runner/src/index.ts` before the `while(true)` loop:
```typescript
if (prompt.toLowerCase().includes('/mycommand')) { ...; return; }
```

**Important**: The `message:text` handler has `if (ctx.message.text.startsWith('/')) return` — unregistered slash commands are silently dropped. Always register a `bot.command()` handler.

**Telegram command names**: only `[a-z0-9_]` — no hyphens. Use underscores.

**To add to `/help` reply**: edit the string in `this.bot.command('help', ...)`.

**To register in Telegram's "/" menu**: add to `setMyCommands()` array (called in `connect()` before `bot.start()`).

## Container Build Cache

The container buildkit caches the build context aggressively. `--no-cache` alone does NOT invalidate COPY steps — the builder's volume retains stale files. To force a truly clean rebuild, prune the builder then re-run `./container/build.sh`.

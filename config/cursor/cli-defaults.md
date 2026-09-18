# Cursor CLI defaults (Remote Agents worker)

The worker passes these flags on every CLI run (see `apps/worker/src/cli-cursor-runtime.ts`):

```bash
cursor agent --sandbox disabled --force ...
```

Environment overrides:

| Variable | Default | Purpose |
|----------|---------|---------|
| `WORKER_SANDBOX` | `disabled` | Maps to `--sandbox disabled` |
| `WORKER_FORCE` | `1` | Passes `--force` on each run |
| `CURSOR_BIN` | `cursor` | CLI binary name |

Do **not** enable sandbox for remote agent slots unless you intentionally restrict filesystem access.

# Managed Browser — Python Backend

FastAPI backend for Managed Browser. It runs browser automation for agents with Camoufox Python and CloakBrowser, while preserving the useful parts of the legacy Node `camofox-browser` REST API.

## Layout

```text
/home/jul/tools/managed-browser/
├── server/                 # this Python backend
├── legacy/camofox-node/     # original Node server kept for compatibility/reference
└── plugins/                 # Managed Browser plugins/integrations
```

The live user systemd service is `camofox-browser.service` on port `9377` and should use:

```ini
WorkingDirectory=/home/jul/tools/managed-browser/server
ExecStart=/home/jul/venvs/cloverlabs-camoufox/bin/python3 server.py --port 9377
```

## Quick start

```bash
cd /home/jul/tools/managed-browser/server
python3 -m pip install -e ".[dev]"
python3 server.py --port 9377
```

## API

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Server health check, active sessions/tabs and engine status |
| `POST` | `/start` | Launch/reuse a browser session |
| `POST` | `/stop` | Stop a browser session |
| `GET` | `/tabs` | List active tabs |
| `POST` | `/tabs` | Create a new tab |
| `POST` | `/tabs/{tabId}/navigate` | Navigate to URL |
| `GET` | `/tabs/{tabId}/snapshot` | DOM/YAML snapshot with element refs |
| `POST` | `/tabs/{tabId}/click` | Click element by ref or selector |
| `POST` | `/tabs/{tabId}/type` | Type text into element by ref or selector |
| `POST` | `/tabs/{tabId}/press` | Press a keyboard key |
| `POST` | `/tabs/{tabId}/scroll` | Scroll the page |
| `GET` | `/tabs/{tabId}/screenshot` | Take a page screenshot |
| `POST` | `/managed/cli/open` | Managed profile open/navigation wrapper |
| `POST` | `/managed/cli/snapshot` | Managed DOM snapshot + refs |
| `POST` | `/managed/cli/act` | Execute a single replay action through the deterministic replay engine |
| `POST` | `/managed/cli/memory/*` | Persist, list, inspect/export, and replay managed flows |
| `POST` | `/flow/*` | Legacy-compatible flow endpoints backed by persistent memory |

## Example flow

```bash
# 1. Start browser
curl -X POST http://127.0.0.1:9377/start \
  -H "Content-Type: application/json" \
  -d '{"userId":"demo","engine":"camoufox-python"}'

# 2. Create tab
TAB=$(curl -s -X POST http://127.0.0.1:9377/tabs \
  -H "Content-Type: application/json" \
  -d '{"userId":"demo","engine":"camoufox-python"}' \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['tabId'])")

# 3. Navigate
curl -X POST "http://127.0.0.1:9377/tabs/$TAB/navigate" \
  -H "Content-Type: application/json" \
  -d '{"userId":"demo","engine":"camoufox-python","url":"https://example.com"}'

# 4. Snapshot
curl -s "http://127.0.0.1:9377/tabs/$TAB/snapshot?userId=demo&engine=camoufox-python"
```

## Engines

Supported engine names:

- `camoufox-python` / `camoufox` / `camoufox-146`
- `cloakbrowser` / `cloak`
- `camofox-node` is reserved for a legacy bridge

When using a non-default engine, pass `engine` on every tab/session request. Sessions are keyed by `engine:userId`, so omitting `engine` can create or target a different browser session.

## Snapshot format

The snapshot endpoints return a compact pipe-delimited view of the DOM tree:

```text
#1|body|body|page content|
  #2|h1|heading|title|
  #3|a|link|click here||||||e1
  #4|button|button|submit||||||e2
```

Each line: `{indent}#{index}|{tag}|{role}|{name}|{description}|{checked}|{value}|{keyShortcuts}|{expanded}|{ref}`.
Interactive elements get ref IDs (`e1`, `e2`, …) stored on the tab for click/type/replay.

## Development

```bash
cd /home/jul/tools/managed-browser/server
python -m compileall -q camofox tests/unit/test_persistence_memory.py
python -m pytest tests/unit -q
python -m pytest tests/integration/test_managed_memory_replay.py tests/integration/test_cloak_browser.py -q
```

## Config

Via environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `CAMOFOX_API_KEY` | (none) | API auth key |
| `HOST` | `0.0.0.0` | Bind address |
| `PORT` | `9377` | Default port when `--port` is omitted |
| `MANAGED_BROWSER_DEFAULT_ENGINE` | `camoufox-python` | Default engine |
| `CAMOFOX_PROFILE_DIR` | `~/.camofox/profiles` | Storage-state/profile root |
| `CLOAK_BROWSER_ENABLED` | `0` | Enable CloakBrowser engine |

## License

MIT — preserves compatibility with the original Node.js `camofox-browser` API where useful.

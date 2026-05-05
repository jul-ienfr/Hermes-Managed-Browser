# Managed Browser — Python Backend

Managed browser automation server with explicit multi-engine support. Camoufox Python is the default engine, CloakBrowser can be enabled with `CLOAK_BROWSER_ENABLED=1`, and the legacy Camofox Node server can remain separate.

## Quick start

```bash
# Install
pip install -e .

# Start server (default port 8090)
python server.py
```

## API

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Server health check |
| `POST` | `/start` | Launch a browser session |
| `POST` | `/stop` | Stop a browser session |
| `GET` | `/tabs` | List active tabs |
| `POST` | `/tabs` | Create a new tab |
| `POST` | `/tabs/{tabId}/navigate` | Navigate to URL |
| `GET` | `/tabs/{tabId}/snapshot` | DOM/YAML snapshot with element refs |
| `POST` | `/tabs/{tabId}/click` | Click element by ref (e.g. `e1`) |
| `POST` | `/tabs/{tabId}/type` | Type text into element by ref |
| `POST` | `/tabs/{tabId}/press` | Press a keyboard key |
| `POST` | `/tabs/{tabId}/scroll` | Scroll the page |
| `GET` | `/tabs/{tabId}/screenshot` | Take a page screenshot |
| `GET` | `/tabs/{tabId}/images` | List page images |

### Example flow

```bash
# 1. Start browser
curl -X POST http://localhost:8090/start \
  -H "Content-Type: application/json" \
  -d '{"userId":"demo","browser":"chromium","headless":true}'

# 2. Create tab
TAB=$(curl -s -X POST http://localhost:8090/tabs \
  -H "Content-Type: application/json" \
  -d '{"userId":"demo"}' | python3 -c "import sys,json; print(json.load(sys.stdin)['tabId'])")

# 3. Navigate
curl -X POST "http://localhost:8090/tabs/$TAB/navigate" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com"}'

# 4. Snapshot (get DOM with clickable element refs)
curl -s "http://localhost:8090/tabs/$TAB/snapshot"

# 5. Click element by ref
curl -X POST "http://localhost:8090/tabs/$TAB/click" \
  -H "Content-Type: application/json" \
  -d '{"ref":"e1","userId":"demo"}'
```

## Snapshot format

The `/snapshot` endpoint returns a YAML-compatible pipe-delimited view of the DOM tree:

```
#1|body|body|page content|
  #2|h1|heading|title|
  #3|a|link|click here|||e1
  #4|button|button|submit|||e2
```

Each line: `{indent}#{index}|{tag}|{role}|{name}|{description}|{checked}|{value}|{keyShortcuts}|{expanded}|{ref}`

- `role` is inferred from ARIA attributes or HTML semantics
- Interactive elements get ref IDs (`e1`, `e2`, …) for clicking/typing
- Snapshot can be paginated with `?offset=N` for large pages

## Development

```bash
# Install dev deps
pip install -e ".[dev]"

# Run tests
pytest

# Start with hot reload
python server.py --reload
```

## Config

Via environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `CAMOFOX_API_KEY` | (none) | API auth key |
| `HOST` | `0.0.0.0` | Bind address |
| `PORT` | `8090` | Port |
| `HEADLESS` | `auto` | Force headless mode |

## License

MIT — derived from [camofox-browser](https://github.com/daijro/camoufox) (MIT).

# Managed Browser

Managed Browser is a multi-engine browser automation project for AI agents. The active backend is the Python server in `server/`; the original Node Camofox implementation is kept under `legacy/camofox-node/` for compatibility and reference.

## Repository layout

```text
server/                         Python Managed Browser backend
plugins/hermes/managed-browser/ Hermes managed_browser_* tool integration
legacy/camofox-node/            Original Node Camofox server, kept as legacy
```

## Supported engines

The Python backend accepts explicit engine names on session and tab requests:

- `camoufox-python` / `camoufox` / `camoufox-146`
- `cloakbrowser` / `cloak`
- `camofox-node` is reserved for a future bridge to the legacy Node server

Sessions are keyed by `engine:userId`, so pass `engine` consistently when targeting a non-default browser.

## Python backend quick start

```bash
cd server
python3 -m pip install -e ".[dev]"
python3 server.py --port 9377
```

CloakBrowser example:

```bash
cd server
CLOAK_BROWSER_ENABLED=1 \
CLOAK_BROWSER_EXECUTABLE_PATH=/home/jul/.cloakbrowser/chromium-145.0.7632.159.7/chrome \
MANAGED_BROWSER_DEFAULT_ENGINE=camoufox-python \
python3 server.py --port 9377
```

Example API calls:

```bash
curl -X POST http://127.0.0.1:9377/start \
  -H 'content-type: application/json' \
  -d '{"userId":"cloak-smoke","engine":"cloakbrowser"}'

curl -X POST http://127.0.0.1:9377/tabs \
  -H 'content-type: application/json' \
  -d '{"userId":"cloak-smoke","engine":"cloakbrowser","url":"https://example.com/"}'
```

See `server/README.md` for backend API, configuration, development and test commands.

## Hermes plugin

The Hermes integration lives in `plugins/hermes/managed-browser/` and exposes `managed_browser_*` tools backed by the Python Managed Browser API.

## Legacy Node server

The original Camofox Node server lives in `legacy/camofox-node/`.

```bash
cd legacy/camofox-node
npm install
npm start
```

See `legacy/camofox-node/README.md` for legacy-specific usage. New work should prefer the Python backend unless it explicitly targets Node compatibility.

## License

MIT. The legacy Node implementation preserves the original Camofox Browser compatibility surface where useful.

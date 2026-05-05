# Legacy Camofox Node Server

This directory contains the original Node.js Camofox Browser server. It is kept for compatibility and reference while the active Managed Browser backend lives in `../../server`.

## Layout

```text
server.js                 Node REST server entrypoint
lib/                      Node implementation modules
plugins/                  Original OpenClaw plugins
scripts/                  Node package scripts
tests/                    Legacy Node test suite
```

## Quick start

Run Node commands from this directory:

```bash
npm install
npm start
# http://localhost:9377
```

## Tests

```bash
npm test
npm run test:e2e
npm run typecheck
```

Some tests start browsers or require local browser/cache setup. Prefer the Python backend in `../../server` for new Managed Browser development.

## Relationship to Managed Browser

The repository root is now organized around the Python Managed Browser backend:

```bash
cd ../../server
python3 -m pip install -e ".[dev]"
python3 server.py --port 9377
```

This legacy Node project should remain self-contained so old workflows can still be inspected or run without polluting the repository root.

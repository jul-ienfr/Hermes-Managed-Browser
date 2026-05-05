#!/usr/bin/env python3
"""Generate a valid WebGL fingerprint for a given OS.
Called as subprocess from the Node.js managed browser server.
Replaces the hardcoded ANGLE-based webglConfig that crashes on Linux."""

import json
import sys

# Import from the camoufox pythonlib (install: pip install camoufox)
try:
    from camoufox.webgl import sample_webgl
except ImportError:
    # Fallback: return a safe generic value if camoufox isn't installed
    print(json.dumps({"vendor": None, "renderer": None}))
    sys.exit(0)

OS_MAP = {
    'windows': 'win',
    'macos': 'mac',
    'linux': 'lin',
    'win': 'win',
    'mac': 'mac',
    'lin': 'lin',
}

def main():
    target_os = OS_MAP.get(sys.argv[1] if len(sys.argv) > 1 else 'win', 'win')
    try:
        result = sample_webgl(target_os)
        # result keys are "webGl:vendor" and "webGl:renderer" (CAMOU_CONFIG format)
        output = {
            "vendor": result.get("webGl:vendor") or result.get("vendor"),
            "renderer": result.get("webGl:renderer") or result.get("renderer"),
        }
        # Sanity check: both must be non-empty
        if not output["vendor"] or not output["renderer"]:
            raise ValueError(f"Empty vendor/renderer from sample_webgl('{target_os}'): {result}")
        print(json.dumps(output))
    except Exception as e:
        # Never crash the server — return null/null on error, Node.js will skip webgl
        print(json.dumps({"vendor": None, "renderer": None, "_error": str(e)}))

if __name__ == '__main__':
    main()

# Leboncoin Local Ollama Message Agent Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Build a supervised Leboncoin message assistant that uses the normal browser session only, analyzes incoming buyer messages with a local Ollama model, drafts or sends only safe/obvious replies under learned rules, and asks Julien when uncertain.

**Architecture:** Keep browser interaction separate from decision-making. Camofox/noVNC reads Leboncoin messages through the visible authenticated browser profile. A local policy engine classifies each conversation, calls Ollama for intent/risk/draft JSON, applies hard safety rules, then either creates a draft, sends an approved auto-reply, or asks Julien for guidance. Julien’s corrections become explicit local rules for future decisions. For difficult/ambiguous cases only, the policy may escalate to an online Hermes/Proxypal model such as `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, or `gpt-5.3-codex`; local Ollama remains the default path.

**Tech Stack:** Python 3 for orchestration under `~/.hermes/plugins/browser-memory`, Camofox HTTP browser endpoints on `127.0.0.1:9377`, Ollama HTTP API on `127.0.0.1:11434`, optional Hermes/Proxypal online model fallback on `http://192.168.31.59:8317/v1`, local JSON/JSONL memory files, pytest.

---

## Verified Context

- Camofox browser repo exists: `/home/jul/tools/camofox-browser`.
- Browser-memory plugin folder exists: `/home/jul/.hermes/plugins/browser-memory`.
- Leboncoin browser handling must use browser/VNC only, no Leboncoin API calls.
- Manual Leboncoin profile convention exists:
  - `userId="leboncoin-manual"`
  - `sessionKey="manual-login"`
  - messages URL: `https://www.leboncoin.fr/messages`
- Ollama is installed at `/usr/local/bin/ollama`.
- Ollama service is active on this machine.
- GPU available: NVIDIA RTX 3060 12 GB.
- Existing local models include at least `qwen3:14b` and `nomic-embed-text`.
- Active Hermes/Proxypal online model config was verified from `/home/jul/.hermes/hermes-agent`:
  - provider: `custom`
  - default model: `gpt-5.5`
  - base URL: `http://192.168.31.59:8317/v1`
  - API mode: `chat_completions`
- Live configured online model catalog currently includes:
  - `gpt-5.5`
  - `gpt-5.4`
  - `gpt-5.4-mini`
  - `gpt-5.3-codex`
  - `gpt-5.3-codex-spark`
  - `gpt-5.2`
  - `gemini-3.1-pro-high`, `gemini-3.1-pro-low`, `gemini-3-flash`, `gemini-3.1-flash-lite`
  - `claude-opus-4-6-thinking`, `claude-sonnet-4-6`
- Desired product mode from Julien:
  - analyze incoming Leboncoin messages;
  - answer automatically only when obvious under learned rules;
  - ask Julien when uncertain;
  - learn from Julien’s corrections over time.

---

## Non-Negotiable Safety Rules

1. Use browser endpoints only for Leboncoin UI. No hidden/private Leboncoin API calls.
2. Never bypass captcha or human verification. Stop and ask Julien.
3. Never click buyer-provided links.
4. Never share exact address, phone number, payment info, or personal data without explicit rule/confirmation.
5. Never confirm a firm appointment unless a rule exists for allowed time windows.
6. Never accept a price below known minimum.
7. Never accept payment/shipping terms outside learned rules.
8. Never send a message when model output is invalid JSON or confidence is below threshold.
9. Every sent message must be logged locally with reason, policy version, and source conversation id.
10. Default mode at first is **draft/ask**, not silent full auto-send.

---

## Target Decision Modes

```text
READ_ONLY
  Read messages, summarize, no draft/send.

DRAFT_ONLY
  Create a proposed reply locally, ask Julien before sending.

SUPERVISED_AUTO
  Auto-send only for safe obvious cases covered by policy.
  Ask Julien for all unknown/sensitive cases.

FULL_AUTO_SAFE_SET
  Same as supervised auto, but with broader learned rules after enough approvals.
```

Initial mode: `DRAFT_ONLY` or `SUPERVISED_AUTO` with a tiny safe set.

---

## Data Files

Create these under:

`/home/jul/.hermes/plugins/browser-memory/leboncoin_agent/`

```text
policy.json
conversation_state.json
approvals.jsonl
sent_messages.jsonl
learning_rules.jsonl
pending_questions.jsonl
```

Recommended initial `policy.json`:

```json
{
  "version": 1,
  "mode": "DRAFT_ONLY",
  "model": "qwen3:14b",
  "online_fallback_enabled": false,
  "online_fallback_provider": "proxypal-local",
  "online_fallback_models": ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex"],
  "online_fallback_triggers": ["invalid_local_json", "low_confidence_sensitive", "ambiguous_high_value", "scam_uncertain"],
  "confidence_threshold_auto": 0.85,
  "confidence_threshold_draft": 0.55,
  "default_location_general": "Bogève",
  "allow_exact_address": false,
  "allow_phone": false,
  "allow_external_links": false,
  "allow_buyer_links": false,
  "shipping_default": "ask_julien",
  "appointment_default": "ask_julien",
  "negotiation_default": "ask_julien",
  "safe_auto_replies": {
    "availability": "Bonjour, oui c’est toujours disponible.",
    "general_location": "Bonjour, je suis à Bogève."
  },
  "always_ask_intents": [
    "price_negotiation",
    "appointment",
    "shipping",
    "payment",
    "exact_address",
    "phone_request",
    "suspicious",
    "other"
  ]
}
```

---

## Phase 1 — Local Policy and Rule Store

### Task 1: Create package skeleton

**Objective:** Add an isolated local Leboncoin assistant package without touching Camofox core.

**Files:**
- Create: `/home/jul/.hermes/plugins/browser-memory/leboncoin_agent/__init__.py`
- Create: `/home/jul/.hermes/plugins/browser-memory/leboncoin_agent/policy.py`
- Create: `/home/jul/.hermes/plugins/browser-memory/tests/test_leboncoin_policy.py`

**Step 1: Write failing test**

```python
from pathlib import Path
from leboncoin_agent.policy import load_policy, default_policy


def test_default_policy_is_safe():
    policy = default_policy()
    assert policy["mode"] == "DRAFT_ONLY"
    assert policy["allow_exact_address"] is False
    assert policy["allow_phone"] is False
    assert "availability" in policy["safe_auto_replies"]


def test_load_policy_creates_default(tmp_path):
    path = tmp_path / "policy.json"
    policy = load_policy(path)
    assert path.exists()
    assert policy["mode"] == "DRAFT_ONLY"
```

**Step 2: Run test**

```bash
cd /home/jul/.hermes/plugins/browser-memory
python3 -m pytest tests/test_leboncoin_policy.py -q
```

Expected: FAIL because module does not exist.

**Step 3: Implement minimal policy module**

```python
import json
from pathlib import Path


def default_policy():
    return {
        "version": 1,
        "mode": "DRAFT_ONLY",
        "model": "qwen3:14b",
        "online_fallback_enabled": False,
        "online_fallback_provider": "proxypal-local",
        "online_fallback_models": ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex"],
        "online_fallback_triggers": ["invalid_local_json", "low_confidence_sensitive", "ambiguous_high_value", "scam_uncertain"],
        "confidence_threshold_auto": 0.85,
        "confidence_threshold_draft": 0.55,
        "default_location_general": "Bogève",
        "allow_exact_address": False,
        "allow_phone": False,
        "allow_external_links": False,
        "allow_buyer_links": False,
        "shipping_default": "ask_julien",
        "appointment_default": "ask_julien",
        "negotiation_default": "ask_julien",
        "safe_auto_replies": {
            "availability": "Bonjour, oui c’est toujours disponible.",
            "general_location": "Bonjour, je suis à Bogève.",
        },
        "always_ask_intents": [
            "price_negotiation", "appointment", "shipping", "payment",
            "exact_address", "phone_request", "suspicious", "other",
        ],
    }


def load_policy(path):
    path = Path(path)
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(default_policy(), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return json.loads(path.read_text(encoding="utf-8"))
```

**Step 4: Run test**

```bash
cd /home/jul/.hermes/plugins/browser-memory
PYTHONPATH=. python3 -m pytest tests/test_leboncoin_policy.py -q
```

Expected: PASS.

**Step 5: Commit if repository-managed**

If this plugin folder is a git repo:

```bash
git add leboncoin_agent tests/test_leboncoin_policy.py
git commit -m "feat: add safe Leboncoin message policy store"
```

---

### Task 2: Add append-only local logs

**Objective:** Persist decisions, approvals, sent messages, and learned rules.

**Files:**
- Create: `/home/jul/.hermes/plugins/browser-memory/leboncoin_agent/store.py`
- Create/modify: `/home/jul/.hermes/plugins/browser-memory/tests/test_leboncoin_store.py`

**Step 1: Write failing test**

```python
from leboncoin_agent.store import append_jsonl, read_jsonl


def test_append_and_read_jsonl(tmp_path):
    path = tmp_path / "events.jsonl"
    append_jsonl(path, {"type": "decision", "ok": True})
    append_jsonl(path, {"type": "sent", "ok": True})
    rows = read_jsonl(path)
    assert [row["type"] for row in rows] == ["decision", "sent"]
    assert "ts" in rows[0]
```

**Step 2: Implement**

```python
import json
from datetime import datetime, timezone
from pathlib import Path


def utc_now_iso():
    return datetime.now(timezone.utc).isoformat()


def append_jsonl(path, record):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    enriched = {"ts": utc_now_iso(), **record}
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(enriched, ensure_ascii=False, sort_keys=True) + "\n")
    return enriched


def read_jsonl(path):
    path = Path(path)
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
```

**Step 3: Run tests**

```bash
cd /home/jul/.hermes/plugins/browser-memory
PYTHONPATH=. python3 -m pytest tests/test_leboncoin_store.py tests/test_leboncoin_policy.py -q
```

Expected: PASS.

---

## Phase 2 — Ollama Classifier

### Task 3: Add Ollama client with JSON parsing

**Objective:** Call local Ollama and enforce valid JSON output.

**Files:**
- Create: `/home/jul/.hermes/plugins/browser-memory/leboncoin_agent/ollama_client.py`
- Create: `/home/jul/.hermes/plugins/browser-memory/tests/test_leboncoin_ollama_client.py`

**Step 1: Write tests with mocked transport**

```python
import json
from leboncoin_agent.ollama_client import parse_json_response, build_prompt


def test_parse_json_response_accepts_raw_json():
    payload = '{"intent":"availability","confidence":0.9,"risk":"low","draft_reply":"Bonjour"}'
    parsed = parse_json_response(payload)
    assert parsed["intent"] == "availability"


def test_parse_json_response_extracts_code_fence():
    payload = '```json\n{"intent":"other","confidence":0.4,"risk":"medium"}\n```'
    parsed = parse_json_response(payload)
    assert parsed["intent"] == "other"


def test_build_prompt_mentions_json_only():
    prompt = build_prompt({"message": "Bonjour dispo ?", "ad_title": "Vélo"}, {"mode": "DRAFT_ONLY"})
    assert "JSON" in prompt
    assert "Bonjour dispo ?" in prompt
```

**Step 2: Implement**

Use only stdlib (`urllib.request`) to avoid new dependencies:

```python
import json
import re
import urllib.request


OLLAMA_URL = "http://127.0.0.1:11434/api/generate"


def build_prompt(message_context, policy):
    return f"""
Tu es un assistant local pour gérer des messages acheteurs Leboncoin en français.
Réponds UNIQUEMENT en JSON valide, sans markdown.

Objectif: classifier l'intention, le risque, et proposer une réponse courte.
N'autorise pas l'envoi automatique si: prix, rendez-vous ferme, paiement, téléphone, adresse exacte, livraison inconnue, lien externe, suspicion d'arnaque.

Politique:
{json.dumps(policy, ensure_ascii=False)}

Message/contexte:
{json.dumps(message_context, ensure_ascii=False)}

Schéma JSON obligatoire:
{{
  "intent": "availability|general_location|price_negotiation|appointment|shipping|payment|exact_address|phone_request|suspicious|other",
  "confidence": 0.0,
  "risk": "low|medium|high",
  "can_auto_reply": false,
  "needs_julien": true,
  "reason": "raison courte",
  "draft_reply": "réponse proposée ou chaîne vide"
}}
""".strip()


def parse_json_response(text):
    text = text.strip()
    fence = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.S)
    if fence:
        text = fence.group(1)
    else:
        match = re.search(r"\{.*\}", text, re.S)
        if match:
            text = match.group(0)
    return json.loads(text)


def generate_json(model, prompt, timeout=60):
    body = json.dumps({
        "model": model,
        "prompt": prompt,
        "stream": False,
        "options": {"temperature": 0.1, "num_predict": 300},
    }).encode("utf-8")
    req = urllib.request.Request(OLLAMA_URL, data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        payload = json.loads(resp.read().decode("utf-8"))
    return parse_json_response(payload.get("response", ""))
```

**Step 3: Run tests**

```bash
cd /home/jul/.hermes/plugins/browser-memory
PYTHONPATH=. python3 -m pytest tests/test_leboncoin_ollama_client.py -q
```

Expected: PASS.

---

### Task 4: Add live Ollama smoke command

**Objective:** Verify the local model can classify a simple message.

**Files:**
- Create: `/home/jul/.hermes/plugins/browser-memory/leboncoin_agent/cli.py`
- Test manually; avoid requiring live Ollama in unit tests.

**Step 1: Implement CLI smoke**

```python
import argparse
import json
from pathlib import Path
from .ollama_client import build_prompt, generate_json
from .policy import load_policy

DEFAULT_ROOT = Path.home() / ".hermes" / "plugins" / "browser-memory" / "leboncoin_agent"


def cmd_classify(args):
    policy = load_policy(DEFAULT_ROOT / "policy.json")
    context = {"message": args.message, "ad_title": args.ad_title or ""}
    result = generate_json(policy.get("model", "qwen3:14b"), build_prompt(context, policy))
    print(json.dumps(result, ensure_ascii=False, indent=2))


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(required=True)
    p = sub.add_parser("classify")
    p.add_argument("message")
    p.add_argument("--ad-title", default="")
    p.set_defaults(func=cmd_classify)
    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
```

**Step 2: Run live smoke**

```bash
cd /home/jul/.hermes/plugins/browser-memory
PYTHONPATH=. python3 -m leboncoin_agent.cli classify "Bonjour, c'est toujours disponible ?" --ad-title "Objet test"
```

Expected JSON:

```json
{
  "intent": "availability",
  "confidence": 0.8,
  "risk": "low",
  "can_auto_reply": true,
  "needs_julien": false,
  "draft_reply": "Bonjour, oui c’est toujours disponible."
}
```

If `qwen3:14b` is too slow or unreliable, test a smaller instruct model via Ollama, for example `qwen2.5:7b-instruct` or equivalent already available locally.

---

## Phase 2B — Optional Online Escalation

### Task 4B: Add online model fallback client

**Objective:** Allow the assistant to escalate genuinely ambiguous/high-stakes analysis to a configured online model, while keeping Ollama local as the default and preventing online fallback from sending messages by itself.

**Files:**
- Create: `/home/jul/.hermes/plugins/browser-memory/leboncoin_agent/online_client.py`
- Create: `/home/jul/.hermes/plugins/browser-memory/tests/test_leboncoin_online_client.py`

**Important policy:** Online fallback may improve classification/draft quality, but it must not bypass the deterministic safety gate. Even `gpt-5.5` can only produce a recommendation; the local `decision.py` still decides `send`, `draft`, or `ask_julien`.

**Step 1: Write tests with mocked transport**

```python
from leboncoin_agent.online_client import choose_online_model, should_escalate_online


def test_choose_online_model_prefers_first_available():
    policy = {"online_fallback_models": ["gpt-5.5", "gpt-5.4-mini"]}
    assert choose_online_model(policy, available_models=["gpt-5.4-mini", "gpt-5.5"]) == "gpt-5.5"


def test_should_escalate_only_when_enabled_and_trigger_matches():
    policy = {
        "online_fallback_enabled": True,
        "online_fallback_triggers": ["invalid_local_json", "scam_uncertain"],
    }
    assert should_escalate_online("scam_uncertain", policy) is True
    assert should_escalate_online("routine_availability", policy) is False


def test_should_not_escalate_when_disabled():
    policy = {"online_fallback_enabled": False, "online_fallback_triggers": ["scam_uncertain"]}
    assert should_escalate_online("scam_uncertain", policy) is False
```

**Step 2: Implement minimal client**

Use OpenAI-compatible `/chat/completions` on the verified Proxypal endpoint. Read the API key/base URL from Hermes config when possible, not from hardcoded secrets. Never write secrets to logs.

```python
import json
import urllib.request


def choose_online_model(policy, available_models=None):
    preferred = policy.get("online_fallback_models") or ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini"]
    if not available_models:
        return preferred[0]
    for model in preferred:
        if model in available_models:
            return model
    return preferred[0]


def should_escalate_online(trigger, policy):
    return bool(policy.get("online_fallback_enabled")) and trigger in set(policy.get("online_fallback_triggers", []))


def chat_completion_json(base_url, api_key, model, messages, timeout=90):
    body = json.dumps({
        "model": model,
        "messages": messages,
        "temperature": 0,
        "max_tokens": 500,
    }).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    req = urllib.request.Request(base_url.rstrip("/") + "/chat/completions", data=body, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        payload = json.loads(resp.read().decode("utf-8"))
    return payload["choices"][0]["message"]["content"]
```

**Step 3: Add escalation flow to classifier**

In the classification command:
1. Try Ollama first.
2. If Ollama returns invalid JSON, low confidence on a sensitive intent, or scam uncertainty, compute a trigger such as `invalid_local_json` or `scam_uncertain`.
3. If `online_fallback_enabled=true`, call online fallback with the same strict JSON schema.
4. Mark result metadata:

```json
{
  "model_source": "online",
  "model": "gpt-5.5",
  "fallback_trigger": "scam_uncertain"
}
```

5. Pass the final model result through the same deterministic `decide_action(...)` gate.

**Step 4: Verification command**

Before enabling, verify configured models again from the live Hermes config:

```bash
cd /home/jul/.hermes/hermes-agent
source venv/bin/activate
python - <<'PY'
import json, urllib.request
from hermes_cli.config import load_config
cfg = load_config()
model = cfg.get('model', {})
base = (model.get('base_url') or '').rstrip('/')
key = model.get('api_key') or ''
req = urllib.request.Request(base + '/models', headers={'Authorization': f'Bearer {key}'} if key else {})
with urllib.request.urlopen(req, timeout=10) as resp:
    data = json.loads(resp.read().decode('utf-8', errors='replace'))
print('\n'.join(m['id'] for m in data.get('data', []) if isinstance(m, dict) and m.get('id')))
PY
```

Expected to include at least one of:
- `gpt-5.5`
- `gpt-5.4`
- `gpt-5.4-mini`
- `gpt-5.3-codex`

**Step 5: Safety verification**

Add tests proving:
- online fallback disabled → no online call;
- online fallback result with `intent=price_negotiation` still returns `ask_julien`;
- online fallback result with `risk=medium/high` still returns `ask_julien`;
- online fallback never directly invokes browser send.

---

## Phase 3 — Deterministic Safety Gate

### Task 5: Add decision gate

**Objective:** Make final send/ask decision with deterministic policy, not model alone.

**Files:**
- Create: `/home/jul/.hermes/plugins/browser-memory/leboncoin_agent/decision.py`
- Create: `/home/jul/.hermes/plugins/browser-memory/tests/test_leboncoin_decision.py`

**Step 1: Write failing tests**

```python
from leboncoin_agent.decision import decide_action
from leboncoin_agent.policy import default_policy


def test_availability_can_auto_reply_in_supervised_mode():
    policy = default_policy()
    policy["mode"] = "SUPERVISED_AUTO"
    model = {"intent": "availability", "confidence": 0.93, "risk": "low", "draft_reply": "Bonjour, oui c’est toujours disponible."}
    decision = decide_action(model, policy)
    assert decision["action"] == "send"


def test_price_negotiation_always_asks():
    policy = default_policy()
    policy["mode"] = "SUPERVISED_AUTO"
    model = {"intent": "price_negotiation", "confidence": 0.99, "risk": "low", "draft_reply": "OK pour 20€."}
    decision = decide_action(model, policy)
    assert decision["action"] == "ask_julien"


def test_draft_only_never_sends():
    policy = default_policy()
    model = {"intent": "availability", "confidence": 0.99, "risk": "low", "draft_reply": "Bonjour"}
    decision = decide_action(model, policy)
    assert decision["action"] == "draft"
```

**Step 2: Implement**

```python
def decide_action(model_result, policy):
    intent = model_result.get("intent", "other")
    confidence = float(model_result.get("confidence", 0) or 0)
    risk = model_result.get("risk", "high")
    draft = (model_result.get("draft_reply") or "").strip()

    if not draft:
        return {"action": "ask_julien", "reason": "empty_draft"}
    if risk != "low":
        return {"action": "ask_julien", "reason": f"risk_{risk}", "draft_reply": draft}
    if intent in policy.get("always_ask_intents", []):
        return {"action": "ask_julien", "reason": f"intent_requires_approval:{intent}", "draft_reply": draft}

    mode = policy.get("mode", "DRAFT_ONLY")
    if mode == "READ_ONLY":
        return {"action": "none", "reason": "read_only", "draft_reply": draft}
    if mode == "DRAFT_ONLY":
        return {"action": "draft", "reason": "draft_only", "draft_reply": draft}

    threshold = float(policy.get("confidence_threshold_auto", 0.85))
    if mode in {"SUPERVISED_AUTO", "FULL_AUTO_SAFE_SET"} and confidence >= threshold:
        if intent in policy.get("safe_auto_replies", {}):
            return {"action": "send", "reason": "safe_auto_reply", "draft_reply": policy["safe_auto_replies"][intent]}

    return {"action": "ask_julien", "reason": "below_threshold_or_not_safe", "draft_reply": draft}
```

**Step 3: Run tests**

```bash
cd /home/jul/.hermes/plugins/browser-memory
PYTHONPATH=. python3 -m pytest tests/test_leboncoin_decision.py -q
```

Expected: PASS.

---

## Phase 4 — Browser Message Extraction

### Task 6: Add browser adapter wrapper

**Objective:** Reuse Camofox browser endpoints safely from Python.

**Files:**
- Create: `/home/jul/.hermes/plugins/browser-memory/leboncoin_agent/browser.py`
- Create: `/home/jul/.hermes/plugins/browser-memory/tests/test_leboncoin_browser.py`

**Step 1: Write tests with mocked transport**

```python
from leboncoin_agent.browser import CamofoxClient


class FakeTransport:
    def __init__(self):
        self.calls = []
    def request_json(self, method, path, body=None):
        self.calls.append((method, path, body))
        if path.startswith('/tabs?'):
            return {"tabs": [{"tabId": "t1", "url": "https://www.leboncoin.fr/messages"}]}
        return {"ok": True, "tabId": "t1", "snapshot": "Messages"}


def test_reuses_existing_manual_tab():
    client = CamofoxClient(transport=FakeTransport())
    tab_id = client.ensure_messages_tab()
    assert tab_id == "t1"
```

**Step 2: Implement client**

```python
import json
import urllib.parse
import urllib.request


class UrllibTransport:
    def __init__(self, base_url="http://127.0.0.1:9377"):
        self.base_url = base_url.rstrip('/')

    def request_json(self, method, path, body=None, timeout=60):
        data = None if body is None else json.dumps(body).encode('utf-8')
        req = urllib.request.Request(self.base_url + path, data=data, method=method, headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode('utf-8'))


class CamofoxClient:
    def __init__(self, user_id="leboncoin-manual", session_key="manual-login", transport=None):
        self.user_id = user_id
        self.session_key = session_key
        self.transport = transport or UrllibTransport()

    def ensure_messages_tab(self):
        qs = urllib.parse.urlencode({"userId": self.user_id})
        tabs = self.transport.request_json("GET", f"/tabs?{qs}").get("tabs", [])
        for tab in tabs:
            if "leboncoin.fr" in tab.get("url", ""):
                return tab.get("tabId") or tab.get("targetId")
        body = {"userId": self.user_id, "sessionKey": self.session_key, "url": "https://www.leboncoin.fr/messages"}
        created = self.transport.request_json("POST", "/tabs/open", body)
        return created.get("tabId") or created.get("targetId")

    def navigate_messages(self, tab_id):
        return self.transport.request_json("POST", f"/tabs/{tab_id}/navigate", {
            "userId": self.user_id,
            "sessionKey": self.session_key,
            "url": "https://www.leboncoin.fr/messages",
        })

    def snapshot(self, tab_id):
        qs = urllib.parse.urlencode({"userId": self.user_id})
        return self.transport.request_json("GET", f"/tabs/{tab_id}/snapshot?{qs}")
```

**Step 3: Run tests**

```bash
cd /home/jul/.hermes/plugins/browser-memory
PYTHONPATH=. python3 -m pytest tests/test_leboncoin_browser.py -q
```

Expected: PASS.

---

### Task 7: Parse conversation list from browser snapshot/evaluate

**Objective:** Extract visible conversations compactly.

**Files:**
- Create: `/home/jul/.hermes/plugins/browser-memory/leboncoin_agent/messages.py`
- Create: `/home/jul/.hermes/plugins/browser-memory/tests/test_leboncoin_messages.py`

**Step 1: Start with snapshot text parser**

Test should accept a simple snapshot string and return conversation candidates. Keep it conservative; later use DOM evaluate for richer extraction.

```python
from leboncoin_agent.messages import extract_message_summary


def test_extract_message_summary_from_snapshot_text():
    snapshot = """
    Messages
    Jean Dupont
    Vélo enfant
    Bonjour, est-ce toujours disponible ?
    Aujourd’hui
    """
    summary = extract_message_summary(snapshot)
    assert "Jean Dupont" in summary["raw_text"]
    assert "toujours disponible" in summary["raw_text"]
```

**Step 2: Implement minimal extraction**

```python
def extract_message_summary(snapshot_payload):
    if isinstance(snapshot_payload, dict):
        text = snapshot_payload.get("snapshot") or snapshot_payload.get("text") or str(snapshot_payload)
    else:
        text = str(snapshot_payload)
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    return {
        "raw_text": "\n".join(lines[:200]),
        "lines": lines[:200],
    }
```

**Step 3: Add future DOM evaluate path**

Later, add `CamofoxClient.evaluate(tab_id, expression)` and use selectors:

```js
Array.from(document.querySelectorAll('a[href*="/messages/id/"]')).slice(0, 20).map((a) => ({
  href: a.href,
  text: a.innerText,
  unread: Boolean(a.querySelector('[aria-label*="non lu"], [data-qa-id*="unread"]'))
}))
```

**Step 4: Run tests**

```bash
cd /home/jul/.hermes/plugins/browser-memory
PYTHONPATH=. python3 -m pytest tests/test_leboncoin_messages.py -q
```

Expected: PASS.

---

## Phase 5 — Analyze One Conversation

### Task 8: Build `analyze` command

**Objective:** Navigate to messages, extract summary, classify with Ollama, and output decision without sending.

**Files:**
- Modify: `/home/jul/.hermes/plugins/browser-memory/leboncoin_agent/cli.py`
- Test manually live.

**Step 1: Add command shape**

```bash
PYTHONPATH=. python3 -m leboncoin_agent.cli analyze-once
```

Expected output JSON:

```json
{
  "ok": true,
  "message_context": {...},
  "model_result": {...},
  "decision": {
    "action": "draft|ask_julien|send|none",
    "reason": "...",
    "draft_reply": "..."
  }
}
```

**Step 2: Implement command**

- Load policy.
- Ensure messages tab.
- Navigate to `/messages`.
- Snapshot.
- Extract summary.
- Call Ollama.
- Apply decision gate.
- Log to `approvals.jsonl` or `pending_questions.jsonl` if needs Julien.

**Step 3: Run live, read-only**

```bash
cd /home/jul/.hermes/plugins/browser-memory
PYTHONPATH=. python3 -m leboncoin_agent.cli analyze-once
```

Expected: it reads the current page and outputs a decision. It must not send anything.

---

## Phase 6 — Drafting and Sending via Browser

### Task 9: Add safe draft writer

**Objective:** Type a proposed reply into the current conversation field, but do not send.

**Files:**
- Modify: `/home/jul/.hermes/plugins/browser-memory/leboncoin_agent/browser.py`
- Test with mocked transport.

**Implementation rule:** Only type into `textarea[aria-label="Ecrire mon message"]` or the ref found from snapshot. Never click `[data-qa-id="message-send"]` in this task.

Add methods:

```python
def type_reply_draft(self, tab_id, text):
    return self.transport.request_json("POST", f"/tabs/{tab_id}/type", {
        "userId": self.user_id,
        "selector": 'textarea[aria-label="Ecrire mon message"]',
        "text": text,
    })
```

Test ensures endpoint is `/type`, not `/click` send.

---

### Task 10: Add send function with explicit guard token

**Objective:** Make sending impossible unless caller passes an explicit approved decision id.

**Files:**
- Modify: `browser.py`
- Modify: `cli.py`
- Test: `tests/test_leboncoin_send_guard.py`

**Rule:** Sending requires:

- policy mode allows send;
- decision action is `send`;
- decision has `approved=True` or auto-safe reason;
- message text exactly matches the approved draft;
- CLI called with `--send-approved <decision_id>`.

Browser method:

```python
def click_send(self, tab_id):
    return self.transport.request_json("POST", f"/tabs/{tab_id}/click", {
        "userId": self.user_id,
        "selector": '[data-qa-id="message-send"]',
    })
```

Never expose a generic “send whatever is typed” command.

---

## Phase 7 — Ask Julien and Learn

### Task 11: Generate questions for Julien

**Objective:** When uncertain, produce a concise question with recommended options.

**Files:**
- Create: `leboncoin_agent/questions.py`
- Test: `tests/test_leboncoin_questions.py`

Example output:

```json
{
  "conversation_id": "...",
  "question": "Acheteur demande une baisse à 40 € pour l’annonce Vélo. Tu acceptes ?",
  "choices": ["Accepter 40 €", "Refuser poliment", "Proposer 45 €", "Autre"]
}
```

Keep this local at first in `pending_questions.jsonl`. Platform delivery can be added later with cron/tooling.

---

### Task 12: Add learning rule ingestion

**Objective:** Convert Julien’s answer/correction into explicit durable rules.

**Files:**
- Create: `leboncoin_agent/learning.py`
- Test: `tests/test_leboncoin_learning.py`

Rule examples:

```json
{"scope":"global","if_intent":"shipping","action":"ask_julien","note":"Julien has not defined shipping policy yet"}
{"scope":"ad_title_contains:Vélo","if_intent":"price_negotiation","min_price":40,"counter_offer":45}
{"scope":"global","if_intent":"phone_request","action":"refuse","reply":"Je préfère rester sur la messagerie Leboncoin pour le moment."}
```

Tests:
- applying a global phone rule blocks phone sharing;
- applying an ad-specific min price rule marks low offer as ask/counter-offer.

---

## Phase 8 — Polling Job

### Task 13: Add read-only polling command

**Objective:** Check for new messages periodically without sending.

**Files:**
- Modify: `cli.py`
- Modify: `store.py`
- Test: unit test for deduping.

Command:

```bash
PYTHONPATH=. python3 -m leboncoin_agent.cli poll-once --mode read-only
```

Behavior:
- load previous `conversation_state.json`;
- extract visible conversation ids/snippets;
- only analyze new or changed conversations;
- write decisions/questions to logs.

---

### Task 14: Schedule polling after manual validation

**Objective:** Create a cron job only after live read-only and draft-only tests pass.

Use Hermes cron with a self-contained prompt, or a local systemd timer if preferred. Initial cadence: every 10–15 minutes.

Safety defaults:
- first 24–48h: `DRAFT_ONLY`;
- then enable `SUPERVISED_AUTO` only for availability/general location if Julien confirms.

Cron prompt should be self-contained:

```text
Run Leboncoin local message poll once using browser-only Camofox profile leboncoin-manual and Ollama local policy. Do not use Leboncoin APIs. Do not send messages unless policy mode is SUPERVISED_AUTO and deterministic decision action is send. Stop on captcha/human verification. Report pending questions to the origin chat.
```

---

## Phase 9 — Model Selection and Performance

### Task 15: Benchmark local models for this task

**Objective:** Choose the fastest reliable local model on RTX 3060 12GB.

Test candidates:
- `qwen3:14b` already installed, higher quality, may be slower.
- a smaller Qwen/Mistral 7B instruct model if installed or pulled later.

Benchmark command:

```bash
for model in qwen3:14b; do
  time curl -sS http://127.0.0.1:11434/api/generate \
    -H 'Content-Type: application/json' \
    -d "{\"model\":\"$model\",\"prompt\":\"Réponds en JSON: classifie ce message Leboncoin: Bonjour disponible ?\",\"stream\":false,\"options\":{\"temperature\":0.1,\"num_predict\":120}}" \
    >/tmp/ollama-$model.json
  python3 -m json.tool /tmp/ollama-$model.json >/dev/null || echo "bad json envelope"
done
```

Decision criteria:
- valid JSON rate;
- latency;
- French quality;
- conservative safety decisions.

If `qwen3:14b` is too slow, use a 7B/8B instruct model for routine classification and reserve 14B for ambiguous cases.

### Task 15B: Benchmark online escalation models

**Objective:** Verify which configured online model is available and worth using as expensive fallback.

Online candidates verified in the live catalog:
- highest quality default: `gpt-5.5`;
- strong fallback: `gpt-5.4`;
- cheaper/faster fallback: `gpt-5.4-mini`;
- coding/reasoning variants if useful for structured analysis: `gpt-5.3-codex`, `gpt-5.3-codex-spark`.

Benchmark criteria:
- strict JSON validity;
- conservative safety judgement;
- quality on scam/ambiguous negotiation cases;
- latency;
- cost/quota impact.

Rule of thumb:
- routine messages → Ollama local;
- local JSON failure → retry local once, then `gpt-5.4-mini` if enabled;
- scam/ambiguous/high-value issue → `gpt-5.5` if enabled;
- online model still cannot directly approve sending sensitive replies.

---

## Phase 10 — End-to-End Validation

### Task 16: Dry run on current Leboncoin messages

**Objective:** Analyze real inbox without sending.

Commands:

```bash
cd /home/jul/.hermes/plugins/browser-memory
PYTHONPATH=. python3 -m leboncoin_agent.cli analyze-once
PYTHONPATH=. python3 -m leboncoin_agent.cli poll-once --mode read-only
```

Verify:
- no message sent;
- no hidden API call;
- no captcha bypass;
- output is clear;
- pending questions are sensible.

---

### Task 17: Draft-only live test

**Objective:** Type one safe draft into a conversation field but do not send.

Procedure:
1. Pick a non-sensitive test conversation.
2. Run analysis.
3. Confirm decision action is `draft`.
4. Type draft into field.
5. Visually verify in noVNC.
6. Manually clear draft or send only after Julien says so.

---

### Task 18: Enable minimal supervised auto-send

**Objective:** Only after Julien approves behavior, enable auto-send for tiny safe set.

Policy change:

```json
"mode": "SUPERVISED_AUTO",
"safe_auto_replies": {
  "availability": "Bonjour, oui c’est toujours disponible.",
  "general_location": "Bonjour, je suis à Bogève."
}
```

Still ask Julien for:
- price;
- shipping;
- appointments;
- payment;
- phone;
- exact address;
- suspicious messages;
- anything confidence < 0.85.

---

## Final Verification Checklist

- [ ] Browser-only Leboncoin access; no Leboncoin API calls.
- [ ] Ollama local model used for classification/draft.
- [ ] Invalid JSON never sends.
- [ ] Low confidence never sends.
- [ ] Sensitive intents always ask Julien.
- [ ] All sent messages are logged.
- [ ] Human verification stops safely.
- [ ] Buyer links are never clicked.
- [ ] Policy can be edited without code changes.
- [ ] Julien’s corrections become explicit rules.
- [ ] Read-only and draft-only live tests passed before auto-send.

---

## Recommended First Operating Policy

Start with:

```json
{
  "mode": "DRAFT_ONLY",
  "confidence_threshold_auto": 0.85,
  "shipping_default": "ask_julien",
  "appointment_default": "ask_julien",
  "negotiation_default": "ask_julien"
}
```

After a few validated examples, move to:

```json
{
  "mode": "SUPERVISED_AUTO",
  "safe_auto_replies": {
    "availability": "Bonjour, oui c’est toujours disponible.",
    "general_location": "Bonjour, je suis à Bogève."
  }
}
```

This gives Julien the learning loop he asked for without making the agent overconfident too early.

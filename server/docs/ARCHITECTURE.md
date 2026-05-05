# Camofox Browser — Architecture Python

## Vue d'ensemble

Migration complète du serveur Node.js `camofox-browser` (5864 lignes, 55 libs, Express + camoufox-js)
vers Python FastAPI + camoufox Python 0.4.11 + BrowserForge.

## Dépendances clés

- **camoufox** 0.4.11 — anti-détection Firefox (AsyncCamoufox, launch_options, virtdisplay)
- **BrowserForge** (via camoufox) — génération de fingerprints: `generate_fingerprint()`
- **FastAPI** — serveur REST
- **Pydantic** — validation des modèles
- **Prometheus client** — métriques
- **Playwright** (via camoufox) — contrôle browser

## Structure

```
camofox-browser-python/
├── server.py                  # Entrypoint: uvicorn.run()
├── camofox/
│   ├── __init__.py
│   ├── app.py                 # FastAPI app factory
│   ├── config.py              # Pydantic config model + loading
│   └── modules/
│       ├── auth.py            # Auth middleware + API key check
│       ├── browser.py         # Browser lifecycle (launch, idle, health)
│       ├── session.py         # Sessions (maps userId→context+tabs)
│       ├── proxy.py           # Proxy pool (round_robin, backconnect)
│       ├── persona.py         # Deterministic persona generation
│       ├── fingerprint.py     # Fingerprint generation + coherence
│       ├── profile.py         # Profile persistence on disk
│       ├── snapshot.py        # Accessibility tree snapshot
│       ├── actions.py         # Actions navigate/click/type/scroll/press
│       ├── managed.py         # Managed browser system (lifecycle, leases, CLI)
│       ├── notifications.py   # Notification capture + polling
│       ├── memory.py          # Agent history + self-healing replay
│       ├── interrupts.py      # Interrupt detection + handling
│       ├── plugins.py         # Plugin event bus
│       ├── vnc.py             # VNC display management + Xvfb
│       ├── metrics.py         # Prometheus metrics
│       └── utils.py           # Helpers (safePageClose, timeouts)
```

## Flux de bootstrap

```
server.py
  → app.py: create_app(config)
    → config.py: load from env + JSON config
    → proxy.py: createProxyPool(config.proxy)
    → plugins.py: init event bus
    → metrics.py: init prometheus
    → FastAPI router mounts
    → on_startup: pre-warm browser, start keepalive
```

## Modèles de données (Pydantic)

```python
class Config(BaseSettings):
    port: int = 9377
    api_key: str = ""       # CAMOFOX_API_KEY
    admin_key: str = ""     # CAMOFOX_ADMIN_KEY
    node_env: str = "development"
    handler_timeout_ms: int = 30000
    session_timeout_ms: int = 600000
    tab_inactivity_ms: int = 300000
    max_sessions: int = 50
    max_tabs_per_session: int = 10
    max_tabs_global: int = 50
    max_concurrent_per_user: int = 3
    navigate_timeout_ms: int = 25000
    buildrefs_timeout_ms: int = 12000
    browser_idle_timeout_ms: int = 300000
    profile_dir: str = "~/.camofox/profiles"
    prometheus_enabled: bool = False
    shared_display: str = ""        # DISPLAY=:99 etc.
    shared_display_user_ids: list[str] = []

class ProxyConfig(BaseSettings):
    strategy: str = "round_robin"   # round_robin | backconnect
    provider: str = "generic"
    host: str = ""
    port: int = 0
    ports: list[int] = []
    username: str = ""
    password: str = ""
    backconnect_host: str = ""
    backconnect_port: int = 0
    country: str = ""
    state: str = ""
    city: str = ""
    session_duration_minutes: int = 10

class Persona(BaseModel):
    version: int = 2
    os: str          # windows | macos | linux
    locale: str
    languages: list[str]
    timezone_id: str
    geolocation: dict = {}
    screen: dict = {}        # {width, height}
    window: dict = {}        # {outerWidth, outerHeight}
    viewport: dict = {}      # {width, height}
    device_scale_factor: float = 1
    hardware_concurrency: int = 8
    device_memory: int = 8
    firefox_user_prefs: dict = {}
    launch_screen_constraints: dict = {}

class BrowserProfile(BaseModel):
    version: int = 1
    persona: Persona
    launch_constraints: dict = {}
    context_defaults: dict = {}
    firefox_user_prefs: dict = {}

class FingerprintData(BaseModel):
    screen: dict
    navigator: dict
    headers: dict
    video_codecs: dict
    audio_codecs: dict
    plugins_data: dict
    battery: dict | None
    video_card: dict | None
    multimedia_devices: list[str]
    fonts: list[str]

class TabState(BaseModel):
    class Config:
        arbitrary_types_allowed = True
    page: Any         # playwright Page
    refs: dict = {}   # refId→{role,name,nth}
    visited_urls: set = set()
    downloads: list = []
    tool_calls: int = 0
    # ... snapshot cache, diagnostics, recovery_meta, human_session

class SessionState(BaseModel):
    class Config:
        arbitrary_types_allowed = True
    context: Any       # playwright BrowserContext
    tab_groups: dict   # sessionKey→dict[tabId→TabState]
    profile_dir: str
    launch_persona: BrowserProfile | None
    display: str | None

class ManagedProfileIdentity(BaseModel):
    user_id: str
    profile: str
    site_key: str
    session_key: str
    profile_dir: str
    browser_persona_key: str
    human_persona_key: str
```

## Routes API

### Sessions
```
POST /sessions/{userId}/cookies   — Injecter des cookies
GET  /tabs                        — Lister tous les tabs
POST /tabs                        — Créer un tab (legacy)
POST /tabs/open                   — Créer un tab (moderne)
POST /start                       — Lancer navigateur + session
POST /stop                        — Stopper navigateur
```

### Tabs (opérations)
```
GET    /tabs/{tabId}/snapshot     — Snapshot arbre accessibilité
GET    /tabs/{tabId}/screenshot   — Capture d'écran
GET    /tabs/{tabId}/images       — URLs des images sur la page
GET    /tabs/{tabId}/links        — Liens de la page
GET    /tabs/{tabId}/diagnostics  — Logs console + JS errors
GET    /tabs/{tabId}/stats        — Stats du tab
GET    /tabs/{tabId}/downloads    — Fichiers téléchargés
POST   /tabs/{tabId}/navigate     — Naviguer
POST   /tabs/{tabId}/click        — Cliquer sur un élément
POST   /tabs/{tabId}/type         — Taper du texte
POST   /tabs/{tabId}/press        — Presser une touche
POST   /tabs/{tabId}/scroll       — Scroller
POST   /tabs/{tabId}/back         — Reculer
POST   /tabs/{tabId}/forward      — Avancer
POST   /tabs/{tabId}/refresh      — Rafraîchir
POST   /tabs/{tabId}/wait         — Attendre un état
POST   /tabs/{tabId}/evaluate     — Exécuter JS
DELETE /tabs/{tabId}              — Fermer un tab
DELETE /tabs/group/{listItemId}   — Fermer un groupe
DELETE /sessions/{userId}         — Fermer une session
```

### Managed Browser
```
GET    /managed/profiles                          — Lister les profils
GET    /managed/profiles/{profile}/status         — Statut d'un profil
POST   /managed/profiles/ensure                   — Assurer l'existence
POST   /managed/profiles/lease/acquire            — Acquérir un lease
POST   /managed/profiles/lease/renew              — Renouveler
POST   /managed/profiles/lease/release            — Libérer
POST   /managed/cli/open                          — Ouvrir CLI
POST   /managed/cli/snapshot                      — Snapshot CLI
POST   /managed/cli/act                           — Action CLI
POST   /managed/cli/memory/record                 — Enregistrer flow
POST   /managed/cli/memory/replay                 — Rejouer flow
POST   /managed/cli/checkpoint                    — Checkpoint
POST   /managed/cli/release                       — Libérer CLI
POST   /managed/visible-tab                       — Tab visible
POST   /managed/recover-tab                       — Recovery
POST   /managed/storage-checkpoint                — Save state
```

### Notifications
```
POST /notifications/status     — État des notifications
POST /notifications/enable     — Activer
POST /notifications/disable    — Désactiver
POST /notifications/list       — Lister
POST /notifications/poll       — Poller
POST /notifications/mark-read  — Marquer comme lu
```

### Agent Memory
```
POST   /memory/record          — Enregistrer action
GET    /memory/search          — Chercher dans l'historique
DELETE /memory/delete          — Supprimer
POST   /memory/replay          — Rejouer une séquence
```

### Admin
```
GET  /health                   — Healthcheck
GET  /metrics                  — Prometheus
POST /profile/status           — Status du profil
POST /fingerprint/doctor       — Diagnostiquer fingerprint
POST /auth/status              — Status auth
POST /auth/ensure              — Assurer l'auth
```

## Implémentation des sub-agents

### Module 1: Core (config, auth, utils, plugins, app factory)
- `camofox/core/` — tout le socle
- config.py, auth.py, utils.py, plugins.py, metrics.py, app.py

### Module 2: Browser & Sessions
- `browser.py` — BrowserEntry, ensureBrowser, launchBrowserInstance, idle shutdown, health
- `session.py` — SessionState, getSession, closeSession, createTabState, tabLock

### Module 3: Persona, Fingerprint & Profile
- `persona.py` — buildBrowserPersona (déterministe par userId)
- `fingerprint.py` — generateCanonicalFingerprint (via camoufox Python)
- `profile.py` — Load/save/persist profiles on disk (atomic writes)

### Module 4: Proxy
- `proxy.py` — createProxyPool, providers (round_robin, backconnect), normalizePlaywrightProxy

### Module 5: Routes sessions & tabs
- `api/sessions.py` — Routes sessions
- `api/tabs.py` — Routes tabs (navigate, click, type, scroll, screenshot, snapshot...)

### Module 6: Snapshot & Actions
- `snapshot.py` — windowSnapshot, compactSnapshot, filterDialogArtifacts
- `actions.py` — humanClick, humanType, humanScroll, humanPress (bezier, typos, etc.)

### Module 7: Managed Browser
- `api/managed.py` — Toutes les routes managed
- Module managed/ avec lifecycle, leases, recovery

### Module 8: Notifications, Memory, Interrupts
- `api/notifications.py` — routes notifications
- `memory.py` — agent history + self-healing replay
- `interrupts.py` — challenge detection, cookie consent
- `api/memory.py` — routes memory

### Module 9: VNC
- `vnc.py` — VirtualDisplay, display registry, geometry doctor
- `api/vnc.py` — routes VNC

### Module 10: Plugins
- `plugins.py` — Event bus, plugin loading (YouTube, persistence)

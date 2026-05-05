"""VNC routes — status, enable, disable VNC for users."""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import HTMLResponse
from pydantic import BaseModel

from camofox.core.config import config
from camofox.core.utils import normalize_user_id
from camofox.domain.vnc import (
    resolve_vnc_config,
    read_display_registry,
    read_selected_vnc_user_id,
    remove_vnc_display,
)
from camofox.core.browser import close_browser
from camofox.core.session import close_session, sessions

log = logging.getLogger("camofox.api.vnc")
router = APIRouter()


# ---------------------------------------------------------------------------
# Request models
# ---------------------------------------------------------------------------


class UserIdRequest(BaseModel):
    userId: str


def _vnc_cfg() -> dict:
    return resolve_vnc_config(
        plugin_config=config.vnc.model_dump() if hasattr(config.vnc, "model_dump") else None
    )


def _selection_path() -> str:
    return str(_vnc_cfg().get("display_selection") or "")


def _read_selected_object() -> dict | None:
    import json
    from pathlib import Path

    path = _selection_path()
    if not path:
        return None
    try:
        parsed = json.loads(Path(path).read_text())
        return parsed if isinstance(parsed, dict) and parsed.get("userId") else None
    except Exception:
        return None


def _display_socket_exists(display: str) -> bool:
    """Return True when the X11 unix socket for *display* exists.

    The VNC registry can outlive the Python daemon PID after a project rename or
    service reload. In that case, a stale PID must not hide a still-visible
    managed profile from the human switcher if the X display is still present.
    """
    import re
    from pathlib import Path

    match = re.search(r":(\d+)", str(display or ""))
    if not match:
        return False
    return Path(f"/tmp/.X11-unix/X{match.group(1)}").exists()


def _entry_alive(entry: dict) -> bool:
    import os

    if not entry or not entry.get("userId") or not entry.get("display"):
        return False
    if str(entry.get("userId")) == "default":
        return False

    display = str(entry.get("display") or "")
    pid = int(entry.get("pid") or 0)
    if pid > 0:
        try:
            os.kill(pid, 0)
            return True
        except OSError:
            # The Python daemon may have been restarted from a renamed project
            # while the Xvfb display/socket is still alive. Keep the profile
            # visible so the operator can select/recover it instead of showing
            # an empty switcher.
            return _display_socket_exists(display)
    return _display_socket_exists(display)


def _list_profiles() -> list[dict]:
    profiles = []
    for key, entry in read_display_registry().items():
        if not isinstance(entry, dict):
            continue
        normalized = {**entry, "userId": str(entry.get("userId") or key)}
        if _entry_alive(normalized):
            profiles.append(normalized)
    return sorted(profiles, key=lambda item: str(item.get("userId") or ""))


def _selected_profile() -> dict | None:
    registry = read_display_registry()
    selected = _read_selected_object()
    if selected:
        user_id = str(selected.get("userId") or "")
        entry = registry.get(user_id)
        if isinstance(entry, dict) and entry.get("display"):
            return {**entry, "userId": str(entry.get("userId") or user_id), "selected": True}

    selected_user = read_selected_vnc_user_id(_selection_path())
    if selected_user:
        entry = registry.get(selected_user)
        if isinstance(entry, dict) and entry.get("display"):
            return {**entry, "userId": str(entry.get("userId") or selected_user), "selected": True}
        if selected_user.startswith("leboncoin-"):
            return None
    profiles = _list_profiles()
    return profiles[0] if profiles else None


def _write_selection(user_id: str) -> dict:
    import json
    from datetime import datetime, timezone
    from pathlib import Path

    registry = read_display_registry()
    entry = registry.get(user_id)
    if not isinstance(entry, dict) or not _entry_alive({**entry, "userId": str(entry.get("userId") or user_id)}):
        raise HTTPException(status_code=404, detail=f'No VNC display registered for userId="{user_id}"')
    selected = {
        "userId": str(entry.get("userId") or user_id),
        "display": str(entry.get("display")),
        "pid": entry.get("pid"),
        "selectedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }
    import os

    selection_path = Path(_selection_path())
    selection_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = selection_path.with_suffix(selection_path.suffix + f".{os.getpid()}.tmp")
    tmp.write_text(json.dumps(selected, indent=2) + "\n")
    tmp.rename(selection_path)
    return selected


def _novnc_url(request: Request) -> str:
    vnc_cfg = _vnc_cfg()
    host = request.headers.get("host", "127.0.0.1").split(":", 1)[0]
    return f"http://{host}:{vnc_cfg.get('novnc_port', 6081)}/vnc.html"


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.get("", response_class=HTMLResponse)
async def vnc_switcher():
    return HTMLResponse("""<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Camofox VNC switcher</title>
<style>body{font-family:system-ui,sans-serif;margin:2rem;background:#111827;color:#e5e7eb}main{max-width:960px;margin:auto}.muted{color:#9ca3af}.toolbar{display:flex;gap:.75rem;margin:1.5rem 0;flex-wrap:wrap}button,a.button{border:0;border-radius:.5rem;padding:.65rem .9rem;background:#2563eb;color:#fff;cursor:pointer;text-decoration:none}button:disabled{background:#374151;cursor:default}button.danger{background:#991b1b}table{width:100%;border-collapse:collapse;background:#1f2937;border-radius:.75rem;overflow:hidden}th,td{padding:.75rem;text-align:left;border-bottom:1px solid #374151}th{background:#111827}tr.selected{background:#064e3b}.status{margin:1rem 0;min-height:1.5rem;color:#bfdbfe}.empty{padding:1rem;background:#1f2937;border-radius:.75rem}.actions{display:flex;gap:.5rem;flex-wrap:wrap}</style>
</head><body><main><h1>Camofox VNC switcher</h1><p class="muted">Sélection humaine du profil managed affiché dans noVNC.</p><section id="selected" class="status">Chargement…</section><section class="toolbar"><button id="refresh">Rafraîchir</button><a id="novnc" class="button" target="_blank" rel="noreferrer">Ouvrir noVNC</a></section><section id="profiles"></section></main>
<script>
const profilesEl=document.getElementById('profiles'),selectedEl=document.getElementById('selected'),novncEl=document.getElementById('novnc'),refreshEl=document.getElementById('refresh');
const esc=v=>String(v??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
function fmt(v){if(!v)return '';const d=new Date(v);if(Number.isNaN(d.getTime()))return String(v);return new Intl.DateTimeFormat('fr-FR',{timeZone:'Europe/Paris',day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit'}).format(d).replace(',',' à')}
async function loadProfiles(message=''){const r=await fetch('/vnc/profiles');if(!r.ok)throw new Error('Impossible de charger les profils VNC');const data=await r.json();const sid=data.selected?.userId||'';selectedEl.textContent=message||(data.selected?'Profil affiché: '+data.selected.userId+' ('+data.selected.display+')':'Aucun profil visible sélectionné');if(data.novncUrl&&data.selected){novncEl.href=data.novncUrl;novncEl.style.display='inline-block'}else{novncEl.removeAttribute('href');novncEl.style.display='none'}if(!data.profiles?.length){profilesEl.innerHTML='<div class="empty">Aucun profil managed visible enregistré pour le moment.</div>';return}profilesEl.innerHTML='<table><thead><tr><th>Profil</th><th>Display</th><th>PID</th><th>Mis à jour</th><th>Action</th></tr></thead><tbody>'+data.profiles.map(p=>{const sel=p.userId===sid;return '<tr class="'+(sel?'selected':'')+'"><td>'+esc(p.userId)+'</td><td>'+esc(p.display)+'</td><td>'+esc(p.pid||'')+'</td><td title="'+esc(p.updatedAt||'')+'">'+esc(fmt(p.updatedAt))+'</td><td class="actions"><button data-user-id="'+esc(p.userId)+'" '+(sel?'disabled':'')+'>'+(sel?'Affiché':'Afficher dans noVNC')+'</button><button class="danger" data-close-user-id="'+esc(p.userId)+'">Fermer</button></td></tr>'}).join('')+'</tbody></table>'}
async function selectProfile(userId){const r=await fetch('/vnc/select',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({userId})});if(!r.ok){const d=await r.json().catch(()=>({}));throw new Error(d.detail||d.error||'Impossible de sélectionner ce profil')}await loadProfiles('Sélection changée vers '+userId+'; noVNC va se reconnecter sous environ 2 secondes.')}
async function closeProfile(userId){const r=await fetch('/vnc/close',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({userId})});if(!r.ok){const d=await r.json().catch(()=>({}));throw new Error(d.detail||d.error||'Impossible de fermer ce profil')}const d=await r.json();await loadProfiles(d.closed?'Profil fermé: '+userId:'Profil retiré de la liste: '+userId)}
profilesEl.addEventListener('click',async ev=>{const c=ev.target.closest('button[data-close-user-id]');if(c){const u=c.dataset.closeUserId;if(!confirm('Fermer le profil '+u+' ?'))return;c.disabled=true;selectedEl.textContent='Fermeture de '+u+'…';try{await closeProfile(u)}catch(e){selectedEl.textContent=e.message;await loadProfiles()}return}const b=ev.target.closest('button[data-user-id]');if(!b)return;b.disabled=true;selectedEl.textContent='Changement de sélection…';try{await selectProfile(b.dataset.userId)}catch(e){selectedEl.textContent=e.message;await loadProfiles()}});
refreshEl.addEventListener('click',()=>loadProfiles().catch(e=>{selectedEl.textContent=e.message}));loadProfiles().catch(e=>{selectedEl.textContent=e.message});setInterval(()=>{if(!document.hidden)loadProfiles().catch(e=>{selectedEl.textContent=e.message})},2000);
</script></body></html>""")


@router.get("/profiles")
async def vnc_profiles(request: Request):
    return {"profiles": _list_profiles(), "selected": _selected_profile(), "novncUrl": _novnc_url(request)}


@router.post("/select")
async def vnc_select(body: UserIdRequest):
    uid = normalize_user_id(body.userId)
    selected = _write_selection(uid)
    return {"selected": selected, "profiles": _list_profiles()}


@router.post("/close")
async def vnc_close(body: UserIdRequest):
    uid = normalize_user_id(body.userId)
    closed = False
    try:
        if uid in sessions:
            await close_session(uid, reason="vnc_close")
            closed = True
        await close_browser(uid)
    except Exception as exc:
        log.warning("Failed to close VNC profile %s: %s", uid, exc)
    remove_vnc_display(uid)
    return {"ok": True, "closed": closed, "removed": True, "userId": uid, "profiles": _list_profiles(), "selected": _selected_profile()}


@router.post("/status")
async def vnc_status(body: UserIdRequest):
    """Return the current VNC status for the system or a specific user.

    Returns the resolved VNC configuration, the display registry state,
    and the currently selected VNC user (if any).
    """
    uid = normalize_user_id(body.userId)

    # Resolve VNC config from the application config
    vnc_cfg = resolve_vnc_config(
        plugin_config=config.vnc.model_dump() if hasattr(config.vnc, "model_dump") else None
    )

    display_registry = read_display_registry()
    selected_user = read_selected_vnc_user_id()

    user_entry = display_registry.get(uid)

    return {
        "ok": True,
        "enabled": vnc_cfg.get("enabled", False),
        "config": {
            "resolution": vnc_cfg.get("resolution"),
            "vnc_port": vnc_cfg.get("vnc_port"),
            "novnc_port": vnc_cfg.get("novnc_port"),
            "bind": vnc_cfg.get("bind"),
            "view_only": vnc_cfg.get("view_only"),
            "human_only": vnc_cfg.get("human_only"),
            "managed_registry_only": vnc_cfg.get("managed_registry_only"),
        },
        "user": uid,
        "user_display": user_entry,
        "selected_vnc_user": selected_user,
        "registry_entry_count": len(display_registry),
    }


@router.post("/enable")
async def vnc_enable(body: UserIdRequest):
    """Enable VNC for a user.

    Stub implementation — records the intent to enable VNC.
    Full VNC watcher launch will be added in a future module.
    """
    uid = normalize_user_id(body.userId)
    log.info("VNC enable requested for user %s", uid)

    vnc_cfg = resolve_vnc_config(
        plugin_config=config.vnc.model_dump() if hasattr(config.vnc, "model_dump") else None
    )

    if not vnc_cfg.get("enabled", False):
        return {
            "ok": False,
            "note": "VNC is globally disabled in configuration",
            "userId": uid,
        }

    return {
        "ok": True,
        "note": "VNC enable recorded; full watcher launch not yet implemented",
        "userId": uid,
    }


@router.post("/disable")
async def vnc_disable(body: UserIdRequest):
    """Disable VNC for a user.

    Stub implementation — records the intent to disable VNC.
    Full VNC watcher shutdown will be added in a future module.
    """
    uid = normalize_user_id(body.userId)
    log.info("VNC disable requested for user %s", uid)

    return {
        "ok": True,
        "note": "VNC disable recorded; full watcher shutdown not yet implemented",
        "userId": uid,
    }

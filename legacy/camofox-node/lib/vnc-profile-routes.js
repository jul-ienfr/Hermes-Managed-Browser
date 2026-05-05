import {
  getSelectedVncDisplay,
  listVncDisplays,
  removeVncDisplay,
  selectVncDisplay,
} from './vnc-display-registry.js';

function renderVncSwitcherHtml() {
  return `<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Camofox VNC switcher</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 2rem; background: #111827; color: #e5e7eb; }
    main { max-width: 960px; margin: 0 auto; }
    h1 { margin-bottom: 0.25rem; }
    .muted { color: #9ca3af; }
    .toolbar { display: flex; gap: 0.75rem; align-items: center; margin: 1.5rem 0; flex-wrap: wrap; }
    button, a.button { border: 0; border-radius: 0.5rem; padding: 0.65rem 0.9rem; background: #2563eb; color: white; cursor: pointer; text-decoration: none; display: inline-block; }
    button:disabled { background: #374151; cursor: default; }
    button.danger { background: #991b1b; }
    button.danger:hover { background: #b91c1c; }
    td.actions { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; }
    table { width: 100%; border-collapse: collapse; background: #1f2937; border-radius: 0.75rem; overflow: hidden; }
    th, td { padding: 0.75rem; text-align: left; border-bottom: 1px solid #374151; }
    th { background: #111827; color: #d1d5db; }
    tr.selected { background: #064e3b; }
    .status { margin: 1rem 0; min-height: 1.5rem; color: #bfdbfe; }
    .empty { padding: 1rem; background: #1f2937; border-radius: 0.75rem; }
  </style>
</head>
<body>
  <main>
    <h1>Camofox VNC switcher</h1>
    <p class="muted">Sélection humaine du profil managed affiché dans noVNC. Les agents restent limités aux outils managed_browser_*.</p>
    <section id="selected" class="status">Chargement…</section>
    <section class="toolbar">
      <button type="button" id="refresh">Rafraîchir</button>
      <a id="novnc" class="button" target="_blank" rel="noreferrer">Ouvrir noVNC</a>
    </section>
    <section id="profiles"></section>
  </main>
  <script>
    const profilesEl = document.getElementById('profiles');
    const selectedEl = document.getElementById('selected');
    const novncEl = document.getElementById('novnc');
    const refreshEl = document.getElementById('refresh');

    function escapeHtml(value) {
      return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
    }

    function formatFrenchDateTime(value) {
      if (!value) return '';
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return String(value);
      return new Intl.DateTimeFormat('fr-FR', {
        timeZone: 'Europe/Paris',
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      }).format(date).replace(',', ' à');
    }

    async function loadProfiles(message = '') {
      const response = await fetch('/vnc/profiles');
      if (!response.ok) throw new Error('Impossible de charger les profils VNC');
      const data = await response.json();
      const selectedUserId = data.selected?.userId || '';
      selectedEl.textContent = message || (data.selected ? 'Profil affiché: ' + data.selected.userId + ' (' + data.selected.display + ')' : 'Aucun profil visible sélectionné');
      if (data.novncUrl && data.selected) {
        novncEl.href = data.novncUrl;
        novncEl.style.display = 'inline-block';
      } else {
        novncEl.removeAttribute('href');
        novncEl.style.display = 'none';
      }
      if (!data.profiles?.length) {
        profilesEl.innerHTML = '<div class="empty">Aucun profil managed visible enregistré pour le moment.</div>';
        return;
      }
      profilesEl.innerHTML = '<table>'
        + '<thead><tr><th>Profil</th><th>Display</th><th>PID</th><th>Mis à jour</th><th>Action</th></tr></thead>'
        + '<tbody>' + data.profiles.map((profile) => {
          const isSelected = profile.userId === selectedUserId;
          return '<tr class="' + (isSelected ? 'selected' : '') + '">'
            + '<td>' + escapeHtml(profile.userId) + '</td>'
            + '<td>' + escapeHtml(profile.display) + '</td>'
            + '<td>' + escapeHtml(profile.pid || '') + '</td>'
            + '<td title="' + escapeHtml(profile.updatedAt || '') + '">' + escapeHtml(formatFrenchDateTime(profile.updatedAt)) + '</td>'
            + '<td class="actions">'
            + '<button type="button" data-user-id="' + escapeHtml(profile.userId) + '" ' + (isSelected ? 'disabled' : '') + '>' + (isSelected ? 'Affiché' : 'Afficher dans noVNC') + '</button>'
            + '<button type="button" class="danger" data-close-user-id="' + escapeHtml(profile.userId) + '">Fermer</button>'
            + '</td>'
            + '</tr>';
        }).join('') + '</tbody></table>';
    }

    async function selectProfile(userId) {
      const response = await fetch('/vnc/select', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Impossible de sélectionner ce profil');
      }
      await loadProfiles('Sélection changée vers ' + userId + '; noVNC va se reconnecter sous environ 2 secondes.');
    }

    async function closeProfile(userId) {
      const response = await fetch('/vnc/close', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Impossible de fermer ce profil');
      }
      const data = await response.json();
      await loadProfiles(data.closed ? 'Profil fermé: ' + userId : 'Profil retiré de la liste: ' + userId);
    }

    profilesEl.addEventListener('click', async (event) => {
      const closeButton = event.target.closest('button[data-close-user-id]');
      if (closeButton) {
        const userId = closeButton.dataset.closeUserId;
        if (!confirm('Fermer le profil ' + userId + ' ?')) return;
        closeButton.disabled = true;
        selectedEl.textContent = 'Fermeture de ' + userId + '…';
        try {
          await closeProfile(userId);
        } catch (err) {
          selectedEl.textContent = err.message;
          await loadProfiles();
        }
        return;
      }
      const button = event.target.closest('button[data-user-id]');
      if (!button) return;
      button.disabled = true;
      selectedEl.textContent = 'Changement de sélection…';
      try {
        await selectProfile(button.dataset.userId);
      } catch (err) {
        selectedEl.textContent = err.message;
        await loadProfiles();
      }
    });
    refreshEl.addEventListener('click', () => loadProfiles().catch((err) => { selectedEl.textContent = err.message; }));
    loadProfiles().catch((err) => { selectedEl.textContent = err.message; });
    setInterval(() => {
      if (document.hidden) return;
      loadProfiles().catch((err) => { selectedEl.textContent = err.message; });
    }, 2000);
  </script>
</body>
</html>`;
}

function registerVncProfileRoutes(app, { authMiddleware, registryPath, selectionPath, safeError = (err) => err.message, getNovncUrl, closeProfile } = {}) {
  const auth = authMiddleware || ((req, res, next) => next());

  app.get('/vnc', auth, (_req, res) => {
    res.type('html').send(renderVncSwitcherHtml());
  });

  app.get('/vnc/profiles', auth, (req, res) => {
    res.json({
      profiles: listVncDisplays(registryPath),
      selected: getSelectedVncDisplay({ registryPath, selectionPath }),
      ...(getNovncUrl ? { novncUrl: getNovncUrl(req) } : {}),
    });
  });

  app.post('/vnc/select', auth, (req, res) => {
    try {
      const userId = req.body?.userId;
      if (!userId) {
        return res.status(400).json({ error: 'Missing "userId" field in request body' });
      }
      const selected = selectVncDisplay(userId, { registryPath, selectionPath });
      return res.json({
        selected,
        profiles: listVncDisplays(registryPath),
      });
    } catch (err) {
      return res.status(404).json({ error: safeError(err) });
    }
  });

  app.post('/vnc/close', auth, async (req, res) => {
    try {
      const userId = req.body?.userId;
      if (!userId) {
        return res.status(400).json({ error: 'Missing "userId" field in request body' });
      }
      let closed = false;
      if (closeProfile) {
        const result = await closeProfile(String(userId));
        closed = Boolean(result?.closed);
      }
      removeVncDisplay(userId, registryPath);
      return res.json({
        ok: true,
        closed,
        removed: true,
        userId: String(userId),
        profiles: listVncDisplays(registryPath),
        selected: getSelectedVncDisplay({ registryPath, selectionPath }),
      });
    } catch (err) {
      return res.status(500).json({ error: safeError(err) });
    }
  });
}

export { registerVncProfileRoutes };

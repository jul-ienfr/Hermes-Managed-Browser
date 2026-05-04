function managedSiteForProfile(userId) {
  const normalized = String(userId || '');
  if (normalized === 'leboncoin-cim' || normalized === 'leboncoin-ge') return 'leboncoin';
  if (normalized === 'vinted-main') return 'vinted';
  return '';
}

function manualKeepaliveSite(userId) {
  const normalized = String(userId || '');
  if (normalized === 'leboncoin-manual') return 'leboncoin';
  if (normalized === 'vinted-manual') return 'vinted';
  return '';
}

function shouldStartKeepalive({ keepaliveUserId = '', selectedUserId = '' } = {}) {
  if (!keepaliveUserId) return false;
  const keepaliveSite = manualKeepaliveSite(keepaliveUserId);
  if (keepaliveSite && keepaliveSite === managedSiteForProfile(selectedUserId)) {
    return false;
  }
  return true;
}

export { shouldStartKeepalive };

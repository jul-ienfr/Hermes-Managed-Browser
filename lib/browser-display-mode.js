function resolveBrowserDisplayMode({ platform, userId = '', sharedDisplay, sharedDisplayUserIds = [], createVirtualDisplay }) {
  const normalizedSharedDisplay = typeof sharedDisplay === 'string' && sharedDisplay.trim()
    ? sharedDisplay.trim()
    : '';
  const allowedSharedDisplayUserIds = Array.isArray(sharedDisplayUserIds)
    ? sharedDisplayUserIds.map((value) => String(value))
    : [];
  const canUseSharedDisplay = normalizedSharedDisplay
    && String(userId)
    && allowedSharedDisplayUserIds.includes(String(userId));

  if (canUseSharedDisplay) {
    return {
      display: normalizedSharedDisplay,
      virtualDisplay: null,
      usesSharedDisplay: true,
      headless: false,
    };
  }

  if (platform !== 'linux') {
    return {
      display: undefined,
      virtualDisplay: null,
      usesSharedDisplay: false,
      headless: true,
    };
  }

  const virtualDisplay = createVirtualDisplay();
  return {
    display: virtualDisplay.get(),
    virtualDisplay,
    usesSharedDisplay: false,
    headless: false,
  };
}

export { resolveBrowserDisplayMode };

/*
 * Local noVNC error-handler patch loaded before noVNC UI.
 * Browser extensions injected into the noVNC viewer can throw page errors.
 * Those errors are not noVNC failures and should not cover the remote screen.
 */
(function ignoreExtensionErrorsInNoVnc() {
  'use strict';

  const isExtensionError = (event) => {
    const filename = event && event.filename ? String(event.filename) : '';
    return filename.startsWith('chrome-extension://') ||
      filename.startsWith('moz-extension://') ||
      filename.startsWith('safari-extension://');
  };

  const fallbackRandomUUID = () => {
    const bytes = new Uint8Array(16);
    window.crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  };

  if (window.crypto && typeof window.crypto.randomUUID !== 'function') {
    Object.defineProperty(window.crypto, 'randomUUID', {
      configurable: true,
      value: fallbackRandomUUID,
    });
  }

  window.addEventListener('error', (event) => {
    if (!isExtensionError(event)) {
      return;
    }
    event.stopImmediatePropagation();
  }, true);
}());

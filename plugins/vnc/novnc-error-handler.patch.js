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

  window.addEventListener('error', (event) => {
    if (!isExtensionError(event)) {
      return;
    }
    event.stopImmediatePropagation();
  }, true);
}());

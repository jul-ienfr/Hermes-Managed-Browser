const DEFAULT_BINDING_NAME = '__managedBrowserRecordNotification';

function buildNotificationInitScript(bindingName = DEFAULT_BINDING_NAME) {
  return `(() => {
  if (window.__managedBrowserNotificationCaptureInstalled) return;
  window.__managedBrowserNotificationCaptureInstalled = true;
  const NativeNotification = window.Notification;
  if (typeof NativeNotification !== 'function') return;
  const bindingName = ${JSON.stringify(bindingName)};
  function bindingAvailable() {
    return typeof window[bindingName] === 'function';
  }
  window.__managedBrowserNotificationCaptureBindingAvailable = bindingAvailable;
  function safeRecord(title, options) {
    try {
      const binding = window[bindingName];
      window.__managedBrowserNotificationCaptureLastAttempt = {
        title: String(title || ''),
        at: new Date().toISOString(),
        bindingAvailable: typeof binding === 'function',
      };
      if (typeof binding !== 'function') {
        window.__managedBrowserNotificationCaptureLastError = 'binding_unavailable';
        return;
      }
      binding({ title: String(title || ''), options: options || {}, url: window.location.href });
      window.__managedBrowserNotificationCaptureLastError = null;
    } catch (err) {
      window.__managedBrowserNotificationCaptureLastError = String(err && err.message ? err.message : err);
    }
  }
  function ManagedNotification(title, options) {
    safeRecord(title, options);
    return Reflect.construct(NativeNotification, [title, options], new.target || ManagedNotification);
  }
  Object.defineProperty(ManagedNotification, 'name', { value: 'Notification' });
  Object.defineProperty(ManagedNotification, 'length', { value: NativeNotification.length });
  const permissionDescriptor = Object.getOwnPropertyDescriptor(NativeNotification, 'permission');
  if (permissionDescriptor) {
    Object.defineProperty(ManagedNotification, 'permission', permissionDescriptor.get ? {
      configurable: permissionDescriptor.configurable,
      enumerable: permissionDescriptor.enumerable,
      get: () => NativeNotification.permission,
    } : permissionDescriptor);
  }
  Object.defineProperty(ManagedNotification, 'requestPermission', {
    configurable: true,
    enumerable: false,
    writable: true,
    value: function requestPermission(callback) {
      return NativeNotification.requestPermission.apply(NativeNotification, arguments);
    },
  });
  ManagedNotification.prototype = NativeNotification.prototype;
  Object.setPrototypeOf(ManagedNotification, NativeNotification);
  window.Notification = ManagedNotification;
  try {
    const ServiceWorkerRegistrationCtor = window.ServiceWorkerRegistration;
    const proto = ServiceWorkerRegistrationCtor && ServiceWorkerRegistrationCtor.prototype;
    if (proto && typeof proto.showNotification === 'function' && !proto.__managedBrowserShowNotificationWrapped) {
      const NativeShowNotification = proto.showNotification;
      Object.defineProperty(proto, '__managedBrowserShowNotificationWrapped', { value: true, configurable: true });
      Object.defineProperty(proto, 'showNotification', {
        configurable: true,
        enumerable: false,
        writable: true,
        value: function showNotification(title, options) {
          safeRecord(title, options);
          return NativeShowNotification.apply(this, arguments);
        },
      });
    }
  } catch (err) {
    window.__managedBrowserNotificationCaptureLastError = String(err && err.message ? err.message : err);
  }
})();`;
}

function normalizeCapturedNotification({ profile, site, origin, pageUrl, payload } = {}) {
  const options = payload?.options && typeof payload.options === 'object' ? payload.options : {};
  return {
    profile: String(profile || ''),
    site: String(site || ''),
    origin: String(origin || ''),
    title: String(payload?.title || ''),
    body: String(options.body || ''),
    tag: String(options.tag || ''),
    url: String(payload?.url || pageUrl || options?.data?.url || ''),
  };
}

function notificationBindingHandler(options = {}) {
  return async (source, payload) => {
    const pageUrl = source?.page?.url?.() || payload?.url || '';
    const record = normalizeCapturedNotification({ ...options, pageUrl, payload });
    await options.onNotification?.(record);
    return { ok: true };
  };
}

async function exposeNotificationBinding(target, bindingName, options = {}) {
  if (!target || typeof target.exposeBinding !== 'function') return false;
  if (!target.__managedNotificationCaptureBindings) target.__managedNotificationCaptureBindings = new Set();
  if (target.__managedNotificationCaptureBindings.has(bindingName)) return true;
  try {
    await target.exposeBinding(bindingName, notificationBindingHandler(options));
  } catch (err) {
    if (!String(err?.message || err).includes('has been already registered')) throw err;
  }
  target.__managedNotificationCaptureBindings.add(bindingName);
  return true;
}

async function installNotificationCapture(context, options = {}) {
  if (!context || typeof context.addInitScript !== 'function') {
    throw new Error('Playwright browser context with addInitScript is required');
  }
  const bindingName = options.bindingName || DEFAULT_BINDING_NAME;
  await exposeNotificationBinding(context, bindingName, options);
  await context.addInitScript(buildNotificationInitScript(bindingName));
  return { installed: true, bindingName };
}

async function ensureNotificationCaptureOnPage(page, options = {}) {
  if (!page || typeof page.evaluate !== 'function') {
    throw new Error('Playwright page with evaluate is required');
  }
  const bindingName = options.bindingName || DEFAULT_BINDING_NAME;
  await exposeNotificationBinding(page, bindingName, options);
  if (typeof page.addInitScript === 'function') {
    await page.addInitScript(buildNotificationInitScript(bindingName));
  }
  await page.evaluate(buildNotificationInitScript(bindingName)).catch(() => undefined);
  const diagnostics = await page.evaluate((name) => ({
    installed: Boolean(window.__managedBrowserNotificationCaptureInstalled),
    binding_available: typeof window[name] === 'function',
    binding_type: typeof window[name],
  }), bindingName).catch(() => ({ installed: false, binding_available: false, binding_type: 'unavailable' }));
  return { installed: true, bindingName, ...diagnostics };
}

export {
  DEFAULT_BINDING_NAME,
  buildNotificationInitScript,
  ensureNotificationCaptureOnPage,
  installNotificationCapture,
  normalizeCapturedNotification,
};

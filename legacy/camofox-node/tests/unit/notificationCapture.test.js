import { describe, expect, test } from '@jest/globals';

import {
  buildNotificationInitScript,
  installNotificationCapture,
  normalizeCapturedNotification,
} from '../../lib/notification-capture.js';

describe('notification capture init script', () => {
  test('installs a safe Notification wrapper without replacing permission/requestPermission semantics', () => {
    const script = buildNotificationInitScript();

    expect(script).toContain('const NativeNotification = window.Notification');
    expect(script).toContain('Reflect.construct(NativeNotification');
    expect(script).toContain("Object.getOwnPropertyDescriptor(NativeNotification, 'permission')");
    expect(script).toContain("Object.defineProperty(ManagedNotification, 'permission'");
    expect(script).toContain('NativeNotification.requestPermission.apply(NativeNotification');
    expect(script).toContain('ManagedNotification.prototype = NativeNotification.prototype');
    expect(script).toContain('Object.setPrototypeOf(ManagedNotification, NativeNotification)');
    expect(script).toContain('window.__managedBrowserNotificationCaptureBindingAvailable');
  });

  test('captures service-worker showNotification calls as browser notifications', () => {
    const script = buildNotificationInitScript();

    expect(script).toContain('ServiceWorkerRegistration');
    expect(script).toContain('showNotification');
    expect(script).toContain('NativeShowNotification.apply(this, arguments)');
  });

  test('captures title/body/tag/url metadata through an exposed binding', async () => {
    const calls = [];
    const context = {
      async exposeBinding(name, handler) {
        calls.push(['binding', name]);
        this.bindingName = name;
        this.handler = handler;
      },
      async addInitScript(script) {
        calls.push(['script', script]);
      },
    };

    await installNotificationCapture(context, {
      profile: 'buyer-a',
      site: 'leboncoin',
      origin: 'https://www.leboncoin.fr',
      onNotification: (record) => calls.push(['record', record]),
    });

    expect(calls[0]).toEqual(['binding', '__managedBrowserRecordNotification']);
    expect(calls[1][0]).toBe('script');
    await context.handler({ page: { url: () => 'https://www.leboncoin.fr/messages' } }, {
      title: 'New message',
      options: { body: 'hello', tag: 'thread-1', data: { url: '/messages/1' } },
      url: 'https://www.leboncoin.fr/messages',
    });

    expect(calls[2]).toEqual(['record', expect.objectContaining({
      profile: 'buyer-a',
      site: 'leboncoin',
      origin: 'https://www.leboncoin.fr',
      title: 'New message',
      body: 'hello',
      tag: 'thread-1',
      url: 'https://www.leboncoin.fr/messages',
    })]);
  });

  test('can retrofit capture into an already-open page when context binding is missing', async () => {
    const calls = [];
    const page = {
      async exposeBinding(name, handler) {
        calls.push(['binding', name]);
        this.bindingName = name;
        this.handler = handler;
      },
      async addInitScript(script) {
        calls.push(['page-script', script]);
      },
      async evaluate(arg, maybeName) {
        if (typeof arg === 'string') {
          calls.push(['evaluate-script', arg]);
          return undefined;
        }
        calls.push(['evaluate-diagnostics', maybeName]);
        return { installed: true, binding_available: true, binding_type: 'function' };
      },
    };

    const { ensureNotificationCaptureOnPage } = await import('../../lib/notification-capture.js');
    const result = await ensureNotificationCaptureOnPage(page, {
      profile: 'buyer-a',
      site: 'leboncoin',
      origin: 'https://www.leboncoin.fr',
      onNotification: (record) => calls.push(['record', record]),
    });

    expect(result).toMatchObject({ installed: true, bindingName: '__managedBrowserRecordNotification', binding_available: true });
    expect(calls.map((call) => call[0])).toEqual(['binding', 'page-script', 'evaluate-script', 'evaluate-diagnostics']);
    await page.handler({ page: { url: () => 'https://www.leboncoin.fr/messages' } }, { title: 'Self test', options: { body: 'body' } });
    expect(calls.at(-1)).toEqual(['record', expect.objectContaining({ profile: 'buyer-a', site: 'leboncoin', origin: 'https://www.leboncoin.fr', title: 'Self test' })]);
  });

  test('treats an already-registered binding as usable for page retrofit', async () => {
    const { ensureNotificationCaptureOnPage } = await import('../../lib/notification-capture.js');
    const page = {
      async exposeBinding() {
        throw new Error('page.exposeBinding: Function "__managedBrowserRecordNotification" has been already registered in the browser context');
      },
      async addInitScript() {},
      async evaluate(arg, maybeName) {
        if (typeof arg === 'string') return undefined;
        return { installed: true, binding_available: true, binding_type: 'function', name: maybeName };
      },
    };

    await expect(ensureNotificationCaptureOnPage(page)).resolves.toMatchObject({ binding_available: true });
  });

  test('normalizes notification payloads defensively', () => {
    expect(normalizeCapturedNotification({
      profile: 'p',
      site: 's',
      origin: 'https://example.test',
      pageUrl: 'https://example.test/inbox',
      payload: { title: 'T', options: { body: 'B', tag: 'tag', data: { url: '/thread/1' } } },
    })).toEqual({
      profile: 'p',
      site: 's',
      origin: 'https://example.test',
      title: 'T',
      body: 'B',
      tag: 'tag',
      url: 'https://example.test/inbox',
    });
  });
});

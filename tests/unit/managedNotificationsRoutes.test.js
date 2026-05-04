import { describe, expect, test } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, '../..');
const serverSource = fs.readFileSync(path.join(rootDir, 'server.js'), 'utf-8');

describe('managed notification HTTP routes', () => {
  test('server exposes status, enable, and disable routes with notification handler', () => {
    for (const route of [
      "app.post('/notifications/status'",
      "app.post('/notifications/enable'",
      "app.post('/notifications/disable'",
      "app.post('/notifications/list'",
      "app.post('/notifications/poll'",
      "app.post('/notifications/self-test'",
      "app.post('/notifications/mark-read'",
      'managedNotificationsHandle',
      'normalizeManagedNotificationResponse',
    ]) {
      expect(serverSource).toContain(route);
    }
  });

  test('routes validate profile/site/origin using managed profile identity and URL parsing', () => {
    const start = serverSource.indexOf('async function managedNotificationsHandle');
    const end = serverSource.indexOf("app.post('/notifications/status'", start);
    const section = serverSource.slice(start, end);

    expect(section).toContain('requireManagedBrowserProfileIdentity');
    expect(section).toContain('validateNotificationOrigin');
    expect(section).toContain('identity.siteKey');
    const validationStart = serverSource.indexOf('function validateNotificationOrigin');
    const validationEnd = serverSource.indexOf('async function managedNotificationsHandle', validationStart);
    const validationSection = serverSource.slice(validationStart, validationEnd);
    expect(validationSection).toContain('new URL(origin)');
  });

  test('status route is read-only and only rereads current browser permission state', () => {
    const start = serverSource.indexOf("app.post('/notifications/status'");
    const end = serverSource.indexOf("app.post('/notifications/enable'", start);
    const section = serverSource.slice(start, end);

    expect(section).toContain('write: false');
    expect(section).toContain('readNotificationPermission');
    expect(section).not.toContain('grantPermissions');
    expect(section).not.toContain('clearPermissions');
    expect(section).not.toContain('page.click');
    expect(section).not.toContain('.click(');
  });

  test('enable route requires confirm=true before external browser permission action and checkpoints storage', () => {
    const start = serverSource.indexOf("app.post('/notifications/enable'");
    const end = serverSource.indexOf("app.post('/notifications/disable'", start);
    const section = serverSource.slice(start, end);

    expect(section).toContain('requires_confirm');
    expect(section).toContain('confirm === true');
    expect(section).toContain('grantPermissions');
    expect(section).toContain('readNotificationPermission');
    expect(section).toContain('checkpointManagedNotificationStorage');
    expect(section).toContain('external_actions: 1');
    expect(section).not.toContain('page.click');
    expect(section).not.toContain('.click(');
  });

  test('disable route disables capture/config without destructive browser permission changes', () => {
    const start = serverSource.indexOf("app.post('/notifications/disable'");
    const nextRoute = serverSource.indexOf('\napp.', start + 1);
    const section = serverSource.slice(start, nextRoute === -1 ? undefined : nextRoute);

    expect(section).toContain('disableNotificationCaptureForOrigin');
    expect(section).toContain('external_actions: 0');
    expect(section).not.toContain('clearPermissions');
    expect(section).not.toContain('grantPermissions');
    expect(section).not.toContain('page.click');
    expect(section).not.toContain('.click(');
  });

  test('list and poll routes are read-only, no-LLM, and poll does not mark read implicitly', () => {
    const listStart = serverSource.indexOf("app.post('/notifications/list'");
    const pollStart = serverSource.indexOf("app.post('/notifications/poll'", listStart);
    const markReadStart = serverSource.indexOf("app.post('/notifications/mark-read'", pollStart);
    const listSection = serverSource.slice(listStart, pollStart);
    const pollSection = serverSource.slice(pollStart, markReadStart);

    expect(listSection).toContain('write: false');
    expect(listSection).toContain('listNotifications');
    expect(listSection).toContain('external_actions: 0');
    expect(pollSection).toContain('write: false');
    expect(pollSection).toContain('readNotificationCursorState');
    expect(pollSection).toContain('writeNotificationCursorState');
    expect(pollSection).toContain('external_actions: 0');
    expect(pollSection).not.toContain('markNotificationsRead');
    expect(pollSection).not.toContain('.click(');
  });

  test('self-test route creates a browser notification and returns capture diagnostics without sending external messages', () => {
    const routeStart = serverSource.indexOf("app.post('/notifications/self-test'");
    const routeEnd = serverSource.indexOf("app.post('/notifications/mark-read'", routeStart);
    const routeSection = serverSource.slice(routeStart, routeEnd);
    const helperStart = serverSource.indexOf('async function emitManagedNotificationSelfTest');
    const helperEnd = serverSource.indexOf('async function checkpointManagedNotificationStorage', helperStart);
    const helperSection = serverSource.slice(helperStart, helperEnd);

    expect(routeSection).toContain('emitManagedNotificationSelfTest');
    expect(helperSection).toContain('new Notification(');
    expect(helperSection).toContain('__managedBrowserNotificationCaptureBindingAvailable');
    expect(helperSection).toContain('capture_binding_available');
    expect(helperSection).toContain('external_actions: 0');
    expect(routeSection).not.toContain('markNotificationsRead');
    expect(routeSection).not.toContain('grantPermissions');
  });

  test('mark-read is the only route that explicitly marks notifications read', () => {
    const markReadStart = serverSource.indexOf("app.post('/notifications/mark-read'");
    const nextRoute = serverSource.indexOf('\napp.', markReadStart + 1);
    const markReadSection = serverSource.slice(markReadStart, nextRoute === -1 ? undefined : nextRoute);
    const beforeMarkRead = serverSource.slice(0, markReadStart);

    expect(markReadSection).toContain('markNotificationsRead');
    expect(markReadSection).toContain('external_actions: 0');
    expect(beforeMarkRead).not.toContain('markNotificationsRead(');
  });
});

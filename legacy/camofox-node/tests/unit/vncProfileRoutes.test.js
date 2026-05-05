import { jest } from '@jest/globals';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { registerVncProfileRoutes } from '../../lib/vnc-profile-routes.js';
import { recordVncDisplay, selectVncDisplay } from '../../lib/vnc-display-registry.js';

function request(server, method, url, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : '';
    const req = http.request(
      {
        method,
        port: server.address().port,
        host: '127.0.0.1',
        path: url,
        headers: payload
          ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
          : {},
      },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (raw += chunk));
        res.on('end', () => {
          const contentType = res.headers['content-type'] || '';
          const body = raw && contentType.includes('application/json') ? JSON.parse(raw) : raw;
          resolve({ status: res.statusCode, headers: res.headers, body });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

describe('vnc profile selection routes', () => {
  let dir;
  let registryPath;
  let selectionPath;
  let server;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vnc-profile-routes-'));
    registryPath = path.join(dir, 'registry.json');
    selectionPath = path.join(dir, 'selected.json');
    recordVncDisplay({ userId: 'leboncoin-ge', display: ':101', registryPath });
    recordVncDisplay({ userId: 'leboncoin-cim', display: ':102', registryPath });
    selectVncDisplay('leboncoin-ge', { registryPath, selectionPath });

    const app = express();
    app.use(express.json());
    registerVncProfileRoutes(app, {
      registryPath,
      selectionPath,
      getNovncUrl: () => 'http://127.0.0.1:6081/vnc.html',
    });
    server = await new Promise((resolve) => {
      const srv = app.listen(0, () => resolve(srv));
    });
  });

  afterEach(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('serves human VNC switcher UI', async () => {
    const res = await request(server, 'GET', '/vnc');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('/vnc/profiles');
    expect(res.body).toContain('/vnc/select');
    expect(res.body).toContain('Ouvrir noVNC');
    expect(res.body).toContain('formatFrenchDateTime');
    expect(res.body).toContain('Europe/Paris');
    expect(res.body).toContain('/vnc/close');
    expect(res.body).toContain('Fermer');
    expect(res.body).toContain('setInterval');
  });

  test('lists registered VNC profile displays, selected profile, and noVNC URL', async () => {
    const res = await request(server, 'GET', '/vnc/profiles');

    expect(res.status).toBe(200);
    expect(res.body.profiles).toEqual(expect.arrayContaining([
      expect.objectContaining({ userId: 'leboncoin-ge', display: ':101' }),
      expect.objectContaining({ userId: 'leboncoin-cim', display: ':102' }),
    ]));
    expect(res.body.selected).toMatchObject({ userId: 'leboncoin-ge', display: ':101' });
    expect(res.body.novncUrl).toBe('http://127.0.0.1:6081/vnc.html');
  });

  test('selects which profile display noVNC should show', async () => {
    const res = await request(server, 'POST', '/vnc/select', { userId: 'leboncoin-cim' });

    expect(res.status).toBe(200);
    expect(res.body.selected).toMatchObject({ userId: 'leboncoin-cim', display: ':102' });

    const after = await request(server, 'GET', '/vnc/profiles');
    expect(after.body.selected).toMatchObject({ userId: 'leboncoin-cim', display: ':102' });
  });

  test('closes a VNC profile from the switcher and removes it from the list', async () => {
    const res = await request(server, 'POST', '/vnc/close', { userId: 'leboncoin-cim' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, removed: true, userId: 'leboncoin-cim' });
    expect(res.body.profiles).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ userId: 'leboncoin-cim' }),
    ]));

    const after = await request(server, 'GET', '/vnc/profiles');
    expect(after.body.profiles).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ userId: 'leboncoin-cim' }),
    ]));
  });

  test('returns 404 for selecting an unknown VNC profile', async () => {
    const res = await request(server, 'POST', '/vnc/select', { userId: 'missing' });

    expect(res.status).toBe(404);
    expect(res.body.error).toContain('No VNC display registered');
  });

  test('protects human switcher UI with auth middleware', async () => {
    if (server) await new Promise((resolve) => server.close(resolve));

    const app = express();
    app.use(express.json());
    const authMiddleware = jest.fn((_req, res, _next) => res.status(401).json({ error: 'auth required' }));
    registerVncProfileRoutes(app, { registryPath, selectionPath, authMiddleware });
    server = await new Promise((resolve) => {
      const srv = app.listen(0, () => resolve(srv));
    });

    const res = await request(server, 'GET', '/vnc');
    expect(res.status).toBe(401);
    expect(authMiddleware).toHaveBeenCalled();
  });
});

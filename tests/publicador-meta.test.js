import test from 'node:test';
import assert from 'node:assert/strict';
import {
  tieneCredencialesMeta,
  resolverUrlPublicaClip,
  publicarReelInstagramMeta,
} from '../src/engine/publicadorMeta.js';

test('detecta credenciales de Meta y arma URL pública desde RAILWAY_PUBLIC_DOMAIN + rutaVideo', () => {
  const env = {
    IG_ACCESS_TOKEN: 'EAAS_TEST_TOKEN',
    IG_USER_ID: '17841402295297534',
    RAILWAY_PUBLIC_DOMAIN: 'cliplab-backend-production.up.railway.app',
  };
  assert.equal(tieneCredencialesMeta(env), true);
  assert.equal(
    resolverUrlPublicaClip({ rutaVideo: '/data/clips/clip_01.mp4' }, env),
    'https://cliplab-backend-production.up.railway.app/clips/clip_01.mp4'
  );
});

test('publica Reel vía Meta Graph API esperando FINISHED y devolviendo mediaId', async () => {
  const llamadas = [];
  const fakeFetch = async (url, init = {}) => {
    llamadas.push({ url: String(url), method: init.method || 'GET' });
    if (String(url).endsWith('/media')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: 'CONTENEDOR_123' }),
      };
    }
    if (String(url).includes('/CONTENEDOR_123')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ status_code: 'FINISHED' }),
      };
    }
    if (String(url).endsWith('/media_publish')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: 'REEL_PUBLICADO_999' }),
      };
    }
    throw new Error(`URL inesperada: ${url}`);
  };

  const res = await publicarReelInstagramMeta(
    {
      rutaVideo: '/data/clips/prueba.mp4',
      texto: 'Clip de prueba #farolaldia',
    },
    {
      env: {
        IG_ACCESS_TOKEN: 'TOKEN_PRUEBA',
        IG_USER_ID: '17841402295297534',
        RAILWAY_PUBLIC_DOMAIN: 'cliplab.up.railway.app',
      },
      fetchFn: fakeFetch,
      sleepFn: async () => {},
    }
  );

  assert.equal(res.ok, true);
  assert.equal(res.mediaId, 'REEL_PUBLICADO_999');
  assert.equal(llamadas.length, 3);
  assert.equal(llamadas[0].method, 'POST');
  assert.equal(llamadas[1].method, 'GET');
  assert.equal(llamadas[2].method, 'POST');
});

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { publicarClip } from '../src/engine/publicador.js';

test('publicarClip usa Meta Graph API en instagram sin pedir cookies ni lanzar navegador', async () => {
  const fakeFetch = async (url) => {
    if (String(url).endsWith('/media')) {
      return { ok: true, status: 200, json: async () => ({ id: 'CONT_LIVE_1' }) };
    }
    if (String(url).includes('/CONT_LIVE_1')) {
      return { ok: true, status: 200, json: async () => ({ status_code: 'FINISHED' }) };
    }
    if (String(url).endsWith('/media_publish')) {
      return { ok: true, status: 200, json: async () => ({ id: 'IG_MEDIA_777' }) };
    }
    throw new Error(`URL inesperada: ${url}`);
  };

  const tmpFile = path.join(os.tmpdir(), `reel_meta_${Date.now()}.mp4`);
  await fs.writeFile(tmpFile, 'fake-mp4');
  try {
  const out = await publicarClip(
    {
      rutaVideo: tmpFile,
      descripcion: 'Prueba directa API Meta',
      plataformas: ['instagram'],
    },
    {
      env: {
        IG_ACCESS_TOKEN: 'TOKEN_OK',
        IG_USER_ID: '17841402295297534',
        RAILWAY_PUBLIC_DOMAIN: 'cliplab-backend.up.railway.app',
      },
      fetchFn: fakeFetch,
      sleepFn: async () => {},
      leerCookies: async () => {
        throw new Error('NO_DEBERIA_LLAMAR_A_COOKIES');
      },
    }
  );

  assert.equal(out.ok, true);
  assert.equal(out.resultados.instagram.ok, true);
  assert.equal(out.resultados.instagram.meta.mediaId, 'IG_MEDIA_777');
  } finally { await fs.unlink(tmpFile).catch(() => {}); }
});

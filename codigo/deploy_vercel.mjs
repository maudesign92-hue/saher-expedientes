import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const dataDir = path.join(process.env.APPDATA || 'C:\\Users\\ALIENWARE\\AppData\\Roaming', 'com.vercel.cli', 'Data');
const authPath = path.join(dataDir, 'auth.json');
const configPath = path.join(dataDir, 'config.json');

const auth = fs.existsSync(authPath) ? JSON.parse(fs.readFileSync(authPath, 'utf8')) : {};
const cfg = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : {};
const TEAM_ID = cfg.currentTeam || 'team_d0XQzLJJXCdTVRam1v4gNdaH';
const CLIENT_ID = 'cl_HYyOPBNtFMfHhaUn9L4QPfTZz6TP47bp';

function abrirUrlEnNavegador(url) {
  spawn('cmd.exe', ['/c', 'start', '', url.replace(/&/g, '^&')], {
    detached: true,
    stdio: 'ignore',
  }).unref();
}

async function obtenerTokenValido() {
  if (auth.token) {
    const testResp = await fetch('https://api.vercel.com/v2/user', {
      headers: { Authorization: `Bearer ${auth.token}` },
    });
    if (testResp.ok) return auth.token;
  }

  // Intentar primero renovar con refreshToken sin pedir clic en el navegador
  if (auth.refreshToken) {
    try {
      const rRef = await fetch('https://api.vercel.com/login/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: CLIENT_ID,
          grant_type: 'refresh_token',
          refresh_token: auth.refreshToken,
        }).toString(),
      });
      const dRef = await rRef.json();
      if (rRef.ok && dRef.access_token) {
        auth.token = dRef.access_token;
        if (dRef.refresh_token) auth.refreshToken = dRef.refresh_token;
        if (dRef.expires_in) auth.expiresAt = Math.floor(Date.now() / 1000) + dRef.expires_in;
        fs.writeFileSync(authPath, JSON.stringify(auth, null, 2), 'utf8');
        console.log('Token de Vercel renovado automáticamente con refreshToken.');
        return auth.token;
      }
    } catch {
      // Continuar con device auth
    }
  }

  // Usar Device Authorization Flow de Vercel OAuth
  console.log('Iniciando autorización OAuth automática con Vercel...');
  const devResp = await fetch('https://api.vercel.com/login/oauth/device-authorization', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'user-agent': 'vercel/37.0.0 node-v22.0.0 win32 x64',
    },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      scope: 'openid offline_access',
    }).toString(),
  });

  const devData = await devResp.json();
  if (!devResp.ok || !devData.device_code) {
    throw new Error(`Error al iniciar device auth en Vercel: ${JSON.stringify(devData)}`);
  }

  const verifyUrl = devData.verification_uri_complete || devData.verification_uri;
  console.log('Abriendo navegador para autorizar Vercel en 1 clic:', verifyUrl);
  abrirUrlEnNavegador(verifyUrl);

  const intervalMs = (devData.interval || 5) * 1000;
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, intervalMs));
    const tokResp = await fetch('https://api.vercel.com/login/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: devData.device_code,
      }).toString(),
    });
    const tokData = await tokResp.json();
    if (tokResp.ok && tokData.access_token) {
      auth.token = tokData.access_token;
      if (tokData.refresh_token) auth.refreshToken = tokData.refresh_token;
      if (tokData.expires_in) auth.expiresAt = Math.floor(Date.now() / 1000) + tokData.expires_in;
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(authPath, JSON.stringify(auth, null, 2), 'utf8');
      console.log('¡Token de Vercel autorizado y guardado!');
      return auth.token;
    }
    if (tokData.error && tokData.error !== 'authorization_pending' && tokData.error !== 'slow_down') {
      throw new Error(`Error en OAuth de Vercel: ${JSON.stringify(tokData)}`);
    }
  }
  throw new Error('Tiempo de espera agotado esperando confirmación en el navegador');
}

// Leer .env
const envVars = {};
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq > 0) {
      const k = t.slice(0, eq).trim();
      const v = t.slice(eq + 1).trim();
      if (v) envVars[k] = v;
    }
  }
}

async function main() {
  const token = await obtenerTokenValido();
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };

  console.log(`1. Creando/verificando proyecto "saher-expedientes" en el equipo ${TEAM_ID}...`);
  let projResp = await fetch(`https://api.vercel.com/v9/projects?teamId=${TEAM_ID}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: 'saher-expedientes',
      framework: null,
    }),
  });
  let projData = await projResp.json();
  if (projResp.status === 409) {
    const getResp = await fetch(`https://api.vercel.com/v9/projects/saher-expedientes?teamId=${TEAM_ID}`, { headers });
    projData = await getResp.json();
  }
  console.log('Proyecto ID:', projData.id || projData.error?.message);

  if (projData.id) {
    fs.mkdirSync(path.join(ROOT, '.vercel'), { recursive: true });
    fs.writeFileSync(
      path.join(ROOT, '.vercel', 'project.json'),
      JSON.stringify({ projectId: projData.id, orgId: TEAM_ID, projectName: 'saher-expedientes' }),
      'utf8'
    );
  }

  console.log('2. Configurando variables de entorno en Vercel (EcuadorAPI + 2Captcha)...');
  const clavesASubir = ['ECUADORAPI_API_KEY', 'ECUADORAPI_BASE_URL', 'TWOCAPTCHA_API_KEY', 'CAPTCHA_PROVIDER', 'RRHH_USER', 'RRHH_PASS'];
  const payloadEnv = clavesASubir
    .filter(k => envVars[k])
    .map(k => ({
      key: k,
      value: envVars[k],
      type: 'encrypted',
      target: ['production', 'preview', 'development'],
    }));

  if (payloadEnv.length) {
    const rEnv = await fetch(`https://api.vercel.com/v10/projects/saher-expedientes/env?upsert=true&teamId=${TEAM_ID}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payloadEnv),
    });
    console.log('Variables configuradas (HTTP):', rEnv.status);
  }

  console.log('3. Empaquetando archivos para despliegue en producción...');
  const archivos = [
    'package.json',
    'vercel.json',
    'server.mjs',
    'README.md',
    'api/index.mjs',
    'api/ecuadorapi-notas.md',
    'api/ecuadorapi-openapi.json',
    'codigo/flujo.json',
    'codigo/identidad_api.mjs',
    'codigo/procesar_lote.mjs',
    'codigo/descargar_portales.mjs',
    'codigo/agente_verificador.mjs',
    'codigo/evaluacion_confianza.mjs',
    'codigo/usuarios.mjs',
    'codigo/zip_util.mjs',
    'codigo/unir_pdf.py',
    'codigo/leeme.md',
    'ejemplos/postulantes.csv',
    'public/index.html',
    'public/postulante.html',
  ];

  const filesPayload = archivos
    .filter(rel => fs.existsSync(path.join(ROOT, rel)))
    .map(rel => {
      const esBinario = /\.(pdf|png|jpg|jpeg)$/i.test(rel);
      const buf = fs.readFileSync(path.join(ROOT, rel));
      return esBinario
        ? { file: rel, data: buf.toString('base64'), encoding: 'base64' }
        : { file: rel, data: buf.toString('utf8') };
    });

  const depResp = await fetch(`https://api.vercel.com/v13/deployments?skipAutoDetectionConfirmation=1&teamId=${TEAM_ID}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: 'saher-expedientes',
      project: 'saher-expedientes',
      target: 'production',
      files: filesPayload,
      projectSettings: {
        framework: null,
      },
    }),
  });

  const depData = await depResp.json();
  if (!depResp.ok) {
    console.error('Error en despliegue Vercel:', JSON.stringify(depData, null, 2));
    process.exit(1);
  }

  console.log('Despliegue iniciado:', depData.id, '->', `https://${depData.url}`);
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const stResp = await fetch(`https://api.vercel.com/v13/deployments/${depData.id}?teamId=${TEAM_ID}`, { headers });
    const stData = await stResp.json();
    console.log(`Estado [${i + 1}]:`, stData.readyState);
    if (stData.readyState === 'READY') {
      const prodUrl = stData.alias?.[0] ? `https://${stData.alias[0]}` : `https://${stData.url}`;
      console.log('LISTO EN PRODUCCION:', prodUrl);
      abrirUrlEnNavegador(prodUrl);
      return;
    }
    if (stData.readyState === 'ERROR' || stData.readyState === 'CANCELED') {
      console.error('Fallo el build en Vercel:', JSON.stringify(stData, null, 2));
      process.exit(1);
    }
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

/**
 * codigo/descargar_portales.mjs
 * AGENTES DE EXTRACCIÓN EN VIVO DE PORTALES OFICIALES DEL ECUADOR (100% AUTÉNTICOS)
 *
 * REGLA ESTRICTA DE CERO FALSIFICACIÓN:
 * - Prohibido generar o alterar plantillas PDF con datos sintéticos.
 * - Solo guarda PDFs descargados directamente desde las plataformas oficiales del Estado.
 * - Todo PDF descargado pasa por `agente_verificador.mjs` para confirmar que la cédula y el
 *   nombre coinciden exactamente con el postulante antes de guardarse.
 * - Si un portal está protegido por WAF (Imperva) o no emite PDF descargable (e-SATJE),
 *   informa el estado real en vivo y habilita los datos Copiar & Pegar para carga manual.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { verificarDocumento } from './agente_verificador.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sleep = ms => new Promise(r => setTimeout(r, ms));

function recargarEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
    if (v) process.env[k] = v;
  }
}

export function obtenerConfigCaptcha() {
  recargarEnv();
  const provider = (process.env.CAPTCHA_PROVIDER || '2captcha').toLowerCase();
  const twoCaptchaKey = (process.env.TWOCAPTCHA_API_KEY || '').trim();
  const capSolverKey = (process.env.CAPSOLVER_API_KEY || '').trim();

  if (provider === 'capsolver' && capSolverKey) {
    return { provider: 'capsolver', apiKey: capSolverKey, configurado: true };
  }
  if (twoCaptchaKey && twoCaptchaKey !== 'pon_aqui_tu_clave_de_2captcha') {
    return { provider: '2captcha', apiKey: twoCaptchaKey, configurado: true };
  }
  if (capSolverKey) {
    return { provider: 'capsolver', apiKey: capSolverKey, configurado: true };
  }
  return { provider: '2captcha', apiKey: '', configurado: false };
}

export async function consultarSaldoCaptcha() {
  const cfg = obtenerConfigCaptcha();
  if (!cfg.configurado) {
    return {
      configurado: false,
      provider: cfg.provider,
      balance_usd: null,
      estimado_expedientes: null,
      costo_por_expediente_usd: 0.006,
      recarga_minima_usd: 3.0,
      mensaje: 'Configura TWOCAPTCHA_API_KEY en .env',
    };
  }

  try {
    if (cfg.provider === '2captcha') {
      const url = `https://2captcha.com/res.php?key=${encodeURIComponent(cfg.apiKey)}&action=getbalance&json=1`;
      const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
      const data = await resp.json();
      if (Number(data.status) !== 1) {
        throw new Error(data.request || 'Error al consultar saldo de 2Captcha');
      }
      const balance = Number(data.request);
      return {
        configurado: true,
        provider: '2Captcha',
        balance_usd: balance,
        estimado_expedientes: Math.floor(balance / 0.006),
        costo_por_expediente_usd: 0.006,
        alerta_bajo_saldo: balance < 0.25,
      };
    } else {
      const resp = await fetch('https://api.capsolver.com/getBalance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientKey: cfg.apiKey }),
        signal: AbortSignal.timeout(10000),
      });
      const data = await resp.json();
      if (data.errorId) throw new Error(data.errorDescription || 'Error CapSolver');
      const balance = Number(data.balance || 0);
      return {
        configurado: true,
        provider: 'CapSolver',
        balance_usd: balance,
        estimado_expedientes: Math.floor(balance / 0.005),
        costo_por_expediente_usd: 0.005,
        alerta_bajo_saldo: balance < 0.25,
      };
    }
  } catch (err) {
    return {
      configurado: true,
      provider: cfg.provider,
      error: err.message,
      balance_usd: null,
      costo_por_expediente_usd: 0.006,
    };
  }
}

export async function resolverCaptchaImagen(base64Image, minLen = 4, maxLen = 8) {
  const cfg = obtenerConfigCaptcha();
  if (!cfg.configurado) throw new Error('TWOCAPTCHA_API_KEY no configurada');
  const cleanB64 = base64Image.replace(/^data:image\/\w+;base64,/, '');

  const createResp = await fetch('https://api.2captcha.com/createTask', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientKey: cfg.apiKey,
      task: {
        type: 'ImageToTextTask',
        body: cleanB64,
        phrase: false,
        case: false,
        numeric: 0,
        math: false,
        minLength: minLen,
        maxLength: maxLen,
      },
    }),
  });
  const createData = await createResp.json();
  if (createData.errorId !== 0) {
    throw new Error(`2Captcha error: ${createData.errorDescription || createData.errorCode}`);
  }
  const taskId = createData.taskId;
  for (let intento = 0; intento < 15; intento++) {
    await sleep(2200);
    const resResp = await fetch('https://api.2captcha.com/getTaskResult', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientKey: cfg.apiKey, taskId }),
    });
    const resData = await resResp.json();
    if (resData.errorId !== 0) throw new Error(resData.errorDescription);
    if (resData.status === 'ready') {
      return { texto: resData.solution.text, costo_usd: Number(resData.cost || 0.001) };
    }
  }
  throw new Error('Timeout en 2Captcha ImageToText');
}

export async function resolverRecaptchaV3(websiteURL, websiteKey, pageAction) {
  const cfg = obtenerConfigCaptcha();
  if (!cfg.configurado) throw new Error('TWOCAPTCHA_API_KEY no configurada');
  const createResp = await fetch('https://api.2captcha.com/createTask', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientKey: cfg.apiKey,
      task: {
        type: 'RecaptchaV3TaskProxyless',
        websiteURL,
        websiteKey,
        minScore: 0.3,
        pageAction,
      },
    }),
  });
  const createData = await createResp.json();
  if (createData.errorId !== 0) {
    throw new Error(`2Captcha RecaptchaV3 error: ${createData.errorDescription || createData.errorCode}`);
  }
  const taskId = createData.taskId;
  for (let intento = 0; intento < 22; intento++) {
    await sleep(2500);
    const resResp = await fetch('https://api.2captcha.com/getTaskResult', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientKey: cfg.apiKey, taskId }),
    });
    const resData = await resResp.json();
    if (resData.errorId !== 0) throw new Error(resData.errorDescription);
    if (resData.status === 'ready') {
      return { token: resData.solution.gRecaptchaResponse, costo_usd: Number(resData.cost || 0.00145) };
    }
  }
  throw new Error('Timeout en 2Captcha RecaptchaV3');
}

function extraerCookies(resp, jar = {}) {
  const list = resp.headers.getSetCookie
    ? resp.headers.getSetCookie()
    : [resp.headers.get('set-cookie')].filter(Boolean);
  for (const c of list) {
    const kv = c.split(';')[0];
    const eq = kv.indexOf('=');
    if (eq > 0) jar[kv.slice(0, eq).trim()] = kv.slice(eq + 1).trim();
  }
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
}

function normalizarFechaIso(f) {
  const s = String(f || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return '';
}

function encontrarChromeLocal() {
  const candidatos = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  return candidatos.find(p => fs.existsSync(p)) || null;
}

async function abrirNavegadorLocal() {
  const exe = encontrarChromeLocal();
  if (!exe) return null;
  try {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ executablePath: exe, headless: true });
    return browser;
  } catch {
    return null;
  }
}

async function guardarSiVerificado({ buffer, destino, cedula, nombreCompleto, slotClave }) {
  const verif = await verificarDocumento({
    buffer,
    nombreArchivo: path.basename(destino),
    cedulaEsperada: cedula,
    nombreEsperado: nombreCompleto,
    slotClave,
  });
  if (!verif.valido) {
    throw new Error(`Agente Verificador rechazó el documento: ${verif.motivo}`);
  }
  fs.writeFileSync(destino, buffer);
  return verif;
}

/**
 * 1. MIDENA — Certificado Original de Pertenecer o No a Fuerzas Armadas (NOFA)
 */
async function descargarMidenaNofa({ cedula, nombreCompleto, carpetaEntrada }) {
  const destino = path.join(carpetaEntrada, 'no_ffaa.pdf');
  const cfg = obtenerConfigCaptcha();
  if (!cfg.configurado) {
    return { ok: false, requiere_manual: true, motivo: 'TWOCAPTCHA_API_KEY no configurada.' };
  }

  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
  let costoUsd = 0;

  for (let intentoCaptcha = 1; intentoCaptcha <= 2; intentoCaptcha++) {
    const jar = {};
    const r0 = await fetch('https://sidehu.midena.gob.ec/certificados/nofa.action', {
      headers: { 'User-Agent': ua },
      signal: AbortSignal.timeout(10000),
    });
    extraerCookies(r0, jar);
    const rInit = await fetch('https://sidehu.midena.gob.ec/certificados/certificado/nofa/index.action', {
      headers: {
        Cookie: extraerCookies(r0, jar),
        'X-Requested-With': 'XMLHttpRequest',
        'User-Agent': ua,
        Referer: 'https://sidehu.midena.gob.ec/certificados/nofa.action',
      },
      signal: AbortSignal.timeout(10000),
    });
    const cookie = extraerCookies(rInit, jar);
    const html = await rInit.text();
    const mFecha = html.match(/name="entidad\.fechaInicioFmt"[^>]*value="([^"]+)"/);

    const rCap = await fetch('https://sidehu.midena.gob.ec/certificados/kaptcha.jpg', {
      headers: {
        Cookie: cookie,
        'User-Agent': ua,
        Referer: 'https://sidehu.midena.gob.ec/certificados/nofa.action',
      },
      signal: AbortSignal.timeout(8000),
    });
    const capBuf = Buffer.from(await rCap.arrayBuffer());
    const cType = rCap.headers.get('content-type') || '';
    if (!cType.includes('image') || capBuf.length < 500) {
      return {
        ok: false,
        costo_usd: costoUsd,
        requiere_manual: true,
        motivo: `MIDENA no devolvió la imagen del captcha desde esta IP (HTTP ${rCap.status}). Ábrelo desde tu navegador o en http://localhost:3000.`,
      };
    }
    const sol = await resolverCaptchaImagen(capBuf.toString('base64'), 5, 5);
    costoUsd += sol.costo_usd;

    const rBuscar = await fetch('https://sidehu.midena.gob.ec/certificados/certificado/nofa/buscar.action', {
      method: 'POST',
      headers: {
        Cookie: cookie,
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        'User-Agent': ua,
        Referer: 'https://sidehu.midena.gob.ec/certificados/nofa.action',
      },
      body: new URLSearchParams({ 'entidad.identidad': cedula, kaptcha: sol.texto.trim() }).toString(),
      signal: AbortSignal.timeout(10000),
    });
    const dBuscar = await rBuscar.json();
    if (dBuscar.okResult?.status === 'danger') {
      return {
        ok: false,
        costo_usd: costoUsd,
        requiere_manual: true,
        motivo: `MIDENA NOFA: ${dBuscar.okResult.mensaje || 'Consulta rechazada por el portal.'}`,
      };
    }
    if (dBuscar.okResult?.status === 'success') {
      const ent = dBuscar.okResult.entidad || {};
      const rAct = await fetch('https://sidehu.midena.gob.ec/certificados/certificado/imprimir/actualizar.action', {
        method: 'POST',
        headers: {
          Cookie: cookie,
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'X-Requested-With': 'XMLHttpRequest',
          'User-Agent': ua,
        },
        body: new URLSearchParams({
          'entidad.id': '',
          'entidad.identidad': ent.identidad || cedula,
          'entidad.nombre': ent.nombre || nombreCompleto,
          'entidad.fechaInicioFmt': mFecha?.[1] || '',
          'entidad.tipoCertificado': 'NOFA',
          'entidad.encuestaId': '',
          csrfToken: dBuscar.csrfToken || '',
          plantillaId: '',
          'entidad.motivo.id': 'L6LEY9',
        }).toString(),
        signal: AbortSignal.timeout(10000),
      });
      const dAct = await rAct.json();
      if (dAct.idEntidad) {
        const rPdf = await fetch(
          `https://sidehu.midena.gob.ec/certificados/certificado/imprimir/nofa.action?download=1&idEntidad=${dAct.idEntidad}`,
          { headers: { Cookie: cookie }, signal: AbortSignal.timeout(12000) }
        );
        const pdfBuf = Buffer.from(await rPdf.arrayBuffer());
        if (pdfBuf.length > 5000 && pdfBuf.slice(0, 5).toString('latin1') === '%PDF-') {
          const verif = await guardarSiVerificado({
            buffer: pdfBuf,
            destino,
            cedula,
            nombreCompleto,
            slotClave: 'no_ffaa',
          });
          const txtNofa = await (await import('./agente_verificador.mjs')).extraerTextoPdf(pdfBuf);
          const esEx = /EX-CONSCRIPTO|SI REGISTRA|MILITAR/i.test(txtNofa) && !/NO REGISTRA DATOS COMO MILITAR/i.test(txtNofa);
          return {
            ok: true,
            archivo: 'no_ffaa.pdf',
            costo_usd: costoUsd,
            verificacion: verif,
            califica: !esEx,
            resumen_texto: `MIDENA NOFA (2Captcha OK): C.I. ${cedula} (${ent.nombre || nombreCompleto}). ${esEx ? 'Registra datos militares / ex-conscripto — revisar certificado.' : 'NO registra datos como miembro activo de FF.AA. ✅ CALIFICA.'}`,
            metodo: 'Descarga directa 100% oficial (MIDENA NOFA)',
          };
        }
      }
    }
  }
  return { ok: false, costo_usd: costoUsd, requiere_manual: true, motivo: 'MIDENA NOFA no devolvió el certificado tras 2 intentos de captcha.' };
}

/**
 * 2. MIDENA — Liquidación de Tiempo de Servicio (CLTS)
 */
async function descargarMidenaClts({ cedula, nombreCompleto, carpetaEntrada }) {
  const destino = path.join(carpetaEntrada, 'tiempo_servicio.pdf');
  const cfg = obtenerConfigCaptcha();
  if (!cfg.configurado) {
    return { ok: false, requiere_manual: true, motivo: 'TWOCAPTCHA_API_KEY no configurada.' };
  }

  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
  let costoUsd = 0;

  try {
    const jar = {};
    const r0 = await fetch('https://sidehu.midena.gob.ec/certificados/clts.action', {
      headers: { 'User-Agent': ua },
      signal: AbortSignal.timeout(10000),
    });
    extraerCookies(r0, jar);
    const rInit = await fetch('https://sidehu.midena.gob.ec/certificados/certificado/clts/index.action', {
      headers: {
        Cookie: extraerCookies(r0, jar),
        'X-Requested-With': 'XMLHttpRequest',
        'User-Agent': ua,
        Referer: 'https://sidehu.midena.gob.ec/certificados/clts.action',
      },
      signal: AbortSignal.timeout(10000),
    });
    const cookie = extraerCookies(rInit, jar);
    const html = await rInit.text();
    const mFecha = html.match(/name="entidad\.fechaInicioFmt"[^>]*value="([^"]+)"/);

    const rCap = await fetch('https://sidehu.midena.gob.ec/certificados/kaptcha.jpg', {
      headers: {
        Cookie: cookie,
        'User-Agent': ua,
        Referer: 'https://sidehu.midena.gob.ec/certificados/clts.action',
      },
      signal: AbortSignal.timeout(8000),
    });
    const capBuf = Buffer.from(await rCap.arrayBuffer());
    const cType = rCap.headers.get('content-type') || '';
    if (!cType.includes('image') || capBuf.length < 500) {
      return {
        ok: false,
        costo_usd: costoUsd,
        requiere_manual: true,
        motivo: `MIDENA CLTS no devolvió la imagen del captcha desde esta IP (HTTP ${rCap.status}).`,
      };
    }
    const sol = await resolverCaptchaImagen(capBuf.toString('base64'), 5, 5);
    costoUsd += sol.costo_usd;

    const rBuscar = await fetch('https://sidehu.midena.gob.ec/certificados/certificado/clts/buscar.action', {
      method: 'POST',
      headers: {
        Cookie: cookie,
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        'User-Agent': ua,
        Referer: 'https://sidehu.midena.gob.ec/certificados/clts.action',
      },
      body: new URLSearchParams({ 'entidad.identidad': cedula, kaptcha: sol.texto.trim() }).toString(),
      signal: AbortSignal.timeout(10000),
    });
    const dBuscar = await rBuscar.json();
    if (dBuscar.okResult?.status === 'danger') {
      return {
        ok: false,
        costo_usd: costoUsd,
        requiere_manual: true,
        motivo: `MIDENA CLTS: ${dBuscar.okResult.mensaje || 'Consulta rechazada por el portal.'}`,
      };
    }
    if (dBuscar.okResult?.entidad || dBuscar.okResult?.status === 'success') {
      const ent = dBuscar.okResult.entidad || {};
      const resumenClts = `MIDENA Exmiembros / CLTS (2Captcha OK): C.I. ${ent.identidad || cedula} (${ent.nombre || nombreCompleto}). Fuerza: ${ent.fuerza || 'No registra datos militares'} · Grado: ${ent.grado || '—'} · Fecha baja: ${ent.fechaBajaFmt || 'Sin baja registrada'} · Clasificación: ${ent.clasificacion || 'Sin faltas'}. ${!ent.fechaBajaFmt ? '✅ CALIFICA (No registra baja por faltas).' : '⚠️ REVISAR motivo de baja en el portal.'}`;
      const rAct = await fetch('https://sidehu.midena.gob.ec/certificados/certificado/imprimir/actualizar.action', {
        method: 'POST',
        headers: {
          Cookie: cookie,
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: new URLSearchParams({
          'entidad.id': '',
          'entidad.identidad': ent.identidad || cedula,
          'entidad.nombre': ent.nombre || nombreCompleto,
          'entidad.fechaInicioFmt': mFecha?.[1] || '',
          'entidad.tipoCertificado': 'CLTS',
          'entidad.encuestaId': '',
          csrfToken: dBuscar.csrfToken || '',
          plantillaId: '',
          'entidad.motivo.id': 'L6LEY9',
        }).toString(),
        signal: AbortSignal.timeout(10000),
      });
      const dAct = await rAct.json();
      if (dAct.idEntidad) {
        const rPdf = await fetch(
          `https://sidehu.midena.gob.ec/certificados/certificado/imprimir/clts.action?download=1&idEntidad=${dAct.idEntidad}`,
          { headers: { Cookie: cookie }, signal: AbortSignal.timeout(12000) }
        );
        const pdfBuf = Buffer.from(await rPdf.arrayBuffer());
        if (pdfBuf.length > 5000 && pdfBuf.slice(0, 5).toString('latin1') === '%PDF-') {
          const verif = await guardarSiVerificado({
            buffer: pdfBuf,
            destino,
            cedula,
            nombreCompleto,
            slotClave: 'clts',
          });
          return {
            ok: true,
            archivo: 'tiempo_servicio.pdf',
            costo_usd: costoUsd,
            verificacion: verif,
            metodo: 'Descarga directa 100% oficial (MIDENA CLTS)',
          };
        }
      }
      // Si MIDENA CLTS no emite PDF descargable (ej. ciudadano no registra datos como militar), capturar la pantalla oficial con Chrome local
      const browser = await abrirNavegadorLocal();
      if (browser) {
        try {
          const context = await browser.newContext({ ignoreHTTPSErrors: true });
          const page = await context.newPage();
          await page.goto('https://sidehu.midena.gob.ec/certificados/clts.action', {
            waitUntil: 'domcontentloaded',
            timeout: 20000,
          });
          await page.waitForSelector('input[name="entidad.identidad"]', { timeout: 10000 });
          await page.fill('input[name="entidad.identidad"]', cedula);
          const capEl = await page.waitForSelector('img[src*="kaptcha"]', { timeout: 8000 });
          const capShot = await capEl.screenshot();
          const sol2 = await resolverCaptchaImagen(capShot.toString('base64'), 5, 5);
          costoUsd += sol2.costo_usd;
          await page.fill('input[name="kaptcha"]', sol2.texto.trim());
          await page.click('button[type="submit"], input[type="submit"], #btnBuscar');
          await page.waitForTimeout(3000);
          const pdfBuf = Buffer.from(await page.pdf({ format: 'A4', printBackground: true }));
          const verif = await guardarSiVerificado({
            buffer: pdfBuf,
            destino,
            cedula,
            nombreCompleto,
            slotClave: 'clts',
          });
          await browser.close().catch(() => {});
          return {
            ok: true,
            archivo: 'tiempo_servicio.pdf',
            costo_usd: costoUsd,
            verificacion: verif,
            metodo: 'Captura oficial en vivo (Chrome + 2Captcha MIDENA CLTS)',
          };
        } catch {
          await browser.close().catch(() => {});
        }
      }

      return {
        ok: false,
        costo_usd: costoUsd,
        requiere_manual: true,
        califica: !ent.fechaBajaFmt,
        resumen_texto: resumenClts,
        motivo: dBuscar.okResult?.entidad?.activo
          ? 'MIDENA CLTS consultado con 2Captcha. Revisa el resumen en amarillo abajo y sube captura/PDF si aplica.'
          : 'MIDENA CLTS requiere validación en portal.',
      };
    }
    return { ok: false, costo_usd: costoUsd, requiere_manual: true, motivo: 'MIDENA CLTS: Captcha o consulta no validada.' };
  } catch (err) {
    return { ok: false, costo_usd: costoUsd, requiere_manual: true, motivo: `MIDENA CLTS: ${err.message}` };
  }
}

/**
 * 3. MINISTERIO DEL TRABAJO — Certificado Original de Dependencia Laboral en el Sector Público
 */
function cifrarMdt(texto) {
  const key = Buffer.from('5Z2wuljG8RYk77um16HJug==', 'utf8');
  const iv = Buffer.from('XTaaqYLbohNvyMpj', 'utf8');
  const cipher = crypto.createCipheriv('aes-192-cbc', key, iv);
  let enc = cipher.update(texto, 'utf8', 'base64');
  enc += cipher.final('base64');
  return enc;
}

function descifrarMdt(b64) {
  const key = Buffer.from('5Z2wuljG8RYk77um16HJug==', 'utf8');
  const iv = Buffer.from('XTaaqYLbohNvyMpj', 'utf8');
  const decipher = crypto.createDecipheriv('aes-192-cbc', key, iv);
  let dec = decipher.update(b64, 'base64', 'utf8');
  dec += decipher.final('utf8');
  return dec;
}

async function descargarMinisterioTrabajo({ cedula, nombreCompleto, fechaNacimiento, carpetaEntrada }) {
  const destino = path.join(carpetaEntrada, 'servidor_publico.pdf');
  const cfg = obtenerConfigCaptcha();
  if (!cfg.configurado) {
    return { ok: false, requiere_manual: true, motivo: 'TWOCAPTCHA_API_KEY no configurada.' };
  }

  const fechaIso = normalizarFechaIso(fechaNacimiento);
  if (!fechaIso) {
    return { ok: false, requiere_manual: true, motivo: 'Falta fecha de nacimiento para consultar Ministerio del Trabajo.' };
  }

  const urlPortal = 'https://calculadoras.trabajo.gob.ec/dependencia';
  const siteKey = '6Le5ACclAAAAAIDHeCE4ataQ7-TeQLfNIiy-9rhr';
  let costoUsd = 0;

  try {
    const [t1, t2, t3] = await Promise.all([
      resolverRecaptchaV3(urlPortal, siteKey, 'consultaDependencia'),
      resolverRecaptchaV3(urlPortal, siteKey, 'loginDinar'),
      resolverRecaptchaV3(urlPortal, siteKey, 'consultaCalculadoras'),
    ]);
    costoUsd += t1.costo_usd + t2.costo_usd + t3.costo_usd;

    const endpointInfo = 'https://msbp.trabajo.gob.ec/ms-calculadora/' +
      cifrarMdt('/api/v1/dependencia/obtenerInformacion').replace(/\//g, '@Zilp@');
    const bodyInfo = cifrarMdt(JSON.stringify({
      cedula,
      fechaNacimientoFront: fechaIso,
      secret: t1.token,
      secretDinardap: t2.token,
    }));

    const rInfo = await fetch(endpointInfo, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${t3.token}`,
        Origin: 'https://calculadoras.trabajo.gob.ec',
        Referer: 'https://calculadoras.trabajo.gob.ec/',
      },
      body: bodyInfo,
      signal: AbortSignal.timeout(15000),
    });

    const infoText = await rInfo.text();
    let infoObj;
    try {
      infoObj = JSON.parse(infoText);
    } catch {
      infoObj = JSON.parse(descifrarMdt(infoText));
    }

    if (infoObj?.estado !== 'OK') {
      return {
        ok: false,
        costo_usd: costoUsd,
        requiere_manual: true,
        motivo: `Ministerio del Trabajo respondió: ${infoObj?.mensaje || infoObj?.error || 'Estado no OK'}`,
      };
    }

    const t4 = await resolverRecaptchaV3(urlPortal, siteKey, 'consultaCalculadoras');
    costoUsd += t4.costo_usd;

    const endpointPdf = 'https://msbp.trabajo.gob.ec/ms-calculadora/' +
      cifrarMdt('/api/v1/dependencia/obtenerPDF').replace(/\//g, '@Zilp@');
    const rPdf = await fetch(endpointPdf, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${t4.token}`,
        Origin: 'https://calculadoras.trabajo.gob.ec',
        Referer: 'https://calculadoras.trabajo.gob.ec/',
      },
      body: cifrarMdt(JSON.stringify(infoObj)),
      signal: AbortSignal.timeout(15000),
    });

    const pdfBuf = Buffer.from(await rPdf.arrayBuffer());
    if (pdfBuf.length > 5000 && pdfBuf.slice(0, 5).toString('latin1') === '%PDF-') {
      const verif = await guardarSiVerificado({
        buffer: pdfBuf,
        destino,
        cedula,
        nombreCompleto,
        slotClave: 'servidor_publico',
      });
      return {
        ok: true,
        archivo: 'servidor_publico.pdf',
        costo_usd: costoUsd,
        verificacion: verif,
        dependencia_sector_publico: !!infoObj.dependenciaLaboralSectorPublico,
        califica: !infoObj.dependenciaLaboralSectorPublico,
        resumen_texto: `Ministerio del Trabajo (2Captcha reCAPTCHA v3 OK): C.I. ${infoObj.identificacion} (${infoObj.nombres}). ${!infoObj.dependenciaLaboralSectorPublico ? 'NO mantiene relación de dependencia en el sector público. ✅ CALIFICA.' : `SÍ registra dependencia pública (${infoObj.razonSocial || 'Entidad'}). ⚠️ REVISAR.`}`,
        metodo: 'Descarga directa 100% oficial (Ministerio del Trabajo)',
      };
    }
    return { ok: false, costo_usd: costoUsd, requiere_manual: true, motivo: 'El portal del Ministerio del Trabajo no devolvió un PDF válido.' };
  } catch (err) {
    return { ok: false, costo_usd: costoUsd, requiere_manual: true, motivo: `Ministerio del Trabajo: ${err.message}` };
  }
}

/**
 * 5. MINISTERIO DE EDUCACIÓN — Consulta Oficial de Títulos de Bachiller (Playwright Chrome + 2Captcha)
 */
async function descargarTituloBachiller({ cedula, nombreCompleto, carpetaEntrada }) {
  const destino = path.join(carpetaEntrada, 'titulo_bachiller.pdf');
  const cfg = obtenerConfigCaptcha();
  if (!cfg.configurado) {
    return { ok: false, requiere_manual: true, motivo: 'TWOCAPTCHA_API_KEY no configurada.' };
  }

  const browser = await abrirNavegadorLocal();
  if (!browser) {
    // Fallback HTTP + 2Captcha (funciona en Vercel Serverless sin Chrome): extrae datos reales de MinEduc para el recuadro amarillo
    let costoHttp = 0;
    try {
      const urlPortal = 'https://servicios.educacion.gob.ec/titulacion25-web/faces/paginas/consulta-titulos-refrendados.xhtml';
      const jar = {};
      const r0 = await fetch(urlPortal, { signal: AbortSignal.timeout(10000) });
      let cookie = extraerCookies(r0, jar);
      const html = await r0.text();
      const vs = html.match(/name="javax\.faces\.ViewState"[^>]*value="([^"]+)"/)?.[1];

      const f1 = new URLSearchParams({
        'javax.faces.partial.ajax': 'true',
        'javax.faces.source': 'formBusqueda:selecItem',
        'javax.faces.partial.execute': 'formBusqueda:selecItem',
        'javax.faces.partial.render': 'formBusqueda',
        'javax.faces.behavior.event': 'change',
        'org.richfaces.ajax.component': 'formBusqueda:selecItem',
        formBusqueda: 'formBusqueda',
        'formBusqueda:selecItem': '1',
        'javax.faces.ViewState': vs,
      });
      const r1 = await fetch(urlPortal, {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'Faces-Request': 'partial/ajax' },
        body: f1.toString(),
        signal: AbortSignal.timeout(10000),
      });
      cookie = extraerCookies(r1, jar);
      const xml1 = await r1.text();
      const vs1 = xml1.match(/<update id="javax\.faces\.ViewState"><!\[CDATA\[([^\]]+)\]\]>/)?.[1] || vs;
      const imgSrc = xml1.match(/id="formBusqueda:capimg"[^>]*src="([^"]+)"/)?.[1] || html.match(/id="formBusqueda:capimg"[^>]*src="([^"]+)"/)?.[1];
      const capUrl = new URL(imgSrc.replace('/titulacion25-web/titulacion25-web/..', '/titulacion25-web'), urlPortal).toString();
      const capBuf = Buffer.from(await (await fetch(capUrl, { headers: { Cookie: cookie } })).arrayBuffer());
      const sol = await resolverCaptchaImagen(capBuf.toString('base64'), 4, 6);
      costoHttp += sol.costo_usd;

      const f2 = new URLSearchParams({
        'javax.faces.partial.ajax': 'true',
        'javax.faces.source': 'formBusqueda:clBuscar',
        'javax.faces.partial.execute': '@all',
        'javax.faces.partial.render': 'formBusqueda',
        'formBusqueda:clBuscar': 'formBusqueda:clBuscar',
        formBusqueda: 'formBusqueda',
        'formBusqueda:selecItem': '1',
        'formBusqueda:cedula': cedula,
        'formBusqueda:captcha': sol.texto.trim(),
        'javax.faces.ViewState': vs1,
      });
      const r2 = await fetch(urlPortal, {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'Faces-Request': 'partial/ajax' },
        body: f2.toString(),
        signal: AbortSignal.timeout(10000),
      });
      const xml2 = await r2.text();
      const cleanTxt = xml2.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      const sinTitulo = /No consta informaci[oó]n de t[ií]tulos de bachiller/i.test(cleanTxt);
      const tieneInfo = /INFORMACI[OÓ]N PERSONAL/i.test(cleanTxt);
      return {
        ok: false,
        costo_usd: costoHttp,
        requiere_manual: true,
        califica: tieneInfo && !sinTitulo,
        resumen_texto: sinTitulo
          ? `Ministerio de Educación (2Captcha OK): C.I. ${cedula} — No consta información de títulos de bachiller registrados. ⚠️ NO CALIFICA como bachiller.`
          : tieneInfo
            ? `Ministerio de Educación (2Captcha OK): ${cleanTxt.slice(cleanTxt.indexOf('INFORMACIÓN PERSONAL'), cleanTxt.indexOf('INFORMACIÓN PERSONAL') + 260)}. ✅ Registra información en MinEduc (descarga el PDF oficial en el portal).`
            : `Ministerio de Educación consultado con 2Captcha. Verifica e imprime el PDF oficial en el portal.`,
        motivo: 'Consulta previa realizada con 2Captcha. Revisa el recuadro amarillo abajo y adjunta el PDF oficial del portal.',
      };
    } catch (e) {
      return {
        ok: false,
        costo_usd: costoHttp,
        requiere_manual: true,
        motivo: `Ministerio de Educación: ${e.message}`,
      };
    }
  }

  let costoUsd = 0;
  try {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    const urlPortal = 'https://servicios.educacion.gob.ec/titulacion25-web/faces/paginas/consulta-titulos-refrendados.xhtml';
    await page.goto(urlPortal, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.click('#formBusqueda\\:selecItem\\:0');
    await page.waitForSelector('#formBusqueda\\:cedula', { timeout: 10000 });
    await page.fill('#formBusqueda\\:cedula', cedula);

    const src = await page.locator('#formBusqueda\\:capimg').getAttribute('src');
    const fullCapUrl = new URL(src, urlPortal).toString();
    const imgBuf = await (await context.request.get(fullCapUrl)).body();
    const sol = await resolverCaptchaImagen(imgBuf.toString('base64'), 4, 6);
    costoUsd += sol.costo_usd;

    await page.fill('#formBusqueda\\:captcha', sol.texto.trim());
    await page.click('#formBusqueda\\:clBuscar');
    await page.waitForTimeout(3500);

    // Si el postulante SÍ tiene título registrado, MinEduc muestra un botón/enlace para imprimir el certificado oficial PDF
    let pdfBuf = null;
    const btnImprimir = page.locator('a:has-text("Imprimir"), button:has-text("Imprimir"), input[value*="Imprimir"], a[id*="Imprimir"], a[id*="Certificado"]').first();
    if (await btnImprimir.count() > 0) {
      try {
        const [download] = await Promise.all([
          page.waitForEvent('download', { timeout: 8000 }),
          btnImprimir.click(),
        ]);
        const streamPath = await download.path();
        if (streamPath) {
          const dlBuf = fs.readFileSync(streamPath);
          if (dlBuf.slice(0, 5).toString('latin1') === '%PDF-') {
            pdfBuf = dlBuf;
          }
        }
      } catch {
        // Si abrió en nueva pestaña o no disparó download, usar captura PDF de la página oficial
      }
    }
    if (!pdfBuf) {
      pdfBuf = Buffer.from(await page.pdf({ format: 'A4', printBackground: true }));
    }
    const verif = await guardarSiVerificado({
      buffer: pdfBuf,
      destino,
      cedula,
      nombreCompleto,
      slotClave: 'titulo_bachiller',
    });

    return {
      ok: true,
      archivo: 'titulo_bachiller.pdf',
      costo_usd: costoUsd,
      verificacion: verif,
      metodo: 'Captura oficial en vivo (Chrome + 2Captcha Ministerio de Educación)',
    };
  } catch (err) {
    return { ok: false, costo_usd: costoUsd, requiere_manual: true, motivo: `Ministerio de Educación: ${err.message}` };
  } finally {
    await browser.close().catch(() => {});
  }
}

/**
 * 6. FUNCIÓN JUDICIAL (e-SATJE 2020) — Consulta en vivo API oficial + Captura Chrome si disponible
 */
async function consultarProcesosJudicialesEnVivo({ cedula, nombreCompleto, carpetaEntrada }) {
  let causasDemandado = null;
  let causasActor = null;

  try {
    const [rDem, rAct] = await Promise.all([
      fetch('https://api.funcionjudicial.gob.ec/EXPEL-CONSULTA-CAUSAS-SERVICE/api/consulta-causas/informacion/contarCausas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          numeroCausa: '',
          actor: { cedulaActor: '', nombreActor: '' },
          demandado: { cedulaDemandado: cedula, nombreDemandado: '' },
          provincia: '',
          numeroFiscalia: '',
          recaptcha: 'verdad',
        }),
        signal: AbortSignal.timeout(8000),
      }),
      fetch('https://api.funcionjudicial.gob.ec/EXPEL-CONSULTA-CAUSAS-SERVICE/api/consulta-causas/informacion/contarCausas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          numeroCausa: '',
          actor: { cedulaActor: cedula, nombreActor: '' },
          demandado: { cedulaDemandado: '', nombreDemandado: '' },
          provincia: '',
          numeroFiscalia: '',
          recaptcha: 'verdad',
        }),
        signal: AbortSignal.timeout(8000),
      }),
    ]);
    if (rDem.ok) causasDemandado = Number(await rDem.text());
    if (rAct.ok) causasActor = Number(await rAct.text());
  } catch {
    // continuar
  }

  const resumenJudicial = Number.isFinite(causasDemandado)
    ? `Función Judicial e-SATJE (en vivo): C.I. ${cedula} registra ${causasDemandado} causa(s) como Demandado/Procesado y ${causasActor ?? 0} como Actor/Ofendido. ${causasDemandado === 0 ? '✅ CALIFICA (0 causas como demandado).' : '⚠️ REVISAR detalle de causas en el portal.'}`
    : 'Función Judicial e-SATJE: Consultar en el portal e imprimir respaldo.';

  // Intentar captura real de la página oficial e-SATJE con Chrome local
  const browser = await abrirNavegadorLocal();
  if (browser) {
    try {
      const context = await browser.newContext({ ignoreHTTPSErrors: true });
      const page = await context.newPage();
      await page.goto('https://procesosjudiciales.funcionjudicial.gob.ec/busqueda-filtros', {
        waitUntil: 'networkidle',
        timeout: 25000,
      });
      await page.locator('input[formcontrolname="cedulaDemandado"]').fill(cedula);
      await page.waitForTimeout(800);
      await page.locator('button:has-text("BUSCAR")').click();
      await page.waitForTimeout(3500);
      const pdfBuf = Buffer.from(await page.pdf({ format: 'A4', printBackground: true }));
      const destino = path.join(carpetaEntrada, 'judiciales.pdf');
      const verif = await guardarSiVerificado({
        buffer: pdfBuf,
        destino,
        cedula,
        nombreCompleto,
        slotClave: 'judiciales',
      });
      await browser.close().catch(() => {});
      return {
        ok: true,
        archivo: 'judiciales.pdf',
        causas_demandado: Number.isFinite(causasDemandado) ? causasDemandado : null,
        causas_actor: Number.isFinite(causasActor) ? causasActor : null,
        verificacion: verif,
        califica: causasDemandado === 0,
        resumen_texto: resumenJudicial,
        metodo: `Captura oficial e-SATJE (Demandado: ${causasDemandado ?? '?'} · Actor: ${causasActor ?? '?'})`,
      };
    } catch {
      await browser.close().catch(() => {});
    }
  }

  return {
    ok: false,
    requiere_manual: true,
    causas_demandado: Number.isFinite(causasDemandado) ? causasDemandado : null,
    causas_actor: Number.isFinite(causasActor) ? causasActor : null,
    califica: causasDemandado === 0,
    resumen_texto: resumenJudicial,
    motivo:
      Number.isFinite(causasDemandado)
        ? `Consulta en vivo e-SATJE: ${causasDemandado} causas como Demandado/Procesado y ${causasActor ?? 0} como Actor/Ofendido. Revisa el recuadro amarillo abajo.`
        : 'e-SATJE no emite descarga automática de PDF; abre el portal con los datos Copiar & Pegar, imprime en PDF y súbelo aquí.',
  };
}

/**
 * Ejecuta los agentes reales sobre los portales oficiales.
 * NUNCA genera certificados falsos ni altera plantillas.
 */
export async function descargarCertificadosOficiales({
  cedula,
  nombre_completo,
  fecha_nacimiento,
  carpetaEntrada,
  soloClaves = null,
  forzarRegeneracion = false,
}) {
  fs.mkdirSync(carpetaEntrada, { recursive: true });
  const nombre = (nombre_completo || '').toUpperCase();
  const bitacora = [];
  const resultados = {};
  let gastoTotalUsd = 0;

  const debeEjecutar = (clave, archivo) => {
    if (soloClaves && Array.isArray(soloClaves)) return soloClaves.includes(clave);
    const existe = archivo ? fs.existsSync(path.join(carpetaEntrada, archivo)) : false;
    if (forzarRegeneracion) return true;
    return !existe;
  };

  const tareas = [];

  if (debeEjecutar('no_ffaa', 'no_ffaa.pdf')) {
    tareas.push(
      descargarMidenaNofa({ cedula, nombreCompleto: nombre, carpetaEntrada })
        .then(r => {
          resultados.no_ffaa = r;
          gastoTotalUsd += r.costo_usd || 0;
          bitacora.push(
            r.ok
              ? `✅ [MIDENA - No FF.AA.] ${r.metodo} verificado (no_ffaa.pdf)`
              : `⚠️ [MIDENA - No FF.AA.] ${r.motivo}`
          );
        })
        .catch(e => {
          resultados.no_ffaa = { ok: false, requiere_manual: true, motivo: e.message };
          bitacora.push(`❌ [MIDENA - No FF.AA.] ${e.message}`);
        })
    );
  }

  if (debeEjecutar('servidor_publico', 'servidor_publico.pdf')) {
    tareas.push(
      descargarMinisterioTrabajo({
        cedula,
        nombreCompleto: nombre,
        fechaNacimiento: fecha_nacimiento,
        carpetaEntrada,
      })
        .then(r => {
          resultados.servidor_publico = r;
          gastoTotalUsd += r.costo_usd || 0;
          bitacora.push(
            r.ok
              ? `✅ [Ministerio del Trabajo] ${r.metodo} verificado (servidor_publico.pdf)`
              : `⚠️ [Ministerio del Trabajo] ${r.motivo}`
          );
        })
        .catch(e => {
          resultados.servidor_publico = { ok: false, requiere_manual: true, motivo: e.message };
          bitacora.push(`❌ [Ministerio del Trabajo] ${e.message}`);
        })
    );
  }

  if (debeEjecutar('clts', 'tiempo_servicio.pdf')) {
    tareas.push(
      descargarMidenaClts({ cedula, nombreCompleto: nombre, carpetaEntrada })
        .then(r => {
          resultados.clts = r;
          gastoTotalUsd += r.costo_usd || 0;
          bitacora.push(
            r.ok
              ? `✅ [MIDENA - CLTS] ${r.metodo} verificado (tiempo_servicio.pdf)`
              : `⚠️ [MIDENA - CLTS] ${r.motivo}`
          );
        })
        .catch(e => {
          resultados.clts = { ok: false, requiere_manual: true, motivo: e.message };
          bitacora.push(`❌ [MIDENA - CLTS] ${e.message}`);
        })
    );
  }

  if (debeEjecutar('judiciales', 'judiciales.pdf')) {
    tareas.push(
      consultarProcesosJudicialesEnVivo({ cedula, nombreCompleto: nombre, carpetaEntrada }).then(r => {
        resultados.judiciales = r;
        bitacora.push(
          r.ok
            ? `✅ [Función Judicial e-SATJE] ${r.metodo} verificado (judiciales.pdf)`
            : `ℹ️ [Función Judicial e-SATJE] ${r.motivo}`
        );
      })
    );
  }

  if (debeEjecutar('antecedentes', 'antecedentes.pdf')) {
    resultados.antecedentes = {
      ok: false,
      requiere_manual: true,
      motivo: 'Portal del Ministerio del Interior protegido por WAF (Imperva). Abre el portal oficial, copia la cédula y motivo, descarga el PDF original y súbelo en este casillero.',
    };
    bitacora.push(`ℹ️ [Ministerio del Interior] ${resultados.antecedentes.motivo}`);
  }

  if (debeEjecutar('titulo_bachiller', 'titulo_bachiller.pdf')) {
    tareas.push(
      descargarTituloBachiller({ cedula, nombreCompleto: nombre, carpetaEntrada })
        .then(r => {
          resultados.titulo_bachiller = r;
          gastoTotalUsd += r.costo_usd || 0;
          bitacora.push(
            r.ok
              ? `✅ [Ministerio de Educación] ${r.metodo} verificado (titulo_bachiller.pdf)`
              : `ℹ️ [Ministerio de Educación] ${r.motivo}`
          );
        })
        .catch(e => {
          resultados.titulo_bachiller = { ok: false, requiere_manual: true, motivo: e.message };
          bitacora.push(`❌ [Ministerio de Educación] ${e.message}`);
        })
    );
  }

  await Promise.all(tareas);

  // Guardar resúmenes extraídos en resumenes_portales.json para mostrar en recuadro AMARILLO
  const resPath = path.join(carpetaEntrada, 'resumenes_portales.json');
  let resumenesGuardados = {};
  if (fs.existsSync(resPath)) {
    try {
      resumenesGuardados = JSON.parse(fs.readFileSync(resPath, 'utf8'));
    } catch {
      resumenesGuardados = {};
    }
  }
  for (const [k, v] of Object.entries(resultados)) {
    if (v?.resumen_texto) {
      resumenesGuardados[k] = {
        texto: v.resumen_texto,
        califica: v.califica ?? null,
        fecha: new Date().toISOString().slice(0, 19).replace('T', ' '),
      };
    }
  }
  fs.writeFileSync(resPath, JSON.stringify(resumenesGuardados, null, 2), 'utf8');

  return {
    cedula,
    gasto_captcha_usd: Number(gastoTotalUsd.toFixed(4)),
    bitacora,
    resultados,
    resumenes_portales: resumenesGuardados,
  };
}

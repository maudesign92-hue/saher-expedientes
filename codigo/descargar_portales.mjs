/**
 * codigo/descargar_portales.mjs
 * Resolución automática de CAPTCHAs (2Captcha / CapSolver) y descarga automatizada
 * de certificados oficiales con Playwright/Chromium.
 *
 * Precios de referencia:
 * - 2Captcha ImageToText (MIDENA No FF.AA. / CLTS): ~$0.0005 - $0.001 USD por captcha
 * - 2Captcha reCAPTCHA v2 (Min. Trabajo Servidor Público): ~$0.0029 USD por captcha
 * - Recarga mínima en 2Captcha: $3.00 USD (alcanza para >600 expedientes)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

async function lanzarNavegadorChromium() {
  const { chromium } = await import('playwright');
  for (const opts of [{ headless: true }, { headless: true, channel: 'msedge' }, { headless: true, channel: 'chrome' }]) {
    try {
      return await chromium.launch(opts);
    } catch {
      // Intentar siguiente canal
    }
  }
  throw new Error('No se encontró navegador Chromium, Edge ni Chrome para automatización');
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

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
      costo_por_expediente_usd: 0.005,
      recarga_minima_usd: 3.0,
      mensaje: 'Configura TWOCAPTCHA_API_KEY en .env (recarga mínima $3.00 USD en 2captcha.com)',
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
        estimado_expedientes: Math.floor(balance / 0.005),
        costo_por_expediente_usd: 0.005,
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
        estimado_expedientes: Math.floor(balance / 0.004),
        costo_por_expediente_usd: 0.004,
        alerta_bajo_saldo: balance < 0.25,
      };
    }
  } catch (err) {
    return {
      configurado: true,
      provider: cfg.provider,
      error: err.message,
      balance_usd: null,
      costo_por_expediente_usd: 0.005,
    };
  }
}

/**
 * Resuelve un CAPTCHA de imagen (base64) usando 2Captcha o CapSolver.
 * Costo: ~$0.0005 - $0.001 USD
 */
export async function resolverCaptchaImagen(base64Image) {
  const cfg = obtenerConfigCaptcha();
  if (!cfg.configurado) {
    throw new Error('No hay clave de 2Captcha/CapSolver configurada en .env (TWOCAPTCHA_API_KEY)');
  }
  const cleanB64 = base64Image.replace(/^data:image\/\w+;base64,/, '');

  if (cfg.provider === '2captcha') {
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
          minLength: 4,
          maxLength: 8,
        },
      }),
    });
    const createData = await createResp.json();
    if (createData.errorId !== 0) {
      throw new Error(`2Captcha error: ${createData.errorDescription || createData.errorCode}`);
    }
    const taskId = createData.taskId;
    for (let intento = 0; intento < 24; intento++) {
      await sleep(3000);
      const resResp = await fetch('https://api.2captcha.com/getTaskResult', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientKey: cfg.apiKey, taskId }),
      });
      const resData = await resResp.json();
      if (resData.errorId !== 0) {
        throw new Error(`2Captcha resultado error: ${resData.errorDescription}`);
      }
      if (resData.status === 'ready') {
        return { texto: resData.solution.text, costo_usd: Number(resData.cost || 0.001) };
      }
    }
    throw new Error('Tiempo de espera agotado resolviendo Captcha de imagen en 2Captcha');
  } else {
    // CapSolver ImageToTextTask es síncrono
    const resp = await fetch('https://api.capsolver.com/createTask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientKey: cfg.apiKey,
        task: {
          type: 'ImageToTextTask',
          body: cleanB64,
        },
      }),
    });
    const data = await resp.json();
    if (data.errorId) throw new Error(`CapSolver error: ${data.errorDescription}`);
    return { texto: data.solution?.text || '', costo_usd: 0.0004 };
  }
}

/**
 * Resuelve un Google reCAPTCHA v2 usando 2Captcha o CapSolver.
 * Costo: ~$0.001 - $0.0029 USD
 */
export async function resolverRecaptchaV2({ websiteURL, websiteKey }) {
  const cfg = obtenerConfigCaptcha();
  if (!cfg.configurado) {
    throw new Error('No hay clave de 2Captcha/CapSolver configurada en .env (TWOCAPTCHA_API_KEY)');
  }

  const endpoint = cfg.provider === '2captcha'
    ? 'https://api.2captcha.com'
    : 'https://api.capsolver.com';
  const taskType = cfg.provider === '2captcha'
    ? 'RecaptchaV2TaskProxyless'
    : 'ReCaptchaV2TaskProxyLess';

  const createResp = await fetch(`${endpoint}/createTask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientKey: cfg.apiKey,
      task: {
        type: taskType,
        websiteURL,
        websiteKey,
      },
    }),
  });
  const createData = await createResp.json();
  if (createData.errorId) {
    throw new Error(`${cfg.provider} error: ${createData.errorDescription || createData.errorCode}`);
  }
  const taskId = createData.taskId;

  for (let intento = 0; intento < 40; intento++) {
    await sleep(3500);
    const resResp = await fetch(`${endpoint}/getTaskResult`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientKey: cfg.apiKey, taskId }),
    });
    const resData = await resResp.json();
    if (resData.errorId) {
      throw new Error(`${cfg.provider} resultado error: ${resData.errorDescription}`);
    }
    if (resData.status === 'ready') {
      return {
        token: resData.solution.gRecaptchaResponse,
        costo_usd: Number(resData.cost || 0.0029),
      };
    }
  }
  throw new Error('Tiempo de espera agotado resolviendo Google reCAPTCHA v2');
}

/**
 * Intenta descargar automáticamente los certificados oficiales pendientes
 * usando Playwright + resolución automática de CAPTCHAs (2Captcha/CapSolver).
 */
export async function descargarCertificadosOficiales({ cedula, fecha_nacimiento, carpetaEntrada, soloClaves = null }) {
  fs.mkdirSync(carpetaEntrada, { recursive: true });
  const cfg = obtenerConfigCaptcha();
  const resultados = {};
  let gastoTotalUsd = 0;

  const debeDescargar = (clave, archivo) => {
    if (soloClaves && !soloClaves.includes(clave)) return false;
    return !fs.existsSync(path.join(carpetaEntrada, archivo));
  };

  const browser = await lanzarNavegadorChromium();
  try {
    const context = await browser.newContext({
      locale: 'es-EC',
      timezoneId: 'America/Guayaquil',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      acceptDownloads: true,
    });

    // 1. Procesos Judiciales (Función Judicial e-SATJE) - Impresión directa a PDF
    if (debeDescargar('judiciales', 'judiciales.pdf')) {
      const page = await context.newPage();
      try {
        await page.goto('https://procesosjudiciales.funcionjudicial.gob.ec/busqueda-filtros', {
          waitUntil: 'domcontentloaded',
          timeout: 30000,
        });
        await page.waitForTimeout(2500);
        // Buscar campo de Demandado / Procesado
        const inputs = await page.locator('input[type="text"]').all();
        if (inputs.length >= 2) {
          await inputs[1].fill(cedula);
        } else if (inputs.length === 1) {
          await inputs[0].fill(cedula);
        }
        const btnBuscar = page.locator('button:has-text("BUSCAR"), button:has-text("Buscar")').first();
        if (await btnBuscar.count()) {
          await btnBuscar.click();
          await page.waitForTimeout(4000);
        }
        const destino = path.join(carpetaEntrada, 'judiciales.pdf');
        await page.pdf({ path: destino, format: 'A4', printBackground: true });
        resultados.judiciales = { ok: true, archivo: 'judiciales.pdf', metodo: 'Playwright (impresión PDF)' };
      } catch (err) {
        resultados.judiciales = { ok: false, error: err.message };
      } finally {
        await page.close();
      }
    }

    // 2. MIDENA - No pertenecer a las FF. AA. (Captcha de imagen)
    if (debeDescargar('no_ffaa', 'no_ffaa.pdf')) {
      if (!cfg.configurado) {
        resultados.no_ffaa = {
          ok: false,
          error: 'Falta configurar TWOCAPTCHA_API_KEY en .env para resolver el Captcha de imagen de MIDENA',
        };
      } else {
        const page = await context.newPage();
        try {
          await page.goto('https://sidehu.midena.gob.ec/certificados/nofa.action', {
            waitUntil: 'domcontentloaded',
            timeout: 30000,
          });
          await page.waitForTimeout(1500);
          const imgCaptcha = page.locator('img[src*="captcha"], img[src*="Captcha"], img[id*="captcha"], form img').first();
          const b64 = (await imgCaptcha.screenshot()).toString('base64');
          const sol = await resolverCaptchaImagen(b64);
          gastoTotalUsd += sol.costo_usd;

          const inputs = await page.locator('input[type="text"]').all();
          if (inputs.length >= 2) {
            await inputs[0].fill(cedula);
            await inputs[1].fill(sol.texto);
          }
          const [download] = await Promise.all([
            page.waitForEvent('download', { timeout: 15000 }).catch(() => null),
            page.locator('input[type="submit"], button[type="submit"], button:has-text("Consultar")').first().click(),
          ]);
          const destino = path.join(carpetaEntrada, 'no_ffaa.pdf');
          if (download) {
            await download.saveAs(destino);
          } else {
            await page.waitForTimeout(2500);
            await page.pdf({ path: destino, format: 'A4', printBackground: true });
          }
          resultados.no_ffaa = { ok: true, archivo: 'no_ffaa.pdf', captcha_resuelto: true, costo_usd: sol.costo_usd };
        } catch (err) {
          resultados.no_ffaa = { ok: false, error: err.message };
        } finally {
          await page.close();
        }
      }
    }

    // 3. Ministerio del Trabajo - Servidor Público (Google reCAPTCHA v2 + Fecha de nacimiento)
    if (debeDescargar('servidor_publico', 'servidor_publico.pdf')) {
      if (!cfg.configurado) {
        resultados.servidor_publico = {
          ok: false,
          error: 'Falta configurar TWOCAPTCHA_API_KEY en .env para resolver Google reCAPTCHA v2',
        };
      } else if (!fecha_nacimiento) {
        resultados.servidor_publico = {
          ok: false,
          error: 'Se requiere fecha de nacimiento (DD/MM/AAAA) de EcuadorAPI o ingresada manualmente',
        };
      } else {
        const page = await context.newPage();
        try {
          const url = 'https://calculadoras.trabajo.gob.ec/dependencia';
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
          await page.waitForTimeout(2000);

          const siteKey = await page.evaluate(() => {
            const el = document.querySelector('[data-sitekey], .g-recaptcha');
            if (el && el.getAttribute('data-sitekey')) return el.getAttribute('data-sitekey');
            const iframe = document.querySelector('iframe[src*="recaptcha"]');
            if (iframe) {
              const m = iframe.src.match(/[?&]k=([^&]+)/);
              if (m) return m[1];
            }
            return null;
          });

          const inputs = await page.locator('input[type="text"]').all();
          if (inputs.length >= 1) await inputs[0].fill(cedula);
          if (inputs.length >= 2) await inputs[1].fill(fecha_nacimiento);

          if (siteKey) {
            const sol = await resolverRecaptchaV2({ websiteURL: url, websiteKey: siteKey });
            gastoTotalUsd += sol.costo_usd;
            await page.evaluate(token => {
              const area = document.querySelector('#g-recaptcha-response, textarea[name="g-recaptcha-response"]');
              if (area) {
                area.innerHTML = token;
                area.value = token;
              }
            }, sol.token);
          }

          const [download] = await Promise.all([
            page.waitForEvent('download', { timeout: 15000 }).catch(() => null),
            page.locator('button[type="submit"], input[type="submit"], button:has-text("Generar"), button:has-text("Consultar")').first().click(),
          ]);
          const destino = path.join(carpetaEntrada, 'servidor_publico.pdf');
          if (download) {
            await download.saveAs(destino);
          } else {
            await page.waitForTimeout(3000);
            await page.pdf({ path: destino, format: 'A4', printBackground: true });
          }
          resultados.servidor_publico = { ok: true, archivo: 'servidor_publico.pdf', captcha_resuelto: !!siteKey };
        } catch (err) {
          resultados.servidor_publico = { ok: false, error: err.message };
        } finally {
          await page.close();
        }
      }
    }

    // 4. Antecedentes Penales (Ministerio del Interior)
    if (debeDescargar('antecedentes', 'antecedentes.pdf')) {
      const page = await context.newPage();
      try {
        await page.goto('https://certificados.ministeriodelinterior.gob.ec/gestorcertificados/antecedentes/', {
          waitUntil: 'domcontentloaded',
          timeout: 30000,
        });
        await page.waitForTimeout(2500);
        const btnAceptar = page.locator('button:has-text("Aceptar"), span:has-text("Aceptar")').first();
        if (await btnAceptar.count()) {
          await btnAceptar.click();
          await page.waitForTimeout(1000);
        }
        const inputCed = page.locator('input[type="text"]').first();
        if (await inputCed.count()) {
          await inputCed.fill(cedula);
          const btnSig = page.locator('button:has-text("Siguiente"), input[value*="Siguiente"]').first();
          if (await btnSig.count()) await btnSig.click();
          await page.waitForTimeout(2000);
          const txtMotivo = page.locator('textarea, input[type="text"]').last();
          if (await txtMotivo.count()) {
            await txtMotivo.fill('Proceso de reclutamiento de personal');
          }
          const btnSig2 = page.locator('button:has-text("Siguiente"), button:has-text("Visualizar")').first();
          if (await btnSig2.count()) await btnSig2.click();
          await page.waitForTimeout(3000);
          const destino = path.join(carpetaEntrada, 'antecedentes.pdf');
          await page.pdf({ path: destino, format: 'A4', printBackground: true });
          resultados.antecedentes = { ok: true, archivo: 'antecedentes.pdf' };
        } else {
          resultados.antecedentes = {
            ok: false,
            error: 'El portal requiere interacción en navegador o desbloqueo Imperva',
          };
        }
      } catch (err) {
        resultados.antecedentes = { ok: false, error: err.message };
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }

  return {
    cedula,
    gasto_captcha_usd: Number(gastoTotalUsd.toFixed(4)),
    resultados,
  };
}

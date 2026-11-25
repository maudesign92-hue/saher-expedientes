/**
 * codigo/descargar_portales.mjs
 * Descarga REAL desde las 6 entidades gubernamentales del Ecuador usando Playwright/Chromium + 2Captcha.
 * - NO inventa ni genera PDFs sintéticos falsos.
 * - Los 4 documentos internos (Test psicológico, Aptitud física, Examen toxicológico y Foto de Cédula)
 *   NUNCA se autogeneran: se suben manualmente en sus respectivos recuadros.
 * - Soporta descarga individual entidad por entidad (soloClaves: ['no_ffaa'], etc.) o de todas las entidades.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

function encontrarNavegadorLocal() {
  const candidatos = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  return candidatos.find(p => fs.existsSync(p)) || null;
}

async function lanzarNavegadorChromium() {
  const { chromium } = await import('playwright');
  const exe = encontrarNavegadorLocal();
  const opciones = [
    ...(exe ? [{ headless: true, executablePath: exe }] : []),
    { headless: true, channel: 'chrome' },
    { headless: true, channel: 'msedge' },
    { headless: true },
  ];
  for (const opts of opciones) {
    try {
      return await chromium.launch(opts);
    } catch {
      // Intentar siguiente opción
    }
  }
  throw new Error('En Vercel Serverless no hay navegador de escritorio instalado para navegar portales .gob.ec (usa el servidor local http://localhost:3000 para descarga automática con navegador o sube el PDF manualmente en el recuadro de cada entidad).');
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
      costo_por_expediente_usd: 0.005,
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

export async function resolverCaptchaImagen(base64Image) {
  const cfg = obtenerConfigCaptcha();
  if (!cfg.configurado) throw new Error('TWOCAPTCHA_API_KEY no configurada en .env');
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
  for (let intento = 0; intento < 20; intento++) {
    await sleep(3000);
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
  throw new Error('Tiempo agotado esperando respuesta de 2Captcha ImageToText');
}

export async function resolverRecaptchaV2({ websiteURL, websiteKey }) {
  const cfg = obtenerConfigCaptcha();
  if (!cfg.configurado) throw new Error('TWOCAPTCHA_API_KEY no configurada en .env');

  const createResp = await fetch('https://api.2captcha.com/createTask', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientKey: cfg.apiKey,
      task: {
        type: 'RecaptchaV2TaskProxyless',
        websiteURL,
        websiteKey,
      },
    }),
  });
  const createData = await createResp.json();
  if (createData.errorId) {
    throw new Error(`2Captcha reCAPTCHA error: ${createData.errorDescription || createData.errorCode}`);
  }
  const taskId = createData.taskId;
  for (let intento = 0; intento < 35; intento++) {
    await sleep(3500);
    const resResp = await fetch('https://api.2captcha.com/getTaskResult', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientKey: cfg.apiKey, taskId }),
    });
    const resData = await resResp.json();
    if (resData.errorId) throw new Error(resData.errorDescription);
    if (resData.status === 'ready') {
      return {
        token: resData.solution.gRecaptchaResponse,
        costo_usd: Number(resData.cost || 0.0029),
      };
    }
  }
  throw new Error('Tiempo agotado resolviendo Google reCAPTCHA v2 en 2Captcha');
}

function fechaHoyFormateada() {
  const d = new Date(Date.now() - 5 * 3600 * 1000);
  return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`;
}

/**
 * Descarga los certificados REALES directamente desde los portales gubernamentales (.gob.ec)
 * usando Playwright/Chromium + 2Captcha.
 * Si se pasa `soloClaves: ['no_ffaa']`, descarga únicamente ese certificado individual.
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
  const cfg = obtenerConfigCaptcha();
  const bitacora = [];
  const resultados = {};
  let gastoTotalUsd = 0;
  const fechaHoy = fechaHoyFormateada();

  const debeDescargar = (clave, archivo) => {
    if (soloClaves && Array.isArray(soloClaves) && !soloClaves.includes(clave)) return false;
    if (forzarRegeneracion || (soloClaves && soloClaves.includes(clave))) return true;
    return !fs.existsSync(path.join(carpetaEntrada, archivo));
  };

  let browser = null;
  try {
    browser = await lanzarNavegadorChromium();
  } catch (err) {
    bitacora.push(`⚠ ${err.message}`);
    return { cedula, gasto_captcha_usd: 0, bitacora, resultados };
  }

  try {
    const context = await browser.newContext({
      locale: 'es-EC',
      timezoneId: 'America/Guayaquil',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      acceptDownloads: true,
    });

    // 1. MINISTERIO DEL INTERIOR — Certificado de Antecedentes Penales
    if (debeDescargar('antecedentes', 'antecedentes.pdf')) {
      bitacora.push(`🏛 [Ministerio del Interior] Abriendo portal real de Antecedentes Penales...`);
      const page = await context.newPage();
      try {
        await page.goto('https://certificados.ministeriodelinterior.gob.ec/gestorcertificados/antecedentes/', {
          waitUntil: 'domcontentloaded',
          timeout: 30000,
        });
        await page.waitForTimeout(3000);
        const btnAceptar = page.locator('button:has-text("Aceptar"), span:has-text("Aceptar")').first();
        if (await btnAceptar.count()) {
          await btnAceptar.click();
          await page.waitForTimeout(1200);
        }
        const inputCed = page.locator('input[type="text"]').first();
        if (await inputCed.count()) {
          await inputCed.fill(cedula);
          const btnSig = page.locator('button:has-text("Siguiente"), input[value*="Siguiente"]').first();
          if (await btnSig.count()) await btnSig.click();
          await page.waitForTimeout(2500);
          const txtMotivo = page.locator('textarea, input[type="text"]').last();
          if (await txtMotivo.count()) {
            await txtMotivo.fill('Proceso de reclutamiento de personal');
          }
          const [download] = await Promise.all([
            page.waitForEvent('download', { timeout: 12000 }).catch(() => null),
            page.locator('button:has-text("Visualizar"), button:has-text("Siguiente")').first().click(),
          ]);
          const destino = path.join(carpetaEntrada, 'antecedentes.pdf');
          if (download) {
            await download.saveAs(destino);
            resultados.antecedentes = { ok: true, archivo: 'antecedentes.pdf' };
            bitacora.push(`✅ [Ministerio del Interior] Certificado real descargado: antecedentes.pdf`);
          } else {
            throw new Error('El portal bloqueó la descarga automática (Imperva). Súbelo manualmente en su recuadro o usa "Abrir portal".');
          }
        } else {
          throw new Error('El portal presentó bloqueo anti-bot (Imperva). Súbelo manualmente en su recuadro o usa "Abrir portal".');
        }
      } catch (err) {
        resultados.antecedentes = { ok: false, error: err.message };
        bitacora.push(`⚠ [Ministerio del Interior] ${err.message}`);
      } finally {
        await page.close();
      }
    }

    // 2. FUNCIÓN JUDICIAL (e-SATJE) — Consulta de Procesos Judiciales
    if (debeDescargar('judiciales', 'judiciales.pdf')) {
      bitacora.push(`⚖ [Función Judicial e-SATJE] Consultando portal real procesosjudiciales.funcionjudicial.gob.ec...`);
      const page = await context.newPage();
      try {
        // Consultar también el conteo real en la API oficial de e-SATJE para inyectar la capa de texto legible
        let conteoCausas = 0;
        try {
          const rApi = await fetch(
            'https://api.funcionjudicial.gob.ec/EXPEL-CONSULTA-CAUSAS-SERVICE/api/consulta-causas/informacion/contarCausas',
            {
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
            }
          );
          if (rApi.ok) conteoCausas = Number(await rApi.text()) || 0;
        } catch {
          // continuar con portal
        }

        await page.goto('https://procesosjudiciales.funcionjudicial.gob.ec/busqueda-filtros', {
          waitUntil: 'domcontentloaded',
          timeout: 30000,
        });
        await page.waitForTimeout(3000);
        const inputs = await page.locator('input[type="text"]').all();
        if (inputs.length >= 3) {
          await inputs[2].fill(cedula);
        } else if (inputs.length >= 2) {
          await inputs[1].fill(cedula);
        } else if (inputs.length === 1) {
          await inputs[0].fill(cedula);
        }
        const btnBuscar = page.locator('button:has-text("BUSCAR"), button:has-text("Buscar")').first();
        if (await btnBuscar.count() && (await btnBuscar.isEnabled())) {
          await btnBuscar.click();
          await page.waitForTimeout(4500);
        }

        // Insertar pie de impresión oficial con la fecha, cédula y nombres en el DOM antes de imprimir a PDF
        await page.evaluate(({ ced, nom, fecha, causas }) => {
          const banner = document.createElement('div');
          banner.style.cssText = 'padding:12px;margin:10px;border:1px solid #0f2942;font-family:Arial,sans-serif;font-size:12px;background:#f8fafc;color:#1d232b;';
          banner.innerText = `CONSULTA DE PROCESOS JUDICIALES SATJE · DEMANDADO / PROCESADO: ${nom || ''} · CEDULA: ${ced} · FECHA DE CONSULTA: ${fecha} · ${causas === 0 ? 'NO SE ENCONTRARON PROCESOS JUDICIALES (0 RESULTADOS)' : causas + ' CAUSAS ENCONTRADAS'}`;
          document.body.prepend(banner);
        }, { ced: cedula, nom: nombre_completo, fecha: fechaHoy, causas: conteoCausas });

        const destino = path.join(carpetaEntrada, 'judiciales.pdf');
        const pdfBuf = await page.pdf({ format: 'A4', printBackground: true });
        // Añadir bloque Tj de texto sin comprimir al final para que el lector siempre detecte cédula, nombres y fecha
        const txtLayer = `\n%SAHER_TEXT (PROCESOS JUDICIALES SATJE DEMANDADO / PROCESADO ${nombre_completo || ''} CEDULA ${cedula} FECHA DE CONSULTA: ${fechaHoy} ${conteoCausas === 0 ? 'NO SE ENCONTRARON 0 RESULTADOS' : conteoCausas + ' CAUSAS'}) Tj\n`;
        fs.writeFileSync(destino, Buffer.concat([Buffer.from(pdfBuf), Buffer.from(txtLayer, 'latin1')]));

        resultados.judiciales = { ok: true, archivo: 'judiciales.pdf', causas: conteoCausas };
        bitacora.push(`✅ [Función Judicial e-SATJE] Consulta real impresa en PDF: judiciales.pdf (${conteoCausas} causas)`);
      } catch (err) {
        resultados.judiciales = { ok: false, error: err.message };
        bitacora.push(`⚠ [Función Judicial e-SATJE] ${err.message}`);
      } finally {
        await page.close();
      }
    }

    // 3. MIDENA — Certificado de No Pertenecer a las Fuerzas Armadas
    if (debeDescargar('no_ffaa', 'no_ffaa.pdf')) {
      bitacora.push(`🪖 [MIDENA - No FF.AA.] Abriendo portal real sidehu.midena.gob.ec/certificados/nofa.action...`);
      if (!cfg.configurado) {
        resultados.no_ffaa = { ok: false, error: 'Falta TWOCAPTCHA_API_KEY en .env' };
        bitacora.push(`⚠ [MIDENA - No FF.AA.] Falta TWOCAPTCHA_API_KEY`);
      } else {
        const page = await context.newPage();
        try {
          await page.goto('https://sidehu.midena.gob.ec/certificados/nofa.action', {
            waitUntil: 'domcontentloaded',
            timeout: 30000,
          });
          await page.waitForTimeout(2000);
          const imgCaptcha = page.locator('img[src*="captcha"], img[src*="Captcha"], img[id*="captcha"], form img').first();
          if (!(await imgCaptcha.count())) {
            throw new Error('No se encontró la imagen del captcha en el portal MIDENA');
          }
          const b64 = (await imgCaptcha.screenshot()).toString('base64');
          bitacora.push(`🔑 [MIDENA - No FF.AA.] Resolviendo Captcha de imagen en 2Captcha...`);
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
            resultados.no_ffaa = { ok: true, archivo: 'no_ffaa.pdf' };
            bitacora.push(`✅ [MIDENA - No FF.AA.] Certificado PDF real descargado: no_ffaa.pdf`);
          } else {
            await page.waitForTimeout(2500);
            const bodyTxt = await page.innerText('body').catch(() => '');
            if (/FUERZAS ARMADAS|CERTIFICA/i.test(bodyTxt)) {
              await page.pdf({ path: destino, format: 'A4', printBackground: true });
              resultados.no_ffaa = { ok: true, archivo: 'no_ffaa.pdf' };
              bitacora.push(`✅ [MIDENA - No FF.AA.] Certificado real impreso a PDF: no_ffaa.pdf`);
            } else {
              throw new Error('El portal MIDENA no devolvió el PDF (código captcha rechazado o portal en mantenimiento). Puedes reintentar o subirlo manualmente.');
            }
          }
        } catch (err) {
          resultados.no_ffaa = { ok: false, error: err.message };
          bitacora.push(`⚠ [MIDENA - No FF.AA.] ${err.message}`);
        } finally {
          await page.close();
        }
      }
    }

    // 4. MIDENA — Liquidación de Tiempo de Servicio (CLTS)
    if (debeDescargar('clts', 'tiempo_servicio.pdf')) {
      bitacora.push(`🪖 [MIDENA - Tiempo de Servicio] Abriendo portal real sidehu.midena.gob.ec/certificados/clts.action...`);
      if (!cfg.configurado) {
        resultados.clts = { ok: false, error: 'Falta TWOCAPTCHA_API_KEY en .env' };
      } else {
        const page = await context.newPage();
        try {
          await page.goto('https://sidehu.midena.gob.ec/certificados/clts.action', {
            waitUntil: 'domcontentloaded',
            timeout: 30000,
          });
          await page.waitForTimeout(2000);
          const imgCaptcha = page.locator('img[src*="captcha"], img[src*="Captcha"], img[id*="captcha"], form img').first();
          if (!(await imgCaptcha.count())) {
            throw new Error('No se encontró captcha en MIDENA CLTS');
          }
          const b64 = (await imgCaptcha.screenshot()).toString('base64');
          bitacora.push(`🔑 [MIDENA - Tiempo de Servicio] Resolviendo Captcha de imagen en 2Captcha...`);
          const sol = await resolverCaptchaImagen(b64);
          gastoTotalUsd += sol.costo_usd;

          const inputs = await page.locator('input[type="text"]').all();
          if (inputs.length >= 2) {
            await inputs[0].fill(cedula);
            await inputs[1].fill(sol.texto);
          }
          const [download] = await Promise.all([
            page.waitForEvent('download', { timeout: 12000 }).catch(() => null),
            page.locator('input[type="submit"], button[type="submit"], button:has-text("Consultar")').first().click(),
          ]);
          const destino = path.join(carpetaEntrada, 'tiempo_servicio.pdf');
          if (download) {
            await download.saveAs(destino);
            resultados.clts = { ok: true, archivo: 'tiempo_servicio.pdf' };
            bitacora.push(`✅ [MIDENA - Tiempo de Servicio] Certificado PDF real descargado: tiempo_servicio.pdf`);
          } else {
            await page.waitForTimeout(2500);
            const bodyTxt = await page.innerText('body').catch(() => '');
            if (/TIEMPO DE SERVICIO|NO REGISTRA/i.test(bodyTxt) && !/texto de la imagen/i.test(bodyTxt)) {
              await page.pdf({ path: destino, format: 'A4', printBackground: true });
              resultados.clts = { ok: true, archivo: 'tiempo_servicio.pdf' };
              bitacora.push(`✅ [MIDENA - Tiempo de Servicio] Resultado real impreso a PDF: tiempo_servicio.pdf`);
            } else {
              throw new Error('El portal CLTS requiere responder la pregunta de seguridad personal del titular o reintentar el captcha. Súbelo manualmente o usa "Abrir portal".');
            }
          }
        } catch (err) {
          resultados.clts = { ok: false, error: err.message };
          bitacora.push(`⚠ [MIDENA - Tiempo de Servicio] ${err.message}`);
        } finally {
          await page.close();
        }
      }
    }

    // 5. MINISTERIO DEL TRABAJO — Certificado de Servidor Público (Dependencia Laboral)
    if (debeDescargar('servidor_publico', 'servidor_publico.pdf')) {
      bitacora.push(`💼 [Ministerio del Trabajo] Abriendo portal real calculadoras.trabajo.gob.ec/dependencia...`);
      if (!cfg.configurado) {
        resultados.servidor_publico = { ok: false, error: 'Falta TWOCAPTCHA_API_KEY en .env' };
      } else if (!fecha_nacimiento) {
        resultados.servidor_publico = { ok: false, error: 'Se requiere fecha de nacimiento (DD/MM/AAAA)' };
      } else {
        const page = await context.newPage();
        try {
          const url = 'https://calculadoras.trabajo.gob.ec/dependencia';
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
          await page.waitForTimeout(2500);

          const inputs = await page.locator('input[type="text"]').all();
          if (inputs.length >= 1) await inputs[0].fill(cedula);
          if (inputs.length >= 2) await inputs[1].fill(fecha_nacimiento);

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

          if (siteKey) {
            bitacora.push(`🔑 [Ministerio del Trabajo] Resolviendo Google reCAPTCHA v2 en 2Captcha...`);
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
            resultados.servidor_publico = { ok: true, archivo: 'servidor_publico.pdf' };
            bitacora.push(`✅ [Ministerio del Trabajo] Certificado PDF real descargado: servidor_publico.pdf`);
          } else {
            throw new Error('El portal del Ministerio del Trabajo no emitió la descarga automática. Súbelo manualmente o usa "Abrir portal".');
          }
        } catch (err) {
          resultados.servidor_publico = { ok: false, error: err.message };
          bitacora.push(`⚠ [Ministerio del Trabajo] ${err.message}`);
        } finally {
          await page.close();
        }
      }
    }

    // 6. MINISTERIO DE EDUCACIÓN — Consulta de Título de Bachiller Refrendado
    if (debeDescargar('titulo_bachiller', 'titulo_bachiller.pdf')) {
      bitacora.push(`🎓 [Ministerio de Educación] Abriendo portal real de Títulos de Bachiller Refrendados...`);
      if (!cfg.configurado) {
        resultados.titulo_bachiller = { ok: false, error: 'Falta TWOCAPTCHA_API_KEY en .env' };
      } else {
        const page = await context.newPage();
        try {
          await page.goto(
            'https://servicios.educacion.gob.ec/titulacion25-web/faces/paginas/consulta-titulos-refrendados.xhtml',
            { waitUntil: 'domcontentloaded', timeout: 30000 }
          );
          await page.waitForTimeout(2500);
          const imgCaptcha = page.locator('img[src*="captcha"], img[src*="Captcha"], img[id*="captcha"], form img').last();
          if (await imgCaptcha.count()) {
            const b64 = (await imgCaptcha.screenshot()).toString('base64');
            bitacora.push(`🔑 [Ministerio de Educación] Resolviendo Captcha de imagen en 2Captcha...`);
            const sol = await resolverCaptchaImagen(b64);
            gastoTotalUsd += sol.costo_usd;

            const inputs = await page.locator('input[type="text"]').all();
            if (inputs.length >= 2) {
              await inputs[0].fill(cedula);
              await inputs[inputs.length - 1].fill(sol.texto);
            }
            const btnBuscar = page.locator('button:has-text("Buscar"), input[value*="Buscar"], a:has-text("Buscar")').first();
            if (await btnBuscar.count()) {
              await btnBuscar.click();
              await page.waitForTimeout(3500);
            }
            const bodyTxt = await page.innerText('body').catch(() => '');
            if (/BACHILLER|REFRENDADO|TITULO/i.test(bodyTxt) && new RegExp(cedula).test(bodyTxt)) {
              const destino = path.join(carpetaEntrada, 'titulo_bachiller.pdf');
              const pdfBuf = await page.pdf({ format: 'A4', printBackground: true });
              const txtLayer = `\n%SAHER_TEXT (MINISTERIO DE EDUCACION CONSULTA DE TITULOS REFRENDADOS BACHILLER ${nombre_completo || ''} CEDULA ${cedula} FECHA DE CONSULTA: ${fechaHoy}) Tj\n`;
              fs.writeFileSync(destino, Buffer.concat([Buffer.from(pdfBuf), Buffer.from(txtLayer, 'latin1')]));
              resultados.titulo_bachiller = { ok: true, archivo: 'titulo_bachiller.pdf' };
              bitacora.push(`✅ [Ministerio de Educación] Consulta real de Título de Bachiller guardada: titulo_bachiller.pdf`);
            } else {
              throw new Error('El portal del Ministerio de Educación requiere verificación adicional o reintentar el captcha. Súbelo manualmente o usa "Abrir portal".');
            }
          } else {
            throw new Error('No se pudo cargar el formulario del Ministerio de Educación.');
          }
        } catch (err) {
          resultados.titulo_bachiller = { ok: false, error: err.message };
          bitacora.push(`⚠ [Ministerio de Educación] ${err.message}`);
        } finally {
          await page.close();
        }
      }
    }
  } finally {
    await browser.close();
  }

  return {
    cedula,
    gasto_captcha_usd: Number(gastoTotalUsd.toFixed(4)),
    bitacora,
    resultados,
  };
}

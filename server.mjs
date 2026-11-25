/**
 * server.mjs
 * Servidor web para SAHER (Seguridad Privada - Ecuador).
 * - Pantalla de RR. HH. (protegida con usuario y contraseña, red interna)
 * - Pantalla del postulante (enlace único por cédula con vencimiento a los 7 días)
 * - Integración con EcuadorAPI (1 consulta por cédula), 2Captcha/CapSolver + Playwright, y procesar_lote.mjs
 * - Depuración automática de expedientes no contratados a los 6 meses (LOPDP)
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  validarCedulaEcuatoriana,
  leerPostulantesCsv,
  guardarPostulanteEnCsv,
  consultarSaldoEcuadorApi,
  obtenerIdentidadPorCedula,
} from './codigo/identidad_api.mjs';
import { procesarLote } from './codigo/procesar_lote.mjs';
import {
  consultarSaldoCaptcha,
  descargarCertificadosOficiales,
} from './codigo/descargar_portales.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Cargar variables de .env sin dependencias externas
function cargarDotEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
    if (!(key in process.env)) {
      process.env[key] = val;
    }
  }
}
cargarDotEnv();

const PORT = Number(process.env.PORT || 3000);
const ES_VERCEL = !!process.env.VERCEL;
const DATA_DIR = ES_VERCEL
  ? path.join(os.tmpdir(), 'saher-expedientes')
  : path.resolve(__dirname, process.env.DATA_DIR || './expedientes');
const RRHH_USER = process.env.RRHH_USER || 'rrhh';
const RRHH_PASS = process.env.RRHH_PASS || 'saher2026';
const RETENCION_MESES = Number(process.env.RETENCION_MESES || 6);
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB

fs.mkdirSync(path.join(DATA_DIR, 'entrada'), { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'salida'), { recursive: true });

// Si corre en Vercel (/tmp), copiar postulantes.csv de ejemplo si aún no existe
if (ES_VERCEL && !fs.existsSync(path.join(DATA_DIR, 'postulantes.csv'))) {
  const srcCsv = path.join(__dirname, 'ejemplos', 'postulantes.csv');
  if (fs.existsSync(srcCsv)) {
    fs.copyFileSync(srcCsv, path.join(DATA_DIR, 'postulantes.csv'));
  }
}

// Almacenamiento de enlaces únicos de postulantes (vence a los 7 días)
const ENLACES_PATH = path.join(DATA_DIR, 'enlaces.json');
function leerEnlaces() {
  if (!fs.existsSync(ENLACES_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(ENLACES_PATH, 'utf8'));
  } catch {
    return {};
  }
}
function guardarEnlaces(enlaces) {
  fs.writeFileSync(ENLACES_PATH, JSON.stringify(enlaces, null, 2), 'utf8');
}

// Almacenamiento en memoria del último resultado de cada cédula
const ESTADO_EXPEDIENTES_PATH = path.join(DATA_DIR, 'ultimos_expedientes.json');
function leerUltimosExpedientes() {
  if (!fs.existsSync(ESTADO_EXPEDIENTES_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(ESTADO_EXPEDIENTES_PATH, 'utf8'));
  } catch {
    return {};
  }
}
function guardarUltimoExpediente(cedula, exp) {
  const todos = leerUltimosExpedientes();
  todos[cedula] = exp;
  fs.writeFileSync(ESTADO_EXPEDIENTES_PATH, JSON.stringify(todos, null, 2), 'utf8');
}

// Depuración automática de expedientes no contratados > 6 meses (LOPDP)
function depurarExpedientesAntiguos() {
  const postulantes = leerPostulantesCsv(DATA_DIR);
  const ahora = Date.now();
  const limiteMs = RETENCION_MESES * 30.44 * 86400 * 1000;
  let eliminados = 0;

  const restantes = postulantes.filter(p => {
    if (String(p.contratado || '').toLowerCase() === 'si') return true;
    const fReg = p.fecha_registro ? new Date(p.fecha_registro + 'T00:00:00Z').getTime() : ahora;
    if (ahora - fReg > limiteMs) {
      const dirEnt = path.join(DATA_DIR, 'entrada', p.cedula);
      if (fs.existsSync(dirEnt)) fs.rmSync(dirEnt, { recursive: true, force: true });
      const archivosSalida = fs.readdirSync(path.join(DATA_DIR, 'salida')).filter(f => f.startsWith(`${p.cedula}_`));
      for (const f of archivosSalida) {
        fs.rmSync(path.join(DATA_DIR, 'salida', f), { force: true });
      }
      eliminados++;
      return false;
    }
    return true;
  });

  if (eliminados > 0) {
    const csvPath = path.join(DATA_DIR, 'postulantes.csv');
    const header = 'cedula,apellidos,nombres,fecha_nacimiento,estado_civil,cedula_busqueda,contratado,fecha_registro';
    const filas = restantes.map(r =>
      [r.cedula, r.apellidos, r.nombres, r.fecha_nacimiento, r.estado_civil, r.cedula_busqueda, r.contratado, r.fecha_registro].join(',')
    );
    fs.writeFileSync(csvPath, [header, ...filas].join('\n') + '\n', 'utf8');
  }
}

// Crear archivos de prueba para la cédula ficticia 1712345675 si no existen
function crearPdfMinimoConTexto(lineas) {
  const escPdf = s => s.replace(/([()\\])/g, '\\$1');
  const tjLines = lineas.map((l, idx) => `${idx === 0 ? '50 760 Td' : '0 -22 Td'} (${escPdf(l)}) Tj`).join('\n');
  const stream = `BT\n/F1 12 Tf\n${tjLines}\nET`;
  const objs = [
    `1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`,
    `2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n`,
    `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n`,
    `4 0 obj\n<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream\nendobj\n`,
    `5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const o of objs) {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += o;
  }
  const xrefPos = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i < offsets.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

async function asegurarArchivosDePrueba1712345675() {
  const dir = path.join(DATA_DIR, 'entrada', '1712345675');
  fs.mkdirSync(dir, { recursive: true });
  if (fs.readdirSync(dir).length > 0) return;

  const crearPdfTexto = async (nombreArchivo, lineas) => {
    const bytes = crearPdfMinimoConTexto(lineas);
    fs.writeFileSync(path.join(dir, nombreArchivo), bytes);
  };

  await crearPdfTexto('antecedentes.pdf', [
    'REPUBLICA DEL ECUADOR - MINISTERIO DEL INTERIOR',
    'CERTIFICADO DE ANTECEDENTES PENALES',
    'FECHA DE EMISION: 20/11/2026',
    'CEDULA DE IDENTIDAD: 1712345675',
    'NOMBRES Y APELLIDOS: PEREZ GOMEZ JUAN ANDRES',
    'POSEE ANTECEDENTES: NO',
  ]);
  await crearPdfTexto('judiciales.pdf', [
    'FUNCION JUDICIAL - CONSULTA DE PROCESOS JUDICIALES SATJE',
    'DEMANDADO / PROCESADO: PEREZ GOMEZ JUAN ANDRES - 1712345675',
    'FECHA DE CONSULTA: 24/11/2026',
    'NO SE ENCONTRARON PROCESOS JUDICIALES (0 RESULTADOS)',
  ]);
  await crearPdfTexto('certificado (3).pdf', [
    'MINISTERIO DE DEFensa NACIONAL - FUERZAS ARMADAS',
    'CERTIFICA QUE EL CIUDADANO PEREZ GOMEZ JUAN ANDRES CON CEDULA 1712345675',
    'NO PERTENECE A LAS FUERZAS ARMADAS',
    'FECHA DE EMISION: 03/09/2026',
  ]);
  await crearPdfTexto('servidor_publico.pdf', [
    'MINISTERIO DEL TRABAJO - CERTIFICADO DE DEPENDENCIA LABORAL EN EL SECTOR PUBLICO',
    'CEDULA: 0926543216',
    'NOMBRES: PEREZ LOPEZ JUAN CARLOS',
    'FECHA DE EMISION: 20/11/2026',
    'NO REGISTRA RELACION DE DEPENDENCIA EN EL SECTOR PUBLICO',
  ]);
  await crearPdfTexto('psicologo.pdf', [
    'SAHER SEGURIDAD PRIVADA - TEST DE CONFIANZA PSICOLOGICO',
    'POSTULANTE: PEREZ GOMEZ JUAN ANDRES - C.I. 1712345675',
    'RESULTADO: APTO',
  ]);
  await crearPdfTexto('aptitud_fisica.pdf', [
    'CERTIFICADO DE APTITUD FISICA',
    'PACIENTE: PEREZ GOMEZ JUAN ANDRES - CEDULA: 1712345675',
    'FECHA DE EMISION: 10/11/2026',
    'RESULTADO: APTO PARA GUARDIA DE SEGURIDAD',
  ]);
  await crearPdfTexto('toxicologico.pdf', [
    'LABORATORIO CLINICO - EXAMEN TOXICOLOGICO',
    'PACIENTE: PEREZ GOMEZ JUAN ANDRES - CEDULA: 1712345675',
    'FECHA DE EMISION: 21/11/2026',
    'RESULTADO: NEGATIVO',
  ]);
  // PNG 1x1 válido para cedula_1712345675.jpg
  const pngMin = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC',
    'base64'
  );
  fs.writeFileSync(path.join(dir, 'cedula_1712345675.jpg'), pngMin);
  fs.writeFileSync(path.join(dir, 'notas.txt'), 'Archivo de prueba no reconocido', 'utf8');
}

function verificarAuthRrhh(req) {
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Basic ')) {
    const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
    const [u, p] = decoded.split(':');
    if (u === RRHH_USER && p === RRHH_PASS) return true;
  }
  const tokenHeader = req.headers['x-rrhh-auth'] || '';
  if (tokenHeader) {
    const decoded = Buffer.from(tokenHeader, 'base64').toString('utf8');
    const [u, p] = decoded.split(':');
    if (u === RRHH_USER && p === RRHH_PASS) return true;
  }
  return false;
}

function leerJsonBody(req, maxBytes = 25 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('El tamaño de los archivos supera el límite permitido'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(new Error('Formato JSON inválido'));
      }
    });
    req.on('error', reject);
  });
}

function responderJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function validarYGuardarArchivosSubidos(cedula, archivos) {
  const dirCedula = path.join(DATA_DIR, 'entrada', cedula);
  fs.mkdirSync(dirCedula, { recursive: true });
  const guardados = [];

  for (const arch of archivos || []) {
    const nombreOriginal = path.basename(String(arch.nombre || 'archivo.pdf')).replace(/[^a-zA-Z0-9._\- ()]/g, '_');
    const ext = (nombreOriginal.split('.').pop() || '').toLowerCase();
    if (!['pdf', 'jpg', 'jpeg', 'png'].includes(ext)) {
      throw new Error(`El archivo "${nombreOriginal}" no está permitido (solo PDF, JPG o PNG)`);
    }
    const cleanB64 = String(arch.dataBase64 || '').replace(/^data:[^;]+;base64,/, '');
    const buf = Buffer.from(cleanB64, 'base64');
    if (buf.length > MAX_UPLOAD_BYTES) {
      throw new Error(`El archivo "${nombreOriginal}" supera el máximo de 10 MB`);
    }
    // Si viene indicado un tipo de documento específico (p.ej. desde la pantalla del postulante o selector)
    let nombreFinal = nombreOriginal;
    if (arch.slotClave) {
      const mapaSlot = {
        antecedentes: 'antecedentes.pdf',
        judiciales: 'judiciales.pdf',
        no_ffaa: 'no_ffaa.pdf',
        clts: 'tiempo_servicio.pdf',
        servidor_publico: 'servidor_publico.pdf',
        psicologico: 'psicologo.pdf',
        aptitud_fisica: 'aptitud_fisica.pdf',
        toxicologico: 'toxicologico.pdf',
        cedula: `cedula_${cedula}.${ext === 'png' ? 'png' : 'jpg'}`,
      };
      if (mapaSlot[arch.slotClave]) {
        nombreFinal = mapaSlot[arch.slotClave];
      }
    } else if (['jpg', 'jpeg', 'png'].includes(ext) && !/^cedula/i.test(nombreFinal)) {
      nombreFinal = `cedula_${cedula}.${ext === 'png' ? 'png' : 'jpg'}`;
    }

    fs.writeFileSync(path.join(dirCedula, nombreFinal), buf);
    guardados.push(nombreFinal);
  }
  return guardados;
}

let inicializado = false;
async function inicializarDatos() {
  if (inicializado) return;
  inicializado = true;
  await asegurarArchivosDePrueba1712345675();
  depurarExpedientesAntiguos();
}

export async function handleRequest(req, res) {
  await inicializarDatos();
  // Permitir CORS por si RR. HH. abre public/index.html con doble clic (file://)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-rrhh-auth');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = urlObj.pathname;

  try {
    // ── ARCHIVOS ESTÁTICOS PÚBLICOS ──
    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    if (req.method === 'GET' && pathname.startsWith('/p/')) {
      const html = fs.readFileSync(path.join(__dirname, 'public', 'postulante.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    // ── ENDPOINTS DEL POSTULANTE (PÚBLICOS CON TOKEN ÚNICO DE 7 DÍAS) ──
    if (pathname.startsWith('/api/postulante/')) {
      const partes = pathname.split('/').filter(Boolean); // ['api', 'postulante', token, accion?]
      const token = partes[2];
      const accion = partes[3] || 'estado';
      const enlaces = leerEnlaces();
      const infoEnlace = enlaces[token];

      if (!infoEnlace) {
        return responderJson(res, 404, { ok: false, error: 'Enlace no válido o inexistente.' });
      }
      if (Date.now() > infoEnlace.expiraEn) {
        return responderJson(res, 410, { ok: false, error: 'Este enlace ha vencido (validez máxima: 7 días). Solicita uno nuevo a Recursos Humanos de SAHER.' });
      }

      const cedula = infoEnlace.cedula;

      if (req.method === 'GET' && accion === 'estado') {
        const ultimos = leerUltimosExpedientes();
        let exp = ultimos[cedula];
        if (!exp) {
          const lote = await procesarLote({ dataDir: DATA_DIR, cedulaFiltro: cedula });
          exp = lote.expedientes[0];
          if (exp) guardarUltimoExpediente(cedula, exp);
        }
        return responderJson(res, 200, {
          ok: true,
          cedula,
          expiraEn: infoEnlace.expiraEn,
          consentimientoAceptado: !!infoEnlace.consentimientoAceptado,
          expediente: exp,
        });
      }

      if (req.method === 'POST' && accion === 'subir') {
        const body = await leerJsonBody(req);
        if (!body.consentimientoLopdp && !infoEnlace.consentimientoAceptado) {
          return responderJson(res, 400, {
            ok: false,
            error: 'Debes marcar la casilla de autorización de tratamiento de datos personales (LOPDP) antes de subir documentos.',
          });
        }
        infoEnlace.consentimientoAceptado = true;
        infoEnlace.fechaConsentimiento = infoEnlace.fechaConsentimiento || new Date().toISOString();
        enlaces[token] = infoEnlace;
        guardarEnlaces(enlaces);

        validarYGuardarArchivosSubidos(cedula, body.archivos || []);
        const lote = await procesarLote({ dataDir: DATA_DIR, cedulaFiltro: cedula });
        const exp = lote.expedientes[0];
        if (exp) guardarUltimoExpediente(cedula, exp);

        return responderJson(res, 200, {
          ok: true,
          cedula,
          expediente: exp,
        });
      }
    }

    // ── ENDPOINTS DE RR. HH. (PROTEGIDOS CON USUARIO Y CONTRASEÑA) ──
    if (pathname.startsWith('/api/rrhh/')) {
      if (!pathname.startsWith('/api/rrhh/pdf/') && !verificarAuthRrhh(req)) {
        return responderJson(res, 401, { ok: false, error: 'Credenciales de Recursos Humanos inválidas.' });
      }

      // 1. Consultar saldos (EcuadorAPI + 2Captcha/CapSolver)
      if (req.method === 'GET' && pathname === '/api/rrhh/saldos') {
        const [ecuadorApi, captcha] = await Promise.all([
          consultarSaldoEcuadorApi(),
          consultarSaldoCaptcha(),
        ]);
        return responderJson(res, 200, { ok: true, ecuadorApi, captcha });
      }

      // 2. Listar postulantes y tabla de control
      if (req.method === 'GET' && pathname === '/api/rrhh/postulantes') {
        const postulantes = leerPostulantesCsv(DATA_DIR);
        const ultimos = leerUltimosExpedientes();
        const lista = postulantes.map(p => ({
          ...p,
          nombre_completo: [p.apellidos, p.nombres].filter(Boolean).join(' '),
          expediente: ultimos[p.cedula] || null,
        }));
        return responderJson(res, 200, { ok: true, postulantes: lista });
      }

      // 3. Armar expediente (valida cédula, consulta EcuadorAPI 1 vez, guarda archivos subidos y ejecuta procesar_lote.mjs)
      if (req.method === 'POST' && pathname === '/api/rrhh/armar') {
        const body = await leerJsonBody(req);
        const val = validarCedulaEcuatoriana(body.cedula);
        if (!val.valida) {
          return responderJson(res, 400, { ok: false, error: val.motivo });
        }
        const cedula = val.cedula;

        // Consulta EcuadorAPI una sola vez por cédula
        const idRes = await obtenerIdentidadPorCedula(cedula, DATA_DIR);
        if (!idRes.ok) {
          return responderJson(res, 400, { ok: false, error: idRes.error });
        }

        // Guardar archivos subidos si los hay
        if (Array.isArray(body.archivos) && body.archivos.length > 0) {
          validarYGuardarArchivosSubidos(cedula, body.archivos);
        }

        // Por defecto los Agentes IA buscan y generan automáticamente los 5 certificados oficiales
        const ejecutarAgentes = body.descargarConCaptcha !== false;
        let descargaPortales = null;
        if (ejecutarAgentes) {
          descargaPortales = await descargarCertificadosOficiales({
            cedula,
            nombre_completo: idRes.postulante.nombre_completo,
            fecha_nacimiento: idRes.postulante.fecha_nacimiento,
            estado_civil: idRes.postulante.estado_civil,
            carpetaEntrada: path.join(DATA_DIR, 'entrada', cedula),
            forzarRegeneracion: !!body.forzarAgentes,
          });
        }

        // Ejecutar procesador de expediente
        const lote = await procesarLote({ dataDir: DATA_DIR, cedulaFiltro: cedula });
        const exp = lote.expedientes[0];

        // Si el procesador extrajo el nombre desde el certificado de antecedentes y no estaba en postulantes.csv, actualizar CSV
        if (exp?.postulante?.nombre_completo && !idRes.postulante.nombre_completo) {
          idRes.postulante.nombre_completo = exp.postulante.nombre_completo;
          guardarPostulanteEnCsv(DATA_DIR, {
            cedula,
            apellidos: exp.postulante.nombre_completo,
            nombres: '',
          });
        }

        if (exp) {
          exp.identidad = {
            ...idRes.postulante,
            nombre_completo: idRes.postulante.nombre_completo || exp.postulante.nombre_completo || 'SIN NOMBRE REGISTRADO',
            fuente: 'fuente: EcuadorAPI, no oficial',
            desde_cache: idRes.desde_cache,
            gasto_usd: idRes.gasto_usd,
          };
          guardarUltimoExpediente(cedula, exp);
        }

        let pdfBase64 = null;
        if (exp?.archivo_pdf) {
          const rutaPdfGenerado = path.join(DATA_DIR, 'salida', exp.archivo_pdf);
          if (fs.existsSync(rutaPdfGenerado)) {
            pdfBase64 = fs.readFileSync(rutaPdfGenerado).toString('base64');
          }
        }

        const [ecuadorApi, captcha] = await Promise.all([
          consultarSaldoEcuadorApi(),
          consultarSaldoCaptcha(),
        ]);

        return responderJson(res, 200, {
          ok: true,
          identidad: exp?.identidad,
          expediente: exp,
          pdfBase64,
          descargaPortales,
          saldos: { ecuadorApi, captcha },
        });
      }

      // 4. Generar enlace único para el postulante (vence a los 7 días)
      if (req.method === 'POST' && pathname === '/api/rrhh/enlace') {
        const body = await leerJsonBody(req);
        const val = validarCedulaEcuatoriana(body.cedula);
        if (!val.valida) {
          return responderJson(res, 400, { ok: false, error: val.motivo });
        }
        const cedula = val.cedula;
        const enlaces = leerEnlaces();
        // Buscar si ya hay un enlace vigente para esta cédula
        let token = Object.keys(enlaces).find(
          t => enlaces[t].cedula === cedula && enlaces[t].expiraEn > Date.now()
        );
        if (!token) {
          token = crypto.randomBytes(18).toString('hex');
          enlaces[token] = {
            cedula,
            creadoEn: Date.now(),
            expiraEn: Date.now() + 7 * 86400 * 1000, // 7 días
            consentimientoAceptado: false,
          };
          guardarEnlaces(enlaces);
        }
        const base = (process.env.PUBLIC_BASE_URL || `http://${req.headers.host}`).replace(/\/$/, '');
        return responderJson(res, 200, {
          ok: true,
          cedula,
          token,
          url: `${base}/p/${token}`,
          expiraEn: enlaces[token].expiraEn,
        });
      }

      // 5. Descargar el PDF del expediente armado
      if (req.method === 'GET' && pathname.startsWith('/api/rrhh/pdf/')) {
        const cedula = pathname.split('/').pop().replace(/\D/g, '');
        const ultimos = leerUltimosExpedientes();
        const archivo = ultimos[cedula]?.archivo_pdf;
        const dirSalida = path.join(DATA_DIR, 'salida');
        let rutaPdf = archivo ? path.join(dirSalida, archivo) : null;
        if (!rutaPdf || !fs.existsSync(rutaPdf)) {
          const encontrado = fs.readdirSync(dirSalida).find(f => f.startsWith(`${cedula}_`) && f.endsWith('.pdf'));
          if (encontrado) rutaPdf = path.join(dirSalida, encontrado);
        }
        if (!rutaPdf || !fs.existsSync(rutaPdf)) {
          return responderJson(res, 404, { ok: false, error: 'PDF no encontrado para esta cédula.' });
        }
        const nombreDescarga = path.basename(rutaPdf);
        const esInline = urlObj.searchParams.get('inline') === '1';
        res.writeHead(200, {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `${esInline ? 'inline' : 'attachment'}; filename="${nombreDescarga}"`,
          'Cache-Control': 'no-store',
        });
        fs.createReadStream(rutaPdf).pipe(res);
        return;
      }
    }

    responderJson(res, 404, { ok: false, error: 'Ruta no encontrada' });
  } catch (err) {
    console.error('Error en servidor:', err);
    responderJson(res, 500, { ok: false, error: err.message || 'Error interno del servidor' });
  }
}

export default handleRequest;

if (!ES_VERCEL) {
  await inicializarDatos();
  setInterval(depurarExpedientesAntiguos, 24 * 3600 * 1000).unref();
  const server = http.createServer(handleRequest);
  server.listen(PORT, () => {
    console.log(`=============================================================`);
    console.log(`SAHER - Sistema de Expedientes de Postulantes a Guardia`);
    console.log(`Pantalla de RR. HH.: http://localhost:${PORT}`);
    console.log(`Usuario RR. HH.: ${RRHH_USER} | Contraseña: ${RRHH_PASS}`);
    console.log(`Carpeta de datos: ${DATA_DIR}`);
    console.log(`=============================================================`);
  });
}

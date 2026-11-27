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
import { verificarDocumento, extraerTextoPdf, normalizarTexto } from './codigo/agente_verificador.mjs';
import {
  ITEMS_CONFIANZA,
  calificarEvaluacionConfianza,
  generarPdfInformeConfianza,
} from './codigo/evaluacion_confianza.mjs';
import {
  autenticarUsuario,
  obtenerUsuarios,
  agregarUsuarioAsesor,
} from './codigo/usuarios.mjs';
import { crearArchivoZip } from './codigo/zip_util.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Evitar que promesas internas de pdf.js (pdf-parse) detengan el servidor ante PDFs externos con XRef no estándar
process.on('unhandledRejection', err => {
  console.warn('Promesa rechazada controlada:', err?.message || err);
});

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

// Almacenamiento y firma stateless (HMAC) de enlaces únicos de postulantes (vence a los 7 días, funciona en Vercel Serverless)
const ENLACES_PATH = path.join(DATA_DIR, 'enlaces.json');
const ENLACE_SECRET = process.env.RRHH_PASS || 'saher2026_secret_key';

function generarTokenStateless(cedula, expiraEn = Date.now() + 7 * 86400 * 1000) {
  const expHex = expiraEn.toString(36);
  const payload = `${cedula}.${expHex}`;
  const sig = crypto.createHmac('sha256', ENLACE_SECRET).update(payload).digest('hex').slice(0, 18);
  return `${cedula}-${expHex}-${sig}`;
}

function verificarTokenStateless(token) {
  const m = String(token || '').match(/^(\d{10})-([a-z0-9]+)-([a-f0-9]{18})$/);
  if (!m) return null;
  const [, cedula, expHex, sig] = m;
  const esperado = crypto.createHmac('sha256', ENLACE_SECRET).update(`${cedula}.${expHex}`).digest('hex').slice(0, 18);
  if (sig !== esperado) return null;
  const expiraEn = parseInt(expHex, 36);
  return { cedula, expiraEn, consentimientoAceptado: true };
}

function obtenerBaseUrlPublica(req) {
  if (process.env.PUBLIC_BASE_URL && !process.env.VERCEL) {
    return process.env.PUBLIC_BASE_URL.replace(/\/$/, '');
  }
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost:3000';
  const proto = req.headers['x-forwarded-proto'] || (host.includes('localhost') ? 'http' : 'https');
  return `${proto}://${host}`;
}

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
    const usr = autenticarUsuario(DATA_DIR, u, p);
    if (usr) return usr;
  }
  const tokenHeader = req.headers['x-rrhh-auth'] || '';
  if (tokenHeader) {
    const decoded = Buffer.from(tokenHeader, 'base64').toString('utf8');
    const [u, p] = decoded.split(':');
    const usr = autenticarUsuario(DATA_DIR, u, p);
    if (usr) return usr;
  }
  return null;
}

function calcularResumenProgreso(exp, dirEntradaCedula = null) {
  if (!exp || !Array.isArray(exp.slots)) {
    return {
      completos: 0,
      total: 10,
      faltantes: [{ clave: 'sin_procesar', titulo: 'Expediente aún no consultado', estado: 'pendiente' }],
      zip_habilitado: false,
      primer_aviso: {
        mayor_de_edad: null,
        ecuatoriano: true,
        bachiller: false,
        bachiller_detalle: 'Pendiente consulta',
        apto_primera_instancia: false,
      },
    };
  }
  const docs = (exp?.slots || []).filter(s => s.clave !== 'portada');
  const completos = docs.filter(s => s.estado === 'completo').length;
  const total = docs.length || 10;
  const faltantes = docs.filter(s => s.estado !== 'completo').map(s => ({
    clave: s.clave,
    titulo: s.titulo,
    estado: s.estado,
  }));

  // Primer Aviso (3 puntos de primera instancia): Mayor de edad, Ecuatoriano, Bachiller
  const mayorDeEdad = exp?.identidad?.mayor_de_edad ?? null;
  const ecuatoriano = true;
  const slotTitulo = docs.find(s => s.clave === 'titulo_bachiller');
  let bachiller = slotTitulo?.estado === 'completo';
  let bachillerDetalle = bachiller ? 'Título de bachiller registrado' : 'Pendiente verificación de título';
  if (bachiller && dirEntradaCedula && slotTitulo?.archivo) {
    const fpTit = path.join(dirEntradaCedula, slotTitulo.archivo);
    if (fs.existsSync(fpTit) && fpTit.endsWith('.pdf')) {
      const txt = exp._tituloTextoNorm || '';
      if (txt.includes('NO CONSTA INFORMACION DE TITULOS DE BACHILLER')) {
        bachiller = false;
        bachillerDetalle = 'Sin título de bachiller registrado en MinEduc';
      }
    }
  }

  return {
    completos,
    total,
    faltantes,
    zip_habilitado: completos === total && total >= 10,
    primer_aviso: {
      mayor_de_edad: mayorDeEdad,
      ecuatoriano,
      bachiller,
      bachiller_detalle: bachillerDetalle,
      apto_primera_instancia: mayorDeEdad === true && ecuatoriano === true && bachiller === true,
    },
  };
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

async function validarYGuardarArchivosSubidos(cedula, archivos, nombreEsperado = '') {
  const dirCedula = path.join(DATA_DIR, 'entrada', cedula);
  fs.mkdirSync(dirCedula, { recursive: true });
  const guardados = [];

  for (const arch of archivos || []) {
    const nombreOriginal = path.basename(String(arch.nombre || 'archivo.pdf')).replace(/[^a-zA-Z0-9._\- ()]/g, '_');
    const ext = (nombreOriginal.split('.').pop() || '').toLowerCase();
    const cleanB64 = String(arch.dataBase64 || '').replace(/^data:[^;]+;base64,/, '');
    const buf = Buffer.from(cleanB64, 'base64');
    if (buf.length > MAX_UPLOAD_BYTES) {
      throw new Error(`El archivo "${nombreOriginal}" supera el máximo de 10 MB`);
    }

    // Agente Verificador: impedir que se suba un PDF de otra persona / otra cédula
    if (ext === 'pdf') {
      const verif = await verificarDocumento({
        buffer: buf,
        nombreArchivo: nombreOriginal,
        cedulaEsperada: cedula,
        nombreEsperado,
        slotClave: arch.slotClave || '',
      });
      if (!verif.valido) {
        throw new Error(`Agente Verificador rechazó "${nombreOriginal}": ${verif.motivo}`);
      }
    }

    const mapaBase = {
      antecedentes: 'antecedentes',
      judiciales: 'judiciales',
      no_ffaa: 'no_ffaa',
      clts: 'tiempo_servicio',
      servidor_publico: 'servidor_publico',
      titulo_bachiller: 'titulo_bachiller',
      psicologico: 'psicologo',
      aptitud_fisica: 'aptitud_fisica',
      toxicologico: 'toxicologico',
      incapacidad: 'incapacidad_civil',
      cedula: `cedula_${cedula}`,
    };

    let nombreFinal = nombreOriginal;
    if (arch.slotClave && mapaBase[arch.slotClave]) {
      // Conservar la extensión original (pdf, jpg, png, doc, docx) para que el .ZIP y las descargas individuales entreguen el archivo auténtico sin alterar
      nombreFinal = `${mapaBase[arch.slotClave]}.${ext || 'pdf'}`;
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
  // Limpiar cualquier PDF sintético previo en 1804625752 y restaurar el certificado REAL del Ministerio del Interior si está en referencia/
  try {
    const dir18 = path.join(DATA_DIR, 'entrada', '1804625752');
    if (fs.existsSync(dir18)) {
      for (const f of fs.readdirSync(dir18)) {
        const fp = path.join(dir18, f);
        const content = fs.readFileSync(fp, 'latin1');
        if (content.includes('%SAHER_TEXT_START') || f === 'cedula_1804625752.png') {
          fs.rmSync(fp, { force: true });
        }
      }
    }
    const refReal = path.join(__dirname, 'referencia', '1804625752_ZAVALA_GARCIA_DANIEL_ROBERTO.pdf');
    const destAnt = path.join(dir18, 'antecedentes.pdf');
    if (fs.existsSync(refReal) && !fs.existsSync(destAnt)) {
      fs.mkdirSync(dir18, { recursive: true });
      const { PDFDocument } = await import('pdf-lib');
      const srcDoc = await PDFDocument.load(fs.readFileSync(refReal));
      if (srcDoc.getPageCount() >= 2) {
        const outDoc = await PDFDocument.create();
        const [p2] = await outDoc.copyPages(srcDoc, [1]);
        outDoc.addPage(p2);
        fs.writeFileSync(destAnt, Buffer.from(await outDoc.save()));
      }
    }
  } catch {
    // continuar
  }
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

    if (req.method === 'GET' && pathname === '/logo-saher.png') {
      const logoPath = path.join(__dirname, 'public', 'logo-saher.png');
      if (fs.existsSync(logoPath)) {
        res.writeHead(200, { 'Content-Type': 'image/png' });
        fs.createReadStream(logoPath).pipe(res);
        return;
      }
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
      const infoEnlace = verificarTokenStateless(token) || enlaces[token];

      if (!infoEnlace) {
        return responderJson(res, 404, { ok: false, error: 'Enlace no válido o inexistente.' });
      }
      if (Date.now() > infoEnlace.expiraEn) {
        return responderJson(res, 410, { ok: false, error: 'Este enlace ha vencido (validez máxima: 7 días). Solicita uno nuevo a Recursos Humanos de SAHER.' });
      }

      const cedula = infoEnlace.cedula;

      if (req.method === 'GET' && accion === 'estado') {
        await obtenerIdentidadPorCedula(cedula, DATA_DIR);
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
          itemsConfianza: ITEMS_CONFIANZA,
        });
      }

      if (req.method === 'POST' && accion === 'evaluacion') {
        const body = await leerJsonBody(req);
        if (!body.consentimientoLopdp && !infoEnlace.consentimientoAceptado) {
          return responderJson(res, 400, {
            ok: false,
            error: 'Debes aceptar el consentimiento informado (LOPDP) antes de enviar la evaluación.',
          });
        }
        const idResEval = await obtenerIdentidadPorCedula(cedula, DATA_DIR);
        const nombreEval = idResEval?.postulante?.nombre_completo || `POSTULANTE ${cedula}`;
        const evalResult = calificarEvaluacionConfianza({
          respuestas: body.respuestas,
          tiemposMs: body.tiemposMs,
          cambiosPestana: body.cambiosPestana,
          fotosCapturadas: body.fotosCapturadas,
          duracionTotalSeg: body.duracionTotalSeg,
        });
        const hoyFmt = new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(0, 10).split('-').reverse().join('/');
        const pdfBuf = await generarPdfInformeConfianza({
          cedula,
          nombreCompleto: nombreEval,
          evaluacion: evalResult,
          fechaHoy: hoyFmt,
        });
        const dirCedula = path.join(DATA_DIR, 'entrada', cedula);
        fs.mkdirSync(dirCedula, { recursive: true });
        fs.writeFileSync(path.join(dirCedula, 'psicologo.pdf'), pdfBuf);
        fs.writeFileSync(path.join(dirCedula, 'evaluacion_confianza.json'), JSON.stringify(evalResult, null, 2), 'utf8');

        const lote = await procesarLote({ dataDir: DATA_DIR, cedulaFiltro: cedula });
        const exp = lote.expedientes[0];
        if (exp) {
          exp.evaluacion_confianza = evalResult;
          exp.progreso_10 = calcularResumenProgreso(exp, dirCedula);
          guardarUltimoExpediente(cedula, exp);
        }
        return responderJson(res, 200, {
          ok: true,
          cedula,
          evaluacion: evalResult,
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
        const idResSubir = await obtenerIdentidadPorCedula(cedula, DATA_DIR);
        await validarYGuardarArchivosSubidos(cedula, body.archivos || [], idResSubir?.postulante?.nombre_completo || '');
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

    // ── ENDPOINTS DE RR. HH. / ASESORES / COORDINADOR (PROTEGIDOS) ──
    if (pathname.startsWith('/api/rrhh/')) {
      const usuarioAuth = verificarAuthRrhh(req);
      if (!pathname.startsWith('/api/rrhh/pdf/') && !pathname.startsWith('/api/rrhh/certificado/') && !pathname.startsWith('/api/rrhh/zip/') && !usuarioAuth) {
        return responderJson(res, 401, { ok: false, error: 'Usuario o contraseña incorrectos.' });
      }

      // 0. Información del usuario autenticado y lista de asesores
      if (req.method === 'GET' && pathname === '/api/rrhh/yo') {
        const usuarios = obtenerUsuarios(DATA_DIR).map(u => ({
          usuario: u.usuario,
          nombre: u.nombre,
          rol: u.rol,
        }));
        return responderJson(res, 200, {
          ok: true,
          usuario: { usuario: usuarioAuth.usuario, nombre: usuarioAuth.nombre, rol: usuarioAuth.rol },
          usuarios,
        });
      }

      // 0.B Crear/actualizar asesor (solo coordinador, ej. Ángel)
      if (req.method === 'POST' && pathname === '/api/rrhh/usuarios') {
        if (usuarioAuth.rol !== 'coordinador') {
          return responderJson(res, 403, { ok: false, error: 'Solo el Coordinador Académico puede gestionar asesores.' });
        }
        const body = await leerJsonBody(req);
        const creado = agregarUsuarioAsesor(DATA_DIR, body);
        return responderJson(res, 200, { ok: true, usuario: creado });
      }

      // 0.C Actualizar asesor, nivel_curso o aprobación del asesor
      if (req.method === 'POST' && pathname === '/api/rrhh/actualizar-meta') {
        const body = await leerJsonBody(req);
        const val = validarCedulaEcuatoriana(body.cedula);
        if (!val.valida) return responderJson(res, 400, { ok: false, error: val.motivo });
        const cedula = val.cedula;
        const actualizado = guardarPostulanteEnCsv(DATA_DIR, {
          cedula,
          asesor: body.asesor,
          nivel_curso: body.nivel_curso,
          aprobado_asesor: body.aprobado_asesor,
        });
        const ultimos = leerUltimosExpedientes();
        if (ultimos[cedula]) {
          ultimos[cedula].asesor = actualizado.asesor;
          ultimos[cedula].nivel_curso = actualizado.nivel_curso;
          ultimos[cedula].aprobado_asesor = actualizado.aprobado_asesor;
          guardarUltimoExpediente(cedula, ultimos[cedula]);
        }
        return responderJson(res, 200, { ok: true, postulante: actualizado });
      }

      // 1. Consultar saldos (EcuadorAPI + 2Captcha/CapSolver)
      if (req.method === 'GET' && pathname === '/api/rrhh/saldos') {
        const [ecuadorApi, captcha] = await Promise.all([
          consultarSaldoEcuadorApi(),
          consultarSaldoCaptcha(),
        ]);
        return responderJson(res, 200, { ok: true, ecuadorApi, captcha });
      }

      // 2. Listar postulantes y tabla de control (Ángel ve todos; Asesores solo ven SUS propios estudiantes)
      if (req.method === 'GET' && pathname === '/api/rrhh/postulantes') {
        const postulantes = leerPostulantesCsv(DATA_DIR);
        const ultimos = leerUltimosExpedientes();
        let lista = postulantes.map(p => {
          const exp = ultimos[p.cedula] || null;
          const prog = exp?.progreso_10 || calcularResumenProgreso(exp);
          return {
            ...p,
            asesor: p.asesor || exp?.asesor || 'Sin asignar',
            nivel_curso: p.nivel_curso || exp?.nivel_curso || 'Nivel 1',
            aprobado_asesor: p.aprobado_asesor || exp?.aprobado_asesor || 'no',
            nombre_completo: [p.apellidos, p.nombres].filter(Boolean).join(' '),
            expediente: exp,
            progreso_10: prog,
          };
        });
        if (usuarioAuth.rol !== 'coordinador') {
          const miNombre = usuarioAuth.nombre.toLowerCase();
          lista = lista.filter(p => (p.asesor || '').toLowerCase() === miNombre);
        }
        return responderJson(res, 200, {
          ok: true,
          rol: usuarioAuth.rol,
          usuario: usuarioAuth.nombre,
          postulantes: lista,
        });
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

        // Guardar archivos subidos si los hay (con Agente Verificador)
        if (Array.isArray(body.archivos) && body.archivos.length > 0) {
          await validarYGuardarArchivosSubidos(cedula, body.archivos, idRes.postulante.nombre_completo);
        }

        // Por defecto, al buscar una cédula se ejecutan los Agentes de los 6 portales oficiales para que sus certificados estén listos para ver y descargar
        const ejecutarAgentes = body.descargarConCaptcha !== false;
        let descargaPortales = null;
        if (ejecutarAgentes) {
          descargaPortales = await descargarCertificadosOficiales({
            cedula,
            nombre_completo: idRes.postulante.nombre_completo,
            fecha_nacimiento: idRes.postulante.fecha_nacimiento,
            estado_civil: idRes.postulante.estado_civil,
            carpetaEntrada: path.join(DATA_DIR, 'entrada', cedula),
            soloClaves: Array.isArray(body.soloClaves) ? body.soloClaves : null,
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
          // Calcular edad y mayoría de edad (Requisito #1: Ser ecuatoriano y mayor de edad)
          let edadAnos = null;
          let mayorDeEdad = null;
          const fnStr = String(idRes.postulante.fecha_nacimiento || '').trim();
          const mFn = fnStr.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/) || fnStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
          if (mFn) {
            const dNac = mFn[1].length === 4
              ? new Date(Number(mFn[1]), Number(mFn[2]) - 1, Number(mFn[3]))
              : new Date(Number(mFn[3]), Number(mFn[2]) - 1, Number(mFn[1]));
            if (!Number.isNaN(dNac.getTime())) {
              const hoyD = new Date();
              edadAnos = hoyD.getFullYear() - dNac.getFullYear() - ((hoyD.getMonth() < dNac.getMonth() || (hoyD.getMonth() === dNac.getMonth() && hoyD.getDate() < dNac.getDate())) ? 1 : 0);
              mayorDeEdad = edadAnos >= 18;
            }
          }

          exp.identidad = {
            ...idRes.postulante,
            nombre_completo: idRes.postulante.nombre_completo || exp.postulante.nombre_completo || 'SIN NOMBRE REGISTRADO',
            fuente: 'fuente: EcuadorAPI, no oficial',
            desde_cache: idRes.desde_cache,
            gasto_usd: idRes.gasto_usd,
            edad_anos: edadAnos,
            mayor_de_edad: mayorDeEdad,
            es_ecuatoriano: true,
          };

          // Ejecutar Agente Verificador sobre cada documento presente en el expediente
          const dirEntradaVerif = path.join(DATA_DIR, 'entrada', cedula);
          let totalVerificados = 0;
          let totalAlertas = 0;
          for (const s of exp.slots || []) {
            if (s.clave === 'portada') continue;
            if (s.archivo) {
              const fp = path.join(dirEntradaVerif, s.archivo);
              if (fs.existsSync(fp)) {
                const bufVerif = fs.readFileSync(fp);
                const vRes = await verificarDocumento({
                  buffer: bufVerif,
                  nombreArchivo: s.archivo,
                  cedulaEsperada: cedula,
                  nombreEsperado: exp.identidad.nombre_completo,
                  slotClave: s.clave,
                });
                if (s.clave === 'titulo_bachiller' && s.archivo.endsWith('.pdf')) {
                  exp._tituloTextoNorm = normalizarTexto(await extraerTextoPdf(bufVerif));
                }
                s.verificacion = vRes;
                if (!vRes.valido || vRes.nivel === 'ALERTA_IDENTIDAD' || vRes.nivel === 'ALERTA_AUTENTICIDAD') {
                  totalAlertas++;
                  s.estado = 'observación';
                  s.motivo = vRes.motivo;
                } else {
                  totalVerificados++;
                }
              }
            }
          }
          exp.verificacion_global = {
            total_verificados: totalVerificados,
            total_alertas: totalAlertas,
            estado: totalAlertas > 0 ? 'CON_ALERTAS' : (totalVerificados > 0 ? 'VERIFICADO' : 'PENDIENTE'),
          };
          const evalJsonPath = path.join(dirEntradaVerif, 'evaluacion_confianza.json');
          if (fs.existsSync(evalJsonPath)) {
            try {
              exp.evaluacion_confianza = JSON.parse(fs.readFileSync(evalJsonPath, 'utf8'));
            } catch {
              // ignorar
            }
          }
          const asesorPrevio = idRes.postulante.asesor || '';
          const asesorFinal = body.asesor ||
            (usuarioAuth.rol === 'asesor' && (!asesorPrevio || asesorPrevio.includes('RR. HH.') || asesorPrevio === 'Sin asignar')
              ? usuarioAuth.nombre
              : asesorPrevio || usuarioAuth.nombre);
          const metaActual = guardarPostulanteEnCsv(DATA_DIR, {
            cedula,
            asesor: asesorFinal,
            nivel_curso: body.nivel_curso || idRes.postulante.nivel_curso || 'Nivel 1',
          });
          exp.asesor = metaActual.asesor || usuarioAuth.nombre;
          exp.nivel_curso = metaActual.nivel_curso || 'Nivel 1';
          exp.aprobado_asesor = metaActual.aprobado_asesor || 'no';
          exp.progreso_10 = calcularResumenProgreso(exp, dirEntradaVerif);
          delete exp._tituloTextoNorm;
          guardarUltimoExpediente(cedula, exp);
        }

        let pdfBase64 = null;
        if (exp?.archivo_pdf) {
          const rutaPdfGenerado = path.join(DATA_DIR, 'salida', exp.archivo_pdf);
          if (fs.existsSync(rutaPdfGenerado)) {
            pdfBase64 = fs.readFileSync(rutaPdfGenerado).toString('base64');
          }
        }

        const archivosIndividuales = {};
        const entradasParaZip = [];
        const dirEntradaCedula = path.join(DATA_DIR, 'entrada', cedula);
        if (fs.existsSync(dirEntradaCedula)) {
          for (const s of exp?.slots || []) {
            if (s.archivo) {
              const pIndiv = path.join(dirEntradaCedula, s.archivo);
              if (fs.existsSync(pIndiv)) {
                const bufIndiv = fs.readFileSync(pIndiv);
                archivosIndividuales[s.archivo] = bufIndiv.toString('base64');
                const numOrden = String(s.orden - 1).padStart(2, '0');
                entradasParaZip.push({
                  nombre: `${numOrden}_${cedula}_${s.archivo}`,
                  buffer: bufIndiv,
                });
              }
            }
          }
        }
        const zipBase64 = (exp?.progreso_10?.zip_habilitado && entradasParaZip.length)
          ? crearArchivoZip(entradasParaZip).toString('base64')
          : null;

        const [ecuadorApi, captcha] = await Promise.all([
          consultarSaldoEcuadorApi(),
          consultarSaldoCaptcha(),
        ]);

        const tokenEnlace = generarTokenStateless(cedula);
        const urlEnlaceBase = `${obtenerBaseUrlPublica(req)}/p/${tokenEnlace}`;

        return responderJson(res, 200, {
          ok: true,
          identidad: exp?.identidad,
          expediente: exp,
          pdfBase64,
          zipBase64,
          archivosIndividuales,
          descargaPortales,
          tokenEnlace,
          urlEnlaceBase,
          saldos: { ecuadorApi, captcha },
        });
      }

      // 4. Generar enlace único para el postulante (vence a los 7 días, stateless HMAC)
      if (req.method === 'POST' && pathname === '/api/rrhh/enlace') {
        const body = await leerJsonBody(req);
        const val = validarCedulaEcuatoriana(body.cedula);
        if (!val.valida) {
          return responderJson(res, 400, { ok: false, error: val.motivo });
        }
        const cedula = val.cedula;
        const expiraEn = Date.now() + 7 * 86400 * 1000;
        const token = generarTokenStateless(cedula, expiraEn);
        const base = obtenerBaseUrlPublica(req);
        const sufijoItem = body.item ? `?item=${encodeURIComponent(body.item)}` : '';
        return responderJson(res, 200, {
          ok: true,
          cedula,
          token,
          url: `${base}/p/${token}${sufijoItem}`,
          expiraEn,
        });
      }

      // 5. Descargar 1 certificado individual por entidad (/api/rrhh/certificado/:cedula/:archivo)
      if (req.method === 'GET' && pathname.startsWith('/api/rrhh/certificado/')) {
        const partes = pathname.split('/').filter(Boolean); // ['api', 'rrhh', 'certificado', cedula, archivo]
        const cedula = (partes[3] || '').replace(/\D/g, '');
        const archivoReq = path.basename(decodeURIComponent(partes[4] || ''));
        const rutaIndiv = path.join(DATA_DIR, 'entrada', cedula, archivoReq);
        if (!cedula || !archivoReq || !fs.existsSync(rutaIndiv)) {
          return responderJson(res, 404, { ok: false, error: 'Certificado individual no encontrado en la carpeta del postulante.' });
        }
        const ext = (archivoReq.split('.').pop() || '').toLowerCase();
        const mimeMap = {
          pdf: 'application/pdf',
          png: 'image/png',
          jpg: 'image/jpeg',
          jpeg: 'image/jpeg',
          doc: 'application/msword',
          docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        };
        const mime = mimeMap[ext] || 'application/octet-stream';
        const esInline = urlObj.searchParams.get('inline') === '1';
        res.writeHead(200, {
          'Content-Type': mime,
          'Content-Disposition': `${esInline ? 'inline' : 'attachment'}; filename="${cedula}_${archivoReq}"`,
          'Cache-Control': 'no-store',
        });
        fs.createReadStream(rutaIndiv).pipe(res);
        return;
      }

      // 5.B Descargar archivo .ZIP con TODOS los certificados originales individuales (solo habilitado cuando está 10/10)
      if (req.method === 'GET' && pathname.startsWith('/api/rrhh/zip/')) {
        const cedula = pathname.split('/').pop().replace(/\D/g, '');
        const ultimosZip = leerUltimosExpedientes();
        const progZip = ultimosZip[cedula]?.progreso_10;
        if (progZip && !progZip.zip_habilitado) {
          return responderJson(res, 403, {
            ok: false,
            error: `El .ZIP solo se habilita cuando el estudiante tiene 10/10 requisitos completos (actual: ${progZip.completos}/${progZip.total}).`,
          });
        }
        const dirEntradaCedula = path.join(DATA_DIR, 'entrada', cedula);
        if (!cedula || !fs.existsSync(dirEntradaCedula)) {
          return responderJson(res, 404, { ok: false, error: 'No hay carpeta de certificados para esta cédula.' });
        }
        const archivosEnCarpeta = fs.readdirSync(dirEntradaCedula).filter(f => {
          const st = fs.statSync(path.join(dirEntradaCedula, f));
          return st.isFile() && /\.(pdf|jpg|jpeg|png|doc|docx)$/i.test(f);
        });
        if (!archivosEnCarpeta.length) {
          return responderJson(res, 404, { ok: false, error: 'No hay certificados individuales para comprimir en .ZIP.' });
        }
        const itemsZip = archivosEnCarpeta.map((f, idx) => ({
          nombre: `${String(idx + 1).padStart(2, '0')}_${cedula}_${f}`,
          buffer: fs.readFileSync(path.join(dirEntradaCedula, f)),
        }));
        const zipBuf = crearArchivoZip(itemsZip);
        res.writeHead(200, {
          'Content-Type': 'application/zip',
          'Content-Disposition': `attachment; filename="${cedula}_CERTIFICADOS_ORIGINALES_INDIVIDUALES.zip"`,
          'Cache-Control': 'no-store',
        });
        res.end(zipBuf);
        return;
      }

      // 6. Descargar el PDF del expediente armado completo
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

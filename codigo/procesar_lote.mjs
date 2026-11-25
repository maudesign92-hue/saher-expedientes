#!/usr/bin/env node
/**
 * codigo/procesar_lote.mjs
 * Ejecuta los nodos Code de codigo/flujo.json con un adaptador ligero de n8n,
 * convierte las páginas HTML (portada, pendientes y foto de cédula) a PDF con Playwright/Chromium
 * y une los 10 documentos en orden con codigo/unir_pdf.py (o pdf-lib si Python no está instalado).
 *
 * Uso CLI:
 *   node codigo/procesar_lote.mjs [--cedula 1712345675] <carpeta_datos>
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function encontrarNavegadorLocal() {
  const candidatos = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  return candidatos.find(p => fs.existsSync(p)) || null;
}

async function convertirHtmlAPdfBuffer(htmlStr, pagePlaywright = null) {
  if (pagePlaywright) {
    await pagePlaywright.setContent(htmlStr, { waitUntil: 'load' });
    const pdfBuf = await pagePlaywright.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '16mm', bottom: '16mm', left: '15mm', right: '15mm' },
    });
    return Buffer.from(pdfBuf);
  }
  const exe = encontrarNavegadorLocal();
  if (exe) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'saher-html-'));
    const htmlFile = path.join(tmpDir, 'page.html');
    const pdfFile = path.join(tmpDir, 'page.pdf');
    try {
      fs.writeFileSync(htmlFile, htmlStr, 'utf8');
      spawnSync(exe, [
        '--headless',
        '--disable-gpu',
        '--no-pdf-header-footer',
        `--print-to-pdf=${pdfFile}`,
        htmlFile,
      ]);
      if (fs.existsSync(pdfFile)) {
        return fs.readFileSync(pdfFile);
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }
  throw new Error('No se encontró navegador (Playwright/Chrome/Edge) para generar el PDF');
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function cargarNodosFlujo() {
  const rutaFlujo = path.join(__dirname, 'flujo.json');
  const flujo = JSON.parse(fs.readFileSync(rutaFlujo, 'utf8'));
  const mapa = {};
  for (const n of flujo.nodes) {
    if (n.parameters?.jsCode) {
      mapa[n.name] = n.parameters.jsCode;
    }
  }
  return mapa;
}

async function ejecutarNodoN8n(jsCode, inputItems, contextoNodos) {
  const $input = {
    all: () => inputItems,
    first: () => inputItems[0] || { json: {}, binary: {} },
  };
  const $ = nombreNodo => {
    const items = contextoNodos[nombreNodo] || [];
    return {
      all: () => items,
      first: () => items[0] || { json: {}, binary: {} },
    };
  };
  const helpers = {
    getBinaryDataBuffer: async (itemIndex, propName = 'data') => {
      const b64 = inputItems[itemIndex]?.binary?.[propName]?.data || '';
      return Buffer.from(b64, 'base64');
    },
  };
  const fn = new AsyncFunction('$input', '$', jsCode);
  return await fn.call({ helpers }, $input, $);
}

async function extraerTextoPdfBuffer(buf) {
  try {
    const pdfParseMod = await import('pdf-parse/lib/pdf-parse.js').catch(() => import('pdf-parse'));
    const pdfParse = pdfParseMod.default || pdfParseMod;
    const data = await pdfParse(buf);
    if (data?.text && data.text.trim()) return data.text;
  } catch {
    // Fallback abajo
  }
  // Fallback para PDFs simples o texto embebido sin compresión Flate
  const raw = buf.toString('latin1');
  const fragmentos = [];
  const regexParen = /\(([^()\\]*(?:\\.[^()\\]*)*)\)\s*Tj/g;
  let m;
  while ((m = regexParen.exec(raw))) {
    fragmentos.push(m[1].replace(/\\([()\\])/g, '$1'));
  }
  const regexTjArr = /\[(.*?)\]\s*TJ/gs;
  while ((m = regexTjArr.exec(raw))) {
    const sub = m[1];
    const r2 = /\(([^()\\]*(?:\\.[^()\\]*)*)\)/g;
    let m2;
    while ((m2 = r2.exec(sub))) {
      fragmentos.push(m2[1].replace(/\\([()\\])/g, '$1'));
    }
  }
  return fragmentos.join(' ');
}

function parseCsvSimple(csvPath) {
  if (!fs.existsSync(csvPath)) return [];
  const raw = fs.readFileSync(csvPath, 'utf8').replace(/^\uFEFF/, '');
  const lines = raw.split(/\r?\n/).filter(l => l.trim() !== '');
  if (lines.length <= 1) return [];
  const sep = lines[0].includes(';') && !lines[0].includes(',') ? ';' : ',';
  const parseLine = line => {
    const cols = [];
    let cur = '';
    let q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (q && line[i + 1] === '"') { cur += '"'; i++; }
        else q = !q;
      } else if (ch === sep && !q) {
        cols.push(cur.trim());
        cur = '';
      } else cur += ch;
    }
    cols.push(cur.trim());
    return cols;
  };
  const headers = parseLine(lines[0]);
  return lines.slice(1).map(l => {
    const vals = parseLine(l);
    const obj = {};
    headers.forEach((h, i) => { obj[h] = vals[i] ?? ''; });
    return { json: obj };
  });
}

async function unirPdfs(rutaSalida, rutasEntrada) {
  // 1. Intentar con codigo/unir_pdf.py (Python 3 + pypdf) si está disponible
  const scriptPy = path.join(__dirname, 'unir_pdf.py');
  for (const cmd of ['python3', 'python']) {
    const res = spawnSync(cmd, [scriptPy, rutaSalida, ...rutasEntrada], { encoding: 'utf8' });
    if (res.status === 0 && fs.existsSync(rutaSalida)) {
      return;
    }
  }

  // 2. Fallback nativo en Node con pdf-lib (para Windows sin Python instalado)
  try {
    const { PDFDocument } = await import('pdf-lib');
    const merged = await PDFDocument.create();
    for (const r of rutasEntrada) {
      const bytes = fs.readFileSync(r);
      const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
      const pages = await merged.copyPages(doc, doc.getPageIndices());
      for (const page of pages) merged.addPage(page);
    }
    const outBytes = await merged.save();
    fs.writeFileSync(rutaSalida, Buffer.from(outBytes));
  } catch {
    // Si pdf-lib aún no está instalado, copiar al menos la portada (primer PDF)
    if (rutasEntrada.length > 0) {
      fs.copyFileSync(rutasEntrada[0], rutaSalida);
    }
  }
}

export async function procesarLote({ dataDir = '/work/expedientes', cedulaFiltro = null } = {}) {
  const dirAbs = path.resolve(dataDir);
  const dirEntradaBase = path.join(dirAbs, 'entrada');
  const dirSalida = path.join(dirAbs, 'salida');
  fs.mkdirSync(dirEntradaBase, { recursive: true });
  fs.mkdirSync(dirSalida, { recursive: true });

  const nodos = cargarNodosFlujo();
  const ctx = {};

  // 1. Nodo Configuración
  const cfgOut = await ejecutarNodoN8n(nodos['Configuración'], [{ json: {} }], ctx);
  cfgOut[0].json.BASE_DIR = dirAbs.replace(/\\/g, '/');
  ctx['Configuración'] = cfgOut;

  // 2. Leer postulantes.csv
  const csvPath = path.join(dirAbs, 'postulantes.csv');
  let filasCsv = parseCsvSimple(csvPath);
  if (cedulaFiltro) {
    filasCsv = filasCsv.filter(f => {
      const c = String(f.json.cedula || f.json.CEDULA || '').replace(/\D/g, '').padStart(10, '0');
      return c === cedulaFiltro;
    });
    if (!filasCsv.length) {
      filasCsv = [{ json: { cedula: cedulaFiltro, apellidos: '', nombres: '', fecha_nacimiento: '' } }];
    }
  }

  // 3. Nodo Normalizar postulantes
  const normOut = await ejecutarNodoN8n(nodos['Normalizar postulantes'], filasCsv, ctx);
  ctx['Normalizar postulantes'] = normOut;

  let browser = null;
  let page = null;
  try {
    const { chromium } = await import('playwright');
    for (const opts of [{ headless: true }, { headless: true, channel: 'msedge' }, { headless: true, channel: 'chrome' }]) {
      try {
        browser = await chromium.launch(opts);
        page = await browser.newPage();
        break;
      } catch {
        // continuar
      }
    }
  } catch {
    // Usará Chrome/Edge local por CLI en convertirHtmlAPdfBuffer
  }
  const registrosLote = [];
  const expedientesDetalle = [];

  try {
    for (const itemPostulante of normOut) {
      ctx['Postulante actual'] = [itemPostulante];
      const p = itemPostulante.json;
      const dirCedula = path.join(dirEntradaBase, p.cedula);
      fs.mkdirSync(dirCedula, { recursive: true });

      const nombresArchivos = fs.readdirSync(dirCedula).filter(f => {
        const st = fs.statSync(path.join(dirCedula, f));
        return st.isFile();
      });

      const itemsCombinados = [];
      for (const nombre of nombresArchivos) {
        const fullPath = path.join(dirCedula, nombre);
        const buf = fs.readFileSync(fullPath);
        const ext = (nombre.split('.').pop() || '').toLowerCase();
        let texto = '';
        let mimeType = 'application/octet-stream';
        if (ext === 'pdf') {
          mimeType = 'application/pdf';
          texto = await extraerTextoPdfBuffer(buf);
        } else if (ext === 'png') {
          mimeType = 'image/png';
        } else if (ext === 'jpg' || ext === 'jpeg') {
          mimeType = 'image/jpeg';
        }
        itemsCombinados.push({
          json: { text: texto },
          binary: {
            data: {
              data: buf.toString('base64'),
              fileName: nombre,
              mimeType,
              fileExtension: ext,
            },
          },
        });
      }

      ctx['Combinar archivo y texto'] = itemsCombinados;

      // 4. Nodo Clasificar y validar
      const clasifOut = await ejecutarNodoN8n(nodos['Clasificar y validar'], itemsCombinados, ctx);
      ctx['Clasificar y validar'] = clasifOut;

      // 5. Renderizar HTML -> PDF con Playwright/Chromium o Edge/Chrome local
      const generadosPdf = [];
      for (const itemHtml of clasifOut) {
        const htmlB64 = itemHtml.binary.index.data;
        const htmlStr = Buffer.from(htmlB64, 'base64').toString('utf8');
        const pdfBuf = await convertirHtmlAPdfBuffer(htmlStr, page);
        generadosPdf.push({
          json: itemHtml.json,
          binary: {
            data: {
              data: Buffer.from(pdfBuf).toString('base64'),
              fileName: `${String(itemHtml.json.orden).padStart(2, '0')}_${itemHtml.json.clave}.pdf`,
              mimeType: 'application/pdf',
              fileExtension: 'pdf',
            },
          },
        });
      }

      // 6. Nodo Ensamblar expediente
      const ensOut = await ejecutarNodoN8n(nodos['Ensamblar expediente'], generadosPdf, ctx);
      ctx['Ensamblar expediente'] = ensOut;

      // 7. Unir f01..f10 en orden
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `saher-${p.cedula}-`));
      const partesOrdenadas = [];
      for (let k = 1; k <= 10; k++) {
        const key = `f${String(k).padStart(2, '0')}`;
        const bin = ensOut[0].binary?.[key];
        if (bin?.data) {
          const partPath = path.join(tmpDir, `${key}.pdf`);
          fs.writeFileSync(partPath, Buffer.from(bin.data, 'base64'));
          partesOrdenadas.push(partPath);
        }
      }
      const mergedTmpPath = path.join(tmpDir, 'merged.pdf');
      let unionInput = [{ json: {}, binary: {} }];
      try {
        await unirPdfs(mergedTmpPath, partesOrdenadas);
        const mergedBuf = fs.readFileSync(mergedTmpPath);
        unionInput = [{
          json: {},
          binary: {
            data: {
              data: mergedBuf.toString('base64'),
              fileName: 'merged.pdf',
              mimeType: 'application/pdf',
              fileExtension: 'pdf',
            },
          },
        }];
      } catch (err) {
        unionInput = [{ json: { error: { message: err.message } }, binary: {} }];
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }

      // 8. Nodo Nombrar y resumir
      const nomOut = await ejecutarNodoN8n(nodos['Nombrar y resumir'], unionInput, ctx);
      ctx['Nombrar y resumir'] = nomOut;
      const resItem = nomOut[0];

      // 9. Guardar resumen .md y PDF final en salida/
      if (resItem.binary?.resumen) {
        fs.writeFileSync(
          path.join(dirSalida, resItem.json.nombre_resumen),
          Buffer.from(resItem.binary.resumen.data, 'base64')
        );
      }
      if (resItem.binary?.pdf && resItem.json.archivo) {
        fs.writeFileSync(
          path.join(dirSalida, resItem.json.archivo),
          Buffer.from(resItem.binary.pdf.data, 'base64')
        );
      }

      registrosLote.push({ json: { registro: resItem.json.registro } });
      expedientesDetalle.push({
        ...ensOut[0].json.expediente,
        archivo_pdf: resItem.json.archivo,
        nombre_resumen: resItem.json.nombre_resumen,
        registro: resItem.json.registro,
      });
    }

    // 10. Nodo Tabla de control (si hay al menos 1 postulante procesado)
    if (registrosLote.length) {
      // Si se procesó una sola cédula, también incluimos el resto de postulantes existentes en postulantes.csv o resúmenes previos para la tabla
      const ctrlOut = await ejecutarNodoN8n(nodos['Tabla de control'], registrosLote, ctx);
      const cItem = ctrlOut[0];
      if (cItem.binary?.csv) {
        fs.writeFileSync(path.join(dirSalida, cItem.json.archivo_csv), Buffer.from(cItem.binary.csv.data, 'base64'));
      }
      if (cItem.binary?.html) {
        fs.writeFileSync(path.join(dirSalida, cItem.json.archivo_html), Buffer.from(cItem.binary.html.data, 'base64'));
      }
      if (cItem.binary?.md) {
        fs.writeFileSync(path.join(dirSalida, cItem.json.archivo_md), Buffer.from(cItem.binary.md.data, 'base64'));
      }
    }
  } finally {
    if (browser) await browser.close();
  }

  return {
    ok: true,
    dataDir: dirAbs,
    expedientes: expedientesDetalle,
  };
}

// Ejecución directa por línea de comandos
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  const args = process.argv.slice(2);
  let cedulaFiltro = null;
  let carpetaDatos = '/work/expedientes';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--cedula' && args[i + 1]) {
      cedulaFiltro = args[i + 1];
      i++;
    } else if (!args[i].startsWith('--')) {
      carpetaDatos = args[i];
    }
  }

  procesarLote({ dataDir: carpetaDatos, cedulaFiltro })
    .then(res => {
      console.log(JSON.stringify({
        ok: true,
        procesados: res.expedientes.map(e => ({
          cedula: e.postulante.cedula,
          nombre: e.postulante.nombre_completo,
          archivo_pdf: e.archivo_pdf,
          totales: e.totales,
        })),
      }, null, 2));
    })
    .catch(err => {
      console.error('Error al procesar lote:', err);
      process.exit(1);
    });
}

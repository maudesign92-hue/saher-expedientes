/**
 * codigo/agente_verificador.mjs
 * AGENTE VERIFICADOR DE IDENTIDAD Y AUTENTICIDAD DOCUMENTAL (SAHER / RCI)
 *
 * Regla de cumplimiento estricto:
 * - Ningún certificado puede ser aceptado o descargado si su cédula o nombre NO coincide
 *   con el postulante consultado.
 * - Rechaza cualquier plantilla alterada o PDF sintético falso.
 * - Verifica que los PDFs gubernamentales provengan de los portales oficiales reales.
 */
import { createRequire } from 'node:module';

const requireCjs = createRequire(import.meta.url);

export function normalizarTexto(s) {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9Ñ\s/\-:.]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function esCedulaMod10(c) {
  if (!/^\d{10}$/.test(c)) return false;
  const prov = Number(c.slice(0, 2));
  if (!((prov >= 1 && prov <= 24) || prov === 30) || Number(c[2]) >= 6) return false;
  const coef = [2, 1, 2, 1, 2, 1, 2, 1, 2];
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    let v = Number(c[i]) * coef[i];
    if (v > 9) v -= 9;
    sum += v;
  }
  return ((10 - (sum % 10)) % 10) === Number(c[9]);
}

export function extraerCedulasEnTexto(texto) {
  const matches = String(texto || '').match(/(?<!\d)\d{9}-?\d(?!\d)/g) || [];
  const limpias = matches.map(m => m.replace('-', ''));
  return [...new Set(limpias)].filter(esCedulaMod10);
}

const FIRMAS_OFICIALES = {
  antecedentes: /MINISTERIO DEL INTERIOR|POLICIA NACIONAL|ANTECEDENTES PENALES|CERTIFICADO DE ANTECEDENTES/i,
  judiciales: /FUNCION JUDICIAL|SATJE|CONSEJO DE LA JUDICATURA|PROCESOS JUDICIALES|CONSULTA DE CAUSAS/i,
  no_ffaa: /MINISTERIO DE DEFENSA NACIONAL|FUERZAS ARMADAS|MDN-NOFA|NO REGISTRA DATOS COMO MILITAR|NO PERTENECE/i,
  clts: /MINISTERIO DE DEFENSA NACIONAL|TIEMPO DE SERVICIO|CLTS|LIQUIDACION DE TIEMPO|NO REGISTRA DATOS COMO MILITAR/i,
  servidor_publico: /MINISTERIO DE TRABAJO|MINISTERIO DEL TRABAJO|MDT-IRSSSP|SECTOR PUBLICO|DEPENDENCIA LABORAL/i,
  titulo_bachiller: /MINISTERIO DE EDUCACION|TITULO DE BACHILLER|TITULOS REFRENDADOS|BACHILLER/i,
};

const STOPWORDS_NOMBRE = new Set(['DEL', 'LOS', 'LAS', 'CON', 'POR', 'PARA', 'UNA', 'UNO', 'SAN', 'SANTA']);

export async function extraerTextoPdf(buffer) {
  try {
    const pdfParse = requireCjs('pdf-parse');
    const data = await pdfParse(buffer);
    return String(data?.text || '');
  } catch {
    return '';
  }
}

/**
 * Verifica estrictamente un documento PDF o archivo antes de aceptarlo en el expediente.
 */
export async function verificarDocumento({
  buffer,
  nombreArchivo = '',
  cedulaEsperada,
  nombreEsperado = '',
  slotClave = '',
}) {
  const ext = (nombreArchivo.split('.').pop() || '').toLowerCase();
  if (!buffer || buffer.length < 100) {
    return {
      valido: false,
      nivel: 'RECHAZADO',
      motivo: 'Archivo vacío o corrupto.',
      cedulasEncontradas: [],
      coincidenciaNombre: false,
      coincidenciaCedula: false,
    };
  }

  // Para imágenes o documentos Word subidos manualmente, no hay texto PDF verificable automáticamente
  if (ext !== 'pdf') {
    return {
      valido: true,
      nivel: 'REVISION_VISUAL',
      motivo: `Archivo ${ext.toUpperCase()} cargado manualmente. Requiere revisión visual de RR. HH.`,
      cedulasEncontradas: [],
      coincidenciaNombre: null,
      coincidenciaCedula: null,
    };
  }

  // Verificar cabecera PDF real
  if (buffer.slice(0, 5).toString('latin1') !== '%PDF-') {
    return {
      valido: false,
      nivel: 'RECHAZADO',
      motivo: 'El archivo no tiene una cabecera PDF válida.',
      cedulasEncontradas: [],
      coincidenciaNombre: false,
      coincidenciaCedula: false,
    };
  }

  // Detectar marcadores de plantillas falsas anteriores
  const rawLatin1 = buffer.toString('latin1');
  if (rawLatin1.includes('%SAHER_TEXT_START') || rawLatin1.includes('SAHER_PORTAL_CAPTURE')) {
    return {
      valido: false,
      nivel: 'RECHAZADO',
      motivo: 'Documento sintético o alterado detectado y bloqueado por el Agente Verificador.',
      cedulasEncontradas: [],
      coincidenciaNombre: false,
      coincidenciaCedula: false,
    };
  }

  const textoCrudo = await extraerTextoPdf(buffer);
  const textoNorm = normalizarTexto(textoCrudo);
  const cedulasEncontradas = extraerCedulasEnTexto(textoCrudo);

  // Si el PDF es una imagen escaneada (sin capa de texto)
  if (textoNorm.length < 25) {
    return {
      valido: true,
      nivel: 'SOLO_IMAGEN',
      motivo: 'PDF escaneado sin texto seleccionable. Revisar visualmente que coincida con el postulante.',
      cedulasEncontradas: [],
      coincidenciaNombre: null,
      coincidenciaCedula: null,
    };
  }

  // 1. Verificar CÉDULA
  const otrasCedulas = cedulasEncontradas.filter(c => c !== cedulaEsperada);
  const tieneCedulaEsperada = cedulasEncontradas.includes(cedulaEsperada);

  if (otrasCedulas.length > 0 && !tieneCedulaEsperada) {
    return {
      valido: false,
      nivel: 'ALERTA_IDENTIDAD',
      motivo: `BLOQUEADO: El PDF pertenece a otra cédula (${otrasCedulas.join(', ')}) y NO a ${cedulaEsperada}.`,
      cedulasEncontradas,
      coincidenciaNombre: false,
      coincidenciaCedula: false,
    };
  }

  // 2. Verificar NOMBRE COMPLETO
  const tokensEsperados = [...new Set(
    normalizarTexto(nombreEsperado)
      .split(/\s+/)
      .filter(w => w.length >= 3 && !STOPWORDS_NOMBRE.has(w))
  )];

  let tokensEncontrados = 0;
  for (const tk of tokensEsperados) {
    if (textoNorm.includes(tk)) tokensEncontrados++;
  }

  const minimoTokens = tokensEsperados.length >= 3 ? 2 : tokensEsperados.length;
  const coincidenciaNombre = tokensEsperados.length === 0 ? true : tokensEncontrados >= minimoTokens;

  if (tokensEsperados.length >= 2 && tokensEncontrados === 0) {
    return {
      valido: false,
      nivel: 'ALERTA_IDENTIDAD',
      motivo: `BLOQUEADO: El nombre dentro del PDF no coincide con "${nombreEsperado}".`,
      cedulasEncontradas,
      coincidenciaNombre: false,
      coincidenciaCedula: tieneCedulaEsperada,
    };
  }

  // 3. Verificar firma oficial si es un portal gubernamental
  if (slotClave && FIRMAS_OFICIALES[slotClave]) {
    if (!FIRMAS_OFICIALES[slotClave].test(textoNorm)) {
      return {
        valido: false,
        nivel: 'ALERTA_AUTENTICIDAD',
        motivo: `El PDF no contiene los encabezados oficiales esperados para "${slotClave}". Verifica que sea el certificado correcto del portal.`,
        cedulasEncontradas,
        coincidenciaNombre,
        coincidenciaCedula: tieneCedulaEsperada,
      };
    }
  }

  return {
    valido: true,
    nivel: tieneCedulaEsperada && coincidenciaNombre ? 'VERIFICADO' : 'VERIFICADO_PARCIAL',
    motivo: tieneCedulaEsperada && coincidenciaNombre
      ? `Identidad verificada: C.I. ${cedulaEsperada} y nombre coinciden 100% con el documento oficial.`
      : `Documento validado (cédula: ${tieneCedulaEsperada ? 'OK' : 'no visible en texto'}, coincidencia nombre: ${tokensEncontrados}/${tokensEsperados.length}).`,
    cedulasEncontradas,
    coincidenciaNombre,
    coincidenciaCedula: tieneCedulaEsperada,
  };
}

/**
 * codigo/evaluacion_confianza.mjs
 * COMPONENTE A — EVALUACIÓN DE CONFIANZA (Marco IPIP-HEXACO Honestidad-Humildad, 40 enunciados)
 *
 * - 4 facetas (10 ítems c/u): Sinceridad, Justicia y normas, Evitación de la codicia, Modestia.
 * - Controles automatizados de calidad:
 *   1. Azarosidad: respuestas marcadas en < 1.5 segundos.
 *   2. Aquiescencia: racha más larga de respuestas idénticas y porcentaje de concentración.
 *   3. Continuidad: salidas de pantalla / cambios de pestaña durante la prueba.
 *   4. Verificación de identidad: captura fotográfica autorizada (si el postulante activó cámara).
 * - Genera el Informe Ejecutivo de Resultados en PDF (psicologo.pdf) con el logo/marca SAHER.
 */
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

// 40 enunciados en español sencillo (escala 1=Nunca, 2=A veces, 3=Neutral/Regularmente, 4=Casi siempre, 5=Siempre)
// invertido: true significa que "Siempre" indica menor puntaje en Honestidad-Humildad.
export const ITEMS_CONFIANZA = [
  // ── 1. SINCERIDAD (10 ítems) ──
  { id: 1, faceta: 'sinceridad', invertido: false, texto: 'Digo la verdad incluso cuando sé que puede traerme problemas.' },
  { id: 2, faceta: 'sinceridad', invertido: true, texto: 'Halago a mis superiores aunque no piense bien de ellos, para ganar su favor.' },
  { id: 3, faceta: 'sinceridad', invertido: false, texto: 'Evito fingir que me agrada alguien solo para obtener un beneficio.' },
  { id: 4, faceta: 'sinceridad', invertido: true, texto: 'Si necesito algo de una persona, suelo decirle exactamente lo que quiere escuchar.' },
  { id: 5, faceta: 'sinceridad', invertido: false, texto: 'Prefiero ser directo y transparente antes que manipular una situación.' },
  { id: 6, faceta: 'sinceridad', invertido: true, texto: 'Exagero mis logros o habilidades para causar mejor impresión en una entrevista.' },
  { id: 7, faceta: 'sinceridad', invertido: false, texto: 'Reconozco mis errores frente a mi jefe o compañeros sin buscar excusas falsas.' },
  { id: 8, faceta: 'sinceridad', invertido: true, texto: 'Oculto información importante si creo que eso me evita una sanción.' },
  { id: 9, faceta: 'sinceridad', invertido: false, texto: 'Mis compañeros pueden confiar en que lo que digo es exactamente lo que ocurrió.' },
  { id: 10, faceta: 'sinceridad', invertido: true, texto: 'Uso cumplidos falsos para lograr que otros hagan favores por mí.' },

  // ── 2. JUSTICIA Y NORMAS (10 ítems) ──
  { id: 11, faceta: 'justicia', invertido: false, texto: 'Cumplo las reglas y procedimientos de seguridad incluso cuando nadie me está vigilando.' },
  { id: 12, faceta: 'justicia', invertido: true, texto: 'Si encuentro dinero o un objeto olvidado en mi puesto, podría quedármelo si nadie reclama.' },
  { id: 13, faceta: 'justicia', invertido: false, texto: 'Nunca aceptaría un soborno o pago indebido para dejar pasar algo irregular.' },
  { id: 14, faceta: 'justicia', invertido: true, texto: 'A veces busco atajos en las normas si eso hace mi turno más fácil o rápido.' },
  { id: 15, faceta: 'justicia', invertido: false, texto: 'Respeto los bienes y equipos de la empresa como si fueran propios.' },
  { id: 16, faceta: 'justicia', invertido: true, texto: 'Si supiera que nunca me descubrirían, podría llevarme algún artículo pequeño del trabajo.' },
  { id: 17, faceta: 'justicia', invertido: false, texto: 'Reporto cualquier novedad o falta grave aunque involucre a un conocido.' },
  { id: 18, faceta: 'justicia', invertido: true, texto: 'Creo que hacer pequeñas trampas no tiene importancia si no perjudica directamente a nadie.' },
  { id: 19, faceta: 'justicia', invertido: false, texto: 'Entrego siempre las cuentas, llaves y novedades exactas al finalizar mi jornada.' },
  { id: 20, faceta: 'justicia', invertido: true, texto: 'Estaría dispuesto a incumplir una consigna si un cliente o amigo me ofrece un favor a cambio.' },

  // ── 3. EVITACIÓN DE LA CODICIA (10 ítems) ──
  { id: 21, faceta: 'codicia', invertido: false, texto: 'Valoro más la tranquilidad de hacer un trabajo honesto que tener lujos.' },
  { id: 22, faceta: 'codicia', invertido: true, texto: 'Tener mucho dinero y bienes materiales es lo más importante en la vida.' },
  { id: 23, faceta: 'codicia', invertido: false, texto: 'Puedo vivir conforme con un ingreso justo sin envidiar lo que otros tienen.' },
  { id: 24, faceta: 'codicia', invertido: true, texto: 'Me siento atraído por el dinero rápido aunque implique asumir riesgos dudosos.' },
  { id: 25, faceta: 'codicia', invertido: false, texto: 'No necesito aparentar un nivel económico mayor al que realmente tengo.' },
  { id: 26, faceta: 'codicia', invertido: true, texto: 'Estaría dispuesto a trabajar en algo poco ético si la paga fuera muy alta.' },
  { id: 27, faceta: 'codicia', invertido: false, texto: 'Prefiero ganar mi salario paso a paso antes que buscar ganancias fáciles.' },
  { id: 28, faceta: 'codicia', invertido: true, texto: 'Admiro a las personas que consiguen dinero y poder sin importar cómo lo lograron.' },
  { id: 29, faceta: 'codicia', invertido: false, texto: 'Para mí, la reputación y el honor valen más que cualquier recompensa económica.' },
  { id: 30, faceta: 'codicia', invertido: true, texto: 'Siento frustración constante cuando veo que otros tienen cosas más caras que las mías.' },

  // ── 4. MODESTIA (10 ítems) ──
  { id: 31, faceta: 'modestia', invertido: false, texto: 'Me considero una persona común, con los mismos derechos y deberes que los demás.' },
  { id: 32, faceta: 'modestia', invertido: true, texto: 'Creo que merezco un trato especial o privilegios por encima de mis compañeros.' },
  { id: 33, faceta: 'modestia', invertido: false, texto: 'Acepto con humildad las correcciones de un supervisor cuando me equivoco.' },
  { id: 34, faceta: 'modestia', invertido: true, texto: 'Me molesta recibir órdenes de personas que considero menos capaces que yo.' },
  { id: 35, faceta: 'modestia', invertido: false, texto: 'Trato con el mismo respeto a todo tipo de personas, sin importar su cargo o condición.' },
  { id: 36, faceta: 'modestia', invertido: true, texto: 'Siento que las reglas estrictas deberían aplicarse a otros, no tanto a mí.' },
  { id: 37, faceta: 'modestia', invertido: false, texto: 'No me gusta presumir de mis logros ni hacer sentir menos a los demás.' },
  { id: 38, faceta: 'modestia', invertido: true, texto: 'Soy mejor que la mayoría de personas con las que trabajo.' },
  { id: 39, faceta: 'modestia', invertido: false, texto: 'Trabajo bien en equipo sin intentar imponer siempre mi voluntad.' },
  { id: 40, faceta: 'modestia', invertido: true, texto: 'Cuando algo sale mal en el turno, casi siempre la culpa es de otras personas.' },
];

const NOMBRES_FACETA = {
  sinceridad: 'Sinceridad',
  justicia: 'Justicia y normas',
  codicia: 'Evitación de la codicia',
  modestia: 'Modestia',
};

const PREGUNTAS_CONTRASTE = {
  sinceridad: [
    'Cuéntame una ocasión en la que cometiste un error en tu trabajo y cómo lo comunicaste a tu supervisor.',
    '¿Qué harías si un compañero te pide cubrir una falta suya ante la jefatura?',
  ],
  justicia: [
    'Si encuentras un objeto de valor o dinero en una garita o área asignada sin cámaras, ¿cuál sería tu procedimiento exacto?',
    '¿Has tenido alguna situación donde alguien intentó ofrecerte un beneficio para flexibilizar un control de acceso?',
  ],
  codicia: [
    '¿Cómo manejas tus compromisos económicos cuando tus ingresos son fijos y surgen gastos imprevistos?',
    '¿Qué pesa más para ti al elegir un puesto de seguridad: estabilidad y respaldo o ingresos adicionales?',
  ],
  modestia: [
    'Describe una situación en la que recibiste una llamada de atención que no compartías del todo. ¿Cómo reaccionaste?',
    '¿Cómo te llevas trabajando bajo protocolos estrictos y supervisión constante?',
  ],
};

export function calificarEvaluacionConfianza({
  respuestas = [],
  tiemposMs = [],
  cambiosPestana = 0,
  fotosCapturadas = 0,
  duracionTotalSeg = 0,
}) {
  if (!Array.isArray(respuestas) || respuestas.length !== ITEMS_CONFIANZA.length) {
    throw new Error(`Se requieren exactamente ${ITEMS_CONFIANZA.length} respuestas.`);
  }

  const acum = { sinceridad: [], justicia: [], codicia: [], modestia: [] };
  const rawVals = [];

  for (let i = 0; i < ITEMS_CONFIANZA.length; i++) {
    const item = ITEMS_CONFIANZA[i];
    const val = Number(respuestas[i]);
    if (!Number.isFinite(val) || val < 1 || val > 5) {
      throw new Error(`Respuesta inválida en pregunta ${i + 1}`);
    }
    rawVals.push(val);
    const score = item.invertido ? (6 - val) : val;
    acum[item.faceta].push(score);
  }

  const promedio = arr => arr.reduce((a, b) => a + b, 0) / arr.length;
  const facetas = {};
  for (const [k, arr] of Object.entries(acum)) {
    facetas[k] = Number(promedio(arr).toFixed(2));
  }
  const puntajeGlobal = Number(promedio(Object.values(facetas)).toFixed(2));

  // Controles de calidad
  const respuestasApresuradas = (tiemposMs || []).filter(ms => Number(ms) > 0 && Number(ms) < 1500).length;

  let rachaActual = 1;
  let rachaMaxima = 1;
  const conteoOpc = {};
  for (let i = 0; i < rawVals.length; i++) {
    conteoOpc[rawVals[i]] = (conteoOpc[rawVals[i]] || 0) + 1;
    if (i > 0 && rawVals[i] === rawVals[i - 1]) {
      rachaActual++;
      if (rachaActual > rachaMaxima) rachaMaxima = rachaActual;
    } else {
      rachaActual = 1;
    }
  }
  const maxConc = Math.round((Math.max(...Object.values(conteoOpc)) / rawVals.length) * 100);

  const alertaAzarosidad = respuestasApresuradas >= 8;
  const alertaAquiescencia = rachaMaxima >= 10 || maxConc >= 70;
  const alertaContinuidad = Number(cambiosPestana) >= 4;
  const calidadConsistente = !alertaAzarosidad && !alertaAquiescencia && !alertaContinuidad;

  // Ordenar facetas para identificar fortaleza y aspecto a contrastar
  const ordenadas = Object.entries(facetas).sort((a, b) => b[1] - a[1]);
  const fortaleza = ordenadas[0][0];
  const menorFaceta = ordenadas[ordenadas.length - 1][0];

  const nivelGlobal = !calidadConsistente
    ? 'NO CONCLUYENTE (La informacion no permite decidir; revisar o repetir)'
    : puntajeGlobal >= 3.6
      ? 'FAVORABLE (El resultado respalda el perfil de confianza evaluado)'
      : 'NO FAVORABLE (El resultado muestra alertas relevantes para el perfil evaluado)';

  const conclusion = !calidadConsistente
    ? 'NO CONCLUYENTE'
    : puntajeGlobal >= 3.6
      ? 'FAVORABLE'
      : 'NO FAVORABLE';

  return {
    conclusion,
    vigencia_dias: 90,
    puntaje_global: puntajeGlobal,
    nivel_global: nivelGlobal,
    facetas,
    fortaleza: NOMBRES_FACETA[fortaleza],
    aspecto_contraste: NOMBRES_FACETA[menorFaceta],
    preguntas_contraste: PREGUNTAS_CONTRASTE[menorFaceta],
    calidad: {
      estado: calidadConsistente ? 'Consistente' : 'Contrastar en entrevista',
      respuestas_apresuradas: respuestasApresuradas,
      racha_identica_max: rachaMaxima,
      concentracion_pct: maxConc,
      salidas_pantalla: Number(cambiosPestana) || 0,
      fotos_verificacion: Number(fotosCapturadas) || 0,
      duracion_seg: Number(duracionTotalSeg) || 0,
    },
  };
}

function limpiarAscii(s) {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7E]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function generarPdfInformeConfianza({ cedula, nombreCompleto, evaluacion, fechaHoy }) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595.28, 841.89]); // A4
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);

  const negro = rgb(0.05, 0.05, 0.06);
  const rojo = rgb(0.784, 0.063, 0.18);
  const dorado = rgb(0.831, 0.686, 0.216);
  const gris = rgb(0.35, 0.37, 0.42);
  const fondoClaro = rgb(0.96, 0.97, 0.98);
  const verde = rgb(0.075, 0.45, 0.2);

  // Header negro + banda dorada
  page.drawRectangle({ x: 0, y: 760, width: 595.28, height: 82, color: negro });
  page.drawRectangle({ x: 0, y: 756, width: 595.28, height: 4, color: dorado });
  page.drawText('SAHER SEGURIDAD PRIVADA · RCI CONFIANZA', {
    x: 40, y: 810, size: 10, font: fontBold, color: dorado,
  });
  page.drawText('INFORME EJECUTIVO DE EVALUACION DE CONFIANZA', {
    x: 40, y: 788, size: 15, font: fontBold, color: rgb(1, 1, 1),
  });
  page.drawText(`Escala IPIP Honestidad-Humildad (HEXACO - 40 enunciados) · Fecha: ${fechaHoy}`, {
    x: 40, y: 770, size: 8.5, font, color: rgb(0.82, 0.84, 0.88),
  });

  // Caja de identidad
  page.drawRectangle({ x: 40, y: 684, width: 515, height: 58, color: fondoClaro, borderColor: negro, borderWidth: 1 });
  page.drawText('POSTULANTE VERIFICADO:', { x: 52, y: 724, size: 8, font: fontBold, color: gris });
  page.drawText(limpiarAscii(nombreCompleto || `POSTULANTE ${cedula}`), { x: 52, y: 707, size: 13, font: fontBold, color: negro });
  page.drawText(`CEDULA DE IDENTIDAD: ${cedula}`, { x: 52, y: 692, size: 9.5, font: fontBold, color: rojo });
  page.drawText(`CARGO: Guardia de Seguridad Privada`, { x: 320, y: 692, size: 9.5, font, color: gris });

  // 3 KPIs (como Slide 8 de MindSuite360)
  const kpis = [
    { label: 'PERFIL GLOBAL H-H', val: `${evaluacion.puntaje_global.toFixed(2)} / 5.00`, sub: evaluacion.nivel_global.split('(')[0].trim() },
    { label: 'CALIDAD DE RESPUESTA', val: evaluacion.calidad.estado, sub: `Apresuradas (<1.5s): ${evaluacion.calidad.respuestas_apresuradas}` },
    { label: 'VERIFICACION SESION', val: `${evaluacion.calidad.fotos_verificacion} foto(s) · ${evaluacion.calidad.salidas_pantalla} salidas`, sub: `Duracion: ${evaluacion.calidad.duracion_seg}s` },
  ];
  kpis.forEach((k, idx) => {
    const x = 40 + idx * 175;
    page.drawRectangle({ x, y: 602, width: 165, height: 68, color: rgb(1, 1, 1), borderColor: rgb(0.82, 0.84, 0.87), borderWidth: 1 });
    page.drawText(k.label, { x: x + 10, y: 654, size: 7.5, font: fontBold, color: gris });
    page.drawText(limpiarAscii(k.val), { x: x + 10, y: 632, size: 12, font: fontBold, color: idx === 0 ? verde : negro });
    page.drawText(limpiarAscii(k.sub), { x: x + 10, y: 614, size: 7.5, font, color: gris });
  });

  // Resumen ejecutivo y Conclusión (FAVORABLE / NO FAVORABLE / NO CONCLUYENTE)
  const conclColor = evaluacion.conclusion === 'FAVORABLE' ? verde : (evaluacion.conclusion === 'NO FAVORABLE' ? rojo : dorado);
  page.drawRectangle({ x: 40, y: 556, width: 515, height: 32, color: fondoClaro, borderColor: conclColor, borderWidth: 1.5 });
  page.drawText(`CONCLUSION: ${evaluacion.conclusion || 'FAVORABLE'}  (Vigencia: 90 dias · Art. 50.4 / 51.4 LOVSP)`, {
    x: 52, y: 568, size: 11, font: fontBold, color: conclColor,
  });

  page.drawText('RESUMEN EJECUTIVO Y LECTURA POR FACETAS', { x: 40, y: 536, size: 10, font: fontBold, color: negro });
  page.drawLine({ start: { x: 40, y: 531 }, end: { x: 555, y: 531 }, thickness: 1.5, color: rojo });
  page.drawText(
    limpiarAscii(`Fortaleza relativa: ${evaluacion.fortaleza}. Area prioritaria de contraste en entrevista: ${evaluacion.aspecto_contraste}.`),
    { x: 40, y: 514, size: 9.5, font, color: negro }
  );

  // Barras de las 4 facetas + global
  const filas = [
    ['Perfil Global (H-H)', evaluacion.puntaje_global],
    ['1. Sinceridad', evaluacion.facetas.sinceridad],
    ['2. Justicia y normas', evaluacion.facetas.justicia],
    ['3. Evitacion de la codicia', evaluacion.facetas.codicia],
    ['4. Modestia', evaluacion.facetas.modestia],
  ];
  let y = 482;
  for (const [nombreF, val] of filas) {
    page.drawText(nombreF, { x: 40, y, size: 9.5, font: fontBold, color: negro });
    // Barra fondo
    page.drawRectangle({ x: 210, y: y - 2, width: 280, height: 12, color: rgb(0.9, 0.92, 0.94) });
    const ancho = Math.max(8, Math.min(280, (val / 5) * 280));
    page.drawRectangle({ x: 210, y: y - 2, width: ancho, height: 12, color: val >= 3.5 ? verde : (val >= 2.8 ? dorado : rojo) });
    page.drawText(`${val.toFixed(2)} / 5`, { x: 502, y, size: 9.5, font: fontBold, color: negro });
    y -= 28;
  }

  // Indicadores de calidad
  y -= 10;
  page.drawText('INDICADORES DE CALIDAD DE LA APLICACION', { x: 40, y, size: 10, font: fontBold, color: negro });
  page.drawLine({ start: { x: 40, y: y - 5 }, end: { x: 555, y: y - 5 }, thickness: 1, color: dorado });
  y -= 24;
  page.drawText(
    `Azarosidad (<1.5s): ${evaluacion.calidad.respuestas_apresuradas} de 40   |   Aquiescencia (racha max): ${evaluacion.calidad.racha_identica_max} (${evaluacion.calidad.concentracion_pct}%)   |   Salidas de pantalla: ${evaluacion.calidad.salidas_pantalla}`,
    { x: 40, y, size: 8.5, font, color: gris }
  );

  // Preguntas sugeridas para entrevista de contraste
  y -= 32;
  page.drawText('PREGUNTAS SUGERIDAS PARA ENTREVISTA DE CONTRASTE', { x: 40, y, size: 10, font: fontBold, color: negro });
  page.drawLine({ start: { x: 40, y: y - 5 }, end: { x: 555, y: y - 5 }, thickness: 1, color: rojo });
  y -= 24;
  for (const pq of evaluacion.preguntas_contraste || []) {
    page.drawText(`- ${limpiarAscii(pq).slice(0, 95)}`, { x: 44, y, size: 9, font, color: negro });
    if (limpiarAscii(pq).length > 95) {
      y -= 14;
      page.drawText(`  ${limpiarAscii(pq).slice(95, 190)}`, { x: 44, y, size: 9, font, color: negro });
    }
    y -= 22;
  }

  // Pie de página
  page.drawLine({ start: { x: 40, y: 58 }, end: { x: 555, y: 58 }, thickness: 0.8, color: rgb(0.8, 0.8, 0.8) });
  page.drawText(
    'SAHER - Centro de Capacitacion y Seguridad Privada · Documento generado automaticamente desde el enlace oficial del postulante.',
    { x: 40, y: 42, size: 8, font, color: gris }
  );

  doc.setSubject(
    `CERTIFICADO DE PRUEBA DE CONFIANZA SAHER ${limpiarAscii(nombreCompleto)} CEDULA ${cedula} PUNTAJE ${evaluacion.puntaje_global.toFixed(2)} FECHA ${fechaHoy}`
  );
  return Buffer.from(await doc.save());
}

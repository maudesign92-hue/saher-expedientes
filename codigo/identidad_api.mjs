/**
 * codigo/identidad_api.mjs
 * Valida la cédula ecuatoriana (10 dígitos, provincia 01-24 o 30, tercer dígito < 6, módulo 10),
 * verifica si ya existe en postulantes.csv para no gastar saldo dos veces,
 * consulta EcuadorAPI una sola vez por cédula y actualiza postulantes.csv.
 */
import fs from 'node:fs';
import path from 'node:path';

export function validarCedulaEcuatoriana(cedulaRaw) {
  const c = String(cedulaRaw ?? '').trim();
  if (!/^\d{10}$/.test(c)) {
    return { valida: false, motivo: 'La cédula debe tener 10 dígitos' };
  }
  const prov = Number(c.slice(0, 2));
  if (!((prov >= 1 && prov <= 24) || prov === 30)) {
    return { valida: false, motivo: 'Código de provincia inválido (debe ser 01 a 24 o 30)' };
  }
  if (Number(c[2]) >= 6) {
    return { valida: false, motivo: 'El tercer dígito de la cédula debe ser menor a 6' };
  }
  const coef = [2, 1, 2, 1, 2, 1, 2, 1, 2];
  let suma = 0;
  for (let i = 0; i < 9; i++) {
    let v = Number(c[i]) * coef[i];
    if (v > 9) v -= 9;
    suma += v;
  }
  const verificador = (10 - (suma % 10)) % 10;
  if (verificador !== Number(c[9])) {
    return { valida: false, motivo: 'Dígito verificador inválido (no supera validación módulo 10)' };
  }
  return { valida: true, cedula: c };
}

function parseCsvLine(line) {
  const sep = line.includes(';') && !line.includes(',') ? ';' : ',';
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === sep && !inQuotes) {
      out.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur.trim());
  return out;
}

export function leerPostulantesCsv(dataDir) {
  const csvPath = path.join(dataDir, 'postulantes.csv');
  if (!fs.existsSync(csvPath)) {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(csvPath, 'cedula,apellidos,nombres,fecha_nacimiento,estado_civil,cedula_busqueda,contratado,fecha_registro\n', 'utf8');
    return [];
  }
  const raw = fs.readFileSync(csvPath, 'utf8').replace(/^\uFEFF/, '');
  const lines = raw.split(/\r?\n/).filter(l => l.trim() !== '');
  if (lines.length <= 1) return [];
  const headers = parseCsvLine(lines[0]).map(h => h.toLowerCase().trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    const obj = {};
    headers.forEach((h, idx) => {
      obj[h] = cols[idx] ?? '';
    });
    if (obj.cedula) rows.push(obj);
  }
  return rows;
}

export function guardarPostulanteEnCsv(dataDir, postulante) {
  const csvPath = path.join(dataDir, 'postulantes.csv');
  const actuales = leerPostulantesCsv(dataDir);
  const idx = actuales.findIndex(r => r.cedula === postulante.cedula);
  const hoy = new Date().toISOString().slice(0, 10);
  const registro = {
    cedula: postulante.cedula,
    apellidos: postulante.apellidos ?? actuales[idx]?.apellidos ?? '',
    nombres: postulante.nombres ?? actuales[idx]?.nombres ?? '',
    fecha_nacimiento: postulante.fecha_nacimiento ?? actuales[idx]?.fecha_nacimiento ?? '',
    estado_civil: postulante.estado_civil ?? actuales[idx]?.estado_civil ?? '',
    cedula_busqueda: postulante.cedula_busqueda ?? actuales[idx]?.cedula_busqueda ?? '',
    contratado: postulante.contratado ?? actuales[idx]?.contratado ?? 'no',
    fecha_registro: actuales[idx]?.fecha_registro || hoy,
  };
  if (idx >= 0) actuales[idx] = registro;
  else actuales.push(registro);

  const header = 'cedula,apellidos,nombres,fecha_nacimiento,estado_civil,cedula_busqueda,contratado,fecha_registro';
  const esc = v => {
    const s = String(v ?? '');
    return s.includes(',') || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const body = actuales.map(r =>
    [r.cedula, r.apellidos, r.nombres, r.fecha_nacimiento, r.estado_civil, r.cedula_busqueda, r.contratado, r.fecha_registro]
      .map(esc)
      .join(',')
  );
  fs.writeFileSync(csvPath, [header, ...body].join('\n') + '\n', 'utf8');
  return registro;
}

export async function consultarSaldoEcuadorApi() {
  const apiKey = process.env.ECUADORAPI_API_KEY || '';
  const baseUrl = (process.env.ECUADORAPI_BASE_URL || 'https://api.ecuadorapi.com/v1').replace(/\/$/, '');
  if (!apiKey || apiKey === 'pon_aqui_tu_clave_de_ecuadorapi') {
    return {
      configurado: false,
      balance_usd: null,
      remaining_queries: null,
      cost_per_query_usd: 0.03,
      alerta_bajo_saldo: false,
      mensaje: 'ECUADORAPI_API_KEY no configurada en .env',
    };
  }
  try {
    const resp = await fetch(`${baseUrl}/usage`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'x-api-key': apiKey,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}`);
    }
    const data = await resp.json();
    const balance = Number(data.balance_usd ?? data.balance ?? data.saldo ?? 0);
    const remaining = Number(data.remaining_queries ?? data.remaining ?? Math.floor(balance / 0.03));
    return {
      configurado: true,
      balance_usd: balance,
      remaining_queries: remaining,
      cost_per_query_usd: 0.03,
      alerta_bajo_saldo: remaining < 20,
    };
  } catch (err) {
    return {
      configurado: true,
      error: err.message,
      balance_usd: null,
      remaining_queries: null,
      cost_per_query_usd: 0.03,
      alerta_bajo_saldo: false,
    };
  }
}

export async function obtenerIdentidadPorCedula(cedulaRaw, dataDir) {
  const val = validarCedulaEcuatoriana(cedulaRaw);
  if (!val.valida) {
    return { ok: false, error: val.motivo };
  }
  const cedula = val.cedula;
  const existentes = leerPostulantesCsv(dataDir);
  const encontrado = existentes.find(r => r.cedula === cedula);

  // Si ya está en postulantes.csv con nombres, NO se vuelve a gastar consulta en EcuadorAPI
  if (encontrado && (encontrado.apellidos || encontrado.nombres)) {
    return {
      ok: true,
      desde_cache: true,
      gasto_usd: 0,
      fuente: 'EcuadorAPI, no oficial (en caché postulantes.csv)',
      postulante: {
        cedula,
        apellidos: encontrado.apellidos || '',
        nombres: encontrado.nombres || '',
        nombre_completo: [encontrado.apellidos, encontrado.nombres].filter(Boolean).join(' '),
        fecha_nacimiento: encontrado.fecha_nacimiento || '',
        estado_civil: encontrado.estado_civil || '—',
      },
    };
  }

  const apiKey = process.env.ECUADORAPI_API_KEY || '';
  const baseUrl = (process.env.ECUADORAPI_BASE_URL || 'https://api.ecuadorapi.com/v1').replace(/\/$/, '');

  if (!apiKey || apiKey === 'pon_aqui_tu_clave_de_ecuadorapi') {
    // Asegurar fila en CSV para que el procesador pueda tomar el nombre del certificado de antecedentes si existe
    const guardado = guardarPostulanteEnCsv(dataDir, {
      cedula,
      apellidos: encontrado?.apellidos || '',
      nombres: encontrado?.nombres || '',
      fecha_nacimiento: encontrado?.fecha_nacimiento || '',
      estado_civil: encontrado?.estado_civil || '',
    });
    return {
      ok: true,
      desde_cache: false,
      gasto_usd: 0,
      sin_api_key: true,
      fuente: 'Sin clave EcuadorAPI (se tomará del certificado de antecedentes si está disponible)',
      postulante: {
        cedula,
        apellidos: guardado.apellidos,
        nombres: guardado.nombres,
        nombre_completo: [guardado.apellidos, guardado.nombres].filter(Boolean).join(' '),
        fecha_nacimiento: guardado.fecha_nacimiento,
        estado_civil: guardado.estado_civil || '—',
      },
    };
  }

  try {
    const resp = await fetch(`${baseUrl}/cedula/${cedula}`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'x-api-key': apiKey,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) {
      throw new Error(`EcuadorAPI respondió HTTP ${resp.status}`);
    }
    const d = await resp.json();
    const payload = d.data || d;
    let apellidos = String(payload.apellidos || payload.last_name || '').trim().toUpperCase();
    let nombres = String(payload.nombres || payload.first_name || '').trim().toUpperCase();
    const nombreCompletoRaw = String(payload.nombre_completo || payload.nombre || payload.full_name || '').trim().toUpperCase();
    if (!apellidos && !nombres && nombreCompletoRaw) {
      const partes = nombreCompletoRaw.split(/\s+/);
      apellidos = partes.slice(0, 2).join(' ');
      nombres = partes.slice(2).join(' ');
    }
    const fecha_nacimiento = String(payload.fecha_nacimiento || payload.fechaNacimiento || payload.birth_date || '').trim();
    const estado_civil = String(payload.estado_civil || payload.estadoCivil || payload.marital_status || '').trim().toUpperCase();

    const guardado = guardarPostulanteEnCsv(dataDir, {
      cedula,
      apellidos,
      nombres,
      fecha_nacimiento,
      estado_civil,
    });

    return {
      ok: true,
      desde_cache: false,
      gasto_usd: 0.03,
      fuente: 'EcuadorAPI, no oficial',
      postulante: {
        cedula,
        apellidos: guardado.apellidos,
        nombres: guardado.nombres,
        nombre_completo: [guardado.apellidos, guardado.nombres].filter(Boolean).join(' '),
        fecha_nacimiento: guardado.fecha_nacimiento,
        estado_civil: guardado.estado_civil || '—',
      },
    };
  } catch (err) {
    const guardado = guardarPostulanteEnCsv(dataDir, {
      cedula,
      apellidos: encontrado?.apellidos || '',
      nombres: encontrado?.nombres || '',
      fecha_nacimiento: encontrado?.fecha_nacimiento || '',
      estado_civil: encontrado?.estado_civil || '',
    });
    return {
      ok: true,
      desde_cache: false,
      gasto_usd: 0,
      error_api: err.message,
      fuente: `EcuadorAPI no disponible (${err.message})`,
      postulante: {
        cedula,
        apellidos: guardado.apellidos,
        nombres: guardado.nombres,
        nombre_completo: [guardado.apellidos, guardado.nombres].filter(Boolean).join(' '),
        fecha_nacimiento: guardado.fecha_nacimiento,
        estado_civil: guardado.estado_civil || '—',
      },
    };
  }
}

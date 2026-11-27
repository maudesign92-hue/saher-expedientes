/**
 * codigo/usuarios.mjs
 * Gestión de usuarios y roles para SAHER:
 * - Coordinador Académico (Ángel) -> ve la base completa de estudiantes, filtros por asesor/estado/nivel,
 *   descarga .ZIP (solo habilitado cuando el estudiante está 10/10) y puede crear nuevos asesores.
 * - Asesores (ej. Geovanna) -> ingresan con su usuario/contraseña, cargan a sus aspirantes y los marcan
 *   con su nivel/curso (Nivel 1, Nivel 2, Reentrenamiento) para que Ángel los visualice.
 */
import fs from 'node:fs';
import path from 'node:path';

export const USUARIOS_BASE = [
  { usuario: 'angel', pass: 'angel2026', nombre: 'Ángel (Coordinador Académico)', rol: 'coordinador' },
  { usuario: 'geovanna', pass: 'geovanna2026', nombre: 'Geovanna', rol: 'asesor' },
  { usuario: 'asesor1', pass: 'asesor2026', nombre: 'Asesor 1', rol: 'asesor' },
  { usuario: 'asesor2', pass: 'asesor2026', nombre: 'Asesor 2', rol: 'asesor' },
  { usuario: 'rrhh', pass: 'saher2026', nombre: 'RR. HH. / Administración', rol: 'coordinador' },
];

export function obtenerUsuarios(dataDir) {
  const customPath = path.join(dataDir, 'usuarios.json');
  const mapa = new Map();
  for (const u of USUARIOS_BASE) {
    mapa.set(u.usuario.toLowerCase(), u);
  }
  // Permitir sobreescribir contraseña de rrhh desde .env si existe
  if (process.env.RRHH_USER && process.env.RRHH_PASS) {
    mapa.set(process.env.RRHH_USER.toLowerCase(), {
      usuario: process.env.RRHH_USER,
      pass: process.env.RRHH_PASS,
      nombre: 'RR. HH. / Administración',
      rol: 'coordinador',
    });
  }
  if (fs.existsSync(customPath)) {
    try {
      const extras = JSON.parse(fs.readFileSync(customPath, 'utf8'));
      if (Array.isArray(extras)) {
        for (const u of extras) {
          if (u.usuario && u.pass) {
            mapa.set(String(u.usuario).toLowerCase(), {
              usuario: String(u.usuario).trim(),
              pass: String(u.pass),
              nombre: String(u.nombre || u.usuario).trim(),
              rol: u.rol === 'coordinador' ? 'coordinador' : 'asesor',
            });
          }
        }
      }
    } catch {
      // ignorar
    }
  }
  return Array.from(mapa.values());
}

export function autenticarUsuario(dataDir, user, pass) {
  const uNorm = String(user || '').trim().toLowerCase();
  const pStr = String(pass || '');
  const lista = obtenerUsuarios(dataDir);
  return lista.find(u => u.usuario.toLowerCase() === uNorm && u.pass === pStr) || null;
}

export function agregarUsuarioAsesor(dataDir, { usuario, pass, nombre, rol = 'asesor' }) {
  const uLimpio = String(usuario || '').trim().toLowerCase().replace(/[^a-z0-9._-]/g, '');
  if (!uLimpio || !pass || String(pass).length < 4) {
    throw new Error('Usuario inválido o contraseña menor a 4 caracteres.');
  }
  const customPath = path.join(dataDir, 'usuarios.json');
  let extras = [];
  if (fs.existsSync(customPath)) {
    try {
      extras = JSON.parse(fs.readFileSync(customPath, 'utf8'));
    } catch {
      extras = [];
    }
  }
  const idx = extras.findIndex(x => String(x.usuario).toLowerCase() === uLimpio);
  const nuevo = {
    usuario: uLimpio,
    pass: String(pass),
    nombre: String(nombre || uLimpio).trim(),
    rol: rol === 'coordinador' ? 'coordinador' : 'asesor',
  };
  if (idx >= 0) extras[idx] = nuevo;
  else extras.push(nuevo);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(customPath, JSON.stringify(extras, null, 2), 'utf8');
  return { usuario: nuevo.usuario, nombre: nuevo.nombre, rol: nuevo.rol };
}

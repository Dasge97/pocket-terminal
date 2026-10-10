// Estado para el panel KitDani. Al importar Pocket Terminal en el Kit, este
// escribe en estado-ruta.txt (raíz del proyecto) la ruta donde quiere leer un
// estado.json. Si ese fichero no existe, no se escribe nada: el Kit es opcional
// y nada de esto puede tumbar al bot, así que todo va dentro de un try.
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { projectRoot } from '../server/config.mjs';

const ficheroRuta = resolve(projectRoot, 'estado-ruta.txt');

// Se relee en cada escritura: si se quita la herramienta del Kit, el fichero
// desaparece y el bot deja de informar sin reiniciarlo.
function rutaEstado() {
  try { return readFileSync(ficheroRuta, 'utf8').replace(/^﻿/, '').trim() || null; }
  catch { return null; }
}

// Fecha ISO con la zona local, por ejemplo 2026-10-10T00:14:18+02:00.
export function isoLocal(fecha = new Date()) {
  const d = n => String(n).padStart(2, '0');
  const zona = -fecha.getTimezoneOffset();
  const signo = zona >= 0 ? '+' : '-';
  const abs = Math.abs(zona);
  return `${fecha.getFullYear()}-${d(fecha.getMonth() + 1)}-${d(fecha.getDate())}T${d(fecha.getHours())}:${d(fecha.getMinutes())}:${d(fecha.getSeconds())}${signo}${d(Math.floor(abs / 60))}:${d(abs % 60)}`;
}

const unaLinea = (texto, max) => {
  const limpio = String(texto ?? '').replace(/\s+/g, ' ').trim();
  return limpio.length > max ? limpio.slice(0, max - 1) + '…' : limpio;
};

// Síncrono a propósito: también se usa al salir, cuando ya no hay bucle de
// eventos que espere a una escritura diferida. Devuelve true si escribió.
export function escribirEstadoKit({ estado, mensaje, indicadores = [] }) {
  const destino = rutaEstado();
  if (!destino) return false;
  const temporal = `${destino}.${process.pid}.tmp`;
  try {
    const datos = {
      estado,
      actualizado: isoLocal(),
      mensaje: unaLinea(mensaje, 200),
      indicadores: indicadores.slice(0, 6).map(({ etiqueta, valor }) => ({ etiqueta: unaLinea(etiqueta, 40), valor: unaLinea(valor, 120) })),
    };
    writeFileSync(temporal, JSON.stringify(datos, null, 2) + '\n', 'utf8');
    renameSync(temporal, destino);
    return true;
  } catch {
    try { rmSync(temporal, { force: true }); } catch {}
    return false;
  }
}

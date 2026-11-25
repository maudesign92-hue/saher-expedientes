# Expediente de reclutamiento de guardias — flujo n8n

Genera un PDF por postulante (`<cedula>_<APELLIDOS_NOMBRES>.pdf`) con portada/índice y los 9 documentos en el orden acordado, un resumen por postulante y una tabla de control del lote.

## 1. Instalación (una vez)

1. Copia `docker-compose.yml` en una carpeta del servidor/PC y ejecuta `docker compose up -d`.
2. Abre n8n (`http://localhost:5678`) → *Workflows* → *Import from file* → `expediente_reclutamiento_n8n.json`.
3. Revisa el nodo **Configuración**: rutas, URL de Gotenberg y **vigencias** (son valores de referencia; confírmalos con la política del cliente).

Si ya usas n8n Cloud: el flujo necesita leer/escribir archivos en disco y un servicio Gotenberg propio, así que requiere n8n *self-hosted* (o cambiar los nodos de archivos por Google Drive).

## 2. Estructura de carpetas

```
expedientes/
├── postulantes.csv                 cedula, apellidos, nombres, fecha_nacimiento, cedula_busqueda (opcional)
├── entrada/
│   └── 1712345675/                 una carpeta por cédula
│       ├── antecedentes.pdf        ← portal Ministerio del Interior
│       ├── judiciales.pdf          ← impresión a PDF de la consulta e-SATJE
│       ├── no_ffaa.pdf             ← MIDENA (no pertenecer a FF.AA.)
│       ├── tiempo_servicio.pdf     ← MIDENA (liquidación de tiempo de servicio)
│       ├── servidor_publico.pdf    ← Ministerio del Trabajo
│       ├── psicologo.pdf
│       ├── aptitud_fisica.pdf
│       ├── toxicologico.pdf
│       └── cedula_1712345675.jpg   (o .png)
└── salida/                         aquí se generan los PDF, resúmenes y la tabla de control
```

Los certificados de portal también se reconocen **por su contenido** si se guardan con el nombre que trae el navegador (p. ej. `certificado (3).pdf`).

## 3. Rutina del operador

1. Añade los postulantes a `postulantes.csv` (separado por comas; si tu Excel exporta con `;`, cambia la opción *Delimiter* del nodo **CSV a filas**).
2. Crea `entrada/<cedula>/` y pon los documentos físicos escaneados.
3. Descarga los 5 certificados en los portales (enlaces e instrucciones en cada página de reserva y en el resumen) y guárdalos en la misma carpeta.
4. En n8n, abre el flujo y pulsa **Test workflow** (nodo *Procesar lote*).
5. Revisa `salida/control_lote_AAAAMMDD.html`. Completa lo pendiente y vuelve a ejecutar: el PDF se regenera y sobrescribe.

## 4. Por qué los certificados no se descargan solos

Verificado el 25/11/2026:

| Documento | Portal | Control que impide automatizar |
|---|---|---|
| Antecedentes penales | Ministerio del Interior | Capa anti-bots (Imperva) + formulario de 3 pasos |
| Procesos judiciales | Función Judicial (e-SATJE) | Capa anti-bots (F5); además no emite certificado, se imprime la consulta |
| No pertenecer a FF.AA. | MIDENA | Captcha de imagen |
| Liquidación de tiempo de servicio | MIDENA | Captcha de imagen + pregunta de seguridad personal del titular |
| Servidor público | Ministerio del Trabajo | Google reCAPTCHA + fecha de nacimiento |

El flujo no intenta eludir estos controles. Automatiza todo lo demás: identificación, validación de cédula (incluido el dígito verificador) y nombres, lectura de la fecha de emisión, vigencias, alertas de contenido, orden, páginas de reserva, unión del PDF y reportes.

## 5. Estados

- **completo**: el archivo está, corresponde al postulante y está vigente.
- **observación**: se incluyó, pero algo requiere revisión humana (nombres parciales, PDF escaneado sin texto, sin fecha, vencido o por vencer, o una alerta de contenido como "registra antecedentes").
- **pendiente**: falta, o el archivo es de otra persona (en ese caso **no** se incluye). Se inserta una página de reserva con el motivo y la acción a seguir.

Las alertas de contenido son heurísticas de texto: nunca sustituyen la lectura del certificado.

## 6. Datos sensibles

Los expedientes contienen antecedentes y resultados médicos. Mantén n8n accesible solo localmente (como viene en el `docker-compose.yml`), restringe la carpeta `expedientes/` y depura `entrada/` cuando el proceso termine.

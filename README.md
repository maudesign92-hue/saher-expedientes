# SAHER — Sistema de Expedientes de Postulantes a Guardia

Sistema web en español para Recursos Humanos de **SAHER Seguridad Privada (Ecuador)**. Valida la cédula ecuatoriana (módulo 10), consulta identidad en **EcuadorAPI** una sola vez por cédula, permite descargar certificados con resolución automática de **CAPTCHAs (2Captcha / CapSolver)** o subirlos manualmente, recibe documentos desde el celular del postulante con enlace único válido por 7 días y arma el expediente en PDF (`<cedula>_<APELLIDOS_NOMBRES>.pdf`).

## 1. Instalación rápida

1. Abre la carpeta `E:\SAHER_EXPEDIENTES`.
2. Edita `.env` (copiado de `.env.example`) y coloca tus claves:
   - `ECUADORAPI_API_KEY`: tu clave de [ecuadorapi.com](https://ecuadorapi.com) (US$ 0,03 por cédula nueva).
   - `TWOCAPTCHA_API_KEY`: tu clave de [2captcha.com](https://2captcha.com) (recarga mínima US$ 3,00; ~US$ 0,005 por expediente).
   - `RRHH_USER` y `RRHH_PASS`: usuario y contraseña para la pantalla de RR. HH. (por defecto `rrhh` / `saher2026`).
3. Instala las dependencias y el navegador Chromium:
   ```bash
   npm install
   npx playwright install chromium
   ```
4. Inicia el servidor:
   ```bash
   npm start
   ```
5. Abre `http://localhost:3000` en el navegador.

## 2. Uso con Docker en la oficina

```bash
docker compose up -d --build
```

## 3. Estructura de datos en disco (sin base de datos)

- `expedientes/postulantes.csv`: registro de postulantes e identidad cacheada para no pagar dos veces la misma cédula.
- `expedientes/entrada/<cedula>/`: certificados PDF y foto de la cédula del postulante.
- `expedientes/salida/`: expedientes PDF armados, resúmenes `.md` y tabla de control del lote.

> **Protección de datos (LOPDP):** los expedientes no marcados como contratados (`contratado=si`) se borran automáticamente a los 6 meses.

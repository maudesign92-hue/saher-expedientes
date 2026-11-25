# Notas de integración: EcuadorAPI + Solucionador de CAPTCHA (2Captcha / CapSolver)

## 1. EcuadorAPI (Consulta de identidad por cédula)
- **Endpoint de consulta**: `GET /cedula/{cedula}` (o `GET /identidad/{cedula}`)
- **Encabezado**: `Authorization: Bearer <ECUADORAPI_API_KEY>` (o `x-api-key: <ECUADORAPI_API_KEY>`)
- **Respuesta**: `apellidos`, `nombres`, `nombre_completo`, `fecha_nacimiento` (`DD/MM/AAAA`), `estado_civil`.
- **Endpoint de saldo**: `GET /usage` devuelve el saldo disponible en USD y consultas restantes.
- **Costo**: US$ 0,03 por cada cédula nueva. Se guarda en `expedientes/postulantes.csv` para no volver a pagar por la misma cédula.
- **Aviso**: todos los datos de identidad mostrados en la interfaz llevan la leyenda `"fuente: EcuadorAPI, no oficial"`.

## 2. Resolución automática de CAPTCHAs (2Captcha / CapSolver)
- **2Captcha (`https://2captcha.com`)**:
  - `in.php` / `res.php` o API v2 (`https://api.2captcha.com/createTask` y `getTaskResult`).
  - Soporta:
    - `ImageToTextTask` (Captcha de imagen "Texto de Seguridad" de MIDENA No FF. AA. y CLTS): ~US$ 0,0005 – 0,001 por captcha.
    - `RecaptchaV2TaskProxyless` (Google reCAPTCHA v2 del Ministerio del Trabajo - Servidor Público): ~US$ 0,0029 por captcha.
  - Endpoint de saldo: `https://2captcha.com/res.php?key=<API_KEY>&action=getbalance&json=1`
- **CapSolver (`https://api.capsolver.com`)**:
  - Soporta `ImageToTextTask` y `ReCaptchaV2TaskProxyLess`.
  - Endpoint de saldo: `POST https://api.capsolver.com/getBalance`

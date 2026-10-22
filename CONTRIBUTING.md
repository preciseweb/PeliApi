# Contribuir a PeliApi

Gracias por considerar contribuir a este proyecto.

Este documento es una guía para ayudarte a entender cómo puedes contribuir de forma efectiva al desarrollo, mantenimiento y mejora continua de **PeliApi**.

## Filosofía del Proyecto

PeliApi es una herramienta 100% Open Source creada por **[FxxMorgan](https://github.com/FxxMorgan/)**. Nuestro objetivo es proveer una API y un motor de descargas robusto, libre y sin limitaciones comerciales para la comunidad. 

> **Nota importante sobre los créditos:** 
> Eres libre de modificar, extender y adaptar este código. Sin embargo, como muestra de respeto al trabajo original, te pedimos que mantengas intactas las firmas de autoría (headers, consola y README) de FxxMorgan, tal como se especifica en nuestra licencia.

## Cómo puedes ayudar

Hay muchas formas de contribuir a PeliApi:

1. **Reportar Bugs:** Si algo falla (ej. problemas con las protecciones de los proveedores, fallas en la resolución de videos, errores en descargas), abre un issue detallando cómo reproducir el error.
2. **Sugerir Funcionalidades:** ¿Nuevo proveedor? ¿Nuevo servidor de video? Abre un issue y lo discutimos.
3. **Mejorar la Documentación:** Corregir errores tipográficos, agregar ejemplos o traducir secciones siempre es bienvenido.
4. **Enviar Pull Requests (PRs):** Arreglar bugs conocidos, agregar soporte para nuevos sitios de streaming o mejorar la lógica de scraping y bypassing.

## Entorno de Desarrollo Local

Si vas a contribuir con código, sigue estos pasos para configurar tu entorno:

1. **Haz un Fork** del repositorio a tu cuenta de GitHub.
2. **Clona** tu fork de manera local:
   ```bash
   git clone https://github.com/tu-usuario/peliapi.git
   cd peliapi
   ```
3. **Usa Node.js 24 e instala las dependencias verificadas**. Puppeteer está incluido:
   ```bash
   npm ci
   ```
4. **Configura el entorno:**
   ```bash
   cp .env.example .env
   ```
5. **Crea una rama (branch)** para tu funcionalidad o corrección:
   ```bash
   git checkout -b feature/nuevo-proveedor
   ```

## Estándares de Código y Scraping

Dado que este proyecto hace peticiones a sitios de terceros, es vital seguir estos estándares para evitar bloqueos y mantener la estabilidad de la API. 

### 1. Evasión y Rendimiento (Puppeteer)
Cuando uses Puppeteer para saltar protecciones, siempre garantiza que la instancia del navegador se cierre usando bloques `try...finally`. 
Los navegadores "zombis" colapsarán la memoria del servidor.

### 2. Manejo Centralizado de Errores
Nunca dejes que un error de scraping crashee la aplicación. Usa siempre las estructuras de error manejables implementadas en la API.

### 3. Filtros Anti-Fake
Muchos servidores sirven videos señuelo cuando detectan solicitudes automatizadas. Asegúrate de no devolver archivos `.mp4` basura.

### 4. Convenciones de Nombrado
- **Variables y Funciones:** Utiliza `camelCase`.
- **Archivos:** Utiliza `kebab-case` o formato con puntos (ej. `voe.resolver.js`).
- **Comentarios:** Es obligatorio documentar las expresiones regulares complejas.

## Proceso para enviar un Pull Request (PR)

1. Asegúrate de probar tu código exhaustivamente usando los endpoints de la API (`npm run dev`).
2. Realiza commits descriptivos.
3. Haz push de tu rama a tu fork.
4. Abre un Pull Request en el repositorio principal, explicando detalladamente los cambios realizados.

Nuevamente, gracias por formar parte de esta comunidad.

Antes de enviar cambios ejecuta `npm run check` y `npm test`. Las regresiones usan HTTP local y navegadores simulados, sin descargar videos. CI instala con `npm ci --ignore-scripts` para omitir binarios opcionales.

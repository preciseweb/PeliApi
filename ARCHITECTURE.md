# Arquitectura y Tecnologías del Proyecto: PeliApi

Este documento detalla la pila tecnológica, la arquitectura del software y el flujo de datos del proyecto **PeliApi**. La plataforma está estructurada de manera modular para garantizar un consumo extremadamente bajo de hardware, lo que la hace idónea para VPS de bajo coste (ej: 1GB de RAM y 0.25 vCPU).

---

## 🗺️ Mapa de Arquitectura General

El proyecto sigue una arquitectura desacoplada de tipo **SPA (Single Page Application)** estática servida por un servidor de microservicios en **Node.js**:

```
 ┌─────────────────────────────────────────────────────────┐
 │               Cliente Web SPA (PeliApi)                 │
 └────────────────────────────┬────────────────────────────┘
                              │
                    REST API (JSON over HTTP)
                              │
                              ▼
 ┌─────────────────────────────────────────────────────────┐
 │             Servidor Express (server.js)                │
 └──────┬─────────────────────┬─────────────────────┬──────┘
        │                     │                     │
        ▼                     ▼                     ▼
 ┌─────────────┐       ┌─────────────┐       ┌─────────────┐
 │ Axios/Cheerio│       │  Resolvers  │       │   FFmpeg    │
 │ (Scraping)  │       │ (Modular &  │       │ (Descargas) │
 │             │       │   yt-dlp)   │       │             │
 └──────┬──────┘       └──────┬──────┘       └──────┬──────┘
        │                     │                     │
        ▼                     ▼                     ▼
 ┌─────────────┐       ┌─────────────┐       ┌─────────────┐
 │  Catálogos  │       │ Streamwish, │       │ Archivos de │
 │ (PelisPlus, │       │ Voe, Dood,  │       │ Video .mp4  │
 │  Cuevana,   │       │ Waaw, etc.  │       │             │
 │ RepelisHD)  │       │             │       │             │
 └─────────────┘       └─────────────┘       └─────────────┘
```

---

## 🛠️ Desglose de Tecnologías por Capa

El proyecto se divide en cuatro capas tecnológicas bien definidas:

---

### 1. Capa de Cliente: Frontend SPA ("PeliApi")
Diseñado para ser ultra-eficiente, inmersivo y reactivo sin el peso de compiladores o frameworks SPA tradicionales.

*   **Tecnologías Clave**:
    *   **HTML5 Semántico**: Para estructurar el dashboard, el reproductor integrado y el cajón de descargas.
    *   **CSS3 Moderno**: Diseño responsivo con **Flexbox y CSS Grid**. Implementación de **Glassmorphism** (desenfoque con `backdrop-filter: blur`), paleta HSL, scroll suave nativo, y animaciones avanzadas en hover (3D scale, resplandor de caja).
    *   **Vanilla JavaScript (ES6+)**: Controla el estado local de la app (navegación SPA, carga de carruseles, renderizado anti-XSS y polling con backoff).
    *   **Ionicons (unpkg.com)**: Set de iconos interactivos vectoriales cargados dinámicamente como SVGs.
*   **¿Dónde y cómo se usa?**:
    *   `public/index.html`: Maquetación estática de la interfaz de streaming, modal de reproducción y cajón lateral de descargas.
    *   `public/style.css`: Contiene todas las variables de color neón (HBO/Netflix), animaciones de esqueleto de carga (*skeletons*), efectos 3D de hover y estilos responsivos para móvil.
    *   `public/app.js`: Lógica cliente.
        *   **Carga Paralela**: Utiliza `Promise.all` para pedir simultáneamente películas, series y anime destacados y acelerar la visualización del Home.
        *   **Seguridad Anti-XSS**: Utiliza una utilidad de creación segura (`createEl`) evitando inyectar texto mediante `innerHTML`.
        *   **AbortControllers**: Cancela solicitudes HTTP previas si el usuario cambia de categoría rápidamente, evitando condiciones de carrera.

---

### 2. Capa del Servidor y API (Backend Express)
El núcleo que orquesta los microservicios de scraping, resolución de enlaces y descargas.

*   **Tecnologías Clave**:
    *   **Node.js**: Entorno de ejecución rápido y asíncrono.
    *   **Express**: Framework web minimalista para el manejo de rutas y controladores HTTP.
    *   **Helmet**: Cabeceras de seguridad HTTP. Implementa una **Content Security Policy (CSP)** estricta.
    *   **Cors**: Permite o restringe llamadas al API desde dominios cruzados.
    *   **Compression (Gzip)**: Comprime todas las respuestas JSON y estáticos sobre la marcha, acelerando la carga web en redes móviles.
    *   **Express Rate Limit**: Middleware de limitación de tasa para evitar ataques de denegación de servicio (DDoS) o scraping excesivo de nuestra propia API.
*   **¿Dónde y cómo se usa?**:
    *   `src/server.js`: Inicialización del servidor, configuración de middlewares globales, compresión, tasa de rate-limit y la definición estricta de la CSP:
        ```javascript
        scriptSrc: ["'self'", "'unsafe-inline'", "https://unpkg.com"],
        connectSrc: ["'self'", "https://unpkg.com"]
        ```
    *   `src/routes/content.routes.js`: Define todos los endpoints asíncronos (`/search`, `/catalog`, `/info`, `/servers`, `/resolve`, `/download`).

---

### 3. Capa de Scraping y Extracción (Web Scrapers & Resolvers)
Encargada de leer y procesar la información de portales externos en tiempo real.

*   **Tecnologías Clave**:
    *   **Axios**: Cliente HTTP para Node.js rápido y ligero. Se utiliza para hacer peticiones rápidas a páginas estáticas.
    *   **Cheerio**: Implementación ultrarrápida del selector jQuery en servidor. Parsea el código HTML crudo devuelto por Axios en microsegundos, abstrayendo selectores del DOM.
    *   **yt-dlp**: Resolvedor nativo de alta velocidad que extrae enlaces directos de video mediante comandos CLI optimizados sin consumo de RAM de navegador.
    *   **Decodificación Nativa (VOE / Streamwish)**: Decodifica de forma síncrona mediante JavaScript puro y peticiones HTTP (`axios` + `unpacker` en local), evitando la sobrecarga de Puppeteer.
    *   **Puppeteer (Headless Chrome)**: Navegador Chromium controlado mediante código. Se usa únicamente como último recurso cuando la página externa requiere resolver desafíos JavaScript complejos, capturar llamadas de red dinámicas en iframe o ejecutar reproductores protegidos.
*   **¿Dónde y cómo se usa?**:
    *   `src/services/pelisplus.service.js`: Utiliza **Axios + Cheerio** para parsear el catálogo principal, categorías y listas de servidores desde PelisPlus, con validación de la estructura recibida.
    *   `src/utils/resolvers.js` y `src/utils/resolvers/`: Orquesta la extracción de enlaces directos delegando en resolvedores específicos de dominio (`voe.resolver.js`, `streamwish.resolver.js`, `streamtape.resolver.js`) y `yt-dlp`. Si estos fallan o se detectan scripts altamente protegidos, ejecuta de forma controlada **Puppeteer** (con limitación de concurrencia y limpieza de procesos zombies en `browser.js`) para capturar el stream `.m3u8` o `.mp4` final.

---

### 4. Capa de Descargas y Procesamiento de Medios (Download Manager)
Gestor de colas y procesamiento que permite almacenar los vídeos en local de manera asíncrona.

*   **Tecnologías Clave**:
    *   **FFmpeg (fluent-ffmpeg & ffmpeg-static)**: Suite multimedia líder en la industria. El backend utiliza el paquete estático binario de FFmpeg (`ffmpeg-static`) y lo controla mediante JavaScript con `fluent-ffmpeg`.
*   **¿Dónde y cómo se usa?**:
    *   `src/services/download.service.js`: Administra la cola de descargas activas.
        *   **Fusión de Flujos HLS**: Cuando un servidor sirve vídeo en formato segmentado HLS (`.m3u8`), FFmpeg descarga todos los fragmentos `.ts` en paralelo, los descifra si es necesario y los consolida en un único archivo `.mp4` de alta fidelidad.
        *   **Reporte de Progreso**: Lee el stream de salida de FFmpeg e intercepta los eventos de porcentaje y velocidad de descarga, almacenándolos en memoria para que el cliente web pueda consultarlos mediante *polling*.

---

## 🔄 Flujo de Trabajo en una Descarga de Vídeo

```
[Usuario hace clic en Descargar]
               │
               ▼
   [app.js POST /api/download] ───► [server.js / Express]
                                           │
                                           ▼
                               [download.service.js]
                                           │
                        ┌──────────────────┴──────────────────┐
                        ▼                                     ▼
                [Si es MP4 Directo]                  [Si es HLS / M3U8]
                Descarga con Axios                  fluent-ffmpeg stream
               (Buffer de Escritura)               (Descarga de fragmentos)
                        │                                     │
                        └──────────────────┬──────────────────┘
                                           ▼
                             [Consolidación de Archivo]
                                           │
                                           ▼
                                 [Guardado en /downloads]
                                           │
                                           ▼
                           [Notificación en Cliente (Toast)]
```

## Revisión de consistencia y recursos

Las fuentes consultan HTML primero; Cuevana usa navegador cuando el documento necesita renderizado. Los identificadores de proveedor se conservan durante información y episodios. Los adaptadores vinculan episodios al título y servidores a sus pestañas.

`content-cache.js` comparte lecturas y propaga cancelación mediante `AsyncLocalStorage`. HTTP reutiliza conexiones con límites de sockets y tamaño de documento. `browser.js` mantiene un lanzamiento compartido, páginas y cola acotadas, y cierra las páginas ante errores o plazos agotados.

Las descargas usan una cola FIFO con concurrencia y capacidad configurables. Su historial terminal tiene límite y caducidad de metadatos. El cierre del servidor o CLI cancela streams y FFmpeg, elimina parciales y conserva archivos completos. Los módulos reutilizables se importan sin abrir puertos ni terminar el proceso.

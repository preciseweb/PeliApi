require("dotenv").config();

const path = require("node:path");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const compression = require("compression");
const rateLimit = require("express-rate-limit");

const contentRoutes = require("./routes/content.routes");
const downloadService = require("./services/download.service");
const { ApiError } = require("./utils/api-error");
const { requireApiKey } = require("./middlewares/auth");
const { cleanup: cleanupBrowser, getBrowserStatus } = require("./utils/browser");

const app = express();

// Trust proxy (necessary for rate-limit behind Nginx/PM2)
app.set("trust proxy", 1);

// Global Middlewares
app.use(compression());
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        frameSrc: ["'self'", "*"], // Allow iframe embeds from any domain
        scriptSrc: ["'self'", "'unsafe-inline'", "https://unpkg.com"],
        connectSrc: ["'self'", "https://unpkg.com"], // Allow Ionicons fetch SVGs
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
        imgSrc: ["'self'", "data:", "https:"],
      },
    },
    crossOriginResourcePolicy: { policy: "cross-origin" },
  })
);
app.use(cors());
app.use(express.json({ limit: "1mb" }));
// Query strings may contain API keys or signed media URLs. Log only paths.
morgan.token("safe-path", req => req.path);
app.use(morgan(":method :safe-path :status :response-time ms", {
  skip: () => process.env.NODE_ENV === "test",
}));

// Rate Limiting
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => String(process.env.DISABLE_RATE_LIMIT).trim().toLowerCase() === "true",
  message: { success: false, message: "Demasiadas peticiones. Espera 1 minuto." }
});

const scrapeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => String(process.env.DISABLE_RATE_LIMIT).trim().toLowerCase() === "true",
  message: { success: false, message: "Límite de scrapeo alcanzado. Espera 1 minuto." }
});

app.use("/api/", apiLimiter);
app.use("/api/v1/content/resolve", scrapeLimiter);
app.use("/api/v1/content/search", scrapeLimiter);
app.use("/api/pelisplus/resolve", scrapeLimiter);
app.use("/api/pelisplus/search", scrapeLimiter);

// Static files
const downloadsDir = downloadService.getDownloadsDir();
const staticDownloadOptions = {
  index: false,
  fallthrough: false,
  setHeaders: (res, filePath) => {
    res.setHeader("Content-Disposition", `attachment; filename="${path.basename(filePath)}"`);
  },
};

app.use(express.static(path.join(__dirname, "../public")));
app.use("/downloads", express.static(downloadsDir, staticDownloadOptions));
app.use("/api/downloads", express.static(downloadsDir, staticDownloadOptions));

// Routes
app.get("/api", (_req, res) => {
  res.status(200).json({
    success: true,
    message: "PeliApi scraper y descargas backend",
    version: "1.0.0",
    endpoints: {
      modern: [
        "/api/v1/content/search",
        "/api/v1/content/catalog",
        "/api/v1/content/genres",
        "/api/v1/content/info/:slug",
        "/api/v1/content/servers",
        "/api/v1/content/resolve",
      ],
      legacy: [
        "/api/pelisplus/search",
        "/api/pelisplus/catalog",
        "/api/pelisplus/genres",
        "/api/pelisplus/info/:slug",
        "/api/pelisplus/servers",
        "/api/pelisplus/resolve",
      ],
    },
  });
});

app.get("/health", async (_req, res) => {
  const browser = await getBrowserStatus();
  res.status(200).json({
    success: true,
    status: "ok",
    // Count the process owned by this service, rather than executing a shell
    // command for every health probe or counting unrelated system browsers.
    chromeProcesses: browser.connected ? 1 : 0,
    memoryWarning: process.memoryUsage().rss > 450 * 1024 * 1024,
    browser,
  });
});

app.use("/api/v1/content", requireApiKey);
app.use("/api/pelisplus", requireApiKey);

app.use("/api/v1/content", contentRoutes);
app.use("/api/pelisplus", contentRoutes);

// 404
app.use((_req, _res, next) => {
  next(new ApiError(404, "Endpoint no encontrado"));
});

// Error handler
app.use((error, _req, res, next) => {
  if (res.headersSent) return next(error);
  const providedStatus = Number(error.statusCode || error.status);
  const statusCode = Number.isInteger(providedStatus) && providedStatus >= 400 && providedStatus <= 599
    ? providedStatus : 500;
  const response = {
    success: false,
    message: error.message || "Error interno del servidor",
  };
  if (process.env.NODE_ENV !== "production" && error.details) {
    response.error = error.details;
  }
  res.status(statusCode).json(response);
});

function startServer(options = {}) {
  const port = options.port ?? Number(process.env.PORT || 5555);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("PORT debe ser un puerto válido");
  const server = app.listen(port, options.host, () => {
    console.log(`PeliApi listening on port ${server.address().port}`);
  });
  server.timeout = 35000;
  server.keepAliveTimeout = 35000;
  server.headersTimeout = 36000;
  server.requestTimeout = 35000;
  return server;
}

function registerShutdown(server, { timeoutMs = 10000 } = {}) {
  const gracePeriod = Number.isInteger(timeoutMs) && timeoutMs > 0 ? Math.min(timeoutMs, 10000) : 10000;
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    const deadline = setTimeout(() => {
      server.closeAllConnections?.();
      // Last resort only after the graceful window has elapsed.
      process.exit(process.exitCode || 0);
    }, gracePeriod);
    deadline.unref();
    try {
      await Promise.all([
        new Promise(resolve => {
          server.close(resolve);
          server.closeIdleConnections?.();
        }),
        cleanupBrowser(),
        downloadService.cleanup?.(),
      ]);
      process.exitCode = 0;
    } catch (_error) {
      process.exitCode = 1;
    }
    // Keep this unref'd watchdog until natural process exit. Background streams
    // or child processes can outlive server.close(), even after cleanup returns.
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

if (require.main === module) {
  // Check yt-dlp availability at startup (non-blocking).
  const ytdlpResolver = require("./utils/resolvers/ytdlp.resolver");
  ytdlpResolver.checkYtdlpAvailability().then(available => {
    console.log(available
      ? "[SYSTEM] yt-dlp disponible como resolvedor primario."
      : "[SYSTEM] yt-dlp no está instalado. Los resolvedores HTTP siguen disponibles.");
  }).catch(() => console.error("[SYSTEM] No se pudo comprobar yt-dlp."));

  const server = startServer();
  server.on("error", error => {
    console.error(`[SYSTEM] No se pudo iniciar el servidor: ${error.code || "ERROR"}`);
    process.exitCode = 1;
    void cleanupBrowser();
  });
  registerShutdown(server);
}

module.exports = { app, startServer, registerShutdown };

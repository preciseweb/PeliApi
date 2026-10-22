// Preserve the existing Render setting while accepting Puppeteer's current
// PUPPETEER_SKIP_DOWNLOAD environment variable without downloading Chrome.
// Puppeteer's own environment setting takes precedence over this configuration.
const legacy = process.env.PUPPETEER_SKIP_CHROMIUM_DOWNLOAD;
module.exports = legacy === undefined ? {} : {
  skipDownload: String(legacy).trim().toLowerCase() === 'true',
};

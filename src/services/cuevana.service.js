const { scrapeWithPage } = require("../utils/browser");
const { ApiError } = require("../utils/api-error");
const { cleanText, cleanTitle, normalizeSlug, encodedSlug, episodeNumbers, repairMetadata } = require("./content.helpers");

/**
 * Busca contenido en Cuevana3 usando Puppeteer
 */
async function searchContent(query) {
  const url = `https://ww9.cuevana3.to/?s=${encodeURIComponent(query)}`;
  
  const response = await scrapeWithPage(url, () => {
    const results = [];
    const elements = document.querySelectorAll('.MovieList .TPost, .MovieList li, .TPost');
    elements.forEach(el => {
      const linkEl = el.querySelector('a');
      const titleEl = el.querySelector('.Title');
      const imgEl = el.querySelector('img');
      const ratingEl = el.querySelector('.Vote');
      const yearEl = el.querySelector('.Year');
      
      if (linkEl && titleEl) {
        const href = linkEl.href;
        const rawSlug = href.split("cuevana3.to/").pop(); // ej: "2225/scary-movie-2" o "serie/como-peces-dorados"
        const slug = rawSlug.split("/").filter(Boolean).join("/");
        const isSeries = href.includes('/serie/');
        const isAnime = href.includes('/anime/');
        const type = isSeries ? 'series' : (isAnime ? 'anime' : 'movie');
        
        let poster = imgEl ? (imgEl.getAttribute('data-src') || imgEl.src) : '';
        if (poster && poster.startsWith('/')) {
          poster = 'https://ww9.cuevana3.to' + poster;
        }

        results.push({
          id: slug,
          slug: slug,
          title: titleEl.textContent.trim(),
          poster: poster,
          rating: ratingEl ? ratingEl.textContent.trim() : null,
          year: yearEl ? yearEl.textContent.trim() : null,
          type: type,
          url: href
        });
      }
    });
    
    // De-duplicar resultados por slug
    const uniqueResults = [];
    const seen = new Set();
    for (const r of results) {
      if (!seen.has(r.slug)) {
        seen.add(r.slug);
        uniqueResults.push(r);
      }
    }
    return uniqueResults;
  });
  return repairMetadata(response || []).map(item => ({ ...item, title: cleanTitle(item.title) }));
}

/**
 * Obtiene la información detallada de una película o serie de Cuevana3
 */
async function getContentInfo(slug, type = "movie") {
  slug = normalizeSlug(slug, { nested: true });
  const url = `https://ww9.cuevana3.to/${encodedSlug(slug)}`;
  
  const result = await scrapeWithPage(url, () => {
    const title = document.querySelector('h1.Title')?.textContent.trim() || '';
    const synopsis = document.querySelector('.Description p, .Description')?.textContent.trim() || '';
    let poster = document.querySelector('.Image img')?.src || '';
    if (poster && poster.startsWith('/')) {
      poster = 'https://ww9.cuevana3.to' + poster;
    }
    
    const yearMatch = document.querySelector('.InfoList li')?.textContent.trim().match(/\d{4}/);
    const year = yearMatch ? yearMatch[0] : null;
    const rating = document.querySelector('.percircle')?.textContent.trim() || null;
    
    // Check type inside browser by checking page structure or url pattern
    const currentUrl = window.location.href;
    const isSeriesPage = currentUrl.includes('/serie/') || currentUrl.includes('/anime/') || document.querySelectorAll('a[href*="/episodio/"]').length > 0;
    
    const info = {
      title: title,
      originalTitle: title,
      synopsis: synopsis,
      poster: poster,
      rating: rating,
      year: year,
      genres: [],
      cast: [],
      directors: [],
      url: currentUrl
    };
    
    // Parsear géneros
    const genreLinks = document.querySelectorAll('.InfoList a[href*="/genero/"], .Description a[href*="/genero/"], .Genres a[href*="/genero/"]');
    genreLinks.forEach(g => {
      const gName = g.textContent.trim();
      const gSlug = g.href.split("/").filter(Boolean).pop();
      if (gName && !info.genres.some(genre => genre.name === gName)) {
        info.genres.push({ name: gName, slug: gSlug });
      }
    });

    if (!isSeriesPage) {
      // Parsear servidores de reproducción
      const servers = [];
      const languageMenus = document.querySelectorAll('.TPlayerNv > li.open_submenu');
      const tbDivs = document.querySelectorAll('.TPlayerTb');
      let iframeIndex = 0;

      languageMenus.forEach(langMenu => {
        const langNameText = langMenu.childNodes[0]?.textContent.trim() || langMenu.textContent.trim();
        const langName = langNameText.split('CALIDAD')[0].trim();
        
        const serverLiList = langMenu.querySelectorAll('ul li, .clili');
        serverLiList.forEach(serverLi => {
          const serverNameFull = serverLi.textContent.trim();
          const serverNameParts = serverNameFull.split('-').map(s => s.trim());
          const serverName = serverNameParts[1] || serverNameFull;
          
          const correspondingDiv = tbDivs[iframeIndex];
          if (correspondingDiv) {
            const iframe = correspondingDiv.querySelector('iframe');
            const embedUrl = iframe ? (iframe.getAttribute('data-src') || iframe.src) : '';
            
            if (embedUrl) {
              let serverKey = serverName.toLowerCase().replace(/[^a-z0-9]/g, "");
              if (serverKey.includes("streamwish") || embedUrl.includes("streamwish")) serverKey = "streamwish";
              else if (serverKey.includes("voesx") || serverKey.includes("voe") || embedUrl.includes("voe.sx")) serverKey = "voesx";
              else if (serverKey.includes("streamtape") || embedUrl.includes("streamtape")) serverKey = "streamtape";
              else if (serverKey.includes("netu") || serverKey.includes("hqq") || embedUrl.includes("hqq") || embedUrl.includes("waaw") || embedUrl.includes("netu")) serverKey = "netu";
              else if (serverKey.includes("vidhide") || serverKey.includes("vidhide") || embedUrl.includes("filelions")) serverKey = "vidhide";

              servers.push({
                name: serverName,
                server: serverKey,
                language: langName,
                embedUrl: embedUrl
              });
            }
          }
          iframeIndex++;
        });
      });

      info.servers = servers;
    } else {
      // Parsear temporadas y capítulos para series
      info.seasons = [];
      const episodeLinks = Array.from(document.querySelectorAll('a')).map(a => ({
        text: a.textContent.trim(),
        href: a.href
      })).filter(l => l.href.includes('/episodio/'));

      const seasonsMap = new Map();
      episodeLinks.forEach(ep => {
        const match = new URL(ep.href).pathname.match(/(\d+)x(\d+)\/?$/);
        if (match) {
          const seasonNum = Number(match[1]);
          const episodeNum = Number(match[2]);

          if (!seasonsMap.has(seasonNum)) {
            seasonsMap.set(seasonNum, []);
          }

          if (seasonsMap.get(seasonNum).some(episode => episode.number === episodeNum)) return;
          seasonsMap.get(seasonNum).push({
            number: episodeNum,
            title: `Episodio ${episodeNum}`,
            url: ep.href,
            season: seasonNum
          });
        }
      });

      for (const [seasonNum, episodes] of seasonsMap.entries()) {
        episodes.sort((a, b) => a.number - b.number);
        info.seasons.push({
          number: seasonNum,
          name: `Temporada ${seasonNum}`,
          episodes: episodes
        });
      }

      info.seasons.sort((a, b) => a.number - b.number);
    }

    return info;
  });

  if (!cleanText(result?.title)) throw new ApiError(404, 'Contenido no encontrado en Cuevana3');
  if (result) {
    result.title = cleanTitle(result.title);
    result.id = slug;
    result.slug = slug;
    result.type = type;
  }
  return repairMetadata(result);
}

/**
 * Obtiene los servidores y URLs de reproducción de un episodio específico de Cuevana3
 */
async function getEpisodeServers(serieSlug, seasonNumber, episodeNumber) {
  // Los capítulos en Cuevana3 tienen la estructura /episodio/slug-temporadaxcapitulo
  serieSlug = normalizeSlug(serieSlug, { nested: true });
  ({ seasonNumber, episodeNumber } = episodeNumbers(seasonNumber, episodeNumber));
  const coreSlug = serieSlug.replace(/^(?:serie|anime)\//, "");
  const url = `https://ww9.cuevana3.to/episodio/${encodedSlug(coreSlug)}-${seasonNumber}x${episodeNumber}`;

  const result = await scrapeWithPage(url, () => {
    const servers = [];
    const languageMenus = document.querySelectorAll('.TPlayerNv > li.open_submenu');
    const tbDivs = document.querySelectorAll('.TPlayerTb');
    let iframeIndex = 0;

    languageMenus.forEach(langMenu => {
      const langNameText = langMenu.childNodes[0]?.textContent.trim() || langMenu.textContent.trim();
      const langName = langNameText.split('CALIDAD')[0].trim();
      
      const serverLiList = langMenu.querySelectorAll('ul li, .clili');
      serverLiList.forEach(serverLi => {
        const serverNameFull = serverLi.textContent.trim();
        const serverNameParts = serverNameFull.split('-').map(s => s.trim());
        const serverName = serverNameParts[1] || serverNameFull;
        
        const correspondingDiv = tbDivs[iframeIndex];
        if (correspondingDiv) {
          const iframe = correspondingDiv.querySelector('iframe');
          const embedUrl = iframe ? (iframe.getAttribute('data-src') || iframe.src) : '';
          
          if (embedUrl) {
            let serverKey = serverName.toLowerCase().replace(/[^a-z0-9]/g, "");
            if (serverKey.includes("streamwish") || embedUrl.includes("streamwish")) serverKey = "streamwish";
            else if (serverKey.includes("voesx") || serverKey.includes("voe") || embedUrl.includes("voe.sx")) serverKey = "voesx";
            else if (serverKey.includes("streamtape") || embedUrl.includes("streamtape")) serverKey = "streamtape";
            else if (serverKey.includes("netu") || serverKey.includes("hqq") || embedUrl.includes("hqq") || embedUrl.includes("waaw") || embedUrl.includes("netu")) serverKey = "netu";
            else if (serverKey.includes("vidhide") || serverKey.includes("vidhide") || embedUrl.includes("filelions")) serverKey = "vidhide";

            servers.push({
              name: serverName,
              server: serverKey,
              language: langName,
              embedUrl: embedUrl
            });
          }
        }
        iframeIndex++;
      });
    });

    return {
      servers
    };
  });

  return {
    serieSlug,
    season: Number(seasonNumber),
    episode: Number(episodeNumber),
    servers: repairMetadata(result?.servers || []),
    url
  };
}

module.exports = {
  searchContent,
  getContentInfo,
  getEpisodeServers
};

// ==UserScript==
// @name         Wplace Tracker (Backend Sync)
// @namespace    http://tampermonkey.net/
// @version      4.5
// @description  Track drawing progress via tile fetch - multi-tile support
// @author       Antigravity
// @match        *://*.wplace.live/*
// @match        *://wplace.live/*
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @connect      localhost
// @connect      wplace-france-tracker.vercel.app
// ==/UserScript==

(function () {
  "use strict";

  const CHUNK_SIZE = 1000;
  const TILE_URL_REGEX = /\/tiles\/(-?\d+)\/(-?\d+)\.png/;

  const DEBUG = false; // Mettez à true pour activer les logs détaillés de développement
  function log(...args) {
    if (DEBUG) {
      console.log(...args);
    }
  }

  // Initialisation dynamique des configurations
  function getBackendUrl() {
    let url = GM_getValue("BACKEND_URL");
    if (!url) {
      url = "https://wplace-france-tracker.vercel.app/api";
      GM_setValue("BACKEND_URL", url);
    }
    return url;
  }

  function getTrackerKey() {
    let key = GM_getValue("TRACKER_API_KEY");
    if (!key) {
      key = prompt(
        "[Wplace Tracker] Veuillez entrer votre clé d'API (ou mot de passe admin) pour synchroniser la progression :",
      );
      if (key) {
        key = key.trim();
        GM_setValue("TRACKER_API_KEY", key);
      } else {
        alert(
          "[Wplace Tracker] Attention : Sans clé d'API, le suivi de progression sera rejeté par le serveur.",
        );
      }
    }
    return key;
  }

  // Commandes menu Tampermonkey pour pouvoir reconfigurer
  if (typeof GM_registerMenuCommand !== "undefined") {
    GM_registerMenuCommand("Configurer la Clé d'API (Tracker Key)", () => {
      const current = GM_getValue("TRACKER_API_KEY") || "";
      const next = prompt(
        "Entrez la nouvelle clé d'API (Tracker Key) :",
        current,
      );
      if (next !== null) {
        GM_setValue("TRACKER_API_KEY", next.trim());
        alert("Clé d'API mise à jour ! Rechargez la page.");
      }
    });

    GM_registerMenuCommand("Configurer l'URL du Backend", () => {
      const current = getBackendUrl();
      const next = prompt(
        "Entrez l'URL du Backend API (ex: https://.../api) :",
        current,
      );
      if (next !== null) {
        GM_setValue("BACKEND_URL", next.trim());
        alert("URL du Backend mise à jour ! Rechargez la page.");
      }
    });
  }

  let drawings = [];
  const templateCache = {};

  const tileResults = {};
  const tileColorResults = {};

  // ─────────────────────────────────────────────
  // Backend
  // ─────────────────────────────────────────────
  function fetchDrawings() {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "GET",
        url: `${getBackendUrl()}/drawings`,
        onload: (r) =>
          r.status === 200
            ? resolve(JSON.parse(r.responseText))
            : reject(r.status),
        onerror: reject,
      });
    });
  }

  // Utiliser GM_xmlhttpRequest pour charger le template et éviter les blocages CORS du site
  function loadTemplateData(drawing) {
    return new Promise((resolve, reject) => {
      if (templateCache[drawing.id]) return resolve(templateCache[drawing.id]);

      const backendUrlBase = getBackendUrl().replace(/\/api$/, "");
      const imageFullUrl =
        drawing.imageUrl.startsWith("http://") ||
        drawing.imageUrl.startsWith("https://")
          ? drawing.imageUrl
          : `${backendUrlBase}${drawing.imageUrl}`;

      GM_xmlhttpRequest({
        method: "GET",
        url: imageFullUrl,
        responseType: "blob",
        onload: (r) => {
          if (r.status !== 200) return reject(`HTTP ${r.status}`);
          const url = URL.createObjectURL(r.response);
          const img = new Image();
          img.onload = () => {
            const c = document.createElement("canvas");
            c.width = img.width;
            c.height = img.height;
            const ctx = c.getContext("2d");
            ctx.drawImage(img, 0, 0);
            templateCache[drawing.id] = ctx.getImageData(
              0,
              0,
              img.width,
              img.height,
            );
            URL.revokeObjectURL(url);
            log(
              `[Wplace Tracker] ✅ Template "${drawing.name}" chargé (${img.width}x${img.height})`,
            );
            resolve(templateCache[drawing.id]);
          };
          img.onerror = () => {
            URL.revokeObjectURL(url);
            reject("Decode error");
          };
          img.src = url;
        },
        onerror: reject,
      });
    });
  }

  function sendProgress(drawingId, correctPixels, wrongPixels, colorCorrects) {
    const key = getTrackerKey();
    if (!key) return;

    GM_xmlhttpRequest({
      method: "POST",
      url: `${getBackendUrl()}/drawings/${drawingId}/progress`,
      headers: {
        "Content-Type": "application/json",
        "x-tracker-key": key,
      },
      data: JSON.stringify({ correctPixels, wrongPixels, colorCorrects }),
      onload: (r) => {
        if (r.status === 201) {
          const resp = JSON.parse(r.responseText);
          log(`[Wplace Tracker] 📊 ${resp.message}`);
        } else if (r.status === 401) {
          console.error(
            "[Wplace Tracker] ❌ Clé d'API invalide. Vous pouvez la reconfigurer dans le menu de Tampermonkey.",
          );
          GM_setValue("TRACKER_API_KEY", ""); // reset to trigger prompt next time
        } else {
          console.error(
            `[Wplace Tracker] ❌ Erreur serveur lors de l'envoi de la progression (HTTP ${r.status})`,
          );
        }
      },
    });
  }

  // ─────────────────────────────────────────────
  // Web Worker & Gestion d'analyse optimisée (Thread-Safe v4.3)
  // ─────────────────────────────────────────────
  let analysisWorker = null;
  let taskIdCounter = 0;
  const pendingTasks = new Map();

  function getOrCreateWorker() {
    if (!analysisWorker) {
      const workerCode = `
                self.onmessage = function(e) {
                    const { taskId, drawing, tplData, tileData, tileW, tileH, CHUNK_SIZE, ratio, tileStartX, tileStartY, overlapAbsX1, overlapAbsY1, cmpW, cmpH } = e.data;
                    
                    const tplW = drawing.width;
                    const tplH = drawing.height;
                    
                    let correct = 0, wrong = 0, opaque = 0;
                    const colorCounts = {};
                    
                    const rgbToHex = (r, g, b) => {
                        const toHex = c => c.toString(16).padStart(2, '0');
                        return "#" + toHex(r) + toHex(g) + toHex(b);
                    };

                    for (let dy = 0; dy < cmpH; dy++) {
                        for (let dx = 0; dx < cmpW; dx++) {
                            // Lecture dans le template
                            const tplX = (overlapAbsX1 - (drawing.chunkX * CHUNK_SIZE + drawing.offsetX)) + dx;
                            const tplY = (overlapAbsY1 - (drawing.chunkY * CHUNK_SIZE + drawing.offsetY)) + dy;
                            
                            const ti = 4 * (tplY * tplW + tplX);
                            if (tplData[ti + 3] < 128) continue; // transparent
                            opaque++;

                            // Lecture dans la tuile
                            const tileX = tileStartX + Math.round(dx * ratio);
                            const tileY = tileStartY + Math.round(dy * ratio);
                            if (tileX < 0 || tileY < 0 || tileX >= tileW || tileY >= tileH) continue;
                            const gi = 4 * (tileY * tileW + tileX);

                            const tileAlpha = tileData[gi + 3];
                            if (tileAlpha > 0) { // N'analyser que si le pixel est dessiné sur le jeu
                                const isMatch = tplData[ti]   === tileData[gi]   &&
                                                tplData[ti+1] === tileData[gi+1] &&
                                                tplData[ti+2] === tileData[gi+2];
                                
                                const hex = rgbToHex(tplData[ti], tplData[ti+1], tplData[ti+2]).toUpperCase();
                                if (!colorCounts[hex]) {
                                    colorCounts[hex] = 0;
                                }

                                if (isMatch) {
                                    correct++;
                                    colorCounts[hex]++;
                                } else {
                                    wrong++;
                                }
                            }
                        }
                    }
                    
                    self.postMessage({ taskId, drawingId: drawing.id, correct, wrong, opaque, colorCounts });
                };
            `;
      const blob = new Blob([workerCode], { type: "application/javascript" });
      analysisWorker = new Worker(URL.createObjectURL(blob));

      // Un seul gestionnaire d'événements persistant pour router les messages par taskId
      analysisWorker.onmessage = (event) => {
        const { taskId } = event.data;
        const resolve = pendingTasks.get(taskId);
        if (resolve) {
          pendingTasks.delete(taskId);
          resolve(event.data);
        }
      };
    }
    return analysisWorker;
  }

  // Gestion du Debounce & Queue d'analyse sans exécution concurrente
  let analysisTimeout = null;
  let isProcessingQueue = false;
  const tileQueue = {};

  function queueTileForAnalysis(tileChunkX, tileChunkY, blob) {
    const key = `${tileChunkX},${tileChunkY}`;
    tileQueue[key] = blob;

    if (analysisTimeout) clearTimeout(analysisTimeout);
    analysisTimeout = setTimeout(() => {
      processQueue();
    }, 300); // 300ms de silence requis avant l'analyse
  }

  async function processQueue() {
    if (isProcessingQueue) {
      // Si déjà en cours, reprogrammer une vérification très rapide
      if (analysisTimeout) clearTimeout(analysisTimeout);
      analysisTimeout = setTimeout(processQueue, 100);
      return;
    }

    const keys = Object.keys(tileQueue);
    if (keys.length === 0) return;

    isProcessingQueue = true;
    try {
      log(
        `[Wplace Tracker] 🚀 Analyse de ${keys.length} tuile(s) en arrière-plan via Web Worker...`,
      );
      for (const key of keys) {
        const blob = tileQueue[key];
        if (!blob) continue;
        delete tileQueue[key];

        const [tileChunkX, tileChunkY] = key.split(",").map(Number);
        await analyzeTile(tileChunkX, tileChunkY, blob);
      }
    } catch (e) {
      console.error(
        "[Wplace Tracker] Erreur lors du traitement de la file d'attente:",
        e,
      );
    } finally {
      isProcessingQueue = false;
    }
  }

  async function analyzeTile(tileChunkX, tileChunkY, blob) {
    const tileAbsX = tileChunkX * CHUNK_SIZE;
    const tileAbsY = tileChunkY * CHUNK_SIZE;

    // Détecte TOUS les dessins qui chevauchent cette tuile (même partiellement)
    const matching = drawings.filter((d) => {
      const drawAbsX = d.chunkX * CHUNK_SIZE + d.offsetX;
      const drawAbsY = d.chunkY * CHUNK_SIZE + d.offsetY;
      return (
        drawAbsX < tileAbsX + CHUNK_SIZE &&
        drawAbsX + d.width > tileAbsX &&
        drawAbsY < tileAbsY + CHUNK_SIZE &&
        drawAbsY + d.height > tileAbsY
      );
    });

    if (matching.length === 0) return;

    const url = URL.createObjectURL(blob);
    let tileImageData, tileW, tileH;

    try {
      tileImageData = await new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
          const c = document.createElement("canvas");
          c.width = img.width;
          c.height = img.height;
          const ctx = c.getContext("2d");
          ctx.drawImage(img, 0, 0);
          tileW = img.width;
          tileH = img.height;
          resolve(ctx.getImageData(0, 0, img.width, img.height));
        };
        img.onerror = reject;
        img.src = url;
      });
    } catch (e) {
      log("[Wplace Tracker] Impossible de décoder la tuile:", e);
      return;
    } finally {
      URL.revokeObjectURL(url);
    }

    const ratio = tileW / CHUNK_SIZE;

    for (const drawing of matching) {
      const tpl = templateCache[drawing.id];
      if (!tpl) continue;

      const tplW = tpl.width;
      const tplH = tpl.height;

      // Position absolue du dessin dans le monde
      const drawAbsX = drawing.chunkX * CHUNK_SIZE + drawing.offsetX;
      const drawAbsY = drawing.chunkY * CHUNK_SIZE + drawing.offsetY;

      // Zone de chevauchement entre le dessin et cette tuile (en px monde)
      const overlapAbsX1 = Math.max(drawAbsX, tileAbsX);
      const overlapAbsY1 = Math.max(drawAbsY, tileAbsY);
      const overlapAbsX2 = Math.min(drawAbsX + tplW, tileAbsX + CHUNK_SIZE);
      const overlapAbsY2 = Math.min(drawAbsY + tplH, tileAbsY + CHUNK_SIZE);

      // Offset de départ dans le template
      const tplStartX = overlapAbsX1 - drawAbsX;
      const tplStartY = overlapAbsY1 - drawAbsY;

      // Offset de départ dans la tuile (en px tuile, avec ratio de scale)
      const tileStartX = Math.round((overlapAbsX1 - tileAbsX) * ratio);
      const tileStartY = Math.round((overlapAbsY1 - tileAbsY) * ratio);

      // Dimensions de la zone à comparer (en px monde)
      const cmpW = overlapAbsX2 - overlapAbsX1;
      const cmpH = overlapAbsY2 - overlapAbsY1;

      const tileKey = `${tileChunkX},${tileChunkY}`;

      // Calcul en arrière-plan de manière asynchrone et thread-safe
      const taskId = taskIdCounter++;
      const workerResult = await new Promise((resolve) => {
        pendingTasks.set(taskId, resolve);
        const worker = getOrCreateWorker();
        worker.postMessage({
          taskId,
          drawing,
          tplData: tpl.data,
          tileData: tileImageData.data,
          tileW,
          tileH,
          CHUNK_SIZE,
          ratio,
          tileStartX,
          tileStartY,
          overlapAbsX1,
          overlapAbsY1,
          cmpW,
          cmpH,
        });
      });

      const { correct, wrong, opaque, colorCounts } = workerResult;

      if (!tileColorResults[drawing.id]) tileColorResults[drawing.id] = {};
      tileColorResults[drawing.id][tileKey] = colorCounts;

      // Stocker le résultat pour CETTE tuile spécifiquement
      if (!tileResults[drawing.id]) tileResults[drawing.id] = {};
      tileResults[drawing.id][tileKey] = { correct, wrong };

      // Agréger sur TOUTES les tuiles connues pour ce dessin
      const allTiles = Object.values(tileResults[drawing.id]);
      const totalCorrect = allTiles.reduce((s, t) => s + t.correct, 0);
      const totalWrong = allTiles.reduce((s, t) => s + t.wrong, 0);

      // Agréger par couleur sur toutes les tuiles
      const totalColorCorrects = {};
      if (tileColorResults[drawing.id]) {
        for (const tKey of Object.keys(tileColorResults[drawing.id])) {
          const colors = tileColorResults[drawing.id][tKey];
          if (colors) {
            for (const [hex, count] of Object.entries(colors)) {
              totalColorCorrects[hex] = (totalColorCorrects[hex] || 0) + count;
            }
          }
        }
      }

      log(
        `[Wplace Tracker] "${drawing.name}" tuile[${tileKey}] → ${opaque} opaques, ${correct}✅ ${wrong}❌ | Total: ${totalCorrect}✅ ${totalWrong}❌`,
      );
      sendProgress(drawing.id, totalCorrect, totalWrong, totalColorCorrects);
    }
  }

  // ─────────────────────────────────────────────
  // Interception de fetch (Synchrone, Ultra-Robuste v4.5)
  // ─────────────────────────────────────────────
  function interceptFetch() {
    const originalFetch = unsafeWindow.fetch;

    unsafeWindow.fetch = function (...args) {
      const promise = originalFetch.apply(this, args);

      promise.then(response => {
        try {
          if (response && response.ok) {
            let url = '';
            if (args[0]) {
              if (typeof args[0] === 'string') {
                url = args[0];
              } else if (typeof args[0] === 'object') {
                url = args[0].url || args[0].href || String(args[0]);
              }
            }

            const match = url.match(TILE_URL_REGEX);
            if (match) {
              const tileChunkX = parseInt(match[1]);
              const tileChunkY = parseInt(match[2]);

              const tileAbsX = tileChunkX * CHUNK_SIZE;
              const tileAbsY = tileChunkY * CHUNK_SIZE;

              const hasOverlap = drawings.some(d => {
                const drawAbsX = d.chunkX * CHUNK_SIZE + d.offsetX;
                const drawAbsY = d.chunkY * CHUNK_SIZE + d.offsetY;
                return drawAbsX < tileAbsX + CHUNK_SIZE &&
                       drawAbsX + d.width  > tileAbsX &&
                       drawAbsY < tileAbsY + CHUNK_SIZE &&
                       drawAbsY + d.height > tileAbsY;
              });

              if (hasOverlap) {
                const clone = response.clone();
                clone.blob().then(blob => queueTileForAnalysis(tileChunkX, tileChunkY, blob)).catch(() => {});
              }
            }
          }
        } catch (err) {
          log('[Wplace Tracker] Erreur d\'interception fetch silencieusement ignorée :', err);
        }
      }).catch(() => {});

      return promise;
    };

    log('[Wplace Tracker] ✅ Interception fetch active (multi-tuiles supporté, calculs en tâche de fond)');
  }

  // ─────────────────────────────────────────────
  // Démarrage
  // ─────────────────────────────────────────────
  async function init() {
    try {
      drawings = await fetchDrawings();
      console.log(
        `[Wplace Tracker] 🚀 Activé (v4.5) - ${drawings.length} dessin(s) chargé(s)`,
      );
      drawings.forEach((d) =>
        log(
          `  → "${d.name}" : Chunk[${d.chunkX},${d.chunkY}] Offset[${d.offsetX},${d.offsetY}] Taille[${d.width}x${d.height}]`,
        ),
      );

      for (const d of drawings) {
        await loadTemplateData(d);
      }

      interceptFetch();
    } catch (err) {
      console.error("[Wplace Tracker] Erreur initialisation:", err);
    }
  }

  init();
})();

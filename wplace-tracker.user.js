// ==UserScript==
// @name         Wplace Tracker (Backend Sync)
// @namespace    http://tampermonkey.net/
// @version      4.1
// @description  Track drawing progress via tile fetch - multi-tile support
// @author       Antigravity
// @match        *://*.wplace.live/*
// @match        *://wplace.live/*
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      localhost
// ==/UserScript==

(function () {
    'use strict';

    const BACKEND_URL = 'http://localhost:3000/api';
    const CHUNK_SIZE = 1000;
    const TILE_URL_REGEX = /\/tiles\/(-?\d+)\/(-?\d+)\.png/;

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
                method: 'GET',
                url: `${BACKEND_URL}/drawings`,
                onload: r => r.status === 200 ? resolve(JSON.parse(r.responseText)) : reject(r.status),
                onerror: reject
            });
        });
    }

    function loadTemplateData(drawing) {
        return new Promise((resolve, reject) => {
            if (templateCache[drawing.id]) return resolve(templateCache[drawing.id]);

            const imageFullUrl = drawing.imageUrl.startsWith('http://') || drawing.imageUrl.startsWith('https://')
                ? drawing.imageUrl
                : `http://localhost:3000${drawing.imageUrl}`;

            GM_xmlhttpRequest({
                method: 'GET',
                url: imageFullUrl,
                responseType: 'blob',
                onload: r => {
                    if (r.status !== 200) return reject(`HTTP ${r.status}`);
                    const url = URL.createObjectURL(r.response);
                    const img = new Image();
                    img.onload = () => {
                        const c = document.createElement('canvas');
                        c.width = img.width; c.height = img.height;
                        const ctx = c.getContext('2d');
                        ctx.drawImage(img, 0, 0);
                        templateCache[drawing.id] = ctx.getImageData(0, 0, img.width, img.height);
                        URL.revokeObjectURL(url);
                        console.log(`[Wplace Tracker] ✅ Template "${drawing.name}" chargé (${img.width}x${img.height})`);
                        resolve(templateCache[drawing.id]);
                    };
                    img.onerror = () => { URL.revokeObjectURL(url); reject('Decode error'); };
                    img.src = url;
                },
                onerror: reject
            });
        });
    }

    function sendProgress(drawingId, correctPixels, wrongPixels, colorCorrects) {
        GM_xmlhttpRequest({
            method: 'POST',
            url: `${BACKEND_URL}/drawings/${drawingId}/progress`,
            headers: { 'Content-Type': 'application/json' },
            data: JSON.stringify({ correctPixels, wrongPixels, colorCorrects }),
            onload: r => {
                if (r.status === 201) {
                    const resp = JSON.parse(r.responseText);
                    console.log(`[Wplace Tracker] 📊 ${resp.message}`);
                }
            }
        });
    }

    // ─────────────────────────────────────────────
    // Analyse d'une tuile (gestion multi-tuiles)
    // ─────────────────────────────────────────────
    async function analyzeTile(tileChunkX, tileChunkY, blob) {
        const tileAbsX = tileChunkX * CHUNK_SIZE;
        const tileAbsY = tileChunkY * CHUNK_SIZE;

        // Détecte TOUS les dessins qui chevauchent cette tuile (même partiellement)
        const matching = drawings.filter(d => {
            const drawAbsX = d.chunkX * CHUNK_SIZE + d.offsetX;
            const drawAbsY = d.chunkY * CHUNK_SIZE + d.offsetY;
            return drawAbsX < tileAbsX + CHUNK_SIZE &&
                   drawAbsX + d.width  > tileAbsX &&
                   drawAbsY < tileAbsY + CHUNK_SIZE &&
                   drawAbsY + d.height > tileAbsY;
        });

        if (matching.length === 0) return;

        console.log(`[Wplace Tracker] 🔎 Tuile [${tileChunkX},${tileChunkY}] → ${matching.length} dessin(s) en chevauchement`);

        const url = URL.createObjectURL(blob);
        let tileImageData, tileW, tileH;

        try {
            tileImageData = await new Promise((resolve, reject) => {
                const img = new Image();
                img.onload = () => {
                    const c = document.createElement('canvas');
                    c.width = img.width; c.height = img.height;
                    const ctx = c.getContext('2d');
                    ctx.drawImage(img, 0, 0);
                    tileW = img.width;
                    tileH = img.height;
                    resolve(ctx.getImageData(0, 0, img.width, img.height));
                };
                img.onerror = reject;
                img.src = url;
            });
        } catch (e) {
            console.warn('[Wplace Tracker] Impossible de décoder la tuile:', e);
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

            let correct = 0, wrong = 0, opaque = 0;

            const rgbToHex = (r, g, b) => {
                const toHex = c => c.toString(16).padStart(2, '0');
                return `#${toHex(r)}${toHex(g)}${toHex(b)}`.toUpperCase();
            };

            const tileKey = `${tileChunkX},${tileChunkY}`;
            if (!tileColorResults[drawing.id]) tileColorResults[drawing.id] = {};
            tileColorResults[drawing.id][tileKey] = {};

            for (let dy = 0; dy < cmpH; dy++) {
                for (let dx = 0; dx < cmpW; dx++) {
                    // Lecture dans le template
                    const tplX = tplStartX + dx;
                    const tplY = tplStartY + dy;
                    const ti = 4 * (tplY * tplW + tplX);
                    if (tpl.data[ti + 3] < 128) continue; // transparent
                    opaque++;

                    // Lecture dans la tuile
                    const tileX = tileStartX + Math.round(dx * ratio);
                    const tileY = tileStartY + Math.round(dy * ratio);
                    if (tileX < 0 || tileY < 0 || tileX >= tileW || tileY >= tileH) continue;
                    const gi = 4 * (tileY * tileW + tileX);

                    const tileAlpha = tileImageData.data[gi + 3];
                    if (tileAlpha > 0) { // N'analyser que si le pixel est dessiné sur le jeu
                        const absX = overlapAbsX1 + dx;
                        const absY = overlapAbsY1 + dy;
                        const isMatch = tpl.data[ti]   === tileImageData.data[gi]   &&
                                        tpl.data[ti+1] === tileImageData.data[gi+1] &&
                                        tpl.data[ti+2] === tileImageData.data[gi+2];
                        
                        const tplRGB = `rgb(${tpl.data[ti]}, ${tpl.data[ti+1]}, ${tpl.data[ti+2]})`;
                        const tileRGB = `rgb(${tileImageData.data[gi]}, ${tileImageData.data[gi+1]}, ${tileImageData.data[gi+2]})`;
                        
                        console.log(`[Wplace Tracker DEBUG] Pixel dessiné à [${absX}, ${absY}] : Template = ${tplRGB} | Carte = ${tileRGB} -> ${isMatch ? '✅ MATCH' : '❌ ERREUR'}`);
                        
                        const hex = rgbToHex(tpl.data[ti], tpl.data[ti+1], tpl.data[ti+2]);
                        if (!tileColorResults[drawing.id][tileKey][hex]) {
                            tileColorResults[drawing.id][tileKey][hex] = 0;
                        }

                        if (isMatch) {
                            correct++;
                            tileColorResults[drawing.id][tileKey][hex]++;
                        } else {
                            wrong++;
                        }
                    }
                }
            }

            // Stocker le résultat pour CETTE tuile spécifiquement
            if (!tileResults[drawing.id]) tileResults[drawing.id] = {};
            tileResults[drawing.id][tileKey] = { correct, wrong };

            // Agréger sur TOUTES les tuiles connues pour ce dessin
            const allTiles = Object.values(tileResults[drawing.id]);
            const totalCorrect = allTiles.reduce((s, t) => s + t.correct, 0);
            const totalWrong   = allTiles.reduce((s, t) => s + t.wrong, 0);

            // Agréger par couleur sur toutes les tuiles
            const totalColorCorrects = {};
            if (tileColorResults[drawing.id]) {
                for (const tKey of Object.keys(tileColorResults[drawing.id])) {
                    const colors = tileColorResults[drawing.id][tKey];
                    for (const [hex, count] of Object.entries(colors)) {
                        totalColorCorrects[hex] = (totalColorCorrects[hex] || 0) + count;
                    }
                }
            }

            console.log(`[Wplace Tracker] "${drawing.name}" tuile[${tileKey}] → ${opaque} opaques, ${correct}✅ ${wrong}❌ | Total toutes tuiles: ${totalCorrect}✅ ${totalWrong}❌`);
            sendProgress(drawing.id, totalCorrect, totalWrong, totalColorCorrects);
        }
    }

    // ─────────────────────────────────────────────
    // Interception de fetch
    // ─────────────────────────────────────────────
    function interceptFetch() {
        const originalFetch = unsafeWindow.fetch;

        unsafeWindow.fetch = async function (...args) {
            const response = await originalFetch.apply(this, args);
            const url = (args[0] instanceof Request ? args[0].url : args[0]) || '';

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
                    clone.blob().then(blob => analyzeTile(tileChunkX, tileChunkY, blob)).catch(() => {});
                }
            }

            return response;
        };

        console.log('[Wplace Tracker] ✅ Interception fetch active (multi-tuiles supporté)');
    }

    // ─────────────────────────────────────────────
    // Démarrage
    // ─────────────────────────────────────────────
    async function init() {
        try {
            drawings = await fetchDrawings();
            console.log(`[Wplace Tracker] ${drawings.length} dessin(s) chargé(s) :`);
            drawings.forEach(d =>
                console.log(`  → "${d.name}" : Chunk[${d.chunkX},${d.chunkY}] Offset[${d.offsetX},${d.offsetY}] Taille[${d.width}x${d.height}]`)
            );

            for (const d of drawings) {
                await loadTemplateData(d);
            }

            interceptFetch();
        } catch (err) {
            console.error('[Wplace Tracker] Erreur initialisation:', err);
        }
    }

    init();
})();

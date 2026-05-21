const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

async function main() {
    const drawings = await p.drawing.findMany();
    console.log('Dessins existants :');
    drawings.forEach(d => console.log(`  id=${d.id} | "${d.name}" | chunk[${d.chunkX},${d.chunkY}] | offset[${d.offsetX},${d.offsetY}] | taille[${d.width}x${d.height}]`));

    // Mise à jour du premier dessin avec les vraies coordonnées
    if (drawings.length > 0) {
        const updated = await p.drawing.update({
            where: { id: drawings[0].id },
            data: {
                chunkX: 1061,
                chunkY: 367,
                offsetX: 230,
                offsetY: 444
            }
        });
        console.log(`\n✅ Dessin "${updated.name}" mis à jour : chunk[${updated.chunkX},${updated.chunkY}] offset[${updated.offsetX},${updated.offsetY}]`);
    }

    // Reset de la progression pour repartir de zéro
    await p.progress.deleteMany();
    console.log('✅ Progression remise à zéro');
}

main().catch(console.error).finally(() => p.$disconnect());

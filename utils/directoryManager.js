// /utils/directoryManager.js
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const config = require('../config');

const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');
const PENDING_DIR = path.join(UPLOADS_DIR, 'pending');
const ARCHIVED_DIR = path.join(UPLOADS_DIR, 'archived');
const CONFIRMED_ARCHIVE_DIR = path.join(ARCHIVED_DIR, 'confirmed');
const NOT_CONFIRMED_ARCHIVE_DIR = path.join(ARCHIVED_DIR, 'not_confirmed');
const ZIPS_DIR = path.join(__dirname, '..', 'zips');
const TEMP_DIR = path.join(__dirname, '..', 'temp');
const ASSETS_DIR = path.join(__dirname, '..', 'assets');
const activationImagePath = path.join(ASSETS_DIR, config.ACTIVATION_IMAGE_NAME);


async function createDirectories() {
    const dirs = [UPLOADS_DIR, PENDING_DIR, ARCHIVED_DIR, CONFIRMED_ARCHIVE_DIR, NOT_CONFIRMED_ARCHIVE_DIR, ZIPS_DIR, TEMP_DIR, ASSETS_DIR];
    for (const dir of dirs) {
        try {
            await fs.mkdir(dir, { recursive: true });
        } catch (error) {
            console.error(`❌ Error creando directorio ${dir}:`, error);
            process.exit(1);
        }
    }
    console.log('✅ Todos los directorios están listos.');
}

async function checkActivationImage() {
     if (!fsSync.existsSync(activationImagePath)) {
        console.error(`🔥🔥🔥 ERROR FATAL: El archivo '${config.ACTIVATION_IMAGE_NAME}' no está en /assets.`);
        process.exit(1);
    }
}

async function cleanupOldFiles(directory, maxAge) {
    try {
        const files = await fs.readdir(directory);
        for (const file of files) {
            const filePath = path.join(directory, file);
            const stats = await fs.stat(filePath);
            if (stats.isDirectory()) {
                await cleanupOldFiles(filePath, maxAge);
            } else if (Date.now() - stats.mtime.getTime() > maxAge) {
                await fs.unlink(filePath);
                console.log(`🧹 Archivo antiguo borrado: ${filePath}`);
            }
        }
    } catch (err) {
        if (err.code !== 'ENOENT') {
            console.error(`Error al limpiar ${directory}:`, err);
        }
    }
}

module.exports = {
    UPLOADS_DIR,
    PENDING_DIR,
    ARCHIVED_DIR,
    CONFIRMED_ARCHIVE_DIR,
    NOT_CONFIRMED_ARCHIVE_DIR,
    ZIPS_DIR,
    TEMP_DIR,
    ASSETS_DIR,
    activationImagePath,
    createDirectories,
    checkActivationImage,
    cleanupOldFiles
};
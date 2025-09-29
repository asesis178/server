// /index.js

// --- DEPENDENCIAS NATIVAS Y DE TERCEROS ---
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");

// --- IMPORTACIONES DE MÓDULOS LOCALES ---
const config = require('./config');
const allRoutes = require('./routes');
const db = require('./services/db');
const state = require('./state');
const queueProcessor = require('./services/queueProcessor');
const { initializeSocketHandlers } = require('./handlers/socketHandlers');
const dirManager = require('./utils/directoryManager');
const helpers = require('./utils/helpers');


// --- INICIALIZACIÓN DE COMPONENTES ---
const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Hacemos 'io' accesible para los módulos que lo necesiten (rutas, helpers, etc.)
app.set('io', io);
helpers.init(io);
queueProcessor.init(io);

// --- MIDDLEWARES ---
app.use(express.json());

// --- RUTAS ---
app.use('/', allRoutes);

// --- SOCKET.IO HANDLERS ---
initializeSocketHandlers(io);


// --- INICIO DEL SERVIDOR ---
async function startServer() {
    try {
        await dirManager.createDirectories();
        await dirManager.checkActivationImage();
        await db.initializeDatabase();
        await db.loadPendingTasks(io);

        server.listen(config.PORT, () => {
            console.log(`🚀 Servidor iniciado en puerto ${config.PORT}.`);

            // Limpieza periódica de archivos antiguos
            const unaSemanaEnMs = 7 * 24 * 60 * 60 * 1000;
            console.log(`🧹 Primera limpieza de archivos programada para dentro de 7 días.`);
            setTimeout(() => {
                console.log('⏰ Ejecutando la primera limpieza programada de archivos...');
                dirManager.cleanupOldFiles(dirManager.ARCHIVED_DIR, unaSemanaEnMs);
                dirManager.cleanupOldFiles(dirManager.ZIPS_DIR, unaSemanaEnMs);
                setInterval(() => {
                    console.log('🧹 Ejecutando limpieza periódica...');
                    dirManager.cleanupOldFiles(dirManager.ARCHIVED_DIR, unaSemanaEnMs);
                    dirManager.cleanupOldFiles(dirManager.ZIPS_DIR, unaSemanaEnMs);
                }, 24 * 60 * 60 * 1000); // Se ejecuta cada 24 horas
            }, unaSemanaEnMs);

            if (state.taskQueue.length > 0) {
                helpers.logAndEmit('▶️ Iniciando procesamiento de la cola pendiente.', 'log-info');
                queueProcessor.processQueue();
            }
        });
    } catch (error) {
        console.error("🔥🔥🔥 FALLO CRÍTICO AL INICIAR SERVIDOR 🔥🔥🔥", error);
        process.exit(1);
    }
}

startServer();
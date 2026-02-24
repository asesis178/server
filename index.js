// /index.js
const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');

const config         = require('./config');
const allRoutes      = require('./routes');
const db             = require('./services/db');
const state          = require('./state');
const queueProcessor = require('./services/queueProcessor');
const { initializeSocketHandlers } = require('./handlers/socketHandlers');
const dirManager     = require('./utils/directoryManager');
const helpers        = require('./utils/helpers');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);

// Inyectar io en los módulos que lo necesitan
app.set('io', io);
helpers.init(io);
queueProcessor.init(io);

// -------------------------------------------------------
// Parseo del body:
// - El webhook POST necesita el body RAW (Buffer) para
//   verificar la firma HMAC de Meta.
// - El resto de las rutas necesitan JSON parseado.
// -------------------------------------------------------
app.use((req, res, next) => {
    if (req.path === '/webhook' && req.method === 'POST') {
        // Body como Buffer para verificación de firma
        express.raw({ type: 'application/json' })(req, res, next);
    } else {
        // Body parseado como JSON para el resto
        express.json()(req, res, next);
    }
});

// Rutas y Socket.IO
app.use('/', allRoutes);
initializeSocketHandlers(io);

// -------------------------------------------------------
// Inicio del servidor
// -------------------------------------------------------
async function startServer() {
    try {
        await dirManager.createDirectories();
        await dirManager.checkActivationImage();
        await db.initializeDatabase();
        await db.loadPendingTasks(io);

        server.listen(config.PORT, () => {
            console.log(`🚀 Servidor iniciado en puerto ${config.PORT}.`);
            console.log(`🌐 URL externa: ${config.RENDER_EXTERNAL_URL}`);

            // Limpieza periódica de archivos viejos (cada 7 días)
            const unaSemana = 7 * 24 * 60 * 60 * 1000;
            const runCleanup = () => {
                console.log('🧹 Ejecutando limpieza de archivos...');
                dirManager.cleanupOldFiles(dirManager.ARCHIVED_DIR, unaSemana);
                dirManager.cleanupOldFiles(dirManager.ZIPS_DIR, unaSemana);
            };
            setTimeout(() => {
                runCleanup();
                setInterval(runCleanup, unaSemana);
            }, unaSemana);

            // Retomar la cola si había tareas pendientes al reiniciar
            if (state.taskQueue.length > 0) {
                helpers.logAndEmit('▶️ Retomando cola pendiente del reinicio anterior...', 'log-info');
                queueProcessor.processQueue();
            }
        });
    } catch (error) {
        console.error('🔥🔥🔥 FALLO CRÍTICO AL INICIAR SERVIDOR 🔥🔥🔥', error);
        process.exit(1);
    }
}

startServer();

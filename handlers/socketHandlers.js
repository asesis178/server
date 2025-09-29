// /handlers/socketHandlers.js
const db = require('../services/db');
const state = require('../state');
const { logAndEmit } = require('../utils/helpers');

function initializeSocketHandlers(io) {
    io.on('connection', async (socket) => {
        // --- Eventos que se envían al cliente nuevo al conectarse ---
        socket.emit('queue-update', state.taskQueue.length);
        socket.emit('workers-status-update', {
            available: state.availableWorkers.size,
            active: state.senderPool.length - state.availableWorkers.size
        });
        socket.emit('initial-delay-settings', state.delaySettings);
        socket.emit('queue-status-update', { isPaused: state.isQueueProcessingPaused });

        if (state.botFailureInfo.hasFailed) {
            socket.emit('bot-failure', state.botFailureInfo);
        }

        try {
            const confirmedCountResult = await db.pool.query('SELECT COUNT(*) FROM confirmados');
            const notConfirmedCountResult = await db.pool.query('SELECT COUNT(*) FROM no_confirmados');
            socket.emit('stats-update', {
                confirmed: confirmedCountResult.rows[0].count,
                notConfirmed: notConfirmedCountResult.rows[0].count
            });
        } catch (e) {
            console.error("Error al obtener contadores iniciales para el nuevo cliente:", e.message);
        }

        // --- Listeners para acciones que vienen del cliente ---
        socket.on('request-window-status', async ({ number }) => {
            try {
                const windowState = await db.getConversationWindowState(number);
                let logType = 'log-info';
                if (windowState.status === 'ACTIVE' || windowState.status === 'COOL_DOWN') logType = 'log-success';
                if (windowState.status === 'INACTIVE' || windowState.status === 'EXPIRING_SOON') logType = 'log-warn';
                socket.emit('status-update', { text: `[Consulta] Estado para ${number}: <strong>${windowState.status}</strong> (${windowState.details})`, type: logType });
            } catch (error) {
                logAndEmit(`Error al consultar estado para ${number}: ${error.message}`, 'log-error');
            }
        });

        socket.on('ver-confirmados', async () => {
            try {
                const result = await db.pool.query("SELECT cedula, fecha_nacimiento, numero_confirmado, confirmado_en FROM confirmados ORDER BY confirmado_en DESC");
                socket.emit('datos-confirmados', result.rows);
            } catch (dbError) {
                console.error("Error al obtener confirmados:", dbError);
            }
        });

        socket.on('ver-no-confirmados', async () => {
            try {
                const result = await db.pool.query("SELECT cedula, fecha_nacimiento, numero_no_confirmado, registrado_en FROM no_confirmados ORDER BY registrado_en DESC");
                socket.emit('datos-no-confirmados', result.rows);
            } catch (dbError) {
                console.error("Error al obtener no confirmados:", dbError);
            }
        });

        socket.on('limpiar-confirmados', async () => {
            try {
                await db.pool.query('TRUNCATE TABLE confirmados');
                io.emit('datos-confirmados', []); // Notifica a todos para vaciar la tabla visual
                logAndEmit("✅ DB de confirmados limpiada.", 'log-success');

                const notConfirmedCountResult = await db.pool.query('SELECT COUNT(*) FROM no_confirmados');
                io.emit('stats-update', {
                    confirmed: 0,
                    notConfirmed: notConfirmedCountResult.rows[0].count
                });
            } catch (dbError) {
                logAndEmit("❌ Error al limpiar la DB de confirmados.", 'log-error');
            }
        });

        socket.on('limpiar-no-confirmados', async () => {
            try {
                await db.pool.query('TRUNCATE TABLE no_confirmados');
                io.emit('datos-no-confirmados', []);
                logAndEmit("✅ DB de 'no confirmados' limpiada.", 'log-success');

                const confirmedCountResult = await db.pool.query('SELECT COUNT(*) FROM confirmados');
                io.emit('stats-update', {
                    confirmed: confirmedCountResult.rows[0].count,
                    notConfirmed: 0
                });
            } catch (dbError) {
                logAndEmit("❌ Error al limpiar la DB de 'no confirmados'.", 'log-error');
            }
        });
    });
}

module.exports = { initializeSocketHandlers };
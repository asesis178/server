// /utils/helpers.js
const state  = require('../state');
const config = require('../config');

let io;

function init(socketIoInstance) {
    io = socketIoInstance;
}

function logAndEmit(text, type = 'log-info') {
    console.log(text);
    if (io) io.emit('status-update', { text, type });
}

function getFormattedTimestamp() {
    const now    = new Date();
    const year   = now.getFullYear();
    const month  = String(now.getMonth() + 1).padStart(2, '0');
    const day    = String(now.getDate()).padStart(2, '0');
    const hours  = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    return `${year}-${month}-${day}_${hours}-${minutes}`;
}

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function startWebhookWatchdog(dbPool) {
    if (state.webhookWatchdog || state.botFailureInfo.hasFailed) return;
    logAndEmit('🐶 Guardián del webhook activado.', 'log-info');
    state.webhookWatchdog = setTimeout(async () => {
        state.isQueueProcessingPaused = true;
        state.botFailureInfo = {
            hasFailed: true,
            message: `🚨 ¡FALLO CRÍTICO! No se recibieron respuestas del bot en ${config.WATCHDOG_TIMEOUT / 60000} minutos. Cola pausada. Revisá el bot y volvé a subir el último ZIP.`,
        };
        io.emit('queue-status-update', { isPaused: true });
        logAndEmit(state.botFailureInfo.message, 'log-error');
        io.emit('bot-failure', state.botFailureInfo);
        state.taskQueue = [];
        io.emit('queue-update', 0);
        try {
            await dbPool.query("UPDATE envios SET estado = 'cancelled' WHERE estado IN ('pending', 'procesando')");
            logAndEmit('🗑️ Cola limpiada por seguridad.', 'log-warn');
        } catch (dbError) {
            logAndEmit(`❌ Error al limpiar la cola automáticamente: ${dbError.message}`, 'log-error');
        }
    }, config.WATCHDOG_TIMEOUT);
}

function stopWebhookWatchdog() {
    if (state.webhookWatchdog) {
        clearTimeout(state.webhookWatchdog);
        state.webhookWatchdog = null;
        logAndEmit('🐶 Guardián del webhook desactivado.', 'log-info');
    }
}

function resetWebhookWatchdog(dbPool) {
    if (state.webhookWatchdog) {
        clearTimeout(state.webhookWatchdog);
        state.webhookWatchdog = null;
        startWebhookWatchdog(dbPool);
    }
}

module.exports = {
    init,
    logAndEmit,
    getFormattedTimestamp,
    delay,
    startWebhookWatchdog,
    stopWebhookWatchdog,
    resetWebhookWatchdog,
};

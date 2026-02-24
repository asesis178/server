// /services/queueProcessor.js
const axios   = require('axios');
const state   = require('../state');
const db      = require('./db');
const helpers = require('../utils/helpers');
const config  = require('../config');

let io;

function init(socketIoInstance) {
    io = socketIoInstance;
}

function releaseWorkerAndContinue(workerIndex) {
    state.availableWorkers.add(workerIndex);
    io.emit('workers-status-update', {
        available: state.availableWorkers.size,
        active:    state.senderPool.length - state.availableWorkers.size,
    });
    setTimeout(processQueue, state.delaySettings.taskSeparation);
}

async function processQueue() {
    if (state.taskQueue.length === 0) {
        helpers.stopWebhookWatchdog();
    }
    if (
        state.isQueueProcessingPaused   ||
        state.isConversationCheckPaused ||
        state.availableWorkers.size === 0 ||
        state.taskQueue.length === 0
    ) {
        if (state.taskQueue.length > 0) {
            io.emit('window-status-update', await db.getConversationWindowState(state.taskQueue[0].recipientNumber));
        }
        return;
    }

    helpers.startWebhookWatchdog(db.pool);
    const nextRecipient = state.taskQueue[0].recipientNumber;
    const windowState   = await db.getConversationWindowState(nextRecipient);
    io.emit('window-status-update', windowState);

    if (windowState.status === 'COOL_DOWN' || windowState.status === 'EXPIRING_SOON') {
        if (!state.isConversationCheckPaused) {
            helpers.logAndEmit(`⏸️ Cola en espera para ${nextRecipient}: ${windowState.details}`, 'log-warn');
            state.isConversationCheckPaused = true;
        }
        setTimeout(() => {
            state.isConversationCheckPaused = false;
            helpers.logAndEmit('▶️ Reanudando la cola...', 'log-info');
            processQueue();
        }, 30000);
        return;
    }
    state.isConversationCheckPaused = false;

    while (
        state.availableWorkers.size > 0 &&
        state.taskQueue.length > 0 &&
        !state.isQueueProcessingPaused
    ) {
        const workerIndex = state.availableWorkers.values().next().value;
        state.availableWorkers.delete(workerIndex);
        io.emit('workers-status-update', {
            available: state.availableWorkers.size,
            active:    state.senderPool.length - state.availableWorkers.size,
        });

        const task = state.taskQueue.shift();
        io.emit('queue-update', state.taskQueue.length);

        try {
            await db.pool.query(
                'UPDATE envios SET estado = $1, remitente_usado = $2 WHERE id = $3',
                ['procesando', state.senderPool[workerIndex].id, task.id]
            );
            helpers.logAndEmit(`▶️ [Worker ${workerIndex}] iniciando tarea #${task.id}`, 'log-info');
            executeUnifiedSendSequence(task, workerIndex); // Intencional: sin await (concurrente)
        } catch (dbError) {
            helpers.logAndEmit(`❌ Error de DB al iniciar tarea #${task.id}: ${dbError.message}`, 'log-error');
            state.taskQueue.unshift(task);
            io.emit('queue-update', state.taskQueue.length);
            releaseWorkerAndContinue(workerIndex);
        }
    }
}

async function executeUnifiedSendSequence(task, workerIndex) {
    const { id, recipientNumber, imageName } = task;
    const sender  = state.senderPool[workerIndex];
    const API_URL = `https://graph.facebook.com/v19.0/${sender.id}/messages`;
    const HEADERS = { 'Authorization': `Bearer ${sender.token}`, 'Content-Type': 'application/json' };

    try {
        // Verificar ventana antes de enviar
        const windowState = await db.getConversationWindowState(recipientNumber);
        if (windowState.status === 'INACTIVE') {
            helpers.logAndEmit(`[Worker ${workerIndex}] ⚠️ Ventana cerrada para #${id}. Activando...`, 'log-warn');
            state.taskQueue.unshift(task);
            io.emit('queue-update', state.taskQueue.length);
            await db.pool.query("UPDATE envios SET estado = 'pending' WHERE id = $1", [id]);
            await executeActivationSequence(recipientNumber, workerIndex);
            return; // executeActivationSequence llama a releaseWorkerAndContinue en su finally
        }

        helpers.logAndEmit(`[Worker ${workerIndex}] 📤 1/3: Enviando "activar" para #${id}...`, 'log-info');
        await axios.post(API_URL, {
            messaging_product: 'whatsapp', to: recipientNumber,
            type: 'text', text: { body: 'activar' },
        }, { headers: HEADERS });
        await helpers.delay(state.delaySettings.delay1);

        helpers.logAndEmit(`[Worker ${workerIndex}] 📤 2/3: Enviando "3" para #${id}...`, 'log-info');
        await axios.post(API_URL, {
            messaging_product: 'whatsapp', to: recipientNumber,
            type: 'text', text: { body: '3' },
        }, { headers: HEADERS });
        await helpers.delay(state.delaySettings.delay2);

        const publicImageUrl = `${config.RENDER_EXTERNAL_URL}/uploads/pending/${imageName}`;
        helpers.logAndEmit(`[Worker ${workerIndex}] 📤 3/3: Enviando imagen para #${id}...`, 'log-info');
        await axios.post(API_URL, {
            messaging_product: 'whatsapp', to: recipientNumber,
            type: 'image', image: { link: publicImageUrl },
        }, { headers: HEADERS });
        await helpers.delay(2000);

        helpers.logAndEmit(`[Worker ${workerIndex}] ✅ Secuencia completada para #${id}.`, 'log-success');
        await db.pool.query("UPDATE envios SET estado = 'enviado' WHERE id = $1", [id]);

    } catch (error) {
        const msg = error.response?.data?.error?.message || error.message;
        helpers.logAndEmit(`[Worker ${workerIndex}] 🚫 Falló secuencia para #${id}: ${msg}`, 'log-error');
        await db.pool.query("UPDATE envios SET estado = 'failed' WHERE id = $1", [id]);
    } finally {
        releaseWorkerAndContinue(workerIndex);
    }
}

async function executeActivationSequence(recipientNumber, workerIndex) {
    const sender  = state.senderPool[workerIndex];
    const API_URL = `https://graph.facebook.com/v19.0/${sender.id}/messages`;
    const HEADERS = { 'Authorization': `Bearer ${sender.token}`, 'Content-Type': 'application/json' };

    try {
        helpers.logAndEmit(`[Worker ${workerIndex}] 📤 Enviando Template de activación...`, 'log-info');

        await axios.post(API_URL, {
            messaging_product: 'whatsapp',
            to: recipientNumber,
            type: 'template',
            template: {
                name: 'mensaje_activacion_',
                language: { code: 'en_US' }
            }
        }, { headers: HEADERS });

        helpers.logAndEmit(
          `[Worker ${workerIndex}] ⏳ Template enviado. Esperando respuesta del usuario...`,
          'log-info'
        );

    } catch (error) {
        const msg = error.response?.data?.error?.message || error.message;
        helpers.logAndEmit(`[Worker ${workerIndex}] 🚫 Falló activación: ${msg}`, 'log-error');
    } finally {
        releaseWorkerAndContinue(workerIndex);
    }
}

module.exports = { init, processQueue, executeActivationSequence };

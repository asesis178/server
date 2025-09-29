// /state.js
const config = require('./config');

const senderPool = config.PHONE_NUMBER_IDS.map((id, index) => ({
    id: id.trim(),
    token: config.WHATSAPP_TOKENS[index].trim()
}));

// Este objeto contiene todo el estado que puede cambiar durante la ejecución.
// Al exportarlo, cualquier módulo que lo importe podrá acceder y modificar la misma instancia.
const state = {
    taskQueue: [],
    availableWorkers: new Set(senderPool.map((_, index) => index)),
    isConversationCheckPaused: false,
    isQueueProcessingPaused: false,
    delaySettings: { delay1: 10000, delay2: 2000, taskSeparation: 500 },
    botFailureInfo: { hasFailed: false, message: '' },
    webhookWatchdog: null,
    senderPool: senderPool
};

module.exports = state;
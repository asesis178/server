// /state.js
const config = require('./config');

const senderPool = config.PHONE_NUMBER_IDS.map((id, index) => ({
    id:    id.trim(),
    token: config.WHATSAPP_TOKENS[index].trim(),
}));

const state = {
    taskQueue:                [],
    availableWorkers:         new Set(senderPool.map((_, i) => i)),
    isConversationCheckPaused: false,
    isQueueProcessingPaused:   false,
    delaySettings:            { delay1: 10000, delay2: 2000, taskSeparation: 500 },
    botFailureInfo:           { hasFailed: false, message: '' },
    webhookWatchdog:          null,
    senderPool,
};

module.exports = state;

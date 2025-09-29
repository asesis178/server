// /routes/index.js
const express = require('express');
const path = require('path');
const multer = require('multer');
const fs = require('fs').promises;
const AdmZip = require('adm-zip');
const sharp = require('sharp');
const exceljs = require('exceljs');

const router = express.Router();

// Importaciones de módulos locales
const { requireAuth, requireAdmin } = require('../auth');
const state = require('../state');
const db = require('../services/db');
const queueProcessor = require('../services/queueProcessor');
const helpers = require('../utils/helpers');
const dirs = require('../utils/directoryManager');

const upload = multer({ dest: dirs.TEMP_DIR, limits: { fileSize: 50 * 1024 * 1024 } });

// --- ENDPOINTS PÚBLICOS Y HTML ---
router.use('/assets', express.static(dirs.ASSETS_DIR));
router.use('/uploads/pending', express.static(dirs.PENDING_DIR));
router.use('/zips', requireAuth, express.static(dirs.ZIPS_DIR));

router.get('/', (req, res) => res.send('Servidor activo. Visita /panel para operar.'));
router.get('/panel', requireAuth, (req, res) => res.sendFile(path.join(__dirname, '..', '/paneles/panelUser.html')));
router.get('/panelAdmin', requireAuth, requireAdmin, (req, res) => res.sendFile(path.join(__dirname, '..', '/paneles/panelAdmin.html')));

// --- WEBHOOK ---
router.post('/webhook', async (req, res) => {
    res.sendStatus(200);
    const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message || message.type !== 'text') return;

    helpers.resetWebhookWatchdog(db.pool);

    const from = message.from;
    const textBody = message.text.body;
    const regex = /cedula:\s*(\d+)\s*fecha de nacimiento:\s*(\d{2}\/\d{2}\/\d{4})\s*ud (no )?esta habilitado/i;
    const match = textBody.match(regex);
    if (!match) return;

    const [, cedula, fechaNacStr, notKeyword] = match;
    const isConfirmed = !notKeyword;
    const status = isConfirmed ? 'Confirmado' : 'No Confirmado';
    const [day, month, year] = fechaNacStr.split('/');
    const fechaNac = `${year}-${month}-${day}`;
    const tableName = isConfirmed ? 'confirmados' : 'no_confirmados';
    const numberColumn = isConfirmed ? 'numero_confirmado' : 'numero_no_confirmado';

    try {
        const pendingFiles = await fs.readdir(dirs.PENDING_DIR);
        const imageToMove = pendingFiles.find(file => file.includes(cedula));
        if (!imageToMove) {
            helpers.logAndEmit(`[Webhook] ❌ ERROR CRÍTICO: Respuesta para CI ${cedula} recibida, pero no se encontró su imagen. No se registrará.`, 'log-error');
            return;
        }
        const oldPath = path.join(dirs.PENDING_DIR, imageToMove);
        const newDir = isConfirmed ? dirs.CONFIRMED_ARCHIVE_DIR : dirs.NOT_CONFIRMED_ARCHIVE_DIR;
        const newPath = path.join(newDir, imageToMove);
        await fs.rename(oldPath, newPath);
        helpers.logAndEmit(`[Webhook] 🗂️ Imagen para CI ${cedula} archivada en '${status}'.`, 'log-info');

        await db.pool.query(`INSERT INTO ${tableName} (cedula, fecha_nacimiento, ${numberColumn}) VALUES ($1, $2, $3) ON CONFLICT (cedula) DO NOTHING`, [cedula, fechaNac, from]);
        helpers.logAndEmit(`[Webhook] ✅ Registro guardado: ${status} para CI ${cedula}.`, 'log-success');

        const confirmedCount = (await db.pool.query('SELECT COUNT(*) FROM confirmados')).rows[0].count;
        const notConfirmedCount = (await db.pool.query('SELECT COUNT(*) FROM no_confirmados')).rows[0].count;
        req.app.get('io').emit('stats-update', { confirmed: confirmedCount, notConfirmed: notConfirmedCount });
    } catch (error) {
        helpers.logAndEmit(`[Webhook] ❌ Error total al procesar CI ${cedula}: ${error.message}`, 'log-error');
    }
});

// --- ENDPOINTS DE OPERACIÓN (USER & ADMIN) ---
router.post('/subir-zip', requireAuth, upload.single('zipFile'), async (req, res) => {
    if (state.botFailureInfo.hasFailed) {
        return res.status(503).json({ message: 'El sistema está en estado de fallo. Resetea el estado desde el panel.' });
    }
    const { destinationNumber } = req.body;
    const zipFile = req.file;
    if (!destinationNumber || !zipFile) return res.status(400).json({ message: "Faltan datos." });

    try {
        const zip = new AdmZip(zipFile.path);
        const imageEntries = zip.getEntries().filter(e => !e.isDirectory && /\.(jpg|jpeg|png)$/i.test(e.entryName));
        await fs.unlink(zipFile.path);
        if (imageEntries.length === 0) return res.status(400).json({ message: "El ZIP no contiene imágenes válidas." });

        helpers.logAndEmit(`📦 ZIP recibido. Optimizando ${imageEntries.length} imágenes...`, 'log-info');
        const processingPromises = imageEntries.map(entry => {
            const originalFileName = path.basename(entry.entryName);
            const cedulaMatch = originalFileName.match(/\d+/);
            if (!cedulaMatch) {
                helpers.logAndEmit(`⚠️ Imagen ${originalFileName} saltada: no contiene una cédula.`, 'log-warn');
                return Promise.resolve(null);
            }
            const optimizedFileName = originalFileName.replace(/\s/g, '_');
            const targetPath = path.join(dirs.PENDING_DIR, optimizedFileName);
            return sharp(entry.getData()).resize({ width: 1920, withoutEnlargement: true }).jpeg({ quality: 80 }).toFile(targetPath)
                .then(() => optimizedFileName).catch(err => {
                    helpers.logAndEmit(`⚠️ No se pudo optimizar ${originalFileName}.`, 'log-warn');
                    return null;
                });
        });
        const allOptimizedImageNames = (await Promise.all(processingPromises)).filter(Boolean);
        if (allOptimizedImageNames.length === 0) return res.status(400).json({ message: "Ninguna imagen pudo ser procesada." });

        helpers.logAndEmit(`💾 Guardando ${allOptimizedImageNames.length} tareas en DB...`, 'log-info');
        const client = await db.pool.connect();
        try {
            await client.query('BEGIN');
            const newTasks = [];
            for (const imageName of allOptimizedImageNames) {
                const result = await client.query('INSERT INTO envios (numero_destino, nombre_imagen, estado) VALUES ($1, $2, $3) RETURNING id, numero_destino, nombre_imagen', [destinationNumber, imageName, 'pending']);
                newTasks.push({ id: result.rows[0].id, recipientNumber: result.rows[0].numero_destino, imageName: result.rows[0].nombre_imagen });
            }
            await client.query('COMMIT');
            state.taskQueue.push(...newTasks);
            helpers.logAndEmit(`✅ ${newTasks.length} tareas agregadas.`, 'log-success');
            req.app.get('io').emit('queue-update', state.taskQueue.length);
            setTimeout(() => {
                helpers.logAndEmit('▶️ Iniciando procesamiento de la nueva cola.', 'log-info');
                queueProcessor.processQueue();
            }, 2000);
            res.status(200).json({ message: `Se encolaron ${newTasks.length} envíos.` });
        } catch (dbError) {
            await client.query('ROLLBACK');
            throw dbError;
        } finally {
            client.release();
        }
    } catch (error) {
        helpers.logAndEmit(`❌ Error al procesar ZIP: ${error.message}`, 'log-error');
        res.status(500).json({ message: "Error interno al procesar ZIP." });
    }
});

router.get('/download-confirmed-excel', requireAuth, async (req, res) => {
    try {
        const result = await db.pool.query('SELECT cedula, fecha_nacimiento, numero_confirmado, confirmado_en FROM confirmados ORDER BY confirmado_en ASC');
        const workbook = new exceljs.Workbook();
        const worksheet = workbook.addWorksheet('Confirmados');
        worksheet.columns = [{ header: 'Cédula', key: 'cedula', width: 15 }, { header: 'Fecha de Nacimiento', key: 'fecha_nacimiento', width: 20 }, { header: 'Número de Contacto', key: 'numero_confirmado', width: 20 }, { header: 'Fecha de Confirmación', key: 'confirmado_en', width: 25 }];
        worksheet.addRows(result.rows);
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        const timestamp = helpers.getFormattedTimestamp();
        const fileName = `confirmaciones_bps (${timestamp}).xlsx`;
        res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
        await workbook.xlsx.write(res);
        res.end();
    } catch (error) {
        helpers.logAndEmit(`❌ Error generando Excel: ${error.message}`, 'log-error');
        res.status(500).send("Error al generar el archivo Excel.");
    }
});

async function createAndSendZip(res, directory, zipName) {
    try {
        const files = await fs.readdir(directory);
        if (files.length === 0) return res.status(404).json({ message: `No hay imágenes en la categoría '${zipName}'.` });
        const zip = new AdmZip();
        for (const file of files) {
            zip.addLocalFile(path.join(directory, file));
        }
        const zipBuffer = zip.toBuffer();
        const timestamp = helpers.getFormattedTimestamp();
        const finalZipName = `${zipName}_(${timestamp}).zip`;
        await fs.writeFile(path.join(dirs.ZIPS_DIR, finalZipName), zipBuffer);
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="${finalZipName}"`);
        res.send(zipBuffer);
    } catch (error) {
        helpers.logAndEmit(`❌ Error generando ZIP de ${zipName}: ${error.message}`, 'log-error');
        res.status(500).send(`Error al generar el ZIP de ${zipName}.`);
    }
}

router.get('/download-confirmed-zip', requireAuth, (req, res) => createAndSendZip(res, dirs.CONFIRMED_ARCHIVE_DIR, 'confirmados'));
router.get('/download-not-confirmed-zip', requireAuth, (req, res) => createAndSendZip(res, dirs.NOT_CONFIRMED_ARCHIVE_DIR, 'no-confirmados'));

router.post('/pause-queue', requireAuth, (req, res) => {
    if (!state.isQueueProcessingPaused) {
        state.isQueueProcessingPaused = true;
        helpers.logAndEmit('⏸️ Cola pausada.', 'log-warn');
        req.app.get('io').emit('queue-status-update', { isPaused: true });
    }
    res.status(200).json({ message: 'Cola pausada.' });
});

router.post('/resume-queue', requireAuth, (req, res) => {
    if (state.botFailureInfo.hasFailed) {
        return res.status(403).json({ message: 'No se puede reanudar. El sistema está en estado de fallo.' });
    }
    if (state.isQueueProcessingPaused) {
        state.isQueueProcessingPaused = false;
        helpers.logAndEmit('▶️ Cola reanudada.', 'log-info');
        req.app.get('io').emit('queue-status-update', { isPaused: false });
        queueProcessor.processQueue();
    }
    res.status(200).json({ message: 'Cola reanudada.' });
});

router.post('/reset-bot-failure', requireAuth, (req, res) => {
    if (state.botFailureInfo.hasFailed) {
        state.botFailureInfo = { hasFailed: false, message: '' };
        state.isQueueProcessingPaused = false;
        helpers.stopWebhookWatchdog();
        helpers.logAndEmit('🔧 Estado de fallo reseteado. Sistema operativo.', 'log-warn');
        req.app.get('io').emit('bot-failure-resolved');
        req.app.get('io').emit('queue-status-update', { isPaused: false });
        queueProcessor.processQueue();
    }
    res.status(200).json({ message: 'Estado de fallo reseteado.' });
});

router.get('/list-zips', requireAuth, async (req, res) => {
    try {
        const files = await fs.readdir(dirs.ZIPS_DIR);
        res.json(files.sort().reverse());
    } catch (error) {
        res.status(500).json([]);
    }
});

// --- ENDPOINTS DE CONFIGURACIÓN (ADMIN ONLY) ---
router.post('/clear-queue', requireAuth, requireAdmin, async (req, res) => {
    helpers.logAndEmit('🗑️ Vaciando la cola de tareas pendientes...', 'log-warn');
    const tasksToCancel = state.taskQueue.length;
    state.taskQueue = [];
    try {
        await db.pool.query("UPDATE envios SET estado = 'cancelled' WHERE estado = 'pending'");
        helpers.logAndEmit(`✅ Cola vaciada. ${tasksToCancel} tareas canceladas.`, 'log-success');
        req.app.get('io').emit('queue-update', state.taskQueue.length);
        res.status(200).json({ message: 'Cola limpiada.' });
    } catch (dbError) {
        helpers.logAndEmit(`❌ Error al cancelar tareas: ${dbError.message}`, 'log-error');
        res.status(500).json({ message: 'Error en DB.' });
    }
});

router.post('/manual-activate', requireAuth, requireAdmin, upload.none(), async (req, res) => {
    const { destinationNumber } = req.body;
    if (!destinationNumber) return res.status(400).json({ message: "Falta el número." });
    if (state.availableWorkers.size === 0) return res.status(503).json({ message: "Workers ocupados." });
    const workerIndex = state.availableWorkers.values().next().value;
    state.availableWorkers.delete(workerIndex);
    req.app.get('io').emit('workers-status-update', { available: state.availableWorkers.size, active: state.senderPool.length - state.availableWorkers.size });
    helpers.logAndEmit(`▶️ [Worker ${workerIndex}] iniciando activación MANUAL para ${destinationNumber}.`, 'log-info');
    queueProcessor.executeActivationSequence(destinationNumber, workerIndex);
    res.status(202).json({ message: "Activación iniciada." });
});

router.post('/debug-update-window', requireAuth, requireAdmin, async (req, res) => {
    const { recipientNumber, newTimestamp } = req.body;
    if (!recipientNumber || !newTimestamp) return res.status(400).json({ message: "Faltan datos." });
    try {
        await db.pool.query(`INSERT INTO conversation_windows (recipient_number, last_activation_time) VALUES ($1, $2) ON CONFLICT (recipient_number) DO UPDATE SET last_activation_time = $2`, [recipientNumber, newTimestamp]);
        const windowState = await db.getConversationWindowState(recipientNumber);
        req.app.get('io').emit('window-status-update', windowState);
        res.json({ message: `Fecha forzada para ${recipientNumber}.` });
    } catch (error) {
        console.error("Error en /debug-update-window:", error);
        res.status(500).json({ message: "Error al actualizar." });
    }
});

router.post('/update-delays', requireAuth, requireAdmin, (req, res) => {
    const { delay1, delay2, taskSeparation } = req.body;
    const d1 = parseInt(delay1, 10), d2 = parseInt(delay2, 10), sep = parseInt(taskSeparation, 10);
    if (isNaN(d1) || isNaN(d2) || isNaN(sep) || d1 < 0 || d2 < 0 || sep < 0) {
        return res.status(400).json({ message: 'Valores inválidos.' });
    }
    state.delaySettings = { delay1: d1, delay2: d2, taskSeparation: sep };
    helpers.logAndEmit(`🔧 Tiempos actualizados: D1=${d1}ms, D2=${d2}ms, Sep=${sep}ms`, 'log-info');
    req.app.get('io').emit('delay-settings-updated', state.delaySettings);
    res.status(200).json({ message: 'Delays actualizados.' });
});

module.exports = router;
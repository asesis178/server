// /routes/index.js
const express  = require('express');
const path     = require('path');
const crypto   = require('crypto'); // Built-in de Node.js, no necesita instalación
const multer   = require('multer');
const fs       = require('fs').promises;
const AdmZip   = require('adm-zip');
const sharp    = require('sharp');
const exceljs  = require('exceljs');

const router = express.Router();

const { requireAuth, requireAdmin } = require('../auth');
const config         = require('../config');
const state          = require('../state');
const db             = require('../services/db');
const queueProcessor = require('../services/queueProcessor');
const helpers        = require('../utils/helpers');
const dirs           = require('../utils/directoryManager');

const upload = multer({ dest: dirs.TEMP_DIR, limits: { fileSize: 50 * 1024 * 1024 } });

// --- Helpers internos ---

// Validar que sea un número de teléfono (solo dígitos, entre 7 y 15 caracteres)
function isValidPhoneNumber(number) {
    return typeof number === 'string' && /^\d{7,15}$/.test(number);
}

// Verificar que el path resultante esté DENTRO del directorio base (previene path traversal)
function isSafePath(baseDir, targetPath) {
    const resolvedBase   = path.resolve(baseDir);
    const resolvedTarget = path.resolve(targetPath);
    return resolvedTarget.startsWith(resolvedBase + path.sep) || resolvedTarget === resolvedBase;
}

// --- Archivos estáticos ---
router.use('/assets', express.static(dirs.ASSETS_DIR));
// ✅ /uploads/pending protegido: contiene documentos de identidad
router.use('/uploads/pending', requireAuth, express.static(dirs.PENDING_DIR));
router.use('/zips', requireAuth, express.static(dirs.ZIPS_DIR));

// --- Páginas HTML ---
router.get('/', (req, res) => res.send('Servidor activo. Visitá /panel para operar.'));
router.get('/panel',      requireAuth,               (req, res) => res.sendFile(path.join(__dirname, '..', 'paneles', 'panelUser.html')));
router.get('/panelAdmin', requireAuth, requireAdmin, (req, res) => res.sendFile(path.join(__dirname, '..', 'paneles', 'panelAdmin.html')));
router.get('/chat',       requireAuth, requireAdmin, (req, res) => res.sendFile(path.join(__dirname, '..', 'paneles', 'chat.html')));

// ============================================================
// WEBHOOK
// ============================================================

// GET: Verificación inicial del webhook (Meta llama esto una vez al registrarlo)
router.get('/webhook', (req, res) => {
    const mode      = req.query['hub.mode'];
    const token     = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === config.VERIFY_TOKEN) {
        console.log('✅ Webhook verificado correctamente por Meta.');
        return res.status(200).send(challenge);
    }
    console.warn('⚠️ Verificación de webhook fallida. Token incorrecto.');
    return res.sendStatus(403);
});

// POST: Recepción de mensajes.
// IMPORTANTE: Este endpoint usa express.raw() en vez de express.json()
// para poder verificar la firma HMAC. Esto se configura en index.js.
router.post('/webhook', (req, res) => {
    // ✅ Verificar firma de Meta (garantiza que el request viene realmente de Meta)
    const signature = req.headers['x-hub-signature-256'];
    if (!signature) {
        console.warn('⚠️ Webhook recibido sin firma X-Hub-Signature-256. Rechazado.');
        return res.sendStatus(401);
    }

    const expectedSignature = 'sha256=' + crypto
        .createHmac('sha256', config.WHATSAPP_APP_SECRET)
        .update(req.body) // req.body es un Buffer gracias a express.raw() en index.js
        .digest('hex');

    // timingSafeEqual previene timing attacks
    const sigBuffer = Buffer.from(signature);
    const expBuffer = Buffer.from(expectedSignature);
    if (sigBuffer.length !== expBuffer.length || !crypto.timingSafeEqual(sigBuffer, expBuffer)) {
        console.warn('⚠️ Firma del webhook inválida. Posible request falso. Rechazado.');
        return res.sendStatus(401);
    }

    // Responder 200 inmediatamente (Meta requiere respuesta rápida)
    res.sendStatus(200);

    // Parsear el body (que llegó como Buffer)
    let body;
    try {
        body = JSON.parse(req.body.toString('utf8'));
    } catch (e) {
        console.error('❌ Error al parsear body del webhook:', e.message);
        return;
    }

    const message = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message || message.type !== 'text') return;

    // Resetear el guardián cada vez que llega un mensaje válido
    helpers.resetWebhookWatchdog(db.pool);

    const from     = message.from;
    const textBody = message.text.body;

    // Regex para detectar el formato de respuesta del bot
    const regex = /cedula:\s*(\d+)\s*fecha de nacimiento:\s*(\d{2}\/\d{2}\/\d{4})\s*ud (no )?esta habilitado/i;
    const match = textBody.match(regex);
    const isValidFormat = !!match;

    // Emitir al visor de chat en tiempo real
    req.app.get('io').emit('new-webhook-message', { from, text: textBody, isValidFormat });

    if (!isValidFormat) return;

    // Procesar el mensaje de forma asíncrona
    const [, cedula, fechaNacStr, notKeyword] = match;
    const isConfirmed  = !notKeyword;
    const status       = isConfirmed ? 'Confirmado' : 'No Confirmado';
    const [day, month, year] = fechaNacStr.split('/');
    const fechaNac     = `${year}-${month}-${day}`;
    const tableName    = isConfirmed ? 'confirmados' : 'no_confirmados';
    const numberColumn = isConfirmed ? 'numero_confirmado' : 'numero_no_confirmado';

    (async () => {
        try {
            const pendingFiles = await fs.readdir(dirs.PENDING_DIR);
            const imageToMove  = pendingFiles.find(file => file.includes(cedula));

            if (!imageToMove) {
                helpers.logAndEmit(
                    `[Webhook] ❌ Respuesta para CI ${cedula} recibida, pero no se encontró su imagen en pending.`,
                    'log-error'
                );
                return;
            }

            const oldPath = path.join(dirs.PENDING_DIR, imageToMove);
            const newDir  = isConfirmed ? dirs.CONFIRMED_ARCHIVE_DIR : dirs.NOT_CONFIRMED_ARCHIVE_DIR;
            const newPath = path.join(newDir, imageToMove);
            await fs.rename(oldPath, newPath);
            helpers.logAndEmit(`[Webhook] 🗂️ Imagen para CI ${cedula} archivada en '${status}'.`, 'log-info');

            await db.pool.query(
                `INSERT INTO ${tableName} (cedula, fecha_nacimiento, ${numberColumn})
                 VALUES ($1, $2, $3)
                 ON CONFLICT (cedula) DO NOTHING`,
                [cedula, fechaNac, from]
            );
            helpers.logAndEmit(`[Webhook] ✅ Registro guardado: ${status} para CI ${cedula}.`, 'log-success');

            const confirmedCount    = (await db.pool.query('SELECT COUNT(*) FROM confirmados')).rows[0].count;
            const notConfirmedCount = (await db.pool.query('SELECT COUNT(*) FROM no_confirmados')).rows[0].count;
            req.app.get('io').emit('stats-update', { confirmed: confirmedCount, notConfirmed: notConfirmedCount });

        } catch (error) {
            helpers.logAndEmit(`[Webhook] ❌ Error al procesar CI ${cedula}: ${error.message}`, 'log-error');
        }
    })();
});

// ============================================================
// OPERACIONES (USER + ADMIN)
// ============================================================

router.post('/subir-zip', requireAuth, upload.single('zipFile'), async (req, res) => {
    if (state.botFailureInfo.hasFailed) {
        return res.status(503).json({ message: 'El sistema está en estado de fallo. Resetea el estado desde el panel.' });
    }

    const { destinationNumber } = req.body;
    const zipFile = req.file;

    if (!destinationNumber || !zipFile) {
        return res.status(400).json({ message: 'Faltan datos (número o archivo ZIP).' });
    }
    if (!isValidPhoneNumber(destinationNumber)) {
        await fs.unlink(zipFile.path).catch(() => {});
        return res.status(400).json({ message: 'Número de destino inválido. Solo dígitos, 7-15 caracteres.' });
    }

    try {
        const zip          = new AdmZip(zipFile.path);
        const imageEntries = zip.getEntries().filter(e => !e.isDirectory && /\.(jpg|jpeg|png)$/i.test(e.entryName));
        await fs.unlink(zipFile.path);

        if (imageEntries.length === 0) {
            return res.status(400).json({ message: 'El ZIP no contiene imágenes válidas (.jpg, .jpeg, .png).' });
        }

        helpers.logAndEmit(`📦 ZIP recibido. Optimizando ${imageEntries.length} imágenes...`, 'log-info');

        const processingPromises = imageEntries.map(entry => {
            // path.basename previene traversal de directorios dentro del ZIP
            const originalFileName = path.basename(entry.entryName);

            // Verificar que el nombre contiene una cédula (número)
            if (!originalFileName.match(/\d+/)) {
                helpers.logAndEmit(`⚠️ Imagen '${originalFileName}' saltada: no contiene una cédula en el nombre.`, 'log-warn');
                return Promise.resolve(null);
            }

            // ✅ Sanitizar nombre: reemplazar espacios y eliminar caracteres peligrosos
            const safeName     = originalFileName.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_.\-]/g, '');
            const targetPath   = path.join(dirs.PENDING_DIR, safeName);

            // ✅ Verificar que el path final está dentro de PENDING_DIR
            if (!isSafePath(dirs.PENDING_DIR, targetPath)) {
                helpers.logAndEmit(`⚠️ Nombre de archivo bloqueado (path traversal): ${originalFileName}`, 'log-warn');
                return Promise.resolve(null);
            }

            return sharp(entry.getData())
                .resize({ width: 1920, withoutEnlargement: true })
                .jpeg({ quality: 80 })
                .toFile(targetPath)
                .then(() => safeName)
                .catch(err => {
                    helpers.logAndEmit(`⚠️ No se pudo optimizar '${originalFileName}': ${err.message}`, 'log-warn');
                    return null;
                });
        });

        const optimizedNames = (await Promise.all(processingPromises)).filter(Boolean);
        if (optimizedNames.length === 0) {
            return res.status(400).json({ message: 'Ninguna imagen pudo ser procesada.' });
        }

        helpers.logAndEmit(`💾 Guardando ${optimizedNames.length} tareas en DB...`, 'log-info');

        const client = await db.pool.connect();
        try {
            await client.query('BEGIN');
            const newTasks = [];
            for (const imageName of optimizedNames) {
                const result = await client.query(
                    "INSERT INTO envios (numero_destino, nombre_imagen, estado) VALUES ($1, $2, 'pending') RETURNING id, numero_destino, nombre_imagen",
                    [destinationNumber, imageName]
                );
                newTasks.push({
                    id:              result.rows[0].id,
                    recipientNumber: result.rows[0].numero_destino,
                    imageName:       result.rows[0].nombre_imagen,
                });
            }
            await client.query('COMMIT');

            state.taskQueue.push(...newTasks);
            helpers.logAndEmit(`✅ ${newTasks.length} tareas agregadas a la cola.`, 'log-success');
            req.app.get('io').emit('queue-update', state.taskQueue.length);

            // Pequeño delay antes de arrancar para que la respuesta HTTP llegue primero
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
        res.status(500).json({ message: 'Error interno al procesar el ZIP.' });
    }
});

router.get('/download-confirmed-excel', requireAuth, async (req, res) => {
    try {
        const result    = await db.pool.query(
            'SELECT cedula, fecha_nacimiento, numero_confirmado, confirmado_en FROM confirmados ORDER BY confirmado_en ASC'
        );
        const workbook  = new exceljs.Workbook();
        const worksheet = workbook.addWorksheet('Confirmados');
        worksheet.columns = [
            { header: 'Cédula',               key: 'cedula',            width: 15 },
            { header: 'Fecha de Nacimiento',  key: 'fecha_nacimiento',  width: 20 },
            { header: 'Número de Contacto',   key: 'numero_confirmado', width: 20 },
            { header: 'Fecha de Confirmación',key: 'confirmado_en',     width: 25 },
        ];
        worksheet.addRows(result.rows);
        const timestamp = helpers.getFormattedTimestamp();
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="confirmaciones_bps_(${timestamp}).xlsx"`);
        await workbook.xlsx.write(res);
        res.end();
    } catch (error) {
        helpers.logAndEmit(`❌ Error generando Excel: ${error.message}`, 'log-error');
        res.status(500).send('Error al generar el archivo Excel.');
    }
});

async function createAndSendZip(res, directory, zipName) {
    try {
        const files = await fs.readdir(directory);
        if (files.length === 0) {
            return res.status(404).json({ message: `No hay imágenes en '${zipName}'.` });
        }
        const zip = new AdmZip();
        for (const file of files) {
            zip.addLocalFile(path.join(directory, file));
        }
        const zipBuffer   = zip.toBuffer();
        const timestamp   = helpers.getFormattedTimestamp();
        const finalName   = `${zipName}_(${timestamp}).zip`;
        await fs.writeFile(path.join(dirs.ZIPS_DIR, finalName), zipBuffer);
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="${finalName}"`);
        res.send(zipBuffer);
    } catch (error) {
        helpers.logAndEmit(`❌ Error generando ZIP de ${zipName}: ${error.message}`, 'log-error');
        res.status(500).send(`Error al generar el ZIP de ${zipName}.`);
    }
}

router.get('/download-confirmed-zip',     requireAuth, (req, res) => createAndSendZip(res, dirs.CONFIRMED_ARCHIVE_DIR,     'confirmados'));
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
        return res.status(403).json({ message: 'No se puede reanudar: el sistema está en estado de fallo. Reseteá primero.' });
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
        state.botFailureInfo          = { hasFailed: false, message: '' };
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
        res.json(files.filter(f => f.endsWith('.zip')).sort().reverse());
    } catch {
        res.status(500).json([]);
    }
});

// ============================================================
// CONFIGURACIÓN (ADMIN ONLY)
// ============================================================

router.post('/clear-queue', requireAuth, requireAdmin, async (req, res) => {
    const tasksToCancel = state.taskQueue.length;
    state.taskQueue = [];
    helpers.logAndEmit('🗑️ Vaciando la cola de tareas pendientes...', 'log-warn');
    try {
        await db.pool.query("UPDATE envios SET estado = 'cancelled' WHERE estado = 'pending'");
        helpers.logAndEmit(`✅ Cola vaciada. ${tasksToCancel} tareas canceladas.`, 'log-success');
        req.app.get('io').emit('queue-update', 0);
        res.status(200).json({ message: 'Cola limpiada.' });
    } catch (dbError) {
        helpers.logAndEmit(`❌ Error al cancelar tareas en DB: ${dbError.message}`, 'log-error');
        res.status(500).json({ message: 'Error en DB.' });
    }
});

router.post('/manual-activate', requireAuth, requireAdmin, upload.none(), async (req, res) => {
    const { destinationNumber } = req.body;
    if (!destinationNumber) return res.status(400).json({ message: 'Falta el número.' });
    if (!isValidPhoneNumber(destinationNumber)) return res.status(400).json({ message: 'Número inválido.' });
    if (state.availableWorkers.size === 0) return res.status(503).json({ message: 'Todos los workers están ocupados. Intentá más tarde.' });

    const workerIndex = state.availableWorkers.values().next().value;
    state.availableWorkers.delete(workerIndex);
    req.app.get('io').emit('workers-status-update', {
        available: state.availableWorkers.size,
        active:    state.senderPool.length - state.availableWorkers.size,
    });
    helpers.logAndEmit(`▶️ [Worker ${workerIndex}] iniciando activación MANUAL para ${destinationNumber}.`, 'log-info');
    queueProcessor.executeActivationSequence(destinationNumber, workerIndex);
    res.status(202).json({ message: 'Activación iniciada.' });
});

router.post('/debug-update-window', requireAuth, requireAdmin, async (req, res) => {
    const { recipientNumber, newTimestamp } = req.body;
    if (!recipientNumber || !newTimestamp) return res.status(400).json({ message: 'Faltan datos.' });
    if (!isValidPhoneNumber(recipientNumber)) return res.status(400).json({ message: 'Número inválido.' });
    try {
        await db.pool.query(
            `INSERT INTO conversation_windows (recipient_number, last_activation_time)
             VALUES ($1, $2)
             ON CONFLICT (recipient_number) DO UPDATE SET last_activation_time = $2`,
            [recipientNumber, newTimestamp]
        );
        const windowState = await db.getConversationWindowState(recipientNumber);
        req.app.get('io').emit('window-status-update', windowState);
        res.json({ message: `Fecha forzada para ${recipientNumber}.` });
    } catch (error) {
        console.error('Error en /debug-update-window:', error);
        res.status(500).json({ message: 'Error al actualizar.' });
    }
});

router.post('/update-delays', requireAuth, requireAdmin, (req, res) => {
    const { delay1, delay2, taskSeparation } = req.body;
    const d1  = parseInt(delay1, 10);
    const d2  = parseInt(delay2, 10);
    const sep = parseInt(taskSeparation, 10);

    if (isNaN(d1) || isNaN(d2) || isNaN(sep) || d1 < 0 || d2 < 0 || sep < 0) {
        return res.status(400).json({ message: 'Valores inválidos. Deben ser números positivos.' });
    }
    state.delaySettings = { delay1: d1, delay2: d2, taskSeparation: sep };
    helpers.logAndEmit(`🔧 Delays actualizados: D1=${d1}ms, D2=${d2}ms, Sep=${sep}ms`, 'log-info');
    req.app.get('io').emit('delay-settings-updated', state.delaySettings);
    res.status(200).json({ message: 'Delays actualizados.' });
});

module.exports = router;

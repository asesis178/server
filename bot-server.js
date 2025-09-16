require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const axios = require('axios');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const { Pool } = require('pg');
const AdmZip = require('adm-zip');

// --- CONFIGURACIÓN (sin cambios) ---
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const DATABASE_URL = process.env.DATABASE_URL;
const PORT = process.env.PORT || 3000;
const RENDER_EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;

const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.json());

const UPLOADS_DIR = path.join(__dirname, 'uploads');
const TEMP_DIR = path.join(__dirname, 'temp');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
const upload = multer({ dest: TEMP_DIR });

// --- ESTADO GLOBAL ---
let taskQueue = [];
let isProcessing = false;
let currentTask = null; // CAMBIO CLAVE: Guardamos la tarea actual
let responseTimeout = null; // CAMBIO CLAVE: Para manejar el timeout si no hay respuesta

// ... (initializeDatabase, logAndEmit, io.on('connection') sin cambios)
async function initializeDatabase() {
    const client = await pool.connect();
    try {
        await client.query(`CREATE TABLE IF NOT EXISTS envios (
            id SERIAL PRIMARY KEY, numero_destino VARCHAR(255) NOT NULL, nombre_imagen VARCHAR(255),
            estado VARCHAR(50) DEFAULT 'enviado', creado_en TIMESTAMPTZ DEFAULT NOW()
        );`);
        await client.query(`CREATE TABLE IF NOT EXISTS confirmados (
            id SERIAL PRIMARY KEY, numero_confirmado VARCHAR(255) NOT NULL,
            mensaje_confirmacion VARCHAR(255), confirmado_en TIMESTAMPTZ DEFAULT NOW(),
            UNIQUE(numero_confirmado, mensaje_confirmacion) -- Evita duplicados exactos
        );`);
        console.log("✅ Tablas 'envios' y 'confirmados' verificadas.");
    } catch (err) {
        console.error("❌ Error al inicializar la base de datos:", err);
    } finally {
        client.release();
    }
}

function logAndEmit(text, type = 'log-info') {
    console.log(text);
    io.emit('status-update', { text, type });
}

io.on('connection', (socket) => {
    console.log(`[Socket.IO] Usuario conectado: ${socket.id}`);
    socket.emit('queue-update', taskQueue.length);

    socket.on('ver-confirmados', async () => {
        try {
            const result = await pool.query('SELECT numero_confirmado, mensaje_confirmacion, confirmado_en FROM confirmados ORDER BY confirmado_en DESC');
            socket.emit('datos-confirmados', result.rows);
        } catch (dbError) {
            console.error("Error al obtener confirmados:", dbError);
        }
    });

    socket.on('limpiar-confirmados', async () => {
        try {
            await pool.query('DELETE FROM confirmados');
            console.log("[DB] Tabla 'confirmados' limpiada.");
            io.emit('datos-confirmados', []);
            socket.emit('status-update', { text: "✅ DB de confirmados limpiada.", isError: false, isComplete: true });
        } catch (dbError) {
            console.error("Error al limpiar confirmados:", dbError);
            socket.emit('status-update', { text: "❌ Error al limpiar la DB.", isError: true, isComplete: true });
        }
    });
});

// --- ENDPOINTS ---
app.get('/panel', (req, res) => res.sendFile(path.join(__dirname, 'panel.html')));
app.use('/uploads', express.static(UPLOADS_DIR));
app.get('/', (req, res) => res.send('Servidor activo. Visita /panel para usar el control.'));

// CAMBIO CLAVE: El webhook ahora controla el flujo de la cola
app.post('/webhook', async (req, res) => {
    res.sendStatus(200);
    const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

    // Ignorar si no estamos esperando una respuesta o si el mensaje no es de texto
    if (!isProcessing || !message || message.type !== 'text' || !currentTask) {
        return;
    }

    const from = message.from;
    const textBody = message.text.body.trim();

    // Solo reaccionar a mensajes del número que estamos procesando actualmente
    if (from !== currentTask.recipientNumber) {
        return;
    }

    // Si llega una respuesta, cancelamos el timeout de seguridad
    clearTimeout(responseTimeout);
    responseTimeout = null;

    let wasConfirmed = false;
    if (/^confirmado\s+\d{8}$/i.test(textBody)) {
        const cedula = textBody.split(/\s+/)[1];
        logAndEmit(`✅ Recibida confirmación de ${from} con cédula: ${cedula}`, 'log-success');
        wasConfirmed = true;
        try {
            // Guardamos la cédula asociada a la imagen específica
            await pool.query(
                `INSERT INTO confirmados (numero_confirmado, mensaje_confirmacion) VALUES ($1, $2)`,
                [from, cedula]
            );
            const result = await pool.query('SELECT numero_confirmado, mensaje_confirmacion, confirmado_en FROM confirmados ORDER BY confirmado_en DESC');
            io.emit('datos-confirmados', result.rows);
        } catch (dbError) {
            // Manejar error de duplicado si la cédula ya fue confirmada
            if (dbError.code === '23505') { // Código de error para unique violation
                 logAndEmit(`ℹ️ La cédula ${cedula} ya había sido confirmada previamente por este número.`, 'log-info');
            } else {
                 logAndEmit(`❌ Error al guardar en DB la confirmación de ${from}.`, 'log-error');
            }
        }
    } else {
        logAndEmit(`💬 Respuesta no válida de ${from}: "${textBody}". Continuando con la siguiente tarea.`, 'log-warn');
    }
    
    // Sea cual sea la respuesta, liberamos el proceso y continuamos con la siguiente tarea.
    releaseAndContinue();
});

// Endpoint /subir-zip (sin cambios, ya estaba bien)
app.post('/subir-zip', upload.single('zipFile'), async (req, res) => {
    const { destinationNumber } = req.body;
    const zipFile = req.file;

    if (!destinationNumber || !zipFile) {
        return res.status(400).json({ message: "Faltan el número de destino o el archivo ZIP." });
    }

    const zipFilePath = zipFile.path;

    try {
        const zip = new AdmZip(zipFilePath);
        zip.extractAllTo(UPLOADS_DIR, true);
        const imageFiles = zip.getEntries()
            .filter(entry => !entry.isDirectory && /\.(jpg|jpeg|png)$/i.test(entry.entryName))
            .map(entry => entry.entryName);

        if (imageFiles.length === 0) {
            return res.status(400).json({ message: "El ZIP no contiene imágenes válidas." });
        }

        const newTasks = imageFiles.map(imageName => ({
            recipientNumber: destinationNumber,
            imageName: imageName
        }));
        taskQueue.push(...newTasks);

        logAndEmit(`📦 Se agregaron ${newTasks.length} tareas. Total en cola: ${taskQueue.length}`, 'log-info');
        io.emit('queue-update', taskQueue.length);
        
        processQueue(); // Iniciar el proceso

        res.status(200).json({ message: `Se han encolado ${newTasks.length} envíos.` });
    } catch (error) {
        res.status(500).json({ message: "Error al procesar el ZIP." });
    } finally {
        fs.unlink(zipFilePath, () => {});
    }
});


// --- LÓGICA DE PROCESAMIENTO DE TAREAS (MODIFICADA) ---
const HEADERS = { 'Authorization': `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' };
const API_URL = `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`;
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function releaseAndContinue() {
    if (isProcessing) {
        logAndEmit(`🟢 Proceso liberado. Buscando siguiente tarea...`, 'log-info');
        isProcessing = false;
        currentTask = null;
        if (responseTimeout) {
            clearTimeout(responseTimeout);
            responseTimeout = null;
        }
        // Llamamos a processQueue para que tome la siguiente tarea si hay
        setTimeout(processQueue, 1000);
    }
}

async function processQueue() {
    if (isProcessing || taskQueue.length === 0) return;

    isProcessing = true;
    currentTask = taskQueue.shift();
    io.emit('queue-update', taskQueue.length);

    logAndEmit(`▶️ Procesando envío a ${currentTask.recipientNumber} con imagen ${currentTask.imageName}...`, 'log-info');

    try {
        const result = await pool.query('INSERT INTO envios (numero_destino, nombre_imagen, estado) VALUES ($1, $2, $3) RETURNING id',
            [currentTask.recipientNumber, currentTask.imageName, 'procesando']);
        const envioId = result.rows[0].id;
        
        await executeSendSequence(currentTask, envioId);
        
        // CAMBIO CLAVE: Después de enviar, NO liberamos. Ponemos un timeout.
        logAndEmit(`⏳ Secuencia enviada. Esperando respuesta por 5 minutos...`, 'log-info');
        responseTimeout = setTimeout(() => {
            logAndEmit(`⏰ ¡TIMEOUT! No se recibió respuesta para ${currentTask.imageName}. Continuando con la siguiente tarea.`, 'log-warn');
            releaseAndContinue();
        }, 300000); // 5 minutos

    } catch (error) {
        console.error("Error crítico en processQueue:", error);
        // Si hay un error, lo registramos y liberamos para continuar con el siguiente
        await pool.query('UPDATE envios SET estado = $1 WHERE nombre_imagen = $2 AND estado = $3', ['fallido', currentTask.imageName, 'procesando']);
        releaseAndContinue();
    }
    // NOTA: El 'finally' que liberaba el proceso ha sido eliminado. Ahora se libera desde el webhook o el timeout.
}

// executeSendSequence (sin cambios mayores, solo quita el 'finally')
async function executeSendSequence(task, envioId) {
    const { recipientNumber, imageName } = task;
    const publicImageUrl = `${RENDER_EXTERNAL_URL}/uploads/${imageName}`;
    const imagePath = path.join(UPLOADS_DIR, imageName);

    try {
        await axios.post(API_URL, { messaging_product: "whatsapp", to: recipientNumber, type: "template", template: { name: "hello_world", language: { code: "en_US" } } }, { headers: HEADERS });
        await delay(3000);
        await axios.post(API_URL, { messaging_product: "whatsapp", to: recipientNumber, type: "text", text: { body: "3" } }, { headers: HEADERS });
        await delay(3000);
        await axios.post(API_URL, { messaging_product: "whatsapp", to: recipientNumber, type: "image", image: { link: publicImageUrl } }, { headers: HEADERS });
        
        await pool.query('UPDATE envios SET estado = $1 WHERE id = $2', ['enviado_esperando_respuesta', envioId]);
    } catch (error) {
        await pool.query('UPDATE envios SET estado = $1 WHERE id = $2', ['fallido', envioId]);
        const errorMessage = error.response?.data?.error?.message || error.message;
        logAndEmit(`🚫 Falló envío a ${recipientNumber} con ${imageName}. Razón: ${errorMessage}`, 'log-error');
        // Si falla el envío, lanzamos el error para que processQueue lo capture y libere el proceso
        throw error;
    } finally {
         setTimeout(() => {
            fs.unlink(imagePath, (err) => {
                if (err) console.error(`No se pudo borrar la imagen ${imageName}:`, err);
            });
        }, 60000 * 10); // 10 minutos para dar tiempo de sobra
    }
}


// --- INICIO DEL SERVIDOR ---
server.listen(PORT, async () => {
    console.log(`🚀 Servidor iniciado. Escuchando en el puerto ${PORT}`);
    await initializeDatabase();
});
require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const axios = require('axios');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const { Pool } = require('pg');

// --- CONFIGURACIÓN ---
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;
const PORT = process.env.PORT || 3000;
const RENDER_EXTERNAL_URL = "https://server-2-ydpr.onrender.com";

// --- CONFIGURACIÓN DE LA BASE DE DATOS ---
const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// --- FUNCIÓN PARA INICIALIZAR LA BASE DE DATOS ---
async function initializeDatabase() {
    const client = await pool.connect();
    try {
        // Tabla para el historial de todos los envíos
        await client.query(`
            CREATE TABLE IF NOT EXISTS envios (
                id SERIAL PRIMARY KEY,
                numero_destino VARCHAR(255) NOT NULL,
                nombre_imagen VARCHAR(255),
                estado VARCHAR(50) DEFAULT 'enviado',
                creado_en TIMESTAMPTZ DEFAULT NOW()
            );
        `);
        // Tabla para guardar solo los números confirmados
        await client.query(`
            CREATE TABLE IF NOT EXISTS confirmados (
                id SERIAL PRIMARY KEY,
                numero_confirmado VARCHAR(255) NOT NULL UNIQUE,
                mensaje_confirmacion VARCHAR(255),
                confirmado_en TIMESTAMPTZ DEFAULT NOW()
            );
        `);
        console.log("✅ Tablas 'envios' y 'confirmados' verificadas y listas.");
    } catch (err) {
        console.error("❌ Error al inicializar la base de datos:", err);
    } finally {
        client.release();
    }
}

// --- PREPARACIÓN DE MULTER Y SISTEMA DE ARCHIVOS ---
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`)
});
const upload = multer({ storage: storage });

// --- INICIALIZACIÓN DE SERVIDORES ---
const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.json());

// --- LÓGICA DE SOCKET.IO ---
io.on('connection', (socket) => {
    console.log(`[Socket.IO] Un usuario se ha conectado al panel. ID: ${socket.id}`);
    
    // Escuchamos la petición para ver los confirmados
    socket.on('ver-confirmados', async () => {
        try {
            const result = await pool.query('SELECT numero_confirmado, mensaje_confirmacion, confirmado_en FROM confirmados ORDER BY confirmado_en DESC');
            // Enviamos los datos de vuelta solo al cliente que los pidió
            socket.emit('datos-confirmados', result.rows);
            console.log(`[DB] Se enviaron ${result.rowCount} registros confirmados al panel.`);
        } catch (dbError) {
            console.error("Error al obtener datos de confirmados:", dbError);
        }
    });
});

// --- ENDPOINTS DE EXPRESS ---
app.get('/panel', (req, res) => res.sendFile(path.join(__dirname, 'panel.html')));

app.post('/webhook', async (req, res) => {
    res.sendStatus(200); // Respondemos a Meta inmediatamente

    const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (message && message.type === 'text') {
        const from = message.from;
        const textBody = message.text.body.trim();
        
        console.log(`Mensaje de texto recibido de ${from}: "${textBody}"`);
        
        // Lógica de confirmación: ¿es un número de 3 dígitos?
        if (/^\d{3}$/.test(textBody)) {
            console.log(`¡CONFIRMACIÓN DETECTADA! El mensaje "${textBody}" es un número de 3 dígitos.`);
            try {
                // Insertamos en la tabla 'confirmados', ignorando si el número ya existe (ON CONFLICT DO NOTHING)
                await pool.query(
                    `INSERT INTO confirmados (numero_confirmado, mensaje_confirmacion) VALUES ($1, $2) ON CONFLICT (numero_confirmado) DO NOTHING`,
                    [from, textBody]
                );
                console.log(`[DB] Número ${from} guardado/ignorado en la tabla de confirmados.`);
                io.emit('nueva-respuesta', { from, text: `✅ CONFIRMADO con: ${textBody}` });
            } catch (dbError) {
                console.error("Error al guardar en la tabla de confirmados:", dbError);
            }
        } else {
            // Si no es una confirmación, solo lo mostramos en el panel
            io.emit('nueva-respuesta', { from, text: textBody });
        }
    } else if (message) {
        // Manejar otros tipos de mensajes si es necesario
        io.emit('nueva-respuesta', { from: message.from, text: `(Mensaje de tipo ${message.type})` });
    }
});

app.post('/iniciar-secuencia', upload.single('imageFile'), async (req, res) => {
    const { destinationNumber } = req.body;
    const imageFile = req.file;

    if (!destinationNumber || !imageFile) {
        return res.status(400).json({ message: "Faltan datos." });
    }

    try {
        const result = await pool.query(
            'INSERT INTO envios (numero_destino, nombre_imagen) VALUES ($1, $2) RETURNING id',
            [destinationNumber, imageFile.filename]
        );
        const envioId = result.rows[0].id;
        
        executeSendSequence(destinationNumber, imageFile, io, envioId);
        res.status(200).json({ message: "Solicitud recibida." });
    } catch (dbError) {
        console.error("Error al registrar el envío en la base de datos:", dbError);
        res.status(500).json({ message: "Error interno del servidor." });
    }
});

app.use('/uploads', express.static(UPLOADS_DIR));
app.get('/', (req, res) => res.send('¡Servidor activo! Visita /panel para usar el control.'));

// --- INICIO DEL SERVIDOR ---
server.listen(PORT, async () => {
    console.log(`🚀 Servidor iniciado. Escuchando en el puerto ${PORT}`);
    await initializeDatabase();
});

// --- FUNCIONES (sin cambios significativos) ---
const HEADERS = { 'Authorization': `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' };
const API_URL = `https://graph.facebook.com/v22.0/${PHONE_NUMBER_ID}/messages`;
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function executeSendSequence(recipientNumber, imageFile, socket, envioId) {
    const publicImageUrl = `${RENDER_EXTERNAL_URL}/uploads/${imageFile.filename}`;
    socket.emit('status-update', { text: `Enviando secuencia a ${recipientNumber}...`, isError: false });
    try {
        await axios.post(API_URL, { messaging_product: "whatsapp", to: recipientNumber, type: "template", template: { name: "hello_world", language: { code: "en_US" } } }, { headers: HEADERS });
        await delay(3000);
        await axios.post(API_URL, { messaging_product: "whatsapp", to: recipientNumber, type: "text", text: { body: "3" } }, { headers: HEADERS });
        await delay(3000);
        await axios.post(API_URL, { messaging_product: "whatsapp", to: recipientNumber, type: "image", image: { link: publicImageUrl } }, { headers: HEADERS });
        await pool.query('UPDATE envios SET estado = $1 WHERE id = $2', ['enviado', envioId]);
        socket.emit('status-update', { text: `✅ Secuencia enviada a ${recipientNumber}.`, isError: false, isComplete: true });
    } catch (error) {
        await pool.query('UPDATE envios SET estado = $1 WHERE id = $2', ['fallido', envioId]);
        socket.emit('status-update', { text: `🚫 Falló la secuencia para ${recipientNumber}.`, isError: true, isComplete: true });
    } finally {
        setTimeout(() => { fs.unlink(imageFile.path, () => {}); }, 60000);
    }
}
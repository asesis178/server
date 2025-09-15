require('dotenv').config();
const express = require('express');
const path = require('path');
const axios = require('axios');
const ngrok = require('ngrok');

// --- CONFIGURACIÓN ---
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const RECIPIENT_PHONE_NUMBER = "59892484684"; // Tu número de WhatsApp de destino

const LOCAL_IMAGE_FOLDER = 'public';
const LOCAL_IMAGE_FILENAME = 'cedula_ejemplo.jpg'; // <-- Asegúrate que este sea el nombre de tu imagen
const PORT = 3000;
const PAUSE_DURATION = 5000; // 5 segundos de pausa entre mensajes

// AÑADIMOS UNA PAUSA EXTRA LARGA AL FINAL PARA DAR TIEMPO A META
const FINAL_WAIT_TIME = 15000; // 15 segundos!

// --- FUNCIONES AUXILIARES ---
const API_URL = `https://graph.facebook.com/v22.0/${PHONE_NUMBER_ID}/messages`;
const HEADERS = { 'Authorization': `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' };
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function sendWhatsAppMessage(data) {
    try {
        await axios.post(API_URL, {
            messaging_product: "whatsapp",
            to: RECIPIENT_PHONE_NUMBER,
            ...data
        }, { headers: HEADERS });
        console.log(`✅ Mensaje de tipo '${data.type}' enviado con éxito.`);
    } catch (error) {
        console.error(`❌ Error al enviar mensaje de tipo '${data.type}':`);
        if (error.response && error.response.data) {
            console.error("Detalles del error de la API:", JSON.stringify(error.response.data, null, 2));
        } else {
            console.error("Error general:", error.message);
        }
        throw new Error("Fallo en el envío a la API de WhatsApp.");
    }
}

// --- FUNCIÓN PRINCIPAL Y AUTOMÁTICA ---
async function executeFullSequence() {
    console.log("🚀 Iniciando secuencia automática final...");

    const app = express();
    app.use('/static', express.static(path.join(__dirname, LOCAL_IMAGE_FOLDER)));
    const server = app.listen(PORT, () => console.log(`[Paso 1/4] Servidor local iniciado.`));

    let ngrokUrl = '';
    try {
        ngrokUrl = await ngrok.connect({ proto: 'http', addr: PORT, authtoken_from_env: true });
        console.log(`[Paso 2/4] Túnel de ngrok creado en: ${ngrokUrl}`);
        
        console.log("\n[Paso 3/4] Comenzando envío de la secuencia a WhatsApp...");

        // 1. Enviar Plantilla
        await sendWhatsAppMessage({
            type: "template",
            template: { name: "hello_world", language: { code: "en_US" } }
        });
        await delay(PAUSE_DURATION);

        // 2. Enviar Texto
        await sendWhatsAppMessage({
            type: "text",
            text: { body: "3" }
        });
        await delay(PAUSE_DURATION);

        // 3. Enviar Imagen Local
        const publicImageUrl = `${ngrokUrl}/static/${LOCAL_IMAGE_FILENAME}`;
        console.log(`\n--- Enviando orden para la imagen local: ${publicImageUrl} ---`);
        await sendWhatsAppMessage({
            type: "image",
            image: { link: publicImageUrl }
        });

        // --- PAUSA CRÍTICA AÑADIDA ---
        console.log(`\n[Paso 4/4] Orden enviada. Esperando ${FINAL_WAIT_TIME / 1000} segundos para que Meta descargue la imagen...`);
        await delay(FINAL_WAIT_TIME);
        
        console.log("\n¡Secuencia de mensajes completada!");

    } catch (error) {
        console.error("\n🚫 La secuencia fue interrumpida debido a un error.");
    } finally {
        // Este bloque ahora se ejecuta DESPUÉS de la larga espera.
        console.log("\nCerrando todas las conexiones...");
        if (ngrokUrl) await ngrok.disconnect(ngrokUrl);
        server.close();
        console.log("Proceso finalizado. 👋");
    }
}

// --- EJECUCIÓN ---
executeFullSequence();
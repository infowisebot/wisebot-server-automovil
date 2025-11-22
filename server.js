const express = require("express");
const fetch = require("node-fetch");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
require("dotenv").config();

let pdf; // declaramos la variable

// import dinámico compatible con Node 20+, Render y CommonJS
(async () => {
  const module = await import("pdf-parse/lib/pdf-parse.js");
  pdf = module.default;
})();

const app = express();
app.use(cors()); // habilita CORS para RN/Expo
app.use(express.json({ limit: "10mb" }));

const PORT = process.env.PORT || 5050;

// ==== NUEVO: PDF en memoria para inyectarlo como contexto simple ====
let KB_TEXT = "";
const MAX_CHARS = 50000; // ajusta si tu PDF es pequeño/grande

// ==== NUEVO: función para precargar PDF al iniciar (si KB_PDF_PATH está en .env) ====
async function preloadPDF(path) {
  try {
    const buf = fs.readFileSync(path);
    const parsed = await pdfParse(buf);
    KB_TEXT = (parsed.text || "")
      .replace(/\u0000/g, "")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    if (!KB_TEXT.length) {
      console.warn("⚠️ El PDF se cargó pero no tiene texto (¿falta OCR?).");
    } else {
      console.log(`📚 PDF precargado: ${KB_TEXT.length} chars desde ${path}`);
    }
  } catch (e) {
    console.error("❌ No se pudo precargar el PDF:", e.message);
  }
}

// subir PDF (campo 'file')
const uploadPdf = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 40 * 1024 * 1024 },
});
app.post("/kb/upload", uploadPdf.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Falta el archivo (campo 'file')." });
    const parsed = await pdfParse(req.file.buffer);
    KB_TEXT = (parsed.text || "")
      .replace(/\u0000/g, "")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    res.json({ ok: true, chars: KB_TEXT.length, preview: KB_TEXT.slice(0, 200) });
  } catch (e) {
    console.error("[/kb/upload] error:", e);
    res.status(500).json({ error: "Error al procesar el PDF" });
  }
});

app.get("/kb/status", (req, res) => {
  res.json({ loaded: KB_TEXT.length > 0, chars: KB_TEXT.length });
});

app.post("/kb/clear", (req, res) => {
  KB_TEXT = "";
  res.json({ ok: true });
});

/* ---------- CHAT ---------- */
app.post("/chat", async (req, res) => {
  try {
    const { messages } = req.body;

    // ==== NUEVO: inyectar el contenido del PDF como si lo pegaras en el prompt ====
    let augmented = messages;
    if (KB_TEXT) {
      const docBlock =
`[DOCUMENTO PDF]
${KB_TEXT.slice(0, MAX_CHARS)}

INSTRUCCIONES:
- Prioriza la información de este documento para responder.
- Si la pregunta no está cubierta en el documento, dilo claramente y sugiere hablar con el personal del museo.
- Mantén tono cercano y conciso.`;

      const first = messages?.[0];
      if (first?.role === "system") {
        augmented = [ first, { role: "system", content: docBlock }, ...messages.slice(1) ];
      } else {
        augmented = [ { role: "system", content: docBlock }, ...(messages || []) ];
      }
    }
    // ================================================================

    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: augmented,
      }),
    });

    if (!r.ok) {
      const err = await r.text();
      console.error("Chat error:", err);
      return res.status(500).json({ error: "Chat request failed" });
    }

    const data = await r.json();
    const content = data.choices?.[0]?.message?.content ?? "";
    res.json({ content });
  } catch (e) {
    console.error("Server error /chat:", e);
    res.status(500).json({ error: "Server error" });
  }
});

/* ---------- STT /transcribe (file multipart 'audio') ---------- */
const upload = multer({ limits: { fileSize: 25 * 1024 * 1024 } });
app.post("/transcribe", upload.single("audio"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No audio file" });

    // OpenAI Whisper v1 (form-data)
    const form = new (require("form-data"))();
    form.append("file", req.file.buffer, {
      filename: req.file.originalname || "audio.m4a",
      contentType: req.file.mimetype || "audio/mpeg",
    });
    form.append("model", "gpt-4o-mini-transcribe");

    const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: form,
    });

    if (!r.ok) {
      const err = await r.text();
      console.error("STT error:", err);
      return res.status(500).json({ error: "Transcription failed" });
    }

    const data = await r.json();
    res.json({ text: data.text || "" });
  } catch (e) {
    console.error("Server error /transcribe:", e);
    res.status(500).json({ error: "Server error" });
  }
});

/* ---------- TTS (compat) /tts ---------- */
app.post("/tts", async (req, res) => {
  try {
    const { text, voice = "alloy" } = req.body;

    const r = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini-tts",
        voice,
        input: text,
      }),
    });

    if (!r.ok) {
      const err = await r.text();
      console.error("TTS error:", err);
      return res.status(500).json({ error: "TTS request failed" });
    }

    const buffer = Buffer.from(await r.arrayBuffer());
    const base64 = buffer.toString("base64");
    res.json({ audio: base64, mime: "audio/mpeg" }); // respuesta original
  } catch (e) {
    console.error("Server error /tts:", e);
    res.status(500).json({ error: "Server error" });
  }
});

/* ---------- TTS (lo que espera tu app) /synthesize ---------- */
app.post("/synthesize", async (req, res) => {
  try {
    const { text, voice = "alloy" } = req.body;

    const r = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini-tts",
        voice,
        input: text,
      }),
    });

    if (!r.ok) {
      const err = await r.text();
      console.error("TTS(/synthesize) error:", err);
      return res.status(500).json({ error: "TTS request failed" });
    }

    const buffer = Buffer.from(await r.arrayBuffer());
    const base64 = buffer.toString("base64");
    // la app espera { base64, mime }
    res.json({ base64, mime: "audio/mpeg" });
  } catch (e) {
    console.error("Server error /synthesize:", e);
    res.status(500).json({ error: "Server error" });
  }
});

// ==== NUEVO: lanzar precarga si hay ruta en .env ====
if (process.env.KB_PDF_PATH) {
  preloadPDF(process.env.KB_PDF_PATH);
} else {
  console.log("ℹ️ Define KB_PDF_PATH en .env para precargar un PDF al iniciar.");
}

app.listen(PORT, () => {
  console.log(`🚀 WiseBot server running on http://localhost:${PORT}`);
});

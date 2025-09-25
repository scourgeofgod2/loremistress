require('dotenv').config();
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const fetch = require('node-fetch');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process'); // This line must correctly import 'exec'

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const textModel = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

const app = express();
const port = 3000;
app.use(express.json());
const corsOptions = { origin: 'http://127.0.0.1:5500' }; // Live Server portunuza göre ayarlayın
app.use(cors(corsOptions));
const upload = multer({ storage: multer.memoryStorage() });

const mainDownloadsDir = path.join(__dirname, 'downloads');
if (!fs.existsSync(mainDownloadsDir)){
    fs.mkdirSync(mainDownloadsDir);
}

// Güvenli dosya adı için bir fonksiyon
const sanitizeFilename = (name) => name.replace(/[^a-z0-9\s_-]/gi, '').trim().replace(/[\s_]+/g, '-');

app.post('/process-audio', upload.single('audioFile'), async (req, res) => {
    const { projectName } = req.body;
    if (!req.file || !projectName) return res.status(400).json({ error: "Ses dosyası ve proje adı gerekli." });

    console.log(`Proje '${projectName}' için ses dosyası alındı:`, req.file.originalname);
    const projectDir = path.join(mainDownloadsDir, sanitizeFilename(projectName));
    if (!fs.existsSync(projectDir)) fs.mkdirSync(projectDir, { recursive: true });

    const audioFileName = `audio${path.extname(req.file.originalname)}`;
    const audioFilePath = path.join(projectDir, audioFileName);
    fs.writeFileSync(audioFilePath, req.file.buffer);
    console.log(`Ses dosyası kaydedildi: ${audioFilePath}`);

    try {
        console.log('Adım 1: Ses deşifre ediliyor...');
        const audioBase64 = req.file.buffer.toString('base64');
        const transcribeResult = await textModel.generateContent({ contents: [{ parts: [{ text: "Transcribe this audio with [mm:ss] timestamps." }, { inlineData: { mimeType: req.file.mimetype, data: audioBase64 } }] }] });
        const timestampedTranscript = transcribeResult.response.text();
        console.log('Deşifre tamamlandı.');

        console.log('Adım 2: Metin analiz ediliyor (Bol Kepçe Modu)...');
        const systemInstruction = `
            You are "The Loremistress's Editing Assistant."
            This is a crucial instruction: First, analyze the FULL DURATION of the provided audio transcript.
            You must ensure your timestamps cover the ENTIRE audio duration from [00:00] to the very last second.
            DO NOT stop before the audio ends - your last timestamp must match the total audio length.

            Analyze the provided transcript with [mm:ss] timestamps.
            Your task is to identify ALL potential visual moments, even minor ones, and create a JSON array.
            Each object must contain:
            - "timestamp" (a string formatted as "[mm:ss-mm:ss]")
            - "scene_description" (a brief, 1-2 sentence summary)

            Important rules:
            1. The first timestamp MUST start at [00:00]
            2. The last timestamp MUST extend to the final second of the audio
            3. Do not leave any gaps between timestamps
            4. Each timestamp should logically connect to the next one

            Your entire response MUST be a raw JSON array. Do NOT use markdown.
        `;
        const analysisResult = await textModel.generateContent({ contents: [{ role: "user", parts: [{ text: systemInstruction }, { text: timestampedTranscript }] }] });
        let responseText = analysisResult.response.text();
        if (responseText.startsWith("```json")) responseText = responseText.substring(7, responseText.length - 3).trim();
        const rawShots = JSON.parse(responseText);
        console.log(`API Analizi ${rawShots.length} ham sahne üretti.`);

        // ----- ADIM 3: CERRAH OPERASYONU - SAHNELERİ BİRLEŞTİRME VE ELEME -----
        console.log('Adım 3: Sahne sayısı hedefe göre ayarlanıyor...');

        // Toplam süreyi son timestamp'ten al
        const lastShot = rawShots[rawShots.length - 1];
        const lastTimestamp = lastShot.timestamp.split('-')[1].replace(']', '');
        const [minutes, seconds] = lastTimestamp.split(':').map(Number);
        const totalDurationInSeconds = minutes * 60 + seconds;
        
        const targetShotCount = Math.floor((totalDurationInSeconds / 60) * 2.5);
        console.log(`Hedef sahne sayısı: ${targetShotCount}`);

        let mergedShots = rawShots.map(shot => {
            const [startStr, endStr] = shot.timestamp.replace(/[\[\]]/g, '').split('-');
            const [sm, ss] = startStr.split(':').map(Number);
            const [em, es] = endStr.split(':').map(Number);
            return {
                ...shot,
                start: sm * 60 + ss,
                end: em * 60 + es,
                duration: (em * 60 + es) - (sm * 60 + ss)
            };
        });

        // Sahne sayısı hedeften fazlaysa, en kısa olanları birleştirerek azalt
        while (mergedShots.length > targetShotCount && mergedShots.length > 1) {
            let shortestDuration = Infinity;
            let shortestIndex = -1;

            for (let i = 0; i < mergedShots.length; i++) {
                if (mergedShots[i].duration < shortestDuration) {
                    shortestDuration = mergedShots[i].duration;
                    shortestIndex = i;
                }
            }

            if (shortestIndex === 0) { // Eğer en kısa olan ilk sahneyse, sonrakiyle birleştir
                mergedShots[1].start = mergedShots[0].start;
                mergedShots[1].scene_description = mergedShots[0].scene_description + " " + mergedShots[1].scene_description;
                mergedShots.splice(0, 1);
            } else { // Değilse, bir öncekiyle birleştir
                mergedShots[shortestIndex - 1].end = mergedShots[shortestIndex].end;
                mergedShots[shortestIndex - 1].scene_description += " " + mergedShots[shortestIndex].scene_description;
                mergedShots.splice(shortestIndex, 1);
            }
            
            // Süreleri ve timestamp'leri yeniden hesapla
             mergedShots = mergedShots.map(shot => {
                const newDuration = shot.end - shot.start;
                const formatTime = (s) => `${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;
                return {
                    ...shot,
                    duration: newDuration,
                    timestamp: `[${formatTime(shot.start)}-${formatTime(shot.end)}]`
                };
            });
        }

        console.log(`Nihai sahne sayısı: ${mergedShots.length}`);
        res.json({ transcript: timestampedTranscript, shots: mergedShots });

    } catch (error) {
        console.error("İşlem sırasında bir hata oluştu:", error);
        res.status(500).json({ error: "Yapay zeka işleme sırasında bir hata oluştu: " + error.message });
    }
});

app.post('/generate-image', async (req, res) => {
    // timestamp'i de frontend'den alıyoruz
    const { prompt, index, projectName, timestamp } = req.body; 
    if (!prompt || index === undefined || !projectName || !timestamp) {
        return res.status(400).json({ error: 'Prompt, index, proje adı ve timestamp gerekli.' });
    }
    const fileNumber = parseInt(index) + 1;
    console.log(`'${projectName}' projesi için görsel üretiliyor (Sıra: ${fileNumber}, Zaman: ${timestamp})...`);

    const apiRequestBody = [{
        taskType: "imageInference",
        model: "rundiffusion:110@101",
        numberResults: 1,
        outputFormat: "JPEG",
        width: 1344,
        height: 768,
        steps: 4,
        CFGScale: 1,
        scheduler: "Euler Beta",
        includeCost: true,
        checkNSFW: true,
        outputType: ["URL"],
        lora: [
            {
                model: "civitai:671064@751244",
                weight: 1
            }
        ],
        outputQuality: 85,
        positivePrompt: prompt,
        taskUUID: uuidv4()
    }];

    try {
        const apiResponse = await fetch('https://api.runware.ai/v1', {
            method: 'POST',
            headers: {
                "Authorization": `Bearer ${process.env.RUNWARE_API_KEY}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify(apiRequestBody)
        });

        if (!apiResponse.ok) {
            const errorBody = await apiResponse.text();
            throw new Error(`Runware API hatası: ${apiResponse.statusText} - ${errorBody}`);
        }

        const responseData = await apiResponse.json();
        const imageUrl = responseData.data[0].imageURL;

        if (!imageUrl) throw new Error("Runware API cevabında 'imageURL' alanı bulunamadı.");
        console.log('Görsel başarıyla üretildi. URL:', imageUrl);

        console.log('Görsel locale indiriliyor...');
        const imageResponse = await axios({ method: 'get', url: imageUrl, responseType: 'stream' });
        
        const projectDir = path.join(mainDownloadsDir, sanitizeFilename(projectName));
        if (!fs.existsSync(projectDir)){
            fs.mkdirSync(projectDir, { recursive: true });
        }
        
        
       const safeTimestamp = timestamp.replace(/[\[\]:]/g, '').replace('-', '_'); // Çıktı: 0015_0017
        const fileName = `${fileNumber}-[${safeTimestamp}].jpg`; // Çıktı: 3-[0015_0017].jpg
        const localPath = path.join(projectDir, fileName);
        // ++++++++++++++++++++++++++++++++++++++++++++++
        
        const writer = fs.createWriteStream(localPath);
        imageResponse.data.pipe(writer);

        await new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
        });
        console.log(`Görsel başarıyla kaydedildi: ${localPath}`);

        res.json({ imageUrl: imageUrl, localFile: fileName });

    } catch (error) {
        console.error("Görsel üretme hatası:", error);
        res.status(500).json({ error: "Runware ile görsel üretme/kaydetme sırasında bir hata oluştu." });
    }
});

app.post('/create-video', (req, res) => {
    const { projectName, audioFileName } = req.body;
    if (!projectName || !audioFileName) return res.status(400).json({ error: "Proje adı ve ses dosyası adı gerekli." });

    console.log(`'${projectName}' projesi için video oluşturma isteği alındı.`);
    const projectDir = path.join(mainDownloadsDir, sanitizeFilename(projectName));
    const audioFilePath = path.join(projectDir, audioFileName);
    const outputVideoPath = path.join(projectDir, `${sanitizeFilename(projectName)}.mp4`);
    const filterFilePath = path.join(projectDir, 'filters.txt'); // Temporary file for the filter command

    try {
        const imageFiles = fs.readdirSync(projectDir).filter(f => f.endsWith('.jpg')).sort((a, b) => parseInt(a) - parseInt(b));
        if (imageFiles.length === 0) return res.status(400).json({ error: "Klasörde işlenecek görsel bulunamadı." });

        let inputs = `-i "${audioFilePath}" `;
        let filter_complex_content = ""; // Content for the filters.txt file
        let finalConcatStreams = "";

        imageFiles.forEach((file, index) => {
            const filePath = path.join(projectDir, file);
            inputs += `-loop 1 -i "${filePath}" `;
            
            const timeMatch = file.match(/\[(\d{4}_\d{4})\]/);
            if (!timeMatch) return;

            const [startStr, endStr] = timeMatch[1].split('_');
            const start = parseInt(startStr.substring(0, 2)) * 60 + parseInt(startStr.substring(2, 4));
            const end = parseInt(endStr.substring(0, 2)) * 60 + parseInt(endStr.substring(2, 4));
            const duration = end - start;
            if (duration <= 0) return;

            const videoStreamIndex = index + 1;
            filter_complex_content += 
                `[${videoStreamIndex}:v]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:-1:-1:color=black,setsar=1,` +
                `boxblur=luma_radius=1:luma_power=1,` +
                `eq=contrast=1.05:brightness=-0.02:saturation=0.95,` +
                `vignette=angle=PI/5,` +
                `fade=t=in:st=0:d=1,fade=t=out:st=${duration - 1}:d=1,` +
                `trim=duration=${duration}[stream${index}];\n`; // Use newline instead of semicolon for file
            
            finalConcatStreams += `[stream${index}]`;
        });
        
        filter_complex_content += `${finalConcatStreams}concat=n=${imageFiles.length}:v=1:a=0[vid]`;

        // Write the complex filter string to the temporary file
        fs.writeFileSync(filterFilePath, filter_complex_content);
        console.log('FFmpeg filtre dosyası oluşturuldu.');

        // The command now references the filter file, making it much shorter
        const ffmpegCommand = `ffmpeg -y ${inputs} -filter_complex_script "${filterFilePath}" -map "[vid]" -map 0:a -c:v libx264 -preset ultrafast -pix_fmt yuv420p -c:a aac -shortest "${outputVideoPath}"`;

        console.log("FFmpeg komutu (dosya ile) çalıştırılıyor...");
        exec(ffmpegCommand, (error, stdout, stderr) => {
            fs.unlinkSync(filterFilePath); // Clean up the temporary file

            if (error) {
                console.error(`FFmpeg hatası: ${error.message}`);
                console.error("FFmpeg Stderr:", stderr);
                return res.status(500).json({ error: "FFmpeg çalışırken bir hata oluştu.", details: stderr });
            }
            console.log(`Video başarıyla oluşturuldu: ${outputVideoPath}`);
            res.json({ message: "Video başarıyla oluşturuldu!", videoFile: `${sanitizeFilename(projectName)}.mp4` });
        });

    } catch (error) {
        console.error("Video oluşturma hatası:", error);
        res.status(500).json({ error: "Video oluşturma sırasında bir hata oluştu: " + error.message });
    }
});
app.listen(port, () => {
    console.log(`Loremistress Kurgu Asistanı sunucusu http://localhost:${port} adresinde çalışıyor`);
});
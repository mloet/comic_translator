import * as ort from "onnxruntime-web";
import Tesseract, { PSM } from 'tesseract.js';
import { Image as ImageJS } from 'image-js';
import { resizeImageData, nonMaxSuppression, calculateIoU, cropImageData, imageDataToDataURL, base64ToImageData, toGrayscale } from './utils.js';

// Global service settings
let serviceSettings = {
  googleApiKey: '',
  deeplApiKey: '',
  ocrService: 'tesseract',
  translationService: 'deepl',
  sourceLanguage: 'AUTO',
  targetLanguage: 'EN'
};

// ONNX model path, confidence threshold, and label mapping
let session = null;
const MODEL_PATH = chrome.runtime.getURL("models/comic_text_bubble_detector.onnx");
const bubbleConfidence = 0.8;
const id2label = {
  0: "bubble",
  1: "text_bubble",
  2: "text_free",
};

// DeepL language code -> Tesseract language code
const languageMapping = {
  'AUTO': 'eng', // Default to English for auto-detect
  'AR': 'ara',
  'BG': 'bul',
  'CS': 'ces',
  'DA': 'dan',
  'DE': 'deu',
  'EL': 'ell',
  'EN': 'eng',
  'ES': 'spa',
  'ET': 'est',
  'FI': 'fin',
  'FR': 'fra',
  'HU': 'hun',
  'ID': 'ind',
  'IT': 'ita',
  'JA': 'jpn',
  'KO': 'kor',
  'LT': 'lit',
  'LV': 'lav',
  'NB': 'nor',
  'NL': 'nld',
  'PL': 'pol',
  'PT': 'por',
  'RO': 'ron',
  'RU': 'rus',
  'SK': 'slk',
  'SL': 'slv',
  'SV': 'swe',
  'TR': 'tur',
  'UK': 'ukr',
  'ZH': 'chi_sim'
};

// Register listeners
if (!window.listenersRegistered) {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log("Offscreen received message:", message.action);

    if (message.action === "detectObjects") {
      // Check if service settings are included
      if (message.serviceSettings) {
        serviceSettings = message.serviceSettings;
        console.log("Using service settings:", serviceSettings);
      }
      detectObjects(message.imageData, message.requestId);
    }

    return false;
  });
  window.listenersRegistered = true;
}

// Load the ONNX model
async function loadModel() {
  if (!session) {
    try {
      console.log("Loading ONNX model from:", MODEL_PATH);
      session = await ort.InferenceSession.create(MODEL_PATH, {
        executionProviders: ["wasm"]
      });
      console.log("Model loaded successfully");
    } catch (error) {
      console.error("Error loading model:", error);
      throw error;
    }
  }
}

// Simple concurrency limiter
class ConcurrencyLimiter {
  constructor(maxConcurrent = 3) {
    this.maxConcurrent = maxConcurrent;
    this.running = 0;
    this.queue = [];
  }

  async run(fn) {
    if (this.running >= this.maxConcurrent) {
      // Queue the request
      return new Promise((resolve, reject) => {
        this.queue.push({ fn, resolve, reject });
      });
    }

    this.running++;
    try {
      return await fn();
    } finally {
      this.running--;
      this.processQueue();
    }
  }

  processQueue() {
    if (this.queue.length > 0 && this.running < this.maxConcurrent) {
      const { fn, resolve, reject } = this.queue.shift();
      this.run(fn).then(resolve, reject);
    }
  }
}

// Create a limiter instance
const ocrLimiter = new ConcurrencyLimiter(3);
const translationLimiter = new ConcurrencyLimiter(5);

// Initialize Tesseract worker
let workerPool = {}; // Language -> worker mapping

// Update initializeWorker to better handle concurrent requests
async function initializeWorker(lang = 'eng') {
  if (workerPool[lang]) {
    return workerPool[lang]; // Return existing worker for this language
  }

  console.log('Creating Tesseract worker with language:', lang);

  const worker = await Tesseract.createWorker(lang, 1, {
    corePath: 'local_libraries/tesseract/tesseract.js-core',
    workerPath: 'local_libraries/tesseract/dist/worker.min.js',
    workerBlobURL: false
  });

  await worker.setParameters({
    preserve_interword_spaces: '1',
    tessedit_char_blacklist: '*#$¥%£&©®<=>@[\\]^_`{|}~0123456789¢€₹₩₽₺±×÷∞≈≠…•§¶°†‡"‹›«»–—‒™℠µ←→↑↓↔↕☑☐☒★☆',
  });

  workerPool[lang] = worker;
  console.log('Tesseract worker created with language:', lang);
  return worker;
}

// Perform OCR using Tesseract.js
async function performTesseractOCR(imageData, classIndex, lang = 'eng') {
  let tesseract_worker = await initializeWorker(lang);

  const scaleFactor = 3; // Scale factor for resizing
  const resizedImage = resizeImageData(imageData,
    imageData.width * scaleFactor,
    imageData.height * scaleFactor);

  let processedSubsection = toGrayscale(resizedImage);

  // processedSubsection = processedSubsection.mask({ algorithm: 'otsu', threshold: 0.5 });

  const { data: { text, blocks } } = await tesseract_worker.recognize(
    imageDataToDataURL(processedSubsection),
    { tessedit_pageseg_mode: PSM.SINGLE_BLOCK },
    { blocks: true }
  );

  // console.log(processedSubsection.toDataURL());

  // console.log(blocks);
  // const lines = blocks.map((block) => block.paragraphs.map((paragraph) => paragraph.lines)).flat(2);

  const filteredBlocks = blocks.filter(block => block.confidence >= 40);

  if (filteredBlocks.length === 0) return { text: "", boxes: [], fontSize: 0 };

  let lineBoxes = [];
  let wordArray = [];
  let totalHeight = 0;
  let lineCount = 0;

  // const spellChecker = await getSpellChecker(lang);

  filteredBlocks.forEach(block => {
    block.paragraphs.forEach(paragraph => {
      paragraph.lines.forEach(line => {
        line.words.forEach(word => {
          if (word.confidence > 20) {
            let correctedWord = word.text;
            // if (word.confidence < 80) {
            //   correctedWord = spellChecker.correct(word.text)
            //     ? word.text
            //     : (spellChecker.suggest(word.text)[0] || word.text);
            // }
            wordArray.push(correctedWord);
          }
        });
        if (line.confidence > 60) {
          totalHeight += line.rowAttributes.rowHeight;
          lineCount++;
        }
        lineBoxes.push({
          lx1: line.bbox.x0 / scaleFactor,
          ly1: line.bbox.y0 / scaleFactor,
          lx2: line.bbox.x1 / scaleFactor,
          ly2: line.bbox.y1 / scaleFactor
        });
      });
    });
  });

  const fontSize = lineCount > 0 ? (totalHeight / lineCount) : (image.height / lineBoxes.length);

  return {
    text: text.trim().replace(/-\n+/g, '').replace(/\s+/g, ' ').toUpperCase(), boxes: lineBoxes, fontSize: fontSize / scaleFactor
  };
}

// Fetch OCR results from Google Cloud Vision API
async function performGoogleOCR(imageSrc) {
  const apiKey = serviceSettings.googleApiKey;
  if (!apiKey) {
    console.error('Google Cloud Vision API key is missing');
    return { blocks: [] };
  }

  try {
    const response = await fetch(`https://vision.googleapis.com/v1/images:annotate?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: [{
          image: { content: imageSrc.split(',')[1] },
          features: [{ type: 'DOCUMENT_TEXT_DETECTION' }]
        }]
      })
    });

    if (!response.ok) {
      throw new Error(`Google Cloud Vision API error: ${response.status} - ${response.statusText}`);
    }

    const data = await response.json();
    if (!data.responses || !data.responses[0] || !data.responses[0].fullTextAnnotation) {
      console.log('No text detected by Google Cloud Vision API');
      return { blocks: [] };
    }

    const blocks = data.responses[0].fullTextAnnotation.pages[0].blocks.map(block => {
      const blockVertices = block.boundingBox.vertices;

      // Extract words and their bounding boxes
      const words = block.paragraphs.flatMap(paragraph =>
        paragraph.words.map(word => ({
          text: word.symbols.map(symbol => symbol.text).join(''),
          boundingBox: word.boundingBox.vertices
        }))
      );

      // Calculate font size based on the average height of word bounding boxes
      const totalHeight = words.reduce((sum, word) => {
        const wordHeight = Math.abs(word.boundingBox[3].y - word.boundingBox[0].y);
        return sum + wordHeight;
      }, 0);
      const fontSize = words.length > 0 ? totalHeight / words.length : 0;
      console.log('Font size:', fontSize);

      console.log('words', words);
      // Combine block-level data
      return {
        text: words.map(word => word.text).join(' '), // Combine all words in the block
        boundingBox: blockVertices,
        fontSize,
        words
      };
    });

    return { blocks };
  } catch (error) {
    console.error('Error fetching Google Cloud Vision OCR results:', error);
    return { blocks: [] };
  }
}

// Translate text using Google Translate API
async function translateWithGoogle(text, forcedSourceLang = null, forcedTargetLang = null) {
  if (!text || text.trim() === '') {
    console.error('Translation error: Text is empty');
    return text;
  }

  const sourceLang = forcedSourceLang || serviceSettings.sourceLanguage;
  const targetLang = forcedTargetLang || serviceSettings.targetLanguage;
  const apiKey = serviceSettings.googleApiKey; // Use googleApiKey instead of apiKey

  if (!apiKey || (sourceLang === targetLang && sourceLang !== 'AUTO')) {
    console.log('Translation skipped: missing API key or same language');
    return text;
  }

  const googleSourceLang = sourceLang === 'AUTO' ? '' : sourceLang.toLowerCase();
  const googleTargetLang = targetLang.toLowerCase();

  try {
    const response = await fetch(`https://translation.googleapis.com/language/translate/v2?key=${apiKey}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        q: text,
        source: googleSourceLang || null,
        target: googleTargetLang,
        format: "text"
      }),
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();
    if (data.data && data.data.translations && data.data.translations.length > 0) {
      return data.data.translations[0].translatedText;
    } else {
      throw new Error('Invalid response structure from Google Translate API');
    }
  } catch (error) {
    console.error('Google Translation error:', error);
    return text;
  }
}

// Translate text using DeepL API
async function translateWithDeepL(text, forcedSourceLang = null, forcedTargetLang = null) {
  if (!text || text.trim() === '') {
    console.error('Translation error: Text is empty');
    return text;
  }

  const sourceLang = forcedSourceLang || serviceSettings.sourceLanguage;
  const targetLang = forcedTargetLang || serviceSettings.targetLanguage;
  const apiKey = serviceSettings.deeplApiKey;

  if (!apiKey || (sourceLang === targetLang && sourceLang !== 'AUTO')) {
    console.log('Translation skipped: missing API key or same language');
    return text;
  } else {
    console.log('Translation request payload:', {
      text,
      sourceLang,
      targetLang,
    });
  }

  console.log(apiKey, sourceLang, targetLang, text);
  try {
    const response = await fetch("https://api-free.deepl.com/v2/translate", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        auth_key: serviceSettings.deeplApiKey, // Replace with your DeepL API key
        text: text,
        source_lang: sourceLang.toUpperCase(),
        target_lang: targetLang.toUpperCase(),
      }),
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();
    return data.translations[0].text;
  } catch (error) {
    console.error('DeepL Translation error:', error);
    return text;
  }
}

// Translate text using the selected translation service
async function translateText(text, forcedSourceLang = null, forcedTargetLang = null) {
  return translationLimiter.run(async () => {
    const translationService = serviceSettings.translationService || 'deepl';

    if (translationService === 'deepl') {
      return translateWithDeepL(text, forcedSourceLang, forcedTargetLang);
    } else if (translationService === 'googleTranslate') {
      return translateWithGoogle(text, forcedSourceLang, forcedTargetLang);
    } else {
      console.error('Unknown translation service:', translationService);
      return text; // Return original text if service is somehow unknown
    }
  });
}

async function detectObjects(base64Image, requestId) {
  try {
    console.log("Processing image for detection");

    await loadModel();

    await initializeWorker(languageMapping[serviceSettings.sourceLanguage] || 'eng');

    // Convert base64 to image data
    const { imageData, width, height, img } = await base64ToImageData(base64Image);

    // Preprocess image
    const inputTensor = preprocessImage(imageData);

    // Run inference
    const outputs = await session.run({ pixel_values: inputTensor });

    // Process results
    const results = await postprocessOutput(outputs, width, height, imageData);
    console.log(`Found ${results.length} detections`);

    // Send results back
    chrome.runtime.sendMessage({
      action: "detectionResults",
      results: results,
      requestId: requestId
    });

  } catch (error) {
    console.error("Detection error:", error);
    chrome.runtime.sendMessage({
      action: "detectionResults",
      error: error.message,
      requestId: requestId
    });
  }
}

// Preprocess the image for the model
function preprocessImage(imageData) {
  const targetWidth = 640;
  const targetHeight = 640;

  // Resize imageData
  const resizedImageData = resizeImageData(imageData, targetWidth, targetHeight);
  const data = resizedImageData.data;

  // Preprocessing parameters from preprocessor_config.json
  const imageMean = [0.485, 0.456, 0.406];
  const imageStd = [0.229, 0.224, 0.225];
  const rescaleFactor = 1 / 255.0;

  // Create a Float32Array for the input tensor
  const inputTensor = new Float32Array(3 * targetWidth * targetHeight);

  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    // Normalize and rescale pixel values
    const r = data[i] * rescaleFactor;
    const g = data[i + 1] * rescaleFactor;
    const b = data[i + 2] * rescaleFactor;

    inputTensor[j] = (r - imageMean[0]) / imageStd[0]; // Red channel
    inputTensor[j + targetWidth * targetHeight] = (g - imageMean[1]) / imageStd[1]; // Green channel
    inputTensor[j + 2 * targetWidth * targetHeight] = (b - imageMean[2]) / imageStd[2]; // Blue channel
  }

  return new ort.Tensor('float32', inputTensor, [1, 3, targetHeight, targetWidth]);
}

// Postprocess the model output
async function postprocessOutput(outputs, originalWidth, originalHeight, imageData) {
  const logits = outputs.logits.data; // Classification logits
  const predBoxes = outputs.pred_boxes.data; // Bounding box predictions
  const numQueries = outputs.logits.dims[1]; // Number of object queries
  const numClasses = outputs.logits.dims[2]; // Number of classes (bubble, text_bubble, text_free)
  const detections = [];

  for (let i = 0; i < numQueries; i++) {
    // Extract class scores and bounding box
    const classScores = logits.slice(i * numClasses, (i + 1) * numClasses);
    const bbox = predBoxes.slice(i * 4, (i + 1) * 4);

    // Find the class with the highest score
    const maxScore = Math.max(...classScores);
    const classIndex = classScores.indexOf(maxScore);

    // Filter out low-confidence detections
    if (maxScore < bubbleConfidence || classIndex === 0) continue;

    // Convert bounding box from normalized [cx, cy, w, h] to [x1, y1, x2, y2]
    const cx = bbox[0] * originalWidth;
    const cy = bbox[1] * originalHeight;
    const w = bbox[2] * originalWidth;
    const h = bbox[3] * originalHeight;
    const x1 = cx - w / 2;
    const y1 = cy - h / 2;
    const x2 = cx + w / 2;
    const y2 = cy + h / 2;

    detections.push({
      x1,
      y1,
      x2,
      y2,
      confidence: maxScore,
      classIndex,
    });
  }

  // Perform non-max suppression to filter overlapping boxes
  const filteredDetections = nonMaxSuppression(detections, 0.5);

  // Perform OCR on the entire image using Google OCR
  let googleResults = null;
  if (serviceSettings.ocrService === 'googleCloudVision') {
    const base64Image = imageDataToDataURL(imageData);
    googleResults = await performGoogleOCR(base64Image);
  }

  // Perform OCR on the detected regions
  for (const detection of filteredDetections) {
    const { x1, y1, x2, y2, classIndex } = detection;

    try {
      if (serviceSettings.ocrService === 'googleCloudVision') {
        const wordsInDetection = googleResults.blocks.flatMap(block =>
          block.words.filter(word => {
            const wordBox = word.boundingBox;
            const wordX1 = wordBox[0].x;
            const wordY1 = wordBox[0].y;
            const wordX2 = wordBox[2].x;
            const wordY2 = wordBox[2].y;

            // Check if the word's bounding box is within the detection's bounding box
            return (
              wordX1 >= x1 && wordY1 >= y1 &&
              wordX2 <= x2 && wordY2 <= y2
            );
          })
        );

        console.log('wordsInDetection', wordsInDetection);

        const sortedWords = wordsInDetection.sort((a, b) => {
          const aCenterY = (a.boundingBox[0].y + a.boundingBox[2].y) / 2;
          const bCenterY = (b.boundingBox[0].y + b.boundingBox[2].y) / 2;
          const lineThreshold = Math.min(
            a.boundingBox[3].y - a.boundingBox[0].y,
            b.boundingBox[3].y - b.boundingBox[0].y
          ) * 0.5;

          if (Math.abs(aCenterY - bCenterY) < lineThreshold) {
            const aCenterX = (a.boundingBox[0].x + a.boundingBox[2].x) / 2;
            const bCenterX = (b.boundingBox[0].x + b.boundingBox[2].x) / 2;
            return aCenterX - bCenterX;
          }
          return aCenterY - bCenterY;
        });

        // Calculate font size based on the average height of the words' bounding boxes
        const totalHeight = sortedWords.reduce((sum, word) => {
          const wordHeight = Math.abs(word.boundingBox[3].y - word.boundingBox[0].y);
          return sum + wordHeight;
        }, 0);

        detection.fontSize = sortedWords.length > 0 ? totalHeight / sortedWords.length : 0;
        detection.words = sortedWords;
        detection.text = sortedWords.map(word => word.text).join(' ') || '';
      } else if (serviceSettings.ocrService === 'tesseract') {
        const w = x2 - x1;
        const h = y2 - y1;
        const subsection = cropImageData(imageData, Math.max(0, x1), Math.max(0, y1),
          Math.min(w, originalWidth - x1),
          Math.min(h, originalHeight - y1));

        const ocrResults = await performTesseractOCR(subsection, classIndex);
        detection.boxes = ocrResults.boxes;
        detection.fontSize = ocrResults.fontSize;
        detection.text = ocrResults.text || '';
      }

      if (detection.text) {
        detection.translatedText = await translateText(detection.text, serviceSettings.sourceLanguage, serviceSettings.targetLanguage);
        detection.translatedText = detection.translatedText.toUpperCase(); // Convert to uppercase
      } else {
        detection.translatedText = '';
      }
    } catch (error) {
      console.error('Error processing detection:', error);
      detection.translatedText = detection.text || '';
    }
  }

  return filteredDetections;
}




// async function translateText(text, sourceLang, targetLang) {
//   return new Promise((resolve, reject) => {
//     chrome.runtime.sendMessage(
//       {
//         action: "translateText",
//         text,
//         sourceLang: sourceLang || serviceSettings.sourceLanguage,
//         targetLang: targetLang || serviceSettings.targetLanguage,
//       },
//       (response) => {
//         if (response.error) {
//           reject(new Error(response.error));
//         } else {
//           resolve(response.translatedText);
//         }
//       }
//     );
//   });
// }

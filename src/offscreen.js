import * as ort from "onnxruntime-web";
import Tesseract, { PSM } from 'tesseract.js';
import { Image as ImageJS } from 'image-js';
// import nspell from 'nspell';
// import dictionaryEn from 'dictionary-en';
// import dictionaryFr from 'dictionary-fr';
// import dictionaryEs from 'dictionary-es';


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

// Tesseract worker
// let tesseract_worker = null;

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
    corePath: 'local_tesseract/tesseract.js-core',
    workerPath: 'local_tesseract/worker.min.js',
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

// Perform radial blur on edges using elliptical gradient
function blurEdgesWithGradient(image, blurRadius = 10) {
  // Convert to greyscale if needed
  let processedSubsection = image.colorModel === 'GREY' ? image.clone() : image.grey();

  // Create a blurred version of the entire image
  const blurredImage = processedSubsection.blurFilter({ radius: blurRadius });

  // Calculate the dimensions for the elliptical gradient
  const centerX = Math.floor(processedSubsection.width / 2);
  const centerY = Math.floor(processedSubsection.height / 2);
  // Increase these values to push the blur closer to the edges (max value around 0.9)
  const radiusX = Math.floor(processedSubsection.width * 1);  // Changed from 0.45 to 0.8
  const radiusY = Math.floor(processedSubsection.height * 1); // Changed from 0.45 to 0.8

  // Create a gradient mask with the same dimensions as our image
  const gradientMask = new ImageJS(processedSubsection.width, processedSubsection.height, {
    kind: 'GREY'
  });

  // Fill the gradient mask with values based on distance from center
  for (let y = 0; y < gradientMask.height; y++) {
    for (let x = 0; x < gradientMask.width; x++) {
      // Calculate normalized distance from center (0 to 1+)
      const normalizedDistance =
        Math.sqrt(
          Math.pow(x - centerX, 2) / Math.pow(radiusX, 2) +
          Math.pow(y - centerY, 2) / Math.pow(radiusY, 2)
        );

      let maskValue = 0;
      if (normalizedDistance <= 1) {
        const transitionPower = 2;
        maskValue = Math.pow(Math.cos(normalizedDistance * Math.PI / 2), transitionPower);
      }

      // Set the mask value (scaled to image bit depth)
      const scaledValue = Math.round(maskValue * gradientMask.maxValue);
      gradientMask.setValueXY(x, y, 0, scaledValue);
    }
  }

  // Create a result image to hold our combined result
  const result = processedSubsection.clone();

  // Combine the original image and the blurred image based on the gradient mask
  for (let y = 0; y < result.height; y++) {
    for (let x = 0; x < result.width; x++) {
      // Get the mask value (normalized to [0,1])
      const maskValue = gradientMask.getValueXY(x, y, 0) / gradientMask.maxValue;

      for (let c = 0; c < result.channels; c++) {
        // Linear interpolation between original and blurred image
        const originalValue = processedSubsection.getValueXY(x, y, c);
        const blurredValue = blurredImage.getValueXY(x, y, c);
        const blendedValue = Math.round(
          originalValue * maskValue + blurredValue * (1 - maskValue)
        );

        result.setValueXY(x, y, c, blendedValue);
      }
    }
  }

  return result;
}

// Perform OCR using Tesseract.js
async function performTesseractOCR(image, classIndex, scaleFactor, lang = 'eng') {
  let tesseract_worker = await initializeWorker(lang);

  let processedSubsection = image.grey();

  processedSubsection = blurEdgesWithGradient(processedSubsection, 10);

  // processedSubsection = processedSubsection.mask({ algorithm: 'otsu', threshold: 0.5 });


  const { data: { text, blocks } } = await tesseract_worker.recognize(
    processedSubsection.toDataURL(),
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

  const correctedText = wordArray.join(' ')

  console.log(text);
  console.log(correctedText);

  const fontSize = lineCount > 0 ? (totalHeight / lineCount) : (image.height / lineBoxes.length);

  return { text, boxes: lineBoxes, fontSize };
}

// Fetch OCR results from Google Cloud Vision API
async function performGoogleOCR(imageSrc) {
  const apiKey = serviceSettings.googleApiKey;
  if (!apiKey) {
    console.error('Google Cloud Vision API key is missing');
    return { text: '', blocks: [], fontSize: null };
  }

  try {
    const response = await fetch(`https://vision.googleapis.com/v1/images:annotate?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: [{
          image: { content: imageSrc.split(',')[1] },
          features: [{ type: 'TEXT_DETECTION' }]
        }]
      })
    });

    if (!response.ok) {
      throw new Error(`Google Cloud Vision API error: ${response.status} - ${response.statusText}`);
    }

    const data = await response.json();
    if (!data.responses || !data.responses[0] || !data.responses[0].textAnnotations) {
      console.log('No text detected by Google Cloud Vision API');
      return { text: '', blocks: [], fontSize: null };
    }

    const textAnnotations = data.responses[0].textAnnotations;
    const text = textAnnotations[0].description;
    const blocks = textAnnotations.slice(1).map(annotation => ({
      text: annotation.description,
      boundingBox: annotation.boundingPoly.vertices
    }));

    // Estimate font size based on bounding box heights
    const heights = blocks.map(block => {
      const vertices = block.boundingBox;
      return Math.abs(vertices[3].y - vertices[0].y); // Height of the bounding box
    });
    const fontSize = heights.length > 0 ? heights.reduce((a, b) => a + b, 0) / heights.length : null;

    return { text, blocks, fontSize };
  } catch (error) {
    console.error('Error fetching Google Cloud Vision OCR results:', error);
    return { text: '', blocks: [], fontSize: null };
  }
}

async function performOCR(image, classIndex) {
  return ocrLimiter.run(async () => {
    const scaleFactor = 3; // Scale factor for resizing
    const resizedImage = image.resize({
      factor: scaleFactor,
    });

    let ocrResults = { text: '', blocks: [] };

    if (serviceSettings.ocrService === 'google') {
      ocrResults = await performGoogleOCR(resizedImage.toDataURL());
    } else {
      ocrResults = await performTesseractOCR(resizedImage, classIndex, scaleFactor, languageMapping[serviceSettings.sourceLanguage] || 'eng');
    }

    // Process OCR results
    const processedText = ocrResults.text.trim().replace(/-\n+/g, '').replace(/\s+/g, ' ').toUpperCase();

    return { text: processedText, boxes: ocrResults.boxes, fontSize: Math.min(ocrResults.fontSize, 40) / scaleFactor };
  });
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
  }

  console.log(apiKey, sourceLang, targetLang, text);
  try {
    const response = await fetch("https://api-free.deepl.com/v2/translate", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        auth_key: apiKey,
        text: text,
        source_lang: sourceLang === 'AUTO' ? '' : sourceLang.toUpperCase(),
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

// Main object detection function
async function detectObjects(base64Image, requestId) {
  try {
    console.log("Processing image for detection");

    await loadModel();

    if (serviceSettings.ocrService === 'tesseract') await initializeWorker(languageMapping[serviceSettings.sourceLanguage] || 'eng');

    // Convert base64 to image data
    const { imageData, width, height, img } = await base64ToImageData(base64Image);

    // Preprocess image
    const inputTensor = preprocessImage(img);

    // Run inference
    const outputs = await session.run({ pixel_values: inputTensor });

    // Process results
    const results = await postprocessOutput(outputs, width, height, img);
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

// Helper functions

// Convert base64 image to ImageData
async function base64ToImageData(base64Image) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = function () {
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const imageData = ctx.getImageData(0, 0, img.width, img.height);
      resolve({ imageData, width: img.width, height: img.height, img });
    };
    img.onerror = reject;
    img.src = base64Image;
  });
}

// Preprocess the image for the model
function preprocessImage(img) {
  const targetWidth = 640;
  const targetHeight = 640;

  // Create a canvas to resize the image
  const canvas = document.createElement('canvas');
  canvas.width = targetWidth;
  canvas.height = targetHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, targetWidth, targetHeight);

  // Get image data
  const imageData = ctx.getImageData(0, 0, targetWidth, targetHeight);
  const data = imageData.data;

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

async function postprocessOutput(outputs, originalWidth, originalHeight, img) {
  const image = await ImageJS.load(img.src);
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

  // Perform OCR on the detected regions
  for (const detection of filteredDetections) {
    const { x1, y1, x2, y2, classIndex } = detection;
    const w = x2 - x1;
    const h = y2 - y1;
    const subsection = image.crop({
      x: Math.max(0, x1),
      y: Math.max(0, y1),
      width: Math.min(w, image.width - x1),
      height: Math.min(h, image.height - y1),
    });

    try {
      const ocrResults = await performOCR(subsection, classIndex);
      detection.boxes = ocrResults.boxes;
      detection.fontSize = ocrResults.fontSize;
      detection.translatedText = await translateText(ocrResults.text, serviceSettings.sourceLanguage, serviceSettings.targetLanguage);
    } catch (error) {
      console.error('Error processing OCR or translation:', error);
      detection.boxes = [];
      detection.fontSize = 0;
      detection.translatedText = '';
    }
  }
  return filteredDetections;
}

function calculateIoU(box1, box2) {
  const x1 = Math.max(box1.x1, box2.x1);
  const y1 = Math.max(box1.y1, box2.y1);
  const x2 = Math.min(box1.x2, box2.x2);
  const y2 = Math.min(box1.y2, box2.y2);

  const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const box1Area = (box1.x2 - box1.x1) * (box1.y2 - box1.y1);
  const box2Area = (box2.x2 - box2.x1) * (box2.y2 - box2.y1);

  return intersection / (box1Area + box2Area - intersection);
}

function nonMaxSuppression(detections, iouThreshold) {
  detections.sort((a, b) => b.confidence - a.confidence);
  const finalDetections = [];

  while (detections.length > 0) {
    const best = detections.shift();
    finalDetections.push(best);
    detections = detections.filter(box => calculateIoU(best, box) < iouThreshold);
  }

  return finalDetections;
}
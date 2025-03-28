import * as ort from "onnxruntime-web";
import Tesseract from 'tesseract.js';
import { Image as ImageJS } from 'image-js';

const MODEL_PATH = chrome.runtime.getURL("models/comic_text_bubble_detector.onnx");
const bubbleConfidence = 0.8;

// Load the ONNX model
let session = null;
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

const languageMapping = {
  // DeepL language code -> Tesseract language code
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

// Initialize Tesseract worker
let tesseract_worker = null;
async function initializeWorker(lang = 'eng') {
  if (tesseract_worker) {
    // If worker exists with a different language, terminate it
    const currentLanguage = tesseract_worker.lang;
    if (currentLanguage !== lang) {
      console.log(`Switching Tesseract language from ${currentLanguage} to ${lang}`);
      await tesseract_worker.terminate();
      tesseract_worker = null;
    } else {
      return tesseract_worker; // Return existing worker if language is the same
    }
  }

  console.log('Creating Tesseract worker with language:', lang);

  tesseract_worker = await Tesseract.createWorker(lang, 1, {
    corePath: 'local_tesseract/tesseract.js-core',
    workerPath: 'local_tesseract/worker.min.js',
    workerBlobURL: false
  });

  await tesseract_worker.setParameters({
    preserve_interword_spaces: '1',
    tessedit_char_blacklist: '#$¥%£&®<=>@[\\]^_`{|}~0123456789',
    psm: 6
  });

  console.log('Tesseract worker created with language:', lang);
  return tesseract_worker;
}

async function fetchGoogleCloudVisionOCR(base64Image) {
  const apiKey = serviceSettings.apiKey;
  if (!apiKey) {
    console.error('Google Cloud Vision API key is missing');
    return '';
  }

  try {
    const response = await fetch(`https://vision.googleapis.com/v1/images:annotate?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: [{
          image: { content: base64Image.split(',')[1] },
          features: [{ type: 'TEXT_DETECTION' }]
        }]
      })
    });

    if (!response.ok) {
      throw new Error(`Google Cloud Vision API error: ${response.status} - ${response.statusText}`);
    }

    const data = await response.json();

    // More robust check for text annotations
    if (!data.responses || !data.responses[0] || !data.responses[0].textAnnotations ||
      !data.responses[0].textAnnotations[0]) {
      console.log('No text detected by Google Cloud Vision API');
      return '';
    }

    return data.responses[0].textAnnotations[0].description;
  } catch (error) {
    console.error('Error fetching Google Cloud Vision OCR results:', error);
    return ''; // Consider returning an error flag or object instead
  }
}

// Global service settings
let serviceSettings = {
  apiKey: '',
  ocrService: 'tesseract', // Default to tesseract
  translationService: 'deepl',
  sourceLanguage: 'AUTO',
  targetLanguage: 'EN'
};

async function translateWithGoogleAPI(text, forcedSourceLang = null, forcedTargetLang = null) {
  if (!text || text.trim() === '') {
    console.error('Translation error: Text is empty');
    return text; // Return the original text
  }

  // Use provided languages or fall back to global settings
  const sourceLang = forcedSourceLang || serviceSettings.sourceLanguage;
  const targetLang = forcedTargetLang || serviceSettings.targetLanguage;
  const apiKey = serviceSettings.apiKey;

  // Skip translation if API key is missing or languages are the same
  if (!apiKey || (sourceLang === targetLang && sourceLang !== 'AUTO')) {
    console.log('Translation skipped: missing API key or same language');
    return text;
  }

  // Convert language codes to Google Translate format
  const googleSourceLang = sourceLang === 'AUTO' ? '' : sourceLang.toLowerCase();
  const googleTargetLang = targetLang.toLowerCase();

  console.log('Google Translation request:', {
    text,
    sourceLang: googleSourceLang || 'auto',
    targetLang: googleTargetLang,
  });

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
    return text; // Fallback to the original text if translation fails
  }
}

async function translateWithDeepL(text, forcedSourceLang = null, forcedTargetLang = null) {
  if (!text || text.trim() === '') {
    console.error('Translation error: Text is empty');
    return text; // Return the original text
  }

  // Use provided languages or fall back to global settings
  const sourceLang = forcedSourceLang || serviceSettings.sourceLanguage;
  const targetLang = forcedTargetLang || serviceSettings.targetLanguage;
  const apiKey = serviceSettings.apiKey;

  // Skip translation if API key is missing or languages are the same
  if (!apiKey || (sourceLang === targetLang && sourceLang !== 'AUTO')) {
    console.log('Translation skipped: missing API key or same language');
    return text;
  }

  console.log('DeepL Translation request:', {
    text,
    sourceLang,
    targetLang,
  });

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
    return data.translations[0].text; // Extract the translated text
  } catch (error) {
    console.error('DeepL Translation error:', error);
    return text; // Fallback to the original text if translation fails
  }
}

async function translateText(text, forcedSourceLang = null, forcedTargetLang = null) {
  // Use the selected translation service
  const translationService = serviceSettings.translationService || 'deepl';

  if (translationService === 'deepl') {
    return translateWithDeepL(text, forcedSourceLang, forcedTargetLang);
  } else if (translationService === 'googleTranslate') {
    return translateWithGoogleAPI(text, forcedSourceLang, forcedTargetLang);
  } else {
    console.error('Unknown translation service:', translationService);
    return text; // Return original text if service is unknown
  }
}

if (!window.listenerRegistered) {
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

    if (message.action === "updateserviceSettings") {
      serviceSettings = message.settings;
      console.log("Updated service settings:", serviceSettings);
      console.log("Source language set to:", serviceSettings.sourceLanguage);
      console.log("OCR service set to:", serviceSettings.ocrService);
    }

    return false;
  });
  window.listenerRegistered = true;
}

// Main object detection function
async function detectObjects(base64Image, requestId) {
  try {
    console.log("Processing image for detection");

    await loadModel();

    if (serviceSettings.ocrService === 'tesseract') {
      tesseract_worker = await initializeWorker(languageMapping[serviceSettings.sourceLanguage] || 'eng');
    }

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

const id2label = {
  0: "bubble",
  1: "text_bubble",
  2: "text_free",
};

async function postprocessOutput(outputs, originalWidth, originalHeight, img) {
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
      classLabel: id2label[classIndex],
    });
  }

  // Perform non-max suppression to filter overlapping boxes
  const filteredDetections = nonMaxSuppression(detections, 0.5);

  // Perform OCR on the detected regions
  for (const detection of filteredDetections) {
    const { x1, y1, x2, y2, classIndex } = detection;
    const w = x2 - x1;
    const h = y2 - y1;
    let w2 = w * 4;
    let h2 = h * 3;

    const subsectionImg = await preprocessSubsection(img, x1, y1, w, h, w2, h2, classIndex);

    try {
      const ocrService = serviceSettings.ocrService || 'tesseract';
      if (ocrService === 'tesseract') {
        // Use Tesseract for OCR
        const { data: { text, blocks } } = await tesseract_worker.recognize(subsectionImg.src, {}, { blocks: true });
        detection.text = text.trim().replace(/-\n+/g, '').replace(/\s+/g, ' ').toUpperCase();
      } else if (ocrService === 'googleCloudVision') {
        // Use Google Cloud Vision API for OCR
        const visionResults = await fetchGoogleCloudVisionOCR(subsectionImg.src);
        detection.text = visionResults.trim().replace(/-\n+/g, '').replace(/\s+/g, ' ').toUpperCase();
      }
    } catch (error) {
      console.error('Error recognizing text:', error);
      detection.text = ''; // Fallback to empty text
      continue;
    }

    detection.translatedText = await translateText(detection.text, serviceSettings.sourceLanguage, serviceSettings.targetLanguage).toUpperCase();;
    console.log(detection.translatedText);
    detection.subsectionImg = subsectionImg.src;
  }

  return filteredDetections;
}

async function preprocessSubsection(img, x, y, w, h, targetWidth, targetHeight, classIndex) {
  // Load the image using ImageJS
  const image = await ImageJS.load(img.src);

  // Extract the subsection
  const subsection = image.crop({
    x: Math.max(0, x),
    y: Math.max(0, y),
    width: Math.min(w, image.width - x),
    height: Math.min(h, image.height - y),
  });

  const resizedSubsection = subsection.resize({
    width: targetWidth,
    height: targetHeight,
    preserveAspectRatio: true,
  });

  // Apply different processing based on text type
  let processedSubsection;

  if (classIndex == 2) { // text_free class
    console.log('text_free')
    processedSubsection = resizedSubsection.grey();
    processedSubsection = processedSubsection.gaussianFilter({ radius: 6 });
    // processedSubsection = processedSubsection.mask(processedSubsection.getThreshold());
    processedSubsection = processedSubsection.dilate({ iterations: 2 });
  } else {
    console.log('bubble')
    processedSubsection = resizedSubsection.grey();
    processedSubsection = processedSubsection.mask(processedSubsection.getThreshold());
  }
  // logImageForDebug(processedSubsection, 'Processed Subsection');

  // Convert the resized subsection to a data URL
  const subsectionImg = new Image();
  subsectionImg.src = processedSubsection.toDataURL();


  return subsectionImg;
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
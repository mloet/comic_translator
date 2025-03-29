import * as ort from "onnxruntime-web";
import Tesseract from 'tesseract.js';
import { Image as ImageJS } from 'image-js';

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
let tesseract_worker = null;

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

// Initialize Tesseract worker
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
    tessedit_char_blacklist: '#$¥%£&©®<=>@[\\]^_`{|}~0123456789¢€₹₩₽₺±×÷∞≈≠…•§¶°†‡‘’“”‹›«»–—‒™℠µ←→↑↓↔↕☑☐☒★☆',
    psm: 6
  });

  console.log('Tesseract worker created with language:', lang);
  return tesseract_worker;
}

// Perform OCR using Tesseract.js
async function performTesseractOCR(imageSrc, lang = 'eng') {
  if (!tesseract_worker) {
    tesseract_worker = await initializeWorker(lang);
  }

  try {
    const { data: { text, blocks } } = await tesseract_worker.recognize(imageSrc, {}, { blocks: true });
    return { text, blocks };
  } catch (error) {
    console.error('Error performing OCR:', error);
    return { text: '', blocks: [] };
  }
}

// Fetch OCR results from Google Cloud Vision API
async function performGoogleOCR(imageSrc) {
  const apiKey = serviceSettings.googleApiKey;
  if (!apiKey) {
    console.error('Google Cloud Vision API key is missing');
    return { text: '', blocks: [] };
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
      return { text: '', blocks: [] };
    }

    const textAnnotations = data.responses[0].textAnnotations;
    const text = textAnnotations[0].description;
    const blocks = textAnnotations.slice(1).map(annotation => ({
      text: annotation.description,
      boundingBox: annotation.boundingPoly.vertices
    }));

    return { text, blocks };
  } catch (error) {
    console.error('Error fetching Google Cloud Vision OCR results:', error);
    return { text: '', blocks: [] };
  }
}

// Estimate font size based on OCR results
function estimateFontSize(blocks) {
  if (!blocks || blocks.length === 0) {
    console.warn('No blocks provided for font size estimation.');
    return 0;
  }

  let totalHeight = 0;
  let lineCount = 0;

  blocks.forEach(block => {
    if (block.paragraphs) {
      block.paragraphs.forEach(paragraph => {
        if (paragraph.lines) {
          paragraph.lines.forEach(line => {
            if (line.confidence > 70) {
              totalHeight += line.rowAttributes.rowHeight;
              lineCount++;
            }
          });
        }
      });
    }
  });

  if (lineCount === 0) {
    console.warn('No lines found for font size estimation.');
    return 0;
  }

  const averageFontSize = totalHeight / lineCount; // Average height of lines as font size
  // console.log(`Estimated font size: ${averageFontSize}`);
  return averageFontSize;
}

async function performOCR(imageSrc, classIndex) {
  const ocrService = serviceSettings.ocrService || 'tesseract';
  let ocrResults = { text: '', blocks: [] };

  if (ocrService === 'tesseract') {
    ocrResults = await performTesseractOCR(imageSrc, languageMapping[serviceSettings.sourceLanguage] || 'eng');
  } else if (ocrService === 'googleCloudVision') {
    ocrResults = await performGoogleOCR(imageSrc);
  } else {
    console.error('Unsupported OCR service:', ocrService);
  }

  // Process OCR results
  const processedText = ocrResults.text.trim().replace(/-\n+/g, '').replace(/\s+/g, ' ').toUpperCase();
  const fontSize = estimateFontSize(ocrResults.blocks);
  console.log('OCR Results:', processedText);
  console.log('Font Size:', fontSize);
  console.log(ocrResults.blocks);
  console.log(imageSrc);
  return { text: processedText, blocks: ocrResults.blocks, fontSize: fontSize };
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
  const apiKey = serviceSettings.deeplApiKey; // Use deeplApiKey instead of apiKey

  if (!apiKey || (sourceLang === targetLang && sourceLang !== 'AUTO')) {
    console.log('Translation skipped: missing API key or same language');
    return text;
  }

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
  const translationService = serviceSettings.translationService || 'deepl';

  if (translationService === 'deepl') {
    return translateWithDeepL(text, forcedSourceLang, forcedTargetLang);
  } else if (translationService === 'googleTranslate') {
    return translateWithGoogle(text, forcedSourceLang, forcedTargetLang);
  } else {
    console.error('Unknown translation service:', translationService);
    return text; // Return original text if service is somehow unknown
  }
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
    const wScale = 3;
    const hScale = 3;

    const subsectionImg = await preprocessSubsection(img, x1, y1, w, h, w * wScale, h * hScale, classIndex);

    try {
      const ocrResults = await performOCR(subsectionImg.src, classIndex);
      detection.text = ocrResults.text;
      detection.blocks = ocrResults.blocks;
      detection.fontSize = ocrResults.fontSize / hScale;

      detection.translatedText = await translateText(detection.text, serviceSettings.sourceLanguage, serviceSettings.targetLanguage);
    } catch (error) {
      console.error('Error processing OCR or translation:', error);
      detection.text = '';
      detection.translatedText = '';
    }

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
    processedSubsection = resizedSubsection.grey();
    processedSubsection = processedSubsection.gaussianFilter({ radius: 6 });
    // processedSubsection = processedSubsection.mask(processedSubsection.getThreshold());
    processedSubsection = processedSubsection.dilate({ iterations: 2 });
  } else {
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
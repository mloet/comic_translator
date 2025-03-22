import * as ort from "onnxruntime-web";
import Tesseract from 'tesseract.js';
import { Image as ImageJS } from 'image-js';

const authKey = "a011d0fc-a730-4ab9-b682-526495ade881:fx";
const MODEL_PATH = chrome.runtime.getURL("models/bubble_seg.onnx");

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

// Initialize Tesseract worker
let tesseract_worker = null;
async function initializeWorker() {
  console.log('creating worker')
  if (!tesseract_worker) {
    console.log('no worker yet')

    tesseract_worker = await Tesseract.createWorker('spa', 1, {
      corePath: 'local_tesseract/tesseract.js-core',
      workerPath: "local_tesseract/worker.min.js",
      workerBlobURL: false
    });
    await tesseract_worker.setParameters({
      // tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz.,!?-\'":; ', // Added punctuation and space
      preserve_interword_spaces: '1',
    });

    console.log('worker created')
  }
  return tesseract_worker;
}

// Translate text using DeepL API
async function translateText(text, sourceLang = 'ES', targetLang = 'EN') {
  if (!text || text.trim() === '') {
    console.error('Translation error: Text is empty');
    return text; // Return the original text
  }

  console.log('Translation request payload:', {
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
        auth_key: authKey, // Replace with your DeepL API key
        text: text,
        source_lang: sourceLang.toUpperCase(),
        target_lang: targetLang.toUpperCase(),
      }),
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();
    return data.translations[0].text; // Extract the translated text
  } catch (error) {
    console.error('Translation error:', error);
    return text; // Fallback to the original text if translation fails
  }
}

// Listen for messages from the background script
if (!window.listenerRegistered) {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log("Offscreen received message:", message.action);
    if (message.action === "detectObjects") {
      detectObjects(message.imageData, message.requestId);
    }
    return false;
  });
  window.listenerRegistered = true;
}

// Main object detection function
async function detectObjects(base64Image, requestId) {
  try {
    console.log("Processing image for detection");

    // Load model if needed
    await loadModel();
    const tesseract_worker = await initializeWorker();

    // Convert base64 to image data
    const { imageData, width, height, img } = await base64ToImageData(base64Image);

    // Preprocess image
    const inputTensor = preprocessImage(img);

    // Run inference
    const outputs = await session.run({ images: inputTensor });

    // Process results
    const results = await postprocessOutput(outputs, width, height, img);
    console.log(`Found ${results.length} detections`);

    // Send results back
    chrome.runtime.sendMessage({
      action: "detectionResults",
      results: results,
      requestId: requestId
    });
    // await tesseract_worker.terminate();

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
  const targetSize = 640;
  const canvas = document.createElement('canvas');
  canvas.width = targetSize;
  canvas.height = targetSize;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, targetSize, targetSize);

  const imageData = ctx.getImageData(0, 0, targetSize, targetSize);
  const data = imageData.data;
  const inputTensor = new Float32Array(3 * targetSize * targetSize);

  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    inputTensor[j] = data[i] / 255.0;      // Red
    inputTensor[j + targetSize * targetSize] = data[i + 1] / 255.0;  // Green
    inputTensor[j + 2 * targetSize * targetSize] = data[i + 2] / 255.0;  // Blue
  }

  return new ort.Tensor('float32', inputTensor, [1, 3, targetSize, targetSize]);
}

// Postprocess the model output
async function postprocessOutput(outputs, originalWidth, originalHeight, img) {
  const confidenceThreshold = 0.8;
  const iouThreshold = 0.5;
  const outputData = outputs.output0.data;
  const outputDims = outputs.output0.dims;
  const maskProtos = outputs.output1.data;
  const maskDims = outputs.output1.dims;

  let detections = [];

  for (let i = 0; i < outputDims[2]; i += 1) {
    const cx = outputData[i + outputDims[2] * 0];
    const cy = outputData[i + outputDims[2] * 1];
    const w = outputData[i + outputDims[2] * 2];
    const h = outputData[i + outputDims[2] * 3];
    const confidence = outputData[i + outputDims[2] * 4];

    if (confidence < confidenceThreshold) continue;

    const x1 = (cx - w / 2) * (originalWidth / 640);
    const y1 = (cy - h / 2) * (originalHeight / 640);
    const x2 = (cx + w / 2) * (originalWidth / 640);
    const y2 = (cy + h / 2) * (originalHeight / 640);

    const maskCoeffs = [];
    for (let j = 5; j < outputDims[1]; j++) {
      maskCoeffs.push(outputData[i + outputDims[2] * j]);
    }

    const mask = generateMask(maskCoeffs, maskProtos, maskDims, originalWidth, originalHeight);

    detections.push({ x1, y1, x2, y2, confidence, mask });
  }

  const filteredDetections = nonMaxSuppression(detections, iouThreshold);
  // const tesseract_worker = await initializeWorker();
  for (const detection of filteredDetections) {
    const { x1, y1, x2, y2, confidence, mask } = detection
    const w = x2 - x1;
    const h = y2 - y1;
    const subsectionImg = await preprocessSubsection(img, x1, y1, w, h, w * 5, h * 5, mask);
    // const subsectionImg = await preprocessSubsection(img, x1, y1, w, h, w * 3, h * 3);
    const result = await tesseract_worker.recognize(subsectionImg.src);

    console.log(result.data);

    detection.subsectionImg = subsectionImg.src;
    // detection.text = result.data.text
    //   .trim()
    //   .replace(/-\s+/g, '')
    //   .replace(/\s+/g, ' ');

    // Translate the text to English
    const rawText = result.data.text
      .trim()
      .replace(/-\s+/g, '')
      .replace(/\s+/g, ' ')
      .toUpperCase();
    detection.text = await translateText(rawText, 'es', 'en');
  }

  return filteredDetections;
}

// Preprocess speech bubble for OCR
async function preprocessSubsection(img, x, y, w, h, targetWidth, targetHeight, invertedMask) {
  return new Promise((mainResolve, mainReject) => {
    // Create a canvas for the final result
    const resultCanvas = document.createElement('canvas');
    resultCanvas.width = img.width;
    resultCanvas.height = img.height;
    const resultCtx = resultCanvas.getContext('2d');

    // Step 1: Fill the entire canvas with white (our background)
    resultCtx.fillStyle = 'white';
    resultCtx.fillRect(0, 0, resultCanvas.width, resultCanvas.height);

    // If we have a mask, process it
    if (invertedMask) {
      // Create a temporary canvas to hold the masked image
      const tempCanvas = document.createElement('canvas');
      tempCanvas.width = img.width;
      tempCanvas.height = img.height;
      const tempCtx = tempCanvas.getContext('2d');

      // Load the mask
      const maskImg = new Image();
      maskImg.src = invertedMask;

      maskImg.onload = async () => {
        // First draw the original image to the temp canvas
        tempCtx.drawImage(img, 0, 0);

        // Erode the mask
        const maskImage = await ImageJS.load(maskImg.src);
        const denoisedMask = maskImage.gaussianFilter({ radius: 2 });
        const erodedMask = denoisedMask.grey().erode({ iterations: 1 }); // Adjust iterations as needed

        // Convert the eroded mask back to a canvas
        const erodedMaskCanvas = document.createElement('canvas');
        erodedMaskCanvas.width = erodedMask.width;
        erodedMaskCanvas.height = erodedMask.height;
        const erodedMaskCtx = erodedMaskCanvas.getContext('2d');
        const rgbaData = new Uint8ClampedArray(erodedMask.width * erodedMask.height * 4);
        for (let i = 0; i < erodedMask.data.length; i++) {
          const value = erodedMask.data[i] > 0 ? 255 : 0;
          rgbaData[i * 4] = value;     // R
          rgbaData[i * 4 + 1] = value; // G
          rgbaData[i * 4 + 2] = value; // B
          rgbaData[i * 4 + 3] = value;   // A (fully opaque)
        }
        const imageData = new ImageData(rgbaData, erodedMask.width, erodedMask.height);
        erodedMaskCtx.putImageData(imageData, 0, 0);

        // Apply the mask to the image 
        tempCtx.globalCompositeOperation = 'destination-in';
        tempCtx.drawImage(erodedMaskCanvas, 0, 0, img.width, img.height);

        // Reset composite operation
        tempCtx.globalCompositeOperation = 'source-over';

        resultCtx.drawImage(tempCanvas, 0, 0);

        finishProcessing();
      };

      maskImg.onerror = mainReject;
    } else {
      // If no mask, just draw the original image on white background
      resultCtx.drawImage(img, 0, 0);
      finishProcessing();
    }

    // Function to extract and process the subsection
    function finishProcessing() {
      // Extract the subsection
      const subsectionCanvas = document.createElement('canvas');
      subsectionCanvas.width = targetWidth;
      subsectionCanvas.height = targetHeight;
      const subsectionCtx = subsectionCanvas.getContext('2d');

      // Draw and resize the subsection from the result canvas
      subsectionCtx.drawImage(
        resultCanvas,
        x, y, w, h, // Source rectangle
        0, 0, targetWidth, targetHeight // Destination rectangle
      );

      // Convert the subsection to black and white
      const imageData = subsectionCtx.getImageData(0, 0, targetWidth, targetHeight);
      const data = imageData.data;
      const threshold = 128; // Set a threshold value (0-255)

      for (let i = 0; i < data.length; i += 4) {
        const grayscale = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]; // Convert to grayscale
        const value = grayscale > threshold ? 255 : 0; // Apply threshold
        data[i] = value;     // Red
        data[i + 1] = value; // Green
        data[i + 2] = value; // Blue
        data[i + 3] = 255;   // Alpha (fully opaque)
      }

      subsectionCtx.putImageData(imageData, 0, 0);

      // Return the processed image
      const subsectionImg = new Image();
      subsectionImg.onload = () => mainResolve(subsectionImg);
      subsectionImg.onerror = mainReject;
      subsectionImg.src = subsectionCanvas.toDataURL();
    }
  });
}

// Generate a binary mask from the mask coefficients
function generateMask(maskCoeffs, maskProtos, maskDims, originalWidth, originalHeight) {
  const protoHeight = maskDims[2];
  const protoWidth = maskDims[3];

  const mask = new Float32Array(protoHeight * protoWidth).fill(0);

  for (let h = 0; h < protoHeight; h++) {
    for (let w = 0; w < protoWidth; w++) {
      let val = 0;
      const pixelIdx = h * protoWidth + w;

      for (let c = 0; c < maskDims[1]; c++) {
        const protoIdx = c * protoHeight * protoWidth + pixelIdx;
        val += maskCoeffs[c] * maskProtos[protoIdx];
      }

      mask[pixelIdx] = val;
    }
  }

  const sigmoidMask = mask.map(v => 1 / (1 + Math.exp(-v)));
  const binaryMask = sigmoidMask.map(v => (v > 0.9 ? 1 : 0));

  const maskCanvas = document.createElement('canvas');
  maskCanvas.width = protoWidth;
  maskCanvas.height = protoHeight;
  const maskCtx = maskCanvas.getContext('2d');
  const maskImageData = maskCtx.createImageData(protoWidth, protoHeight);

  for (let i = 0; i < binaryMask.length; i++) {
    const value = binaryMask[i] * 255;
    maskImageData.data[i * 4] = value;     // R
    maskImageData.data[i * 4 + 1] = value; // G
    maskImageData.data[i * 4 + 2] = value; // B
    maskImageData.data[i * 4 + 3] = binaryMask[i] * 255;   // A
  }

  maskCtx.putImageData(maskImageData, 0, 0);

  return maskCanvas.toDataURL('image/png');
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
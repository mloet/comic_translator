import * as ort from "onnxruntime-web";
import Tesseract from 'tesseract.js';

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

let tesseract_worker = null;

// Initialize Tesseract worker
async function initializeWorker() {
  console.log('creating worker')
  if (!tesseract_worker) {
    console.log('no worker yet')

    tesseract_worker = await Tesseract.createWorker('eng', 1, {
      corePath: 'local_tesseract/tesseract.js-core',
      workerPath: "local_tesseract/worker.min.js",
      workerBlobURL: false
    });
    await tesseract_worker.setParameters({
      tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789.,!?-\'":;() ', // Added punctuation and space
      preserve_interword_spaces: '1',
      tessedit_pageseg_mode: '6', // Single uniform block of text
      // tessedit_pageseg_mode: '4', // Assume single column of text
      // tessjs_create_box: '0',
      // tessjs_create_hocr: '0',
      // tessjs_create_tsv: '0',
      // tessjs_create_unlv: '0',
      // tessjs_create_osd: '0'
    });

    console.log('worker created')
  }
  return tesseract_worker;
}

// Listen for messages from the background script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log("Offscreen received message:", message.action);

  if (message.action === "detectObjects") {
    detectObjects(message.imageData, message.requestId);
  }

  return false;
});

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
    await worker.terminate()


  } catch (error) {
    console.error("Detection error:", error);
    chrome.runtime.sendMessage({
      action: "detectionResults",
      error: error.message,
      requestId: requestId
    });
  }
}

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

    const { mask, invertedMask } = generateMask(maskCoeffs, maskProtos, maskDims, originalWidth, originalHeight);
    const w2 = x2 - x1;
    const h2 = y2 - y1;
    const subsectionImg = preprocessSubsection(img, x1, y1, w2, h2, w2 * 3, h2 * 3, invertedMask);
    // const { data: { text } } = await tesseract_worker.recognize(subsectionImg);

    detections.push({ x1, y1, x2, y2, confidence, mask, subsectionImg: subsectionImg.src });
  }

  const filteredDetections = nonMaxSuppression(detections, iouThreshold);
  const tesseract_worker = await initializeWorker();
  for (const detection of filteredDetections) {
    // const subsectionImg = getSubsection(img, detection.x1, detection.y1, detection.x2 - detection.x1, detection.y2 - detection.y1);
    const { x1, y1, x2, y2, confidence, mask, subsectionImg } = detection
    const result = await tesseract_worker.recognize(subsectionImg);
    detection.text = result.data.text.trim().replace(/\s+/g, ' ');
    // console.log(`Detected text: "${detection.text}"`);
    console.log(detection)
  }

  return filteredDetections;
}

function preprocessSubsection(img, x, y, w, h, targetWidth, targetHeight, invertedMask) {
  const canvas = document.createElement('canvas');
  canvas.width = targetWidth;
  canvas.height = targetHeight;
  const ctx = canvas.getContext('2d');

  // Draw and resize the subsection
  ctx.drawImage(img, x, y, w, h, 0, 0, targetWidth, targetHeight);

  // If an inverted mask is provided, apply it
  if (invertedMask) {
    const maskImg = new Image();
    maskImg.src = invertedMask;
    maskImg.onload = () => {
      ctx.globalCompositeOperation = 'destination-in'; // Keep only the masked area
      ctx.drawImage(maskImg, 0, 0, targetWidth, targetHeight);
      ctx.globalCompositeOperation = 'source-over'; // Reset composite operation
    };
  }

  // Return the processed image
  const subsectionImg = new Image();
  subsectionImg.src = canvas.toDataURL();
  return subsectionImg;
}

function generateMask(maskCoeffs, maskProtos, maskDims, originalWidth, originalHeight) {
  // Extract dimensions from maskDims
  const batchSize = maskDims[0];  // Should be 1
  const numChannels = maskDims[1]; // Should be 32
  const protoHeight = maskDims[2]; // Should be 160
  const protoWidth = maskDims[3];  // Should be 160

  // Create an empty mask with the right dimensions
  const mask = new Float32Array(protoHeight * protoWidth).fill(0);

  // Matrix multiplication: maskCoeffs (32) dot maskProtos (32×160×160)
  for (let h = 0; h < protoHeight; h++) {
    for (let w = 0; w < protoWidth; w++) {
      let val = 0;
      const pixelIdx = h * protoWidth + w;

      // Sum over all channels
      for (let c = 0; c < numChannels; c++) {
        // Access the right position in the flattened maskProtos array
        const protoIdx = c * protoHeight * protoWidth + pixelIdx;
        val += maskCoeffs[c] * maskProtos[protoIdx];
      }

      mask[pixelIdx] = val;
    }
  }

  // Apply sigmoid activation
  const sigmoidMask = mask.map(v => 1 / (1 + Math.exp(-v)));

  // Threshold to binary with higher threshold for cleaner results
  const thresholdValue = 0.5;
  const binaryMask = sigmoidMask.map(v => (v > thresholdValue ? 1 : 0));

  // Create a canvas to hold the mask
  const maskCanvas = document.createElement('canvas');
  maskCanvas.width = protoWidth;
  maskCanvas.height = protoHeight;
  const maskCtx = maskCanvas.getContext('2d');
  const maskImageData = maskCtx.createImageData(protoWidth, protoHeight);

  const maskCanvasInv = document.createElement('canvas');
  maskCanvasInv.width = protoWidth;
  maskCanvasInv.height = protoHeight;
  const maskCtxInv = maskCanvasInv.getContext('2d');
  const maskImageDataInv = maskCtxInv.createImageData(protoWidth, protoHeight);

  // Fill the image data - white for mask, transparent for background
  for (let i = 0; i < binaryMask.length; i++) {
    const value = binaryMask[i] * 255;
    const invValue = (1 - binaryMask[i]) * 255;

    // Mask
    maskImageData.data[i * 4] = value;     // R
    maskImageData.data[i * 4 + 1] = value; // G
    maskImageData.data[i * 4 + 2] = value; // B
    maskImageData.data[i * 4 + 3] = value; // A

    // Inverted Mask
    maskImageDataInv.data[i * 4] = invValue;     // R
    maskImageDataInv.data[i * 4 + 1] = invValue; // G
    maskImageDataInv.data[i * 4 + 2] = invValue; // B
    maskImageDataInv.data[i * 4 + 3] = invValue; // A
  }

  maskCtx.putImageData(maskImageData, 0, 0);
  maskCtxInv.putImageData(maskImageDataInv, 0, 0);

  // Resize to the original image dimensions
  const resizedMaskCanvas = document.createElement('canvas');
  resizedMaskCanvas.width = originalWidth;
  resizedMaskCanvas.height = originalHeight;
  const resizedMaskCtx = resizedMaskCanvas.getContext('2d');
  resizedMaskCtx.imageSmoothingEnabled = true;
  resizedMaskCtx.imageSmoothingQuality = 'high';
  resizedMaskCtx.drawImage(maskCanvas, 0, 0, originalWidth, originalHeight);

  const resizedMaskCanvasInv = document.createElement('canvas');
  resizedMaskCanvasInv.width = originalWidth;
  resizedMaskCanvasInv.height = originalHeight;
  const resizedMaskCtxInv = resizedMaskCanvasInv.getContext('2d');
  resizedMaskCtxInv.imageSmoothingEnabled = true;
  resizedMaskCtxInv.imageSmoothingQuality = 'high';
  resizedMaskCtxInv.drawImage(maskCanvasInv, 0, 0, originalWidth, originalHeight);

  return {
    mask: resizedMaskCanvas.toDataURL('image/png'), // Mask
    invertedMask: resizedMaskCanvasInv.toDataURL('image/png') // Inverted Mask
  };
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
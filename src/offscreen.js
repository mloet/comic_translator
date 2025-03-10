import * as ort from "onnxruntime-web";

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

    // Convert base64 to image data
    const { imageData, width, height, img } = await base64ToImageData(base64Image);

    console.log(width, height);

    // Preprocess image
    const inputTensor = preprocessImage(img);

    console.log(inputTensor);

    // Run inference
    console.log("Running inference...");
    const outputs = await session.run({ images: inputTensor });
    console.log("Inference complete");

    console.log(outputs.output0);
    console.log(outputs.output0.data.length);


    // Process results
    const results = postprocessOutput(outputs.output0, width, height);
    console.log(`Found ${results.length} detections`);

    console.log(results);

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

function postprocessOutput(outputTensor, originalWidth, originalHeight) {
  const confidenceThreshold = 0.8;
  const iouThreshold = 0.5;
  const outputData = outputTensor.data;
  const outputDims = outputTensor.dims;

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

    detections.push({ x1, y1, x2, y2, confidence });
  }

  return nonMaxSuppression(detections, iouThreshold);
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

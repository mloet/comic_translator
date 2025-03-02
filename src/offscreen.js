// offscreen.js

import * as ort from "onnxruntime-web";

const MODEL_PATH = chrome.runtime.getURL("models/comic-bubble-detector/onnx/comic-bubble-detector.onnx");

// Load the ONNX model
let session = null;
async function loadModel() {
  if (!session) {
    session = await ort.InferenceSession.create(MODEL_PATH, {
      executionProviders: ["wasm"]
    });
  }
}

// Run YOLOv8 inference
async function detectObjects(imageData) {
  await loadModel();

  const inputTensor = preprocessImage(imageData);
  const outputData = await session.run({ images: inputTensor });
  return postprocessOutput(outputData);
}

// Listen for messages from the background script
chrome.runtime.onMessage.addListener(async (message, sender, sendResponse) => {
  if (message.action === "detectObjects") {
    const result = await detectObjects(message.imageData);
    sendResponse(result);
  }
});

// Convert image to float32 tensor (normalized)
function preprocessImage(imageData) {
  const imgTensor = new Float32Array(3 * 1024 * 1024);

  for (let i = 0; i < imageData.data.length; i += 4) {
    const r = imageData.data[i] / 255.0;
    const g = imageData.data[i + 1] / 255.0;
    const b = imageData.data[i + 2] / 255.0;
    const index = (i / 4) * 3;
    imgTensor[index] = r;
    imgTensor[index + 1] = g;
    imgTensor[index + 2] = b;
  }

  return new ort.Tensor("float32", imgTensor, [1, 3, 1024, 1024]);
}

// Extract valid detections
function postprocessOutput(outputData) {
  const detections = [];
  const threshold = 0.5;

  for (let i = 0; i < outputData.data.length; i += 6) {
    const confidence = outputData.data[i + 4];
    if (confidence > threshold) {
      detections.push({
        bbox: outputData.data.slice(i, i + 4),
        confidence: confidence,
        class: outputData.data[i + 5],
      });
    }
  }

  return detections;
}
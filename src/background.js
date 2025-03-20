// background.js - Service worker that manages the offscreen document

// Check if offscreen document is already created
async function ensureOffscreenDocument() {
  // Check if offscreen document is already open
  const existingContexts = await chrome.runtime.getContexts({});
  const offscreenExists = existingContexts.some(
    (context) => context.contextType === "OFFSCREEN_DOCUMENT"
  );

  // Create offscreen document if it doesn't exist
  if (!offscreenExists) {
    try {
      await chrome.offscreen.createDocument({
        url: "offscreen.html",
        reasons: ["WORKERS"],
        justification: "Run ONNX model for object detection"
      });
      console.log("Offscreen document created successfully");
    } catch (error) {
      console.error("Error creating offscreen document:", error);
    }
  } else {
    console.log("Offscreen document already exists");
  }
}

// Global map to store pendingRequests with their respective callbacks
const pendingRequests = new Map();
let requestId = 0;

// Set up detection results listener
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "detectionResults") {
    // Find the original request callback using requestId
    const callback = pendingRequests.get(message.requestId);

    if (callback) {
      // Forward the results directly to the callback
      if (message.error) {
        callback({ error: message.error });
      } else {
        callback({ results: message.results });
      }

      // Remove this request from the map
      pendingRequests.delete(message.requestId);
    } else {
      console.warn("Received results for unknown request:", message.requestId);
    }

    // No need to send a response here
    return false;
  }
});

// Handle messages from popup.js
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "initDetection") {
    console.log("Received detection request from popup");

    // Create a unique ID for this request
    const currentRequestId = requestId++;

    // Store the sendResponse callback in our map
    pendingRequests.set(currentRequestId, sendResponse);

    // Ensure offscreen document exists and send the request
    ensureOffscreenDocument().then(() => {
      chrome.runtime.sendMessage({
        action: "detectObjects",
        imageData: message.imageData,
        requestId: currentRequestId
      });
    }).catch(error => {
      // If there's an error creating the offscreen document
      sendResponse({ error: `Error creating offscreen document: ${error.message}` });
      pendingRequests.delete(currentRequestId);
    });

    // Return true to indicate we'll respond asynchronously
    return true;
  }
});

chrome.commands.onCommand.addListener((command) => {
  if (command === "open-popup") {
    // Open the popup (this will focus the popup if already open)
    chrome.action.openPopup();
  } else if (command === "start-detection") {
    // Send a message to the popup to start detection
    chrome.runtime.sendMessage({ action: "startDetection" });
  }
});
// background.js - Service worker that manages the offscreen document

// Ensure offscreen document is active
async function ensureOffscreenDocument() {
  try {
    // Check if offscreen document is already open
    const existingContexts = await chrome.runtime.getContexts({});
    const offscreenExists = existingContexts.some(
      (context) => context.contextType === "OFFSCREEN_DOCUMENT"
    );

    // Create offscreen document if it doesn't exist
    if (!offscreenExists) {
      await chrome.offscreen.createDocument({
        url: "offscreen.html",
        reasons: ["WORKERS"],
        justification: "Run ONNX model for object detection"
      });
      console.log("Offscreen document created successfully");
    } else {
      console.log("Offscreen document already exists");
    }
    return true;
  } catch (error) {
    console.error("Error with offscreen document:", error);
    return false;
  }
}

// Global map to store pendingRequests with their callbacks and metadata
const pendingRequests = new Map();
let requestId = 0;

// Set up detection results listener from offscreen.js
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Handle detection results from offscreen document
  if (message.action === "detectionResults") {
    console.log(`Received detection results for request ${message.requestId}`);

    // Get the request data using requestId
    const requestData = pendingRequests.get(message.requestId);

    if (!requestData) {
      console.warn(`No request data found for request ${message.requestId}`);
      return false;
    }

    const { callback, sourceTabId, imageId, source } = requestData;

    // If from content script (has tab ID and image ID)
    if (source === 'content' && sourceTabId && imageId) {
      console.log(`Sending results to content script in tab ${sourceTabId} for image ${imageId}`);

      chrome.tabs.sendMessage(sourceTabId, {
        action: "detectionCompleted",
        imageId: imageId,
        results: message.results,
        error: message.error
      }).catch(error => {
        console.error(`Error sending results to tab ${sourceTabId}:`, error);
      });
    }

    // Clean up the request data
    pendingRequests.delete(message.requestId);

    return false;
  }
});

// Handle messages from popup.js or content.js
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  // Handle settings updates from popup
  if (message.action === "updateserviceSettings") {
    // Update settings
    if (message.settings.apiKey !== undefined) {
      serviceSettings.apiKey = message.settings.apiKey;
    }
    if (message.settings.ocrService !== undefined) {
      serviceSettings.ocrService = message.settings.ocrService;
    }
    if (message.settings.translationService !== undefined) {
      serviceSettings.translationService = message.settings.translationService;
    }
    if (message.settings.sourceLanguage !== undefined) {
      serviceSettings.sourceLanguage = message.settings.sourceLanguage;
    }
    if (message.settings.targetLanguage !== undefined) {
      serviceSettings.targetLanguage = message.settings.targetLanguage;
    }

    console.log('Service settings updated:', serviceSettings);

    // Forward settings to offscreen document
    chrome.runtime.sendMessage({
      action: "updateserviceSettings",
      settings: serviceSettings
    }).catch(error => {
      console.error('Error forwarding settings to offscreen document:', error);
    });

    return false;
  }

  // Handle detection request from webpage content script
  if (message.action === "initWebpageDetection") {
    const currentRequestId = requestId++;
    console.log(`Received detection request from content script in tab ${sender.tab?.id}, assigned ID ${currentRequestId}`);

    // Store source tab ID and image ID
    pendingRequests.set(currentRequestId, {
      sourceTabId: sender.tab?.id,
      imageId: message.imageId,
      source: 'content'
    });

    // Process the detection request with current service settings
    processDetectionRequest(message.imageData, currentRequestId, serviceSettings);

    // No need for a synchronous response
    return false;
  }
});

// Process detection request by forwarding to offscreen document
async function processDetectionRequest(imageData, requestId, settings) {
  try {
    const offscreenReady = await ensureOffscreenDocument();

    if (!offscreenReady) {
      handleDetectionError(requestId, "Failed to create offscreen document");
      return;
    }

    console.log(`Forwarding detection request to offscreen document for request ${requestId}`);
    console.log(`Using service settings:`, settings);

    // Forward the request to the offscreen document
    chrome.runtime.sendMessage({
      action: "detectObjects",
      imageData: imageData,
      requestId: requestId,
      serviceSettings: settings
    }).catch(error => {
      handleDetectionError(requestId, `Error sending to offscreen document: ${error.message}`);
    });
  } catch (error) {
    handleDetectionError(requestId, `Error in detection process: ${error.message}`);
  }
}

// Handle detection errors
function handleDetectionError(requestId, errorMessage) {
  console.error(`Detection error for request ${requestId}: ${errorMessage}`);

  const requestData = pendingRequests.get(requestId);
  if (!requestData) return;

  const { callback, sourceTabId, imageId, source } = requestData;

  // Send error to popup if applicable
  if (source === 'popup' && callback) {
    callback({ error: errorMessage });
  }

  // Send error to content script if applicable
  if (source === 'content' && sourceTabId && imageId) {
    chrome.tabs.sendMessage(sourceTabId, {
      action: "detectionCompleted",
      imageId: imageId,
      error: errorMessage
    }).catch(err => {
      console.error(`Error sending error to tab ${sourceTabId}:`, err);
    });
  }

  // Clean up the request data
  pendingRequests.delete(requestId);
}

// Set up context menu (right-click option)
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "detectTextInImage",
    title: "Detect Text Bubbles",
    contexts: ["image"],
  });
});

// Handle context menu clicks
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "detectTextInImage" && info.srcUrl && tab?.id) {
    // Send message to content script to handle this specific image
    chrome.tabs.sendMessage(tab.id, {
      action: "contextMenuDetection",
      imageUrl: info.srcUrl
    }).catch(error => {
      console.error(`Error sending context menu action to tab ${tab.id}:`, error);
    });
  }
});

// Listen for keyboard shortcuts
chrome.commands.onCommand.addListener((command) => {
  if (command === "open-popup") {
    // Open the popup
    chrome.action.openPopup();
  }
});

// Storage for service settings
let serviceSettings = {
  apiKey: '',
  ocrService: 'tesseract',
  translationService: 'deepl',
  sourceLanguage: 'AUTO',
  targetLanguage: 'EN'
};

// Load saved settings when background script starts
chrome.storage.sync.get(['apiKey', 'ocrService', 'translationService', 'sourceLanguage', 'targetLanguage'], function (items) {
  if (items.apiKey) serviceSettings.apiKey = items.apiKey;
  if (items.ocrService) serviceSettings.ocrService = items.ocrService;
  if (items.translationService) serviceSettings.translationService = items.translationService;
  if (items.sourceLanguage) serviceSettings.sourceLanguage = items.sourceLanguage;
  if (items.targetLanguage) serviceSettings.targetLanguage = items.targetLanguage;
});

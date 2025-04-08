// background.js - Service worker that manages the offscreen document

// Storage for service settings
let serviceSettings = {
  googleApiKey: '',
  deeplApiKey: '',
  ocrService: 'tesseract',
  translationService: 'deepl',
  sourceLanguage: 'AUTO',
  targetLanguage: 'EN'
};

// Request queue management
let requestQueue = [];
let isProcessing = false;

// Load saved settings when background script starts
chrome.storage.sync.get([
  'googleApiKey',
  'deeplApiKey',
  'ocrService',
  'translationService',
  'sourceLanguage',
  'targetLanguage'
], function (items) {
  if (items.googleApiKey) serviceSettings.googleApiKey = items.googleApiKey;
  if (items.deeplApiKey) serviceSettings.deeplApiKey = items.deeplApiKey;
  if (items.ocrService) serviceSettings.ocrService = items.ocrService;
  if (items.translationService) serviceSettings.translationService = items.translationService;
  if (items.sourceLanguage) serviceSettings.sourceLanguage = items.sourceLanguage;
  if (items.targetLanguage) serviceSettings.targetLanguage = items.targetLanguage;
});

// Global map to store pendingRequests with their callbacks and metadata
const pendingRequests = new Map();
let requestId = 0;

// Register listeners
if (!globalThis.listenersRegistered) {
  // Handle messages from popup.js or content.js
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

    // Handle settings updates from popup
    if (message.action === "updateserviceSettings") {
      // Update settings
      if (message.settings.googleApiKey !== undefined) {
        serviceSettings.googleApiKey = message.settings.googleApiKey;
      }
      if (message.settings.deeplApiKey !== undefined) {
        serviceSettings.deeplApiKey = message.settings.deeplApiKey;
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

      // Add to queue instead of processing immediately
      addToQueue(message.imageData, currentRequestId, serviceSettings);

      // No need for a synchronous response
      return false;
    }
  });

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

      // Clear any timeouts associated with this request
      if (requestData.timeout) {
        clearTimeout(requestData.timeout);
      }

      const { sourceTabId, imageId, source } = requestData;

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

      // Process next request in queue
      isProcessing = false;
      processNextInQueue();

      return false;
    }
  });

  // Handle translation requests from offscreen.js
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === "translateText") {
      const { text, sourceLang, targetLang } = message;
      const translationService = serviceSettings.translationService || 'deepl';

      if (translationService === 'deepl') {
        translateWithDeepL(text, sourceLang, targetLang)
          .then(translatedText => sendResponse({ translatedText }))
          .catch(error => sendResponse({ error: error.message }));
      } else if (translationService === 'googleTranslate') {
        translateWithGoogle(text, sourceLang, targetLang)
          .then(translatedText => sendResponse({ translatedText }))
          .catch(error => sendResponse({ error: error.message }));
      } else {
        sendResponse({ error: "Unknown translation service" });
      }

      // Return true to indicate asynchronous response
      return true;
    }
  });


  // Listen for keyboard shortcuts
  chrome.commands.onCommand.addListener((command) => {
    if (command === "open-popup") {
      // Open the popup
      chrome.action.openPopup();
    }
  });

  globalThis.listenersRegistered = true;
}

// Add request to queue and process if possible
function addToQueue(imageData, requestId, settings) {
  requestQueue.push({ imageData, requestId, settings });
  processNextInQueue();
}

// Process next request in queue
function processNextInQueue() {
  if (isProcessing || requestQueue.length === 0) return;

  isProcessing = true;
  const { imageData, requestId, settings } = requestQueue.shift();

  processDetectionRequest(imageData, requestId, settings)
    .finally(() => {
      isProcessing = false;
      processNextInQueue();
    });
}

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

// Process detection request by forwarding to offscreen document
async function processDetectionRequest(imageData, requestId, settings) {
  return new Promise(async (resolve, reject) => {
    try {
      const offscreenReady = await ensureOffscreenDocument();

      if (!offscreenReady) {
        handleDetectionError(requestId, "Failed to create offscreen document");
        reject(new Error("Failed to create offscreen document"));
        return;
      }

      // Set a timeout for the request
      const timeout = setTimeout(() => {
        handleDetectionError(requestId, "Request timed out after 30 seconds");
        reject(new Error("Request timed out"));
      }, 60000); // 30 second timeout

      // Store timeout reference
      const existingData = pendingRequests.get(requestId) || {};
      pendingRequests.set(requestId, {
        ...existingData,
        timeout: timeout
      });

      console.log(`Forwarding detection request to offscreen document for request ${requestId}`);
      console.log(`Using service settings:`, settings);

      // Forward the request to the offscreen document
      chrome.runtime.sendMessage({
        action: "detectObjects",
        imageData: imageData,
        requestId: requestId,
        serviceSettings: settings
      }).catch(error => {
        clearTimeout(timeout);
        handleDetectionError(requestId, `Error sending to offscreen document: ${error.message}`);
        reject(error);
      });
    } catch (error) {
      handleDetectionError(requestId, `Error in detection process: ${error.message}`);
      reject(error);
    }
  });
}

// Handle detection errors
function handleDetectionError(requestId, errorMessage) {
  console.error(`Detection error for request ${requestId}: ${errorMessage}`);

  const requestData = pendingRequests.get(requestId);
  if (!requestData) return;

  const { callback, sourceTabId, imageId, source, timeout } = requestData;

  // Clear timeout if it exists
  if (timeout) {
    clearTimeout(timeout);
  }

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

  // Process next item in queue
  isProcessing = false;
  processNextInQueue();
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

  console.log('Translation request payload:', {
    text,
    sourceLang,
    targetLang,
  });

  console.log(apiKey, sourceLang, targetLang, text);
  try {
    const response = await fetch("https://api-free.deepl.com/v2/translate", {
      method: "POST",
      headers: {
        "Access-Control-Allow-Origin": "https://api-free.deepl.com",
        "Authorization": `DeepL-Auth-Key ${apiKey}`, // Use the Authorization header
        "Content-Type": "application/json", // Send JSON data
      },
      body: JSON.stringify({
        text: [text], // Wrap the text in an array
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
// async function translateText(text, forcedSourceLang = null, forcedTargetLang = null) {
//   return translationLimiter.run(async () => {
//     const translationService = serviceSettings.translationService || 'deepl';

//     if (translationService === 'deepl') {
//       return translateWithDeepL(text, forcedSourceLang, forcedTargetLang);
//     } else if (translationService === 'googleTranslate') {
//       return translateWithGoogle(text, forcedSourceLang, forcedTargetLang);
//     } else {
//       console.error('Unknown translation service:', translationService);
//       return text; // Return original text if service is somehow unknown
//     }
//   });
// }

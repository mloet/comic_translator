// popup.js - handles interaction with the translation settings popup

// Wait for DOM to be fully loaded before attaching event listeners
document.addEventListener('DOMContentLoaded', () => {
  initializePopup();
});

function initializePopup() {
  // Get UI elements
  const googleApiKeyInput = document.getElementById('googleApiKey');
  const deeplApiKeyInput = document.getElementById('deeplApiKey');
  const saveGoogleApiKeyButton = document.getElementById('saveGoogleApiKey');
  const saveDeepLApiKeyButton = document.getElementById('saveDeepLApiKey');
  const ocrServiceSelect = document.getElementById('ocrService');
  const translationServiceSelect = document.getElementById('translationService');
  const sourceLanguageSelect = document.getElementById('sourceLanguage');
  const targetLanguageSelect = document.getElementById('targetLanguage');
  const detectAllImagesButton = document.getElementById('detectAllImages');

  // Load saved settings
  loadSavedSettings();

  // Save Google API key
  saveGoogleApiKeyButton.addEventListener('click', () => saveApiKey('googleApiKey', googleApiKeyInput.value));

  // Save DeepL API key
  saveDeepLApiKeyButton.addEventListener('click', () => saveApiKey('deeplApiKey', deeplApiKeyInput.value));

  // Save OCR and translation service settings
  ocrServiceSelect.addEventListener('change', saveServiceSettings);
  translationServiceSelect.addEventListener('change', saveServiceSettings);

  // Save language settings
  sourceLanguageSelect.addEventListener('change', saveLanguageSettings);
  targetLanguageSelect.addEventListener('change', saveLanguageSettings);

  detectAllImagesButton.addEventListener('click', () => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.id) {
        chrome.tabs.sendMessage(tabs[0].id, { action: 'detectAllImages' });
        showStatus('Detection started for all images!', 'blue');
      }
    });
  });
}

function saveApiKey(keyName, apiKeyValue) {
  const trimmedApiKey = apiKeyValue.trim();

  if (!trimmedApiKey) {
    showStatus(`${keyName} cannot be empty!`, 'red');
    return;
  }

  chrome.storage.sync.set({ [keyName]: trimmedApiKey }, () => {
    showStatus(`${keyName} saved!`, 'green');

    // Send message to background script
    chrome.runtime.sendMessage({
      action: 'updateserviceSettings',
      settings: { [keyName]: trimmedApiKey }
    }).catch(error => {
      console.error(`Error sending ${keyName}:`, error);
    });
  });
}

function saveServiceSettings() {
  const ocrService = document.getElementById('ocrService').value;
  const translationService = document.getElementById('translationService').value;

  chrome.storage.sync.set({
    ocrService: ocrService,
    translationService: translationService
  }, () => {
    showStatus('Service settings saved!', 'green');

    // Send message to background script
    chrome.runtime.sendMessage({
      action: 'updateserviceSettings',
      settings: {
        ocrService: ocrService,
        translationService: translationService
      }
    }).catch(error => {
      console.error('Error sending service settings:', error);
    });
  });
}

function saveLanguageSettings() {
  const sourceLanguage = document.getElementById('sourceLanguage').value;
  const targetLanguage = document.getElementById('targetLanguage').value;

  chrome.storage.sync.set({
    sourceLanguage: sourceLanguage,
    targetLanguage: targetLanguage
  }, () => {
    showStatus('Language settings saved!', 'green');

    // Send message to background script
    chrome.runtime.sendMessage({
      action: 'updateserviceSettings',
      settings: {
        sourceLanguage: sourceLanguage,
        targetLanguage: targetLanguage
      }
    }).catch(error => {
      console.error('Error sending language settings:', error);
    });
  });
}

function loadSavedSettings() {
  chrome.storage.sync.get([
    'googleApiKey',
    'deeplApiKey',
    'ocrService',
    'translationService',
    'sourceLanguage',
    'targetLanguage'
  ], function (items) {
    const googleApiKeyInput = document.getElementById('googleApiKey');
    const deeplApiKeyInput = document.getElementById('deeplApiKey');
    const ocrServiceSelect = document.getElementById('ocrService');
    const translationServiceSelect = document.getElementById('translationService');
    const sourceLanguageSelect = document.getElementById('sourceLanguage');
    const targetLanguageSelect = document.getElementById('targetLanguage');

    // Load Google API key
    if (items.googleApiKey) {
      googleApiKeyInput.value = items.googleApiKey;
    }

    // Load DeepL API key
    if (items.deeplApiKey) {
      deeplApiKeyInput.value = items.deeplApiKey;
    }

    // Load OCR service
    if (items.ocrService) {
      ocrServiceSelect.value = items.ocrService;
    }

    // Load translation service
    if (items.translationService) {
      translationServiceSelect.value = items.translationService;
    }

    // Load language settings
    if (items.sourceLanguage) {
      sourceLanguageSelect.value = items.sourceLanguage;
    }

    if (items.targetLanguage) {
      targetLanguageSelect.value = items.targetLanguage;
    }
  });
}

function showStatus(message, color) {
  const statusElement = document.getElementById('status');
  statusElement.textContent = message;
  statusElement.style.color = color;

  // Clear status after 3 seconds
  setTimeout(() => {
    statusElement.textContent = '';
  }, 3000);
}
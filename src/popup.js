
// popup.js - handles interaction with the translation settings popup

// Wait for DOM to be fully loaded before attaching event listeners
document.addEventListener('DOMContentLoaded', () => {
  initializePopup();
});

function initializePopup() {
  // Get UI elements
  const ocrServiceSelect = document.getElementById('ocrService');
  const translationServiceSelect = document.getElementById('translationService');
  const apiKeyInput = document.getElementById('apiKey');
  const saveApiKeyButton = document.getElementById('saveApiKey');
  const sourceLanguageSelect = document.getElementById('sourceLanguage');
  const targetLanguageSelect = document.getElementById('targetLanguage');

  // Load saved settings
  loadSavedSettings();

  // Save OCR and translation service settings
  ocrServiceSelect.addEventListener('change', saveServiceSettings);
  translationServiceSelect.addEventListener('change', saveServiceSettings);

  // Save API key
  saveApiKeyButton.addEventListener('click', saveApiKey);

  // Save language settings
  sourceLanguageSelect.addEventListener('change', saveLanguageSettings);
  targetLanguageSelect.addEventListener('change', saveLanguageSettings);

  function saveServiceSettings() {
    const ocrService = ocrServiceSelect.value;
    const translationService = translationServiceSelect.value;

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

  function saveApiKey() {
    const apiKey = apiKeyInput.value.trim();

    if (!apiKey) {
      showStatus('API key cannot be empty!', 'red');
      return;
    }

    chrome.storage.sync.set({ apiKey: apiKey }, () => {
      showStatus('API key saved!', 'green');

      // Send message to background script
      chrome.runtime.sendMessage({
        action: 'updateserviceSettings',
        settings: { apiKey: apiKey }
      }).catch(error => {
        console.error('Error sending API key:', error);
      });
    });
  }

  function saveLanguageSettings() {
    const sourceLanguage = sourceLanguageSelect.value;
    const targetLanguage = targetLanguageSelect.value;

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
}

function loadSavedSettings() {
  chrome.storage.sync.get([
    'apiKey',
    'ocrService',
    'translationService',
    'sourceLanguage',
    'targetLanguage'
  ], function (items) {
    const apiKeyInput = document.getElementById('apiKey');
    const ocrServiceSelect = document.getElementById('ocrService');
    const translationServiceSelect = document.getElementById('translationService');
    const sourceLanguageSelect = document.getElementById('sourceLanguage');
    const targetLanguageSelect = document.getElementById('targetLanguage');

    // Load API key
    if (items.apiKey) {
      apiKeyInput.value = items.apiKey;
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
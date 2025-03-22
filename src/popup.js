// popup.js - handles interaction with the translation settings popup

// Wait for DOM to be fully loaded before attaching event listeners
document.addEventListener('DOMContentLoaded', () => {
  initializePopup();
});

function initializePopup() {
  // Get UI elements
  const apiKeyInput = document.getElementById('apiKey');
  const saveApiKeyButton = document.getElementById('saveApiKey');
  const sourceLanguageSelect = document.getElementById('sourceLanguage');
  const targetLanguageSelect = document.getElementById('targetLanguage');
  const statusElement = document.getElementById('status');

  // Load saved settings
  loadSavedSettings();

  // Save API key
  saveApiKeyButton.addEventListener('click', () => {
    const apiKey = apiKeyInput.value.trim();

    if (!apiKey) {
      showStatus('Please enter an API key', 'red');
      return;
    }

    // Save to storage
    chrome.storage.sync.set({ apiKey: apiKey }, () => {
      showStatus('API key saved!', 'green');

      // Send message to background script to update the API key
      chrome.runtime.sendMessage({
        action: 'updateTranslationSettings',
        settings: {
          apiKey: apiKey
        }
      });
    });
  });

  // Handle language selection changes
  sourceLanguageSelect.addEventListener('change', saveLanguageSettings);
  targetLanguageSelect.addEventListener('change', saveLanguageSettings);

  function saveLanguageSettings() {
    const sourceLanguage = sourceLanguageSelect.value;
    const targetLanguage = targetLanguageSelect.value;

    // Save to storage
    chrome.storage.sync.set({
      sourceLanguage: sourceLanguage,
      targetLanguage: targetLanguage
    }, () => {
      showStatus('Language settings saved!', 'green');

      // Send message to background script
      chrome.runtime.sendMessage({
        action: 'updateTranslationSettings',
        settings: {
          sourceLanguage: sourceLanguage,
          targetLanguage: targetLanguage
        }
      });
    });
  }
}

// Load saved settings from storage
function loadSavedSettings() {
  chrome.storage.sync.get(['apiKey', 'sourceLanguage', 'targetLanguage'], function (items) {
    const apiKeyInput = document.getElementById('apiKey');
    const sourceLanguageSelect = document.getElementById('sourceLanguage');
    const targetLanguageSelect = document.getElementById('targetLanguage');

    // Load API key if it exists
    if (items.apiKey) {
      apiKeyInput.value = items.apiKey;
    }

    // Load language preferences
    if (items.sourceLanguage) {
      sourceLanguageSelect.value = items.sourceLanguage;
    }

    if (items.targetLanguage) {
      targetLanguageSelect.value = items.targetLanguage;
    }
  });
}

// Show status message
function showStatus(message, color) {
  const statusElement = document.getElementById('status');
  statusElement.textContent = message;
  statusElement.style.color = color;

  // Clear after 3 seconds
  setTimeout(() => {
    statusElement.textContent = '';
  }, 3000);
}
// popup.js - handles interaction with the extension's popup

const imageUploadElement = document.getElementById('imageUpload');
const detectButton = document.getElementById('detectButton');
const imagePreviewElement = document.getElementById('imagePreview');
const outputElement = document.getElementById('output');

let imageData = null;

// Preview the image when selected
imageUploadElement.addEventListener('change', (event) => {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (e) => {
    // Display the image
    imagePreviewElement.innerHTML = `<img src="${e.target.result}" id="previewImage">`;
    imageData = e.target.result;
  };
  reader.readAsDataURL(file);
});

// Detect objects when the button is clicked
detectButton.addEventListener('click', () => {
  if (!imageData) {
    outputElement.innerText = 'Please select an image first.';
    return;
  }

  // Clear previous results
  outputElement.innerText = 'Processing...';
  detectButton.disabled = true;
  detectButton.textContent = 'Detecting...';

  // Remove previous bounding boxes if any
  const boxes = document.querySelectorAll('.bounding-box');
  boxes.forEach(box => box.remove());

  // Bundle the input data into a message
  const message = {
    action: 'initDetection',
    imageData: imageData
  };

  // Send this message to the service worker
  try {
    chrome.runtime.sendMessage(message, (response) => {
      // Check for runtime.lastError
      if (chrome.runtime.lastError) {
        outputElement.innerText = `Error: ${chrome.runtime.lastError.message}`;
        detectButton.disabled = false;
        detectButton.textContent = 'Detect Objects';
        return;
      }

      // Check if we got a valid response
      if (!response) {
        outputElement.innerText = 'Error: No response received from background service worker';
        detectButton.disabled = false;
        detectButton.textContent = 'Detect Objects';
        return;
      }

      // Handle error response
      if (response.error) {
        outputElement.innerText = `Error: ${response.error}`;
        detectButton.disabled = false;
        detectButton.textContent = 'Detect Objects';
        return;
      }

      // Display results as text
      outputElement.innerText = JSON.stringify(response.results, null, 2);

      // Get the actual rendered dimensions of the image
      const img = document.getElementById('previewImage');
      if (!img) {
        outputElement.innerText += '\nError: Could not find preview image element';
        detectButton.disabled = false;
        detectButton.textContent = 'Detect Objects';
        return;
      }

      const imgWidth = img.clientWidth;
      const imgHeight = img.clientHeight;

      // Draw bounding boxes on the image
      if (response.results && response.results.length > 0) {
        response.results.forEach(detection => renderBox(detection, imgWidth, imgHeight));
      } else {
        outputElement.innerText += '\nNo objects detected in this image.';
      }

      detectButton.disabled = false;
      detectButton.textContent = 'Detect Objects';
    });
  } catch (e) {
    outputElement.innerText = `Error sending message: ${e.message}`;
    detectButton.disabled = false;
    detectButton.textContent = 'Detect Objects';
  }
});

function renderBox(detection, imgWidth, imgHeight) {
  try {
    const { x1, y1, x2, y2, confidence } = detection;

    if (x1 === undefined || y1 === undefined || x2 === undefined || y2 === undefined) {
      console.error('Invalid box coordinates:', detection);
      return;
    }

    // Get the actual dimensions of the image
    const img = document.getElementById('previewImage');
    const actualWidth = img.naturalWidth;
    const actualHeight = img.naturalHeight;

    // Scale the coordinates based on the actual and rendered dimensions
    const scaleX = imgWidth / actualWidth;
    const scaleY = imgHeight / actualHeight;

    const scaledX1 = x1 * scaleX;
    const scaledY1 = y1 * scaleY;
    const scaledX2 = x2 * scaleX;
    const scaledY2 = y2 * scaleY;

    // Generate a random color for the box
    const color = '#' + Math.floor(Math.random() * 0xFFFFFF).toString(16).padStart(6, '0');

    // Create the box element
    const boxElement = document.createElement('div');
    boxElement.className = 'bounding-box';

    // Position the box relative to the image container
    boxElement.style.position = 'absolute';
    boxElement.style.left = `${scaledX1}px`;
    boxElement.style.top = `${scaledY1}px`;
    boxElement.style.width = `${scaledX2 - scaledX1}px`;
    boxElement.style.height = `${scaledY2 - scaledY1}px`;
    boxElement.style.border = `2px solid ${color}`;
    boxElement.style.boxSizing = 'border-box';
    boxElement.style.pointerEvents = 'none';

    // Create and style the label
    const labelElement = document.createElement('span');
    labelElement.textContent = `Confidence: ${(confidence * 100).toFixed(2)}%`;
    labelElement.className = 'bounding-box-label';
    labelElement.style.position = 'absolute';
    labelElement.style.top = '-24px';
    labelElement.style.left = '0';
    labelElement.style.backgroundColor = color;
    labelElement.style.color = 'white';
    labelElement.style.padding = '2px 6px';
    labelElement.style.fontSize = '12px';
    labelElement.style.borderRadius = '2px';
    labelElement.style.whiteSpace = 'nowrap';

    // Add the label to the box and the box to the image container
    boxElement.appendChild(labelElement);
    imagePreviewElement.appendChild(boxElement);
  } catch (e) {
    console.error('Error rendering box:', e);
  }
}
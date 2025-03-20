// popup.js - handles interaction with the extension's popup

// Wait for DOM to be fully loaded before attaching event listeners
document.addEventListener('DOMContentLoaded', () => {
  initializePopup();
});

// Clean up when popup is closed
window.addEventListener('unload', () => {
  cleanupEventListeners();
});

// Listen for messages from the background script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "startDetection") {
    const detectButton = window.popupElements?.detectButton;
    if (detectButton) {
      detectButton.click(); // Simulate a button click to start detection
    }
  }
});

function initializePopup() {
  const imageUploadElement = document.getElementById('imageUpload');
  const detectButton = document.getElementById('detectButton');
  const imagePreviewElement = document.getElementById('imagePreview');
  const outputElement = document.getElementById('output');
  const subsectionImagesContainer = document.getElementById('subsectionImages'); // Add this line

  // Store references globally for cleanup
  window.popupElements = {
    imageUploadElement,
    detectButton,
    imagePreviewElement,
    outputElement,
    subsectionImagesContainer // Add this line
  };

  // Clear existing image data on initialization
  window.imageData = null;

  // Remove existing event listeners (if any) by cloning and replacing elements
  if (imageUploadElement) {
    const newUpload = imageUploadElement.cloneNode(true);
    imageUploadElement.parentNode.replaceChild(newUpload, imageUploadElement);
    window.popupElements.imageUploadElement = newUpload;
  }

  if (detectButton) {
    const newButton = detectButton.cloneNode(true);
    detectButton.parentNode.replaceChild(newButton, detectButton);
    window.popupElements.detectButton = newButton;
  }

  // Get fresh references after replacement
  const freshUpload = document.getElementById('imageUpload');
  const freshButton = document.getElementById('detectButton');

  // Preview the image when selected (using named function for easy removal)
  freshUpload.addEventListener('change', handleImageUpload);

  // Detect objects when the button is clicked (using named function for easy removal)
  freshButton.addEventListener('click', handleDetection);

  // Load a default image
  const defaultImageUrl = 'local_tesseract/test2.png'; // Replace with the actual path to your default image
  const reader = new FileReader();
  const defaultImage = new Image();
  defaultImage.src = defaultImageUrl;

  defaultImage.onload = () => {
    imagePreviewElement.innerHTML = `<img src="${defaultImageUrl}" id="previewImage">`;
    window.imageData = defaultImageUrl; // Store the default image data
    console.log('Default image loaded');
  };

  defaultImage.onerror = () => {
    console.error('Failed to load default image');
  };

  console.log('Popup initialized with fresh event listeners');
}
// Named function for image upload handling
function handleImageUpload(event) {
  const file = event.target.files[0];
  if (!file) return;

  const imagePreviewElement = window.popupElements.imagePreviewElement;

  const reader = new FileReader();
  reader.onload = (e) => {
    // Display the image
    imagePreviewElement.innerHTML = `<img src="${e.target.result}" id="previewImage">`;
    window.imageData = e.target.result;
  };
  reader.readAsDataURL(file);
}

// Named function for detection handling
function handleDetection() {
  console.log('Detection button clicked at:', new Date().toISOString());

  const { outputElement, detectButton, subsectionImagesContainer } = window.popupElements;

  if (!window.imageData) {
    outputElement.innerText = 'Please select an image first.';
    return;
  }

  // Clear previous results
  outputElement.innerText = 'Processing...';
  detectButton.disabled = true;
  detectButton.textContent = 'Detecting...';

  subsectionImagesContainer.innerHTML = '';

  // Remove previous bounding boxes if any
  const boxes = document.querySelectorAll('.bounding-box');
  boxes.forEach(box => box.remove());

  // Bundle the input data into a message
  const message = {
    action: 'initDetection',
    imageData: window.imageData
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
      // outputElement.innerText = JSON.stringify(response.results.text, null, 2);

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

      // Draw bounding boxes and masks on the image
      if (response.results && response.results.length > 0) {
        response.results.forEach(detection => renderBoxAndMask(detection, imgWidth, imgHeight));
      } else {
        outputElement.innerText += '\nNo objects detected in this image.';
      }
      outputElement.innerText = 'Detection complete!';
      detectButton.disabled = false;
      detectButton.textContent = 'Detect Objects';
    });
  } catch (e) {
    outputElement.innerText = `Error sending message: ${e.message}`;
    detectButton.disabled = false;
    detectButton.textContent = 'Detect Objects';
  }
}

// Clean up event listeners when popup is closed
function cleanupEventListeners() {
  if (window.popupElements) {
    const { imageUploadElement, detectButton } = window.popupElements;

    if (imageUploadElement) {
      imageUploadElement.removeEventListener('change', handleImageUpload);
    }

    if (detectButton) {
      detectButton.removeEventListener('click', handleDetection);
    }

    // Clear references
    window.popupElements = null;
    window.imageData = null;

    console.log('Popup event listeners cleaned up');
  }
}

// Improve the renderBoxAndMask function in popup.js to better display the detected text:

function renderBoxAndMask(detection, imgWidth, imgHeight) {
  try {
    const { x1, y1, x2, y2, confidence, mask, subsectionImg, text } = detection;
    // console.log('Rendering box and mask:', confidence,);
    const imagePreviewElement = window.popupElements.imagePreviewElement;
    const subsectionImagesContainer = window.popupElements.subsectionImagesContainer;
    const outputElement = window.popupElements.outputElement;

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
    const boxWidth = scaledX2 - scaledX1;
    const boxHeight = scaledY2 - scaledY1;

    // Create a bounding box element
    const boxElement = document.createElement('div');
    boxElement.className = 'bounding-box';
    boxElement.style.position = 'absolute';
    boxElement.style.left = `${scaledX1}px`;
    boxElement.style.top = `${scaledY1}px`;
    boxElement.style.width = `${boxWidth}px`;
    boxElement.style.height = `${boxHeight}px`;
    boxElement.style.border = '2px solid rgba(0, 255, 0, 0)';
    boxElement.style.boxSizing = 'border-box';
    boxElement.style.pointerEvents = 'none';

    // Add an ID for the bubble
    const bubbleId = `bubble-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    boxElement.id = bubbleId;

    // Add the box to the image container
    imagePreviewElement.appendChild(boxElement);

    // Create a separate canvas for masking each bubble
    const maskCanvas = document.createElement('canvas');
    maskCanvas.width = imgWidth;
    maskCanvas.height = imgHeight;
    maskCanvas.className = 'mask-canvas';
    maskCanvas.style.position = 'absolute';
    maskCanvas.style.left = '0';
    maskCanvas.style.top = '0';
    maskCanvas.style.pointerEvents = 'none';

    const maskCtx = maskCanvas.getContext('2d');

    // Load the mask image
    const maskImg = new Image();
    maskImg.onload = () => {
      // First create a clipping path in the shape of the bounding box
      maskCtx.beginPath();
      maskCtx.rect(scaledX1, scaledY1, boxWidth, boxHeight);
      maskCtx.clip();

      // Draw the mask with some color and transparency
      maskCtx.globalAlpha = 1; // Reduce transparency to 30% to make text more visible
      maskCtx.drawImage(maskImg, 0, 0, imgWidth, imgHeight);

      // Add the mask canvas to the image container
      imagePreviewElement.appendChild(maskCanvas);

      // Create a text div for better control than canvas text
      const textDiv = document.createElement('div');
      textDiv.className = 'bubble-text';
      textDiv.style.position = 'absolute';
      textDiv.style.left = `${scaledX1}px`;
      textDiv.style.top = `${scaledY1}px`;
      textDiv.style.width = `${boxWidth}px`;
      textDiv.style.height = `${boxHeight}px`; // Set height to match the bounding box
      textDiv.style.display = 'flex'; // Use flexbox for centering
      textDiv.style.alignItems = 'center'; // Center vertically
      textDiv.style.justifyContent = 'center'; // Center horizontally
      textDiv.style.textAlign = 'center'; // Center text within the div
      textDiv.style.overflow = 'hidden';
      textDiv.style.padding = '5px';
      textDiv.style.boxSizing = 'border-box';
      textDiv.style.backgroundColor = 'rgba(0, 0, 0, 0)';
      textDiv.style.color = 'black';
      textDiv.style.fontFamily = 'CC Wild Words, Comic Sans MS, Arial, sans-serif';
      textDiv.style.fontSize = '8px';
      textDiv.style.borderRadius = '3px';
      textDiv.style.zIndex = '100';
      textDiv.style.fontWeight = 'bold';
      textDiv.style.whiteSpace = 'normal'; // Allow text to wrap
      textDiv.style.wordWrap = 'break-word';

      // Set the text content
      if (text && text.trim()) {
        textDiv.textContent = text.trim();
      } else {
        textDiv.textContent = `No text detected (${(confidence * 100).toFixed(0)}%)`;
        textDiv.style.color = '#ffcccc';
      }

      // Add the text div to the image container
      imagePreviewElement.appendChild(textDiv);

      // Create a subsection card in the subsection container
      if (subsectionImg) {
        const cardElement = document.createElement('div');
        cardElement.className = 'subsection-card';
        cardElement.style.margin = '10px 0';
        cardElement.style.padding = '10px';
        cardElement.style.border = '1px solid #ccc';
        cardElement.style.borderRadius = '5px';
        cardElement.style.backgroundColor = '#f9f9f9';

        // Add reference to the bubble ID
        cardElement.dataset.bubbleId = bubbleId;

        // Create a header with confidence
        const header = document.createElement('div');
        header.style.marginBottom = '5px';
        header.style.fontWeight = 'bold';
        header.textContent = `Bubble ${subsectionImagesContainer.childElementCount + 1} (${(confidence * 100).toFixed(0)}%)`;
        cardElement.appendChild(header);

        // Add the subsection image
        const subsectionImgElement = new Image();
        subsectionImgElement.src = subsectionImg;
        subsectionImgElement.style.maxWidth = '100%';
        subsectionImgElement.style.border = '1px solid #ddd';
        cardElement.appendChild(subsectionImgElement);

        // Add the detected text
        const textElement = document.createElement('div');
        textElement.style.marginTop = '5px';
        textElement.style.padding = '5px';
        textElement.style.backgroundColor = '#fff';
        textElement.style.border = '1px solid #ddd';
        textElement.style.borderRadius = '3px';
        textElement.style.fontFamily = 'Comic Sans MS, Arial, sans-serif';

        if (text && text.trim()) {
          textElement.textContent = text.trim();
        } else {
          textElement.textContent = "No text detected";
          textElement.style.color = '#999';
        }

        cardElement.appendChild(textElement);

        // Add edit functionality
        const editButton = document.createElement('button');
        editButton.textContent = 'Edit Text';
        editButton.style.marginTop = '5px';
        editButton.style.padding = '3px 8px';
        editButton.style.backgroundColor = '#4CAF50';
        editButton.style.color = 'white';
        editButton.style.border = 'none';
        editButton.style.borderRadius = '3px';
        editButton.style.cursor = 'pointer';

        editButton.addEventListener('click', () => {
          const newText = prompt('Edit text:', textElement.textContent);
          if (newText !== null) {
            textElement.textContent = newText;

            // Also update the text on the image
            const textDivs = document.querySelectorAll('.bubble-text');
            const bubbleBoxes = document.querySelectorAll('.bounding-box');

            for (let i = 0; i < bubbleBoxes.length; i++) {
              if (bubbleBoxes[i].id === bubbleId && textDivs[i]) {
                textDivs[i].textContent = newText;
                break;
              }
            }
          }
        });

        cardElement.appendChild(editButton);

        // Add to the container
        subsectionImagesContainer.appendChild(cardElement);
      }
    };

    maskImg.onerror = (e) => {
      console.error('Error loading mask image:', e);
    };

    maskImg.src = mask;

  } catch (e) {
    console.error('Error rendering box and mask:', e);
  }
}
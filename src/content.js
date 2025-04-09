// content.js - Scan webpage for images and add detection functionality

// Global variables to track processed images and detection results
const processedImages = new Set();
const processingImages = new Map(); // Maps image IDs to processing status
const detectionResults = new Map();
let observer = null;

// Initialize when the page is fully loaded
document.addEventListener('DOMContentLoaded', () => {
  setTimeout(initializeImageDetection, 500);
});

// Also run initialization on load for cases where DOMContentLoaded already fired
window.addEventListener('load', () => {
  if (processedImages.size === 0) {
    setTimeout(initializeImageDetection, 500);
  }
});

// Run immediately if document is already complete
if (document.readyState === 'complete') {
  setTimeout(initializeImageDetection, 500);
}

// Set up message listener for responses from the background script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "detectionCompleted") {
    console.log("Got detection completed message:", message);
    handleDetectionResults(message.imageId, message.results, message.error);
    return false;
  }

  if (message.action === 'detectAllImages') {
    const images = document.querySelectorAll('img');
    images.forEach((img) => {
      if (img.naturalWidth >= 400 && img.naturalHeight >= 400) {
        handleDetectionRequest(img);
      }
    });
  }
});

// Main initialization function
function initializeImageDetection() {
  // Disconnect any existing observer to prevent recursion
  if (observer) {
    observer.disconnect();
  }

  // Find all images on the page that meet minimum size requirements
  const images = document.querySelectorAll('img');

  images.forEach(processImage);

  // Set up a MutationObserver to handle dynamically added images
  setupMutationObserver();
}

// Process a single image
function processImage(img) {
  // Skip if already processed or invalid
  if (processedImages.has(img) || !img.src || img.src.startsWith('data:')) {
    return;
  }

  // Check if image is loaded and has sufficient size
  if (img.complete) {
    if (img.naturalWidth >= 400 && img.naturalHeight >= 400) {
      processedImages.add(img);
      addDetectionButton(img);
    }
  } else {
    // If not loaded, add a one-time load listener
    img.addEventListener('load', function onLoad() {
      img.removeEventListener('load', onLoad);
      if (img.naturalWidth >= 400 && img.naturalHeight >= 400 && !processedImages.has(img)) {
        processedImages.add(img);
        addDetectionButton(img);
      }
    }, { once: true });
  }
}

// Add detection button to an image
function addDetectionButton(img) {
  // Skip if already has detection elements
  if (img.detectorElements) {
    return;
  }

  // Temporarily disable observer to prevent recursion
  if (observer) {
    observer.disconnect();
  }

  // Create wrapper element
  const wrapper = document.createElement('div');
  wrapper.className = 'comic-bubble-detector-wrapper';
  wrapper.style.position = 'relative'; // Ensure relative positioning for the button

  // Create button
  const button = document.createElement('button');
  button.className = 'comic-bubble-detector-button';
  button.textContent = '🔍';
  button.title = 'Detect comic bubbles';

  // Position the button at the top-left
  button.style.position = 'absolute';
  button.style.top = '0';
  button.style.left = '0';
  button.style.zIndex = '10'; // Ensure it appears above the image
  button.style.pointerEvents = 'auto'; // Allow clicks on the button

  // Create results container
  const resultsContainer = document.createElement('div');
  resultsContainer.className = 'comic-bubble-detector-results';
  resultsContainer.style.display = 'none';
  resultsContainer.style.pointerEvents = 'none'; // Prevent clicks on the results container

  // Insert wrapper before the image in DOM
  try {
    const parent = img.parentNode;
    if (parent) {
      // Insert wrapper
      parent.insertBefore(wrapper, img);

      // Move image inside wrapper
      wrapper.appendChild(img);

      // Add button and results container
      wrapper.appendChild(button);
      wrapper.appendChild(resultsContainer);

      // Store reference to elements
      img.detectorElements = {
        wrapper,
        button,
        resultsContainer
      };

      // Add click handler
      button.addEventListener('click', (event) => {
        event.stopPropagation(); // Prevent click from affecting underlying elements

        // If currently processing, do nothing
        if (button.dataset.processing === 'true') {
          return;
        }

        // If results exist and are hidden, show them
        if (resultsContainer.childNodes.length > 0 && resultsContainer.style.display === 'none') {
          resultsContainer.style.display = 'block';
          return;
        }

        // If results exist and are shown, hide them
        if (resultsContainer.childNodes.length > 0 && resultsContainer.style.display === 'block') {
          resultsContainer.style.display = 'none';
          return;
        }

        // If no results yet, process the image
        handleDetectionRequest(img);
      });
    }
  } catch (error) {
    console.error('Error adding detection button:', error);
  }

  // Re-enable observer
  setupMutationObserver();
}

// Handle click on detection button
function handleDetectionRequest(img) {
  // Generate a unique ID for this image if not already assigned
  const imageId = img.dataset.detectorId || `img_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
  img.dataset.detectorId = imageId;

  // Check if already processing
  if (processingImages.has(imageId) || img.detectorElements.button.dataset.processing === 'true') {
    console.log(`Image ${imageId} is already being processed, ignoring request`);
    return;
  }

  // Mark as processing
  processingImages.set(imageId, true);

  const { button, resultsContainer } = img.detectorElements;

  // Show loading state
  button.dataset.processing = 'true';
  button.textContent = '⏳';
  button.title = 'Processing image...';
  button.style.backgroundColor = 'rgba(200, 100, 0, 0.8)';

  // Add a processing indicator to the results container
  resultsContainer.innerHTML = '';
  const processingDiv = document.createElement('div');
  processingDiv.textContent = 'Processing image...';
  processingDiv.style.position = 'absolute';
  processingDiv.style.top = '50%';
  processingDiv.style.left = '50%';
  processingDiv.style.transform = 'translate(-50%, -50%)';
  processingDiv.style.background = 'rgba(0, 0, 0, 0.7)';
  processingDiv.style.color = 'white';
  processingDiv.style.padding = '10px';
  processingDiv.style.borderRadius = '5px';
  processingDiv.style.fontSize = '14px';
  resultsContainer.style.display = 'block';
  resultsContainer.appendChild(processingDiv);

  console.log(`Starting detection for image ${imageId}`);

  // Try to convert image to base64
  try {
    // Check for cross-origin restrictions
    if (isCrossOrigin(img.src) && !img.crossOrigin) {
      throw new Error('Cross-origin image cannot be processed. Try right-clicking and saving the image first.');
    }

    // Create off-screen canvas
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;

    const ctx = canvas.getContext('2d');

    try {
      // This may fail for cross-origin images
      ctx.drawImage(img, 0, 0);

      // Get base64 data
      const imageData = canvas.toDataURL('image/png');

      // Check if imageData is a valid base64 string
      if (!imageData || imageData === 'data:,') {
        throw new Error('Failed to convert image to data URL');
      }

      console.log(`Successfully converted image to base64, sending to background`);

      // Send to background script
      chrome.runtime.sendMessage({
        action: 'initWebpageDetection',
        imageData: imageData,
        imageId: imageId
      }).catch(error => {
        console.error(`Error sending message to background script: ${error.message}`);
        handleDetectionError(img, `Failed to send message to extension: ${error.message}`);
      });

    } catch (canvasError) {
      throw new Error(`Canvas error: ${canvasError.message}`);
    }
  } catch (e) {
    // Handle all errors
    console.error(`Error processing image: ${e.message}`);
    handleDetectionError(img, e.message);
  }
}

// Check if an image is cross-origin
function isCrossOrigin(url) {
  // Data URLs are same-origin
  if (url.startsWith('data:')) {
    return false;
  }

  try {
    const srcUrl = new URL(url);
    const locationUrl = new URL(window.location.href);

    // Compare origin parts
    return srcUrl.origin !== locationUrl.origin;
  } catch (e) {
    // If URL parsing fails, assume it's cross-origin
    return true;
  }
}

// Handle detection errors
function handleDetectionError(img, errorMessage) {
  if (!img.detectorElements) return;

  const { button, resultsContainer } = img.detectorElements;
  const imageId = img.dataset.detectorId;

  // Update button state
  button.dataset.processing = 'false';
  button.textContent = '❌';
  button.title = errorMessage;
  button.style.backgroundColor = 'rgba(255, 0, 0, 0.8)';

  // Display error message
  resultsContainer.innerHTML = '';
  const errorDiv = document.createElement('div');
  errorDiv.textContent = `Error: ${errorMessage}`;
  errorDiv.style.position = 'absolute';
  errorDiv.style.top = '50%';
  errorDiv.style.left = '50%';
  errorDiv.style.transform = 'translate(-50%, -50%)';
  errorDiv.style.background = 'rgba(255, 0, 0, 0.7)';
  errorDiv.style.color = 'white';
  errorDiv.style.padding = '10px';
  errorDiv.style.borderRadius = '5px';
  errorDiv.style.fontSize = '14px';
  errorDiv.style.maxWidth = '80%';
  errorDiv.style.textAlign = 'center';

  resultsContainer.style.display = 'block';
  resultsContainer.appendChild(errorDiv);

  // Clear processing status
  if (imageId) {
    processingImages.delete(imageId);
  }

  // Add retry capability
  setTimeout(() => {
    button.textContent = '🔄'; // Change to retry icon
    button.title = 'Error occurred. Click to retry.';
    button.style.backgroundColor = 'rgba(255, 165, 0, 0.8)'; // Orange for retry
  }, 3000);
}

// Handle detection results - with improved error handling
function handleDetectionResults(imageId, results, error) {
  console.log(`Received detection results for image ${imageId}`);

  // Find the image with this ID
  const img = document.querySelector(`[data-detector-id="${imageId}"]`);

  if (!img || !img.detectorElements) {
    console.error(`Image not found for results: ${imageId}`);
    return;
  }

  const { button, resultsContainer } = img.detectorElements;

  // Update button state
  button.dataset.processing = 'false';

  // Clear previous results
  resultsContainer.innerHTML = '';

  // Clear processing status
  processingImages.delete(imageId);

  // Handle errors
  if (error) {
    console.error(`Detection error for image ${imageId}: ${error}`);
    handleDetectionError(img, error);
    return;
  }

  // If no results or empty results
  // if (!results || results.length === 0) {
  //   button.textContent = '👁️';
  //   button.title = 'No bubbles found (click to retry)';
  //   button.style.backgroundColor = 'rgba(150, 150, 0, 0.8)';

  //   const noResults = document.createElement('div');
  //   noResults.textContent = 'No text bubbles detected';
  //   noResults.style.position = 'absolute';
  //   noResults.style.top = '50%';
  //   noResults.style.left = '50%';
  //   noResults.style.transform = 'translate(-50%, -50%)';
  //   noResults.style.background = 'rgba(0, 0, 0, 0.7)';
  //   noResults.style.color = 'white';
  //   noResults.style.padding = '10px';
  //   noResults.style.borderRadius = '5px';
  //   noResults.style.fontSize = '14px';

  //   resultsContainer.style.display = 'block';
  //   resultsContainer.appendChild(noResults);
  //   return;
  // }

  // Store results for future reference
  detectionResults.set(imageId, results);

  // Success - show results
  button.textContent = '👁️';
  button.title = 'Hide/Show detection results';
  button.style.backgroundColor = 'rgba(0, 200, 0, 0.8)';

  // Get image dimensions
  const actualWidth = img.naturalWidth;
  const actualHeight = img.naturalHeight;
  const imgWidth = img.width;
  const imgHeight = img.height;

  // Disable observer temporarily to prevent recursion
  if (observer) {
    observer.disconnect();
  }

  // Render results
  console.log(`Rendering ${results.length} detections for image ${imageId}`);
  results.forEach((detection, index) => {
    console.log(`Rendering detection ${index + 1}/${results.length}`);
    renderDetection(detection, resultsContainer, actualWidth, actualHeight, imgWidth, imgHeight);
  });

  // Show results
  resultsContainer.style.display = 'block';

  // Re-enable observer
  setupMutationObserver();
}

// Render a single detection
function renderDetection(detection, container, actualWidth, actualHeight, imgWidth, imgHeight) {
  const { x1, y1, x2, y2, translatedText, words, classIndex } = detection;

  // Skip invalid detections
  if (
    x1 === undefined ||
    y1 === undefined ||
    x2 === undefined ||
    y2 === undefined ||
    translatedText === ''
  ) {
    return;
  }

  // Calculate scaling factors
  const scaleX = imgWidth / actualWidth;
  const scaleY = imgHeight / actualHeight;

  const scaledX1 = x1 * scaleX;
  const scaledY1 = y1 * scaleY;
  const scaledX2 = x2 * scaleX;
  const scaledY2 = y2 * scaleY;
  const boxWidth = scaledX2 - scaledX1;
  const boxHeight = scaledY2 - scaledY1;

  // Estimate font size and scale it
  const estimatedFontSize = detection.fontSize; // Use detection's font size or fallback to box height
  const scaledFontSize = estimatedFontSize * scaleY;

  // Create a container for the detection
  const detectionContainer = document.createElement('div');
  detectionContainer.style.position = 'absolute';
  detectionContainer.style.left = `${scaledX1}px`;
  detectionContainer.style.top = `${scaledY1}px`;
  detectionContainer.style.width = `${boxWidth}px`;
  detectionContainer.style.height = `${boxHeight}px`;
  detectionContainer.style.zIndex = '3';
  detectionContainer.style.pointerEvents = 'none'; // Prevent clicks on the container

  // Set background style based on classIndex
  if (classIndex === 2) {
    detectionContainer.style.backgroundColor = 'rgba(0, 0, 0, 0)'; // Semi-transparent black
    detectionContainer.style.backdropFilter = 'blur(10px)'; // Apply heavy blur
  } else {
    detectionContainer.style.backgroundColor = 'rgba(255, 255, 255, 1)'; // Solid white
  }

  // Create text overlay
  const textDiv = document.createElement('div');
  textDiv.textContent = translatedText || 'No text detected';
  textDiv.style.position = 'absolute';
  textDiv.style.width = '100%';
  textDiv.style.height = '100%';
  textDiv.style.display = 'flex';
  textDiv.style.alignItems = 'center';
  textDiv.style.justifyContent = 'center';
  textDiv.style.fontFamily = 'CC Wild Words, Comic Sans MS, Arial, sans-serif';
  textDiv.style.fontWeight = 'bold';
  textDiv.style.fontStyle = 'italic';
  textDiv.style.zIndex = '4';
  textDiv.style.color = 'black';
  textDiv.style.fontSize = `${scaledFontSize}px`;
  textDiv.style.textAlign = 'center';
  textDiv.style.textShadow = `-1px -1px 0 white, 1px -1px 0 white, -1px  1px 0 white, 1px  1px 0 white`;

  // Append elements to the detection container
  detectionContainer.appendChild(textDiv);

  // Append the detection container to the main container
  container.appendChild(detectionContainer);
}

// function renderDetection(detection, container, actualWidth, actualHeight, imgWidth, imgHeight) {
//   const { x1, y1, x2, y2, translatedText, words, classIndex } = detection;

//   // Skip invalid detections
//   if (
//     x1 === undefined ||
//     y1 === undefined ||
//     x2 === undefined ||
//     y2 === undefined ||
//     translatedText === ''
//   ) {
//     return;
//   }

//   // Calculate scaling factors
//   const scaleX = imgWidth / actualWidth;
//   const scaleY = imgHeight / actualHeight;

//   // Draw word bounding boxes as filled rectangles
//   if (words && words.length > 0) {
//     const paddingFactor = 0.1; // 10% padding

//     words.forEach(word => {
//       const wordX1 = word.boundingBox[0].x * scaleX / 3;
//       const wordY1 = word.boundingBox[0].y * scaleY / 3;
//       const wordX2 = word.boundingBox[2].x * scaleX / 3;
//       const wordY2 = word.boundingBox[2].y * scaleY / 3;

//       // Calculate width and height of the box
//       const boxWidth = wordX2 - wordX1;
//       const boxHeight = wordY2 - wordY1;

//       // Apply padding
//       const paddedX1 = wordX1 - boxWidth * paddingFactor;
//       const paddedY1 = wordY1 - boxHeight * paddingFactor;
//       const paddedX2 = wordX2 + boxWidth * paddingFactor;
//       const paddedY2 = wordY2 + boxHeight * paddingFactor;

//       const wordBox = document.createElement('div');
//       wordBox.style.position = 'absolute';
//       wordBox.style.left = `${paddedX1}px`;
//       wordBox.style.top = `${paddedY1}px`;
//       wordBox.style.width = `${paddedX2 - paddedX1}px`;
//       wordBox.style.height = `${paddedY2 - paddedY1}px`;
//       wordBox.style.backgroundColor = 'rgba(255, 255, 255, 1)'; // Semi-transparent white background
//       wordBox.style.zIndex = '2'; // Ensure it appears below the text

//       container.appendChild(wordBox);
//     });
//   }

//   const scaledX1 = x1 * scaleX;
//   const scaledY1 = y1 * scaleY;
//   const scaledX2 = x2 * scaleX;
//   const scaledY2 = y2 * scaleY;
//   const boxWidth = scaledX2 - scaledX1;
//   const boxHeight = scaledY2 - scaledY1;

//   // Estimate font size and scale it
//   const estimatedFontSize = detection.fontSize; // Use detection's font size or fallback to box height
//   const scaledFontSize = estimatedFontSize * scaleY;

//   // Create a container for the detection
//   const detectionContainer = document.createElement('div');
//   detectionContainer.style.position = 'absolute';
//   detectionContainer.style.left = `${scaledX1}px`;
//   detectionContainer.style.top = `${scaledY1}px`;
//   detectionContainer.style.width = `${boxWidth}px`;
//   detectionContainer.style.height = `${boxHeight}px`;
//   detectionContainer.style.zIndex = '3';
//   detectionContainer.style.pointerEvents = 'none'; // Prevent clicks on the container

//   // Create text overlay
//   const textDiv = document.createElement('div');
//   textDiv.textContent = translatedText || 'No text detected';
//   textDiv.style.position = 'absolute';
//   textDiv.style.width = '100%';
//   textDiv.style.height = '100%';
//   textDiv.style.display = 'flex';
//   textDiv.style.alignItems = 'center';
//   textDiv.style.justifyContent = 'center';
//   textDiv.style.fontFamily = 'CC Wild Words, Comic Sans MS, Arial, sans-serif';
//   textDiv.style.fontWeight = 'bold';
//   textDiv.style.fontStyle = 'italic';
//   textDiv.style.zIndex = '4';
//   textDiv.style.backgroundColor = 'rgba(255, 255, 255, 0)';
//   textDiv.style.color = 'black';
//   textDiv.style.fontSize = `${scaledFontSize}px`;
//   textDiv.style.textAlign = 'center';
//   textDiv.style.textShadow = `-1px -1px 0 white, 1px -1px 0 white, -1px  1px 0 white, 1px  1px 0 white`;

//   // Append elements to the detection container
//   detectionContainer.appendChild(textDiv);

//   // Append the detection container to the main container
//   container.appendChild(detectionContainer);
// }

// Set up mutation observer to handle dynamically added images

function setupMutationObserver() {
  // Clean up existing observer
  if (observer) {
    observer.disconnect();
  }

  // Create new observer
  observer = new MutationObserver((mutations) => {
    let newImages = [];

    // First collect all new images
    mutations.forEach(mutation => {
      if (mutation.type === 'childList') {
        mutation.addedNodes.forEach(node => {
          // Direct image nodes
          if (node.nodeName === 'IMG') {
            newImages.push(node);
          }

          // Images inside added elements
          if (node.nodeType === Node.ELEMENT_NODE) {
            const images = node.querySelectorAll('img');
            images.forEach(img => newImages.push(img));
          }
        });
      }
    });

    // Deduplicate images
    newImages = [...new Set(newImages)];

    // Process in batches to avoid stack overflow
    if (newImages.length > 0) {
      // Process first 10 images immediately
      const firstBatch = newImages.slice(0, 10);
      firstBatch.forEach(processImage);

      // Process remaining images with delay
      if (newImages.length > 10) {
        const remainingBatches = [];
        for (let i = 10; i < newImages.length; i += 10) {
          remainingBatches.push(newImages.slice(i, i + 10));
        }

        // Process remaining batches with increasing delays
        remainingBatches.forEach((batch, index) => {
          setTimeout(() => {
            batch.forEach(processImage);
          }, 100 * (index + 1));
        });
      }
    }
  });

  // Start observing
  observer.observe(document.body, {
    childList: true,
    subtree: true
  });
}
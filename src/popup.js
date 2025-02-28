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

    // Remove previous bounding boxes if any
    const boxes = document.querySelectorAll('.bounding-box');
    boxes.forEach(box => box.remove());

    // Bundle the input data into a message
    const message = {
        action: 'detectObjects',
        imageData: imageData
    };

    // Send this message to the service worker
    chrome.runtime.sendMessage(message, (response) => {
        if (response.error) {
            outputElement.innerText = `Error: ${response.error}`;
            return;
        }

        // Display results as text
        outputElement.innerText = JSON.stringify(response.results, null, 2);

        // Get the actual rendered dimensions of the image
        const img = document.getElementById('previewImage');
        const imgWidth = img.clientWidth;
        const imgHeight = img.clientHeight;

        // Draw bounding boxes on the image
        response.results.forEach(detection => renderBox(detection, imgWidth, imgHeight));
    });
});

function renderBox(detection, imgWidth, imgHeight) {
    const { box, label, score } = detection;
    const { xmax, xmin, ymax, ymin } = box;

    // Generate a random color for the box
    const color = '#' + Math.floor(Math.random() * 0xFFFFFF).toString(16).padStart(6, '0');

    // Create the box element
    const boxElement = document.createElement('div');
    boxElement.className = 'bounding-box';

    // Position the box relative to the image container
    // The model returns values as percentages (0-1), so we multiply by container dimensions
    boxElement.style.position = 'absolute';
    boxElement.style.left = `${xmin * 100}%`;
    boxElement.style.top = `${ymin * 100}%`;
    boxElement.style.width = `${(xmax - xmin) * 100}%`;
    boxElement.style.height = `${(ymax - ymin) * 100}%`;
    boxElement.style.border = `2px solid ${color}`;
    boxElement.style.boxSizing = 'border-box';
    boxElement.style.pointerEvents = 'none';

    // Create and style the label
    const labelElement = document.createElement('span');
    labelElement.textContent = `${label} (${Math.round(score * 100)}%)`;
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
}
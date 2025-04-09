
// Convert base64 image to ImageData
export async function base64ToImageData(base64Image) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = function () {
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const imageData = ctx.getImageData(0, 0, img.width, img.height);
      resolve({ imageData, width: img.width, height: img.height, img });
    };
    img.onerror = reject;
    img.src = base64Image;
  });
}

// Here's how we can modify your key image processing functions to use canvas API throughout

// Helper function to create canvas from ImageData
export function imageDataToCanvas(imageData) {
  const canvas = document.createElement('canvas');
  canvas.width = imageData.width;
  canvas.height = imageData.height;
  const ctx = canvas.getContext('2d');
  ctx.putImageData(imageData, 0, 0);
  return { canvas, ctx };
}

// Helper function to get ImageData from canvas
export function canvasToImageData(canvas) {
  const ctx = canvas.getContext('2d');
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

// Convert to grayscale using canvas operations
export function toGrayscale(imageData) {
  const { canvas, ctx } = imageDataToCanvas(imageData);
  const newImageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = newImageData.data;

  for (let i = 0; i < data.length; i += 4) {
    const avg = (data[i] + data[i + 1] + data[i + 2]) / 3;
    data[i] = data[i + 1] = data[i + 2] = avg;
  }

  ctx.putImageData(newImageData, 0, 0);
  return newImageData;
}

// Resize image using canvas operations
export function resizeImageData(imageData, newWidth, newHeight) {
  const { canvas, ctx } = imageDataToCanvas(imageData);

  // Create a new canvas with the target dimensions
  const resizedCanvas = document.createElement('canvas');
  resizedCanvas.width = newWidth;
  resizedCanvas.height = newHeight;
  const resizedCtx = resizedCanvas.getContext('2d');

  // Enable smooth interpolation
  resizedCtx.imageSmoothingEnabled = true;
  resizedCtx.imageSmoothingQuality = 'high';

  // Draw the original canvas onto the resized canvas
  resizedCtx.drawImage(canvas, 0, 0, newWidth, newHeight);

  // Return the ImageData from the resized canvas
  return resizedCtx.getImageData(0, 0, newWidth, newHeight);
}

// Crop an image using canvas operations
export function cropImageData(imageData, x, y, width, height) {
  const { canvas, ctx } = imageDataToCanvas(imageData);

  // Ensure crop region is within bounds
  x = Math.max(0, x);
  y = Math.max(0, y);
  width = Math.min(width, imageData.width - x);
  height = Math.min(height, imageData.height - y);

  // Create a new canvas for the cropped region
  const croppedCanvas = document.createElement('canvas');
  croppedCanvas.width = width;
  croppedCanvas.height = height;
  const croppedCtx = croppedCanvas.getContext('2d');

  // Draw the cropped region
  croppedCtx.drawImage(canvas, x, y, width, height, 0, 0, width, height);

  // Return the ImageData from the cropped canvas
  return croppedCtx.getImageData(0, 0, width, height);
}

// Apply a simple blur filter using canvas operations
export function blurImageData(imageData, radius) {
  // For a simple implementation, we can use a CSS filter
  const { canvas, ctx } = imageDataToCanvas(imageData);

  const blurredCanvas = document.createElement('canvas');
  blurredCanvas.width = canvas.width;
  blurredCanvas.height = canvas.height;
  const blurredCtx = blurredCanvas.getContext('2d');

  // Apply blur filter
  blurredCtx.filter = `blur(${radius}px)`;
  blurredCtx.drawImage(canvas, 0, 0);

  // Clear the filter
  blurredCtx.filter = 'none';

  return blurredCtx.getImageData(0, 0, blurredCanvas.width, blurredCanvas.height);
}

export async function resizeImage(imageOrBase64, scaleFactor) {
  // Convert base64 string to an HTMLImageElement if necessary
  const image = typeof imageOrBase64 === 'string'
    ? await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = imageOrBase64;
    })
    : imageOrBase64;

  // Create an offscreen canvas for resizing
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');

  // Calculate the target dimensions based on the scale factor
  const targetWidth = Math.round(image.width * scaleFactor);
  const targetHeight = Math.round(image.height * scaleFactor);

  // Set the target dimensions
  canvas.width = targetWidth;
  canvas.height = targetHeight;

  // Enable cubic interpolation
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high'; // Use 'high' for cubic interpolation

  // Draw the resized image onto the canvas
  ctx.drawImage(image, 0, 0, targetWidth, targetHeight);

  // Return the resized image as a base64 string
  return canvas.toDataURL();
}

export function calculateIoU(box1, box2) {
  const x1 = Math.max(box1.x1, box2.x1);
  const y1 = Math.max(box1.y1, box2.y1);
  const x2 = Math.min(box1.x2, box2.x2);
  const y2 = Math.min(box1.y2, box2.y2);

  const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const box1Area = (box1.x2 - box1.x1) * (box1.y2 - box1.y1);
  const box2Area = (box2.x2 - box2.x1) * (box2.y2 - box2.y1);

  return intersection / (box1Area + box2Area - intersection);
}

export function nonMaxSuppression(detections, iouThreshold) {
  detections.sort((a, b) => b.confidence - a.confidence);
  const finalDetections = [];

  while (detections.length > 0) {
    const best = detections.shift();
    finalDetections.push(best);
    detections = detections.filter(box => calculateIoU(best, box) < iouThreshold);
  }

  return finalDetections;
}

// Image processing functions

/**
 * Traces a contour starting from a point
 * @param {ImageData} imageData - Binary image data
 * @param {number} startX - Starting X coordinate
 * @param {number} startY - Starting Y coordinate
 * @returns {Array<{x: number, y: number}>} - Array of contour points
 */
export function traceContour(imageData, startX, startY) {
  const visited = new Set();
  const contour = [];
  let x = startX;
  let y = startY;
  const width = imageData.width;

  const directions = [
    [1, 0], [1, 1], [0, 1], [-1, 1],
    [-1, 0], [-1, -1], [0, -1], [1, -1]
  ];

  do {
    visited.add(`${x},${y}`);
    contour.push({ x, y });

    let found = false;
    for (const [dx, dy] of directions) {
      const newX = x + dx;
      const newY = y + dy;

      if (newX >= 0 && newX < imageData.width &&
        newY >= 0 && newY < imageData.height) {
        const idx = (newY * width + newX) * 4;
        if (imageData.data[idx] === 255 && !visited.has(`${newX},${newY}`)) {
          x = newX;
          y = newY;
          found = true;
          break;
        }
      }
    }

    if (!found) break;
  } while (x !== startX || y !== startY);

  return contour;
}

/**
 * Finds all contours in a binary image
 * @param {ImageData} imageData - Binary image data
 * @returns {Array<Array<{x: number, y: number}>>} - Array of contours
 */
export function findContours(imageData) {
  const width = imageData.width;
  const height = imageData.height;
  const visited = new Set();
  const contours = [];

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      if (imageData.data[idx] === 255 && !visited.has(`${x},${y}`)) {
        const contour = traceContour(imageData, x, y);
        if (contour.length > 0) {
          contours.push(contour);
        }
      }
    }
  }

  return contours;
}

/**
 * Checks if a contour is enclosed (doesn't touch image borders)
 * @param {Array<{x: number, y: number}>} contour - Contour points
 * @param {number} width - Image width
 * @param {number} height - Image height
 * @returns {boolean}
 */
export function isEnclosedContour(contour, width, height) {
  return !contour.some(point =>
    point.x === 0 || point.x === width - 1 ||
    point.y === 0 || point.y === height - 1
  );
}

/**
 * Checks if a point is inside a polygon using ray casting algorithm
 * @param {{x: number, y: number}} point - Test point
 * @param {Array<{x: number, y: number}>} polygon - Polygon vertices
 * @returns {boolean}
 */
export function isPointInPolygon(point, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x, yi = polygon[i].y;
    const xj = polygon[j].x, yj = polygon[j].y;

    const intersect = ((yi > point.y) !== (yj > point.y))
      && (point.x < (xj - xi) * (point.y - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * Creates a mask highlighting enclosed text regions
 * @param {ImageData} binaryImage - Binary image data
 * @returns {ImageData} - Mask with filled enclosed contours
 */
export function createTextRegionMask(binaryImage) {
  const contours = findContours(binaryImage);
  const mask = new ImageData(
    new Uint8ClampedArray(binaryImage.data),
    binaryImage.width,
    binaryImage.height
  );

  contours.forEach(contour => {
    if (isEnclosedContour(contour, binaryImage.width, binaryImage.height)) {
      // Find bounding box
      const minX = Math.min(...contour.map(p => p.x));
      const maxX = Math.max(...contour.map(p => p.x));
      const minY = Math.min(...contour.map(p => p.y));
      const maxY = Math.max(...contour.map(p => p.y));

      // Fill contour
      for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
          if (isPointInPolygon({ x, y }, contour)) {
            const idx = (y * binaryImage.width + x) * 4;
            mask.data[idx] = mask.data[idx + 1] = mask.data[idx + 2] = 255;
            mask.data[idx + 3] = 255;
          }
        }
      }
    }
  });

  return mask;
}

// Perform radial blur on edges using elliptical gradient
export function blurEdgesWithGradient(image, blurRadius = 10) {
  // Convert to greyscale if needed
  let processedSubsection = image.colorModel === 'GREY' ? image.clone() : image.grey();

  // Create a blurred version of the entire image
  const blurredImage = processedSubsection.blurFilter({ radius: blurRadius });

  // Calculate the dimensions for the elliptical gradient
  const centerX = Math.floor(processedSubsection.width / 2);
  const centerY = Math.floor(processedSubsection.height / 2);
  // Increase these values to push the blur closer to the edges (max value around 0.9)
  const radiusX = Math.floor(processedSubsection.width * 1);  // Changed from 0.45 to 0.8
  const radiusY = Math.floor(processedSubsection.height * 1); // Changed from 0.45 to 0.8

  // Create a gradient mask with the same dimensions as our image
  const gradientMask = new ImageJS(processedSubsection.width, processedSubsection.height, {
    kind: 'GREY'
  });

  // Fill the gradient mask with values based on distance from center
  for (let y = 0; y < gradientMask.height; y++) {
    for (let x = 0; x < gradientMask.width; x++) {
      // Calculate normalized distance from center (0 to 1+)
      const normalizedDistance =
        Math.sqrt(
          Math.pow(x - centerX, 2) / Math.pow(radiusX, 2) +
          Math.pow(y - centerY, 2) / Math.pow(radiusY, 2)
        );

      let maskValue = 0;
      if (normalizedDistance <= 1) {
        const transitionPower = 2;
        maskValue = Math.pow(Math.cos(normalizedDistance * Math.PI / 2), transitionPower);
      }

      // Set the mask value (scaled to image bit depth)
      const scaledValue = Math.round(maskValue * gradientMask.maxValue);
      gradientMask.setValueXY(x, y, 0, scaledValue);
    }
  }

  // Create a result image to hold our combined result
  const result = processedSubsection.clone();

  // Combine the original image and the blurred image based on the gradient mask
  for (let y = 0; y < result.height; y++) {
    for (let x = 0; x < result.width; x++) {
      // Get the mask value (normalized to [0,1])
      const maskValue = gradientMask.getValueXY(x, y, 0) / gradientMask.maxValue;

      for (let c = 0; c < result.channels; c++) {
        // Linear interpolation between original and blurred image
        const originalValue = processedSubsection.getValueXY(x, y, c);
        const blurredValue = blurredImage.getValueXY(x, y, c);
        const blendedValue = Math.round(
          originalValue * maskValue + blurredValue * (1 - maskValue)
        );

        result.setValueXY(x, y, c, blendedValue);
      }
    }
  }

  return result;
}

/**
 * Creates a data URL for displaying an ImageData object
 * @param {ImageData} imageData - Image data to display
 * @returns {string} - Data URL that can be logged or displayed
 */
export function imageDataToDataURL(imageData) {
  const canvas = document.createElement('canvas');
  canvas.width = imageData.width;
  canvas.height = imageData.height;
  const ctx = canvas.getContext('2d');
  ctx.putImageData(imageData, 0, 0);
  return canvas.toDataURL();
}


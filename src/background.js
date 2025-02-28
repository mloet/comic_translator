// background.js - Modified for YOLOv8 model

import { pipeline, env } from '@xenova/transformers';

// Enable local models
env.allowLocalModels = true;
env.backends.onnx.wasm.numThreads = 1;

class PipelineSingleton {
    static task = 'object-detection';
    static model = 'comic-bubble-detector/onnx'; // Path to your local model folder
    static instance = null;

    static async getInstance(progress_callback = null) {
        if (this.instance === null) {
            this.instance = pipeline(this.task, this.model, { progress_callback });
        }

        return this.instance;
    }
}

// Process image and detect objects
const detectObjects = async (imageData) => {
    try {
        let model = await PipelineSingleton.getInstance((data) => {
            console.log(data);
        });

        // YOLOv8 models typically return normalized coordinates (0-1)
        let result = await model(imageData, {
            threshold: 0.25,
            iou_threshold: 0.45,
            percentage: true, // Return coordinates as percentages
        });

        // Format the results to match the expected structure for visualization
        const formattedResults = result.map(detection => ({
            score: detection.score,
            label: detection.label,
            box: {
                xmin: detection.box.xmin,
                ymin: detection.box.ymin,
                xmax: detection.box.xmax,
                ymax: detection.box.ymax
            }
        }));

        return { results: formattedResults };
    } catch (error) {
        console.error('Error in object detection:', error);
        console.error('Stack trace:', error.stack);
        return { error: error.message };
    }
};

// Listen for messages from popup.js
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'detectObjects') {
        (async function () {
            try {
                const result = await detectObjects(message.imageData);
                sendResponse(result);
            } catch (error) {
                sendResponse({ error: error.message });
            }
        })();
        return true; // Required to use sendResponse asynchronously
    }
});
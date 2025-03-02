// background.js - Handles requests from the UI, runs the model, then sends back a response

import { pipeline, env } from '@xenova/transformers';

env.allowLocalModels = false;
env.backends.onnx.wasm.numThreads = 1;

class PipelineSingleton {
    static task = 'object-detection';
    static model = 'Xenova/detr-resnet-50';
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
        });;

        let result = await model(imageData, {
            threshold: 0.5,
            percentage: true,
        });

        return { results: result };
    } catch (error) {
        console.error('Error in object detection:', error);
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
        return true;
    }
});

import path from 'path';
import { fileURLToPath } from 'url';

import HtmlWebpackPlugin from 'html-webpack-plugin';
import CopyPlugin from 'copy-webpack-plugin';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const config = {
    mode: 'development',
    devtool: 'inline-source-map',
    entry: {
        background: './src/background.js',
        popup: './src/popup.js',
        content: './src/content.js',
        offscreen: './src/offscreen.js'
    },
    output: {
        path: path.resolve(__dirname, 'build'),
        filename: '[name].js',
    },
    plugins: [
        new HtmlWebpackPlugin({
            template: './src/popup.html',
            filename: 'popup.html',
            chunks: ['popup']
        }),
        new HtmlWebpackPlugin({
            template: './src/offscreen.html',
            filename: 'offscreen.html',
            chunks: ['offscreen']
        }),
        new CopyPlugin({
            patterns: [
                {
                    from: "public",
                    to: "." // Copies to build folder
                },
                {
                    from: "src/popup.css",
                    to: "popup.css"
                },
                // Add pattern for model files - make sure the path is correct
                {
                    from: "models",
                    to: "models",
                    globOptions: {
                        ignore: ["**/*.txt", "**/.DS_Store"],
                    }
                }
            ],
        })
    ],
    // Increase limits for ONNX models which can be large
    performance: {
        hints: false,
        maxEntrypointSize: 10485760, // 10MB
        maxAssetSize: 10485760 // 10MB
    }
};

export default config;
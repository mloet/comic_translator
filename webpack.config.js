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
    },
    output: {
        path: path.resolve(__dirname, 'build'),
        filename: '[name].js',
    },
    plugins: [
        new HtmlWebpackPlugin({
            template: './src/popup.html',
            filename: 'popup.html',
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
                // Add new pattern for model files
                {
                    from: "models",
                    to: "models",
                    // Optional: you can add filtering if needed
                    // globOptions: {
                    //     ignore: ["**/*.txt", "**/.DS_Store"],
                    // }
                }
            ],
        })
    ],
    // Add this to handle large files properly
    performance: {
        hints: false,
        maxEntrypointSize: 512000,
        maxAssetSize: 512000
    }
};

export default config;
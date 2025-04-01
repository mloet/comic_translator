import path from 'path';
import { fileURLToPath } from 'url';
import HtmlWebpackPlugin from 'html-webpack-plugin';
import CopyPlugin from 'copy-webpack-plugin';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const config = {
    mode: 'development', // Automatically sets process.env.NODE_ENV
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
                    to: "."
                },
                {
                    from: "src/popup.css",
                    to: "popup.css"
                },
                {
                    from: "src/content-styles.css",
                    to: "content-styles.css"
                },
                {
                    from: "models",
                    to: "models",
                    globOptions: {
                        ignore: ["**/*.txt", "**/.DS_Store"],
                    }
                },
                {
                    from: "local_libraries/tesseract.js-core/tesseract-core-simd-lstm.wasm.js",
                    to: "local_libraries/tesseract.js-core/tesseract-core-simd-lstm.wasm.js"
                },
                {
                    from: "local_libraries/dist/worker.min.js",
                    to: "local_libraries/worker.min.js"
                },
                {
                    from: "local_libraries/test2.png",
                    to: "local_libraries/test2.png"
                }
            ],
        })
    ],
    performance: {
        hints: false,
        maxEntrypointSize: 10485760, // 10MB
        maxAssetSize: 10485760 // 10MB
    }
};

export default config;
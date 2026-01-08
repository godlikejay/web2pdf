const http = require('http');
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const CONCURRENCY_LIMIT = parseInt(process.env.CONCURRENCY_LIMIT || '5', 10);
const ERROR_RESTART_THRESHOLD = parseInt(process.env.ERROR_RESTART_THRESHOLD || '5', 10);
const ERROR_RESET_THRESHOLD = parseInt(process.env.ERROR_RESET_THRESHOLD || '3', 10);
const MAX_REQUEST_BODY_SIZE = parseInt(process.env.MAX_REQUEST_BODY_SIZE || '10485760', 10); // Default 10MB
const MAX_RENDER_DELAY = parseInt(process.env.MAX_RENDER_DELAY || '30000', 10); // Default 30s
const MAX_TIMEOUT = parseInt(process.env.MAX_TIMEOUT || '60000', 10); // Default 60s
const MAX_REQUESTS_BEFORE_RESTART = parseInt(process.env.MAX_REQUESTS_BEFORE_RESTART || '1000', 10); // Default 1000 requests

const TEMP_DIR = path.join(__dirname, 'temp_html');

// Ensure temp directory exists
if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
}

let browser = null;
let isRestarting = false;
let currentPageCount = 0;
let errorCount = 0;
let successStreak = 0;
let totalRequestsProcessed = 0;
const queue = [];

const startBrowser = async () => {
    try {
        console.log('Starting browser...');
        browser = await puppeteer.launch({
            args: ['--no-sandbox', '--disable-dev-shm-usage'],
            headless: true
        });
        browser.on('disconnected', async () => {
            if (!isRestarting) {
                console.error('Browser disconnected unexpectedly. Restarting...');
                await restartBrowser();
            }
        });
        console.log(`Browser is ${browser ? 'active' : 'inactive'}`);
    } catch (error) {
        console.error('Failed to start browser:', error);
        process.exit(1);
    }
};

const closeBrowser = async () => {
    if (browser) {
        try {
            await browser.close();
            console.log('Browser instance closed.');
        } catch (error) {
            console.error('Error closing browser:', error);
        }
        browser = null;
    }
};

const restartBrowser = async () => {
    if (isRestarting) return;
    isRestarting = true;
    console.log('Restarting browser... waiting for active tasks to finish.');

    // Wait for all active pages to be released with a timeout
    let waitTime = 0;
    const MAX_WAIT_TIME = 30000; // 30 seconds timeout

    while (currentPageCount > 0 && waitTime < MAX_WAIT_TIME) {
        await new Promise(resolve => setTimeout(resolve, 500));
        waitTime += 500;
    }

    if (currentPageCount > 0) {
        console.warn(`Warning: ${currentPageCount} tasks did not finish in time. Forcing browser restart.`);
        currentPageCount = 0; // Force reset counter
    } else {
        console.log('All tasks finished. Proceeding with restart.');
    }

    await closeBrowser();
    await startBrowser();
    isRestarting = false;

    errorCount = 0;
    successStreak = 0;
    totalRequestsProcessed = 0;

    console.log('Browser restarted. Resuming queue processing...');
    processQueue();
};

const acquirePage = async () => {
    while (currentPageCount >= CONCURRENCY_LIMIT) {
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    currentPageCount++;
    try {
        const context = await browser.createBrowserContext();
        return await context.newPage();
    } catch (error) {
        currentPageCount--;
        throw error;
    }
};

const releasePage = async (page) => {
    try {
        if (page && !page.isClosed()) {
            const context = page.browserContext();
            await context.close();
        }
    } catch (error) {
        console.error('Error closing page context:', error);
    }
    currentPageCount--;
};

const processQueue = async () => {
    if (isRestarting) return;

    if (queue.length > 0 && currentPageCount < CONCURRENCY_LIMIT) {
        const { resolve, reject, task } = queue.shift();
        let page = null;
        try {
            page = await acquirePage();
            const result = await task(page);
            await releasePage(page);
            page = null; // Mark as released

            successStreak++;
            if (successStreak >= ERROR_RESET_THRESHOLD) {
                errorCount = 0;
                successStreak = 0;
            }
            resolve(result);

            totalRequestsProcessed++;
            if (MAX_REQUESTS_BEFORE_RESTART > 0 && totalRequestsProcessed >= MAX_REQUESTS_BEFORE_RESTART) {
                console.log(`Processed ${totalRequestsProcessed} requests. Restarting browser to release resources...`);
                // Trigger restart but don't await it here to avoid blocking current request flow logic unnecessarily,
                // though processQueue is recursive.
                // Since restartBrowser sets isRestarting=true, subsequent processQueue calls will pause.
                restartBrowser();
                return; // Stop processing queue until restart completes
            }

        } catch (error) {
            console.error('Error processing task:', error);
            if (page) {
                await releasePage(page);
            }
            reject(error);

            errorCount++;
            successStreak = 0;
            if (errorCount >= ERROR_RESTART_THRESHOLD) {
                console.error('Error count exceeded limit. Restarting browser...');
                restartBrowser();
                return; // Stop processing queue until restart completes
            }
        } finally {
            // Continue processing if not restarting
            if (!isRestarting) {
                processQueue();
            }
        }
    }
};

const addToQueue = (task) => {
    return new Promise((resolve, reject) => {
        queue.push({ resolve, reject, task });
        processQueue();
    });
};

const cleanupTempFiles = async () => {
    console.log('Cleaning up stale temporary files...');
    try {
        const files = await fs.promises.readdir(TEMP_DIR);
        for (const file of files) {
            if (file.endsWith('.html')) {
                await fs.promises.unlink(path.join(TEMP_DIR, file));
            }
        }
        console.log('Cleanup complete.');
    } catch (error) {
        console.error('Error cleaning up temp files:', error);
    }
};

const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
        if (browser && browser.isConnected() && !isRestarting) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'ok' }));
        } else {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'error', message: 'Browser not ready' }));
        }
    } else if (req.method === 'GET' && req.url.startsWith('/temp/')) {
        const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
        const filename = path.basename(parsedUrl.pathname);
        const filePath = path.join(TEMP_DIR, filename);

        // Security check: prevent directory traversal
        if (!path.resolve(filePath).startsWith(path.resolve(TEMP_DIR))) {
            res.writeHead(403);
            res.end('Forbidden');
            return;
        }

        try {
            await fs.promises.access(filePath, fs.constants.F_OK);
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            fs.createReadStream(filePath).pipe(res);
        } catch (err) {
            res.writeHead(404);
            res.end('Not Found');
        }
    } else if (req.method === 'POST' && req.url === '/generate-pdf') {
        const MAX_BODY_SIZE = MAX_REQUEST_BODY_SIZE;
        const bodyChunks = [];
        let bodySize = 0;

        req.on('data', chunk => {
            bodySize += chunk.length;
            if (bodySize > MAX_BODY_SIZE) {
                res.writeHead(413, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Request entity too large' }));
                req.destroy();
                return;
            }
            bodyChunks.push(chunk);
        });

        req.on('end', async () => {
            if (req.destroyed) return;
            try {
                const body = Buffer.concat(bodyChunks).toString();
                if (!body) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Empty request body' }));
                    return;
                }

                let params;
                try {
                    params = JSON.parse(body);
                } catch (e) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Invalid JSON' }));
                    return;
                }

                const { url, html, options, wait, mediaType, loadTimeout, printTimeout, renderDelay } = params;

                if (!url && !html) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'URL or HTML content is required' }));
                    return;
                }

                // Security: Prevent arbitrary file writes by removing 'path' from options
                const safeOptions = { ...options };
                if (safeOptions.path) delete safeOptions.path;

                // Security: Limit render delay to prevent holding resources too long
                // Priority: renderDelay > wait (backward compatibility)
                const rawDelay = (typeof renderDelay === 'number') ? renderDelay : (typeof wait === 'number' ? wait : 0);
                const finalDelay = Math.min(Math.max(rawDelay, 0), MAX_RENDER_DELAY);

                // Security check: validate URL protocol if URL is provided and HTML is not
                if (url && !html) {
                    try {
                        const parsedUrl = new URL(url);
                        if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
                            res.writeHead(400, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ error: 'Invalid URL protocol. Only http and https are allowed.' }));
                            return;
                        }
                    } catch (e) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'Invalid URL format' }));
                        return;
                    }
                }

                let targetUrl = url;
                let tempFilePath = null;

                if (html) {
                    const id = crypto.randomUUID();
                    const filename = `${id}.html`;
                    tempFilePath = path.join(TEMP_DIR, filename);
                    await fs.promises.writeFile(tempFilePath, html);
                    targetUrl = `http://localhost:${PORT}/temp/${filename}`;
                }

                addToQueue(async (page) => {
                    console.log(`Processing task: ${targetUrl}`);
                    try {
                        if (mediaType) {
                            console.log(`Setting media type to: ${mediaType}`);
                            await page.emulateMediaType(mediaType);
                        }

                        // Configure navigation (load) timeout with security limits
                        const gotoOptions = { waitUntil: 'networkidle2' };
                        if (typeof loadTimeout === 'number') {
                            let t = loadTimeout <= 0 ? MAX_TIMEOUT : loadTimeout;
                            gotoOptions.timeout = Math.min(t, MAX_TIMEOUT);
                        } else {
                            gotoOptions.timeout = MAX_TIMEOUT;
                        }

                        await page.goto(targetUrl, gotoOptions);

                        if (finalDelay > 0) {
                            console.log(`Waiting for ${finalDelay} ms...`);
                            await new Promise(resolve => setTimeout(resolve, finalDelay));
                        }

                        // Configure PDF generation (print) timeout with security limits
                        const pdfOptions = { format: 'A4', ...safeOptions };
                        if (typeof printTimeout === 'number') {
                            let t = printTimeout <= 0 ? MAX_TIMEOUT : printTimeout;
                            pdfOptions.timeout = Math.min(t, MAX_TIMEOUT);
                        } else {
                            pdfOptions.timeout = MAX_TIMEOUT;
                        }

                        return await page.pdf(pdfOptions);
                    } finally {
                        if (tempFilePath) {
                            try {
                                await fs.promises.unlink(tempFilePath);
                            } catch (err) {
                                console.error(`Error deleting temp file ${tempFilePath}:`, err);
                            }
                        }
                    }
                })
                    .then((pdfBuffer) => {
                        res.writeHead(200, { 'Content-Type': 'application/pdf' });
                        res.end(pdfBuffer);
                    })
                    .catch((error) => {
                        console.error('Error generating PDF:', error);
                        // Don't send error details to client for security, unless needed for debugging
                        res.writeHead(500, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'Failed to generate PDF' }));
                    });

            } catch (error) {
                console.error('Error processing request:', error);
                if (!res.headersSent) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Internal Server Error' }));
                }
            }
        });
    } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not Found' }));
    }
});

const gracefulShutdown = async (signal) => {
    console.log(`\nReceived ${signal}. Shutting down gracefully...`);

    server.close(() => {
        console.log('HTTP server closed.');
    });

    await closeBrowser();

    // Cleanup any remaining temp files
    await cleanupTempFiles();

    process.exit(0);
};

(async () => {
    await cleanupTempFiles(); // Cleanup on startup
    await startBrowser();
    server.listen(PORT, () => {
        console.log(`Server is running at http://localhost:${PORT}`);
    });
})();

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
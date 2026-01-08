const http = require('http');
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const CONCURRENCY_LIMIT = process.env.CONCURRENCY_LIMIT || 5;
const ERROR_RESTART_THRESHOLD = process.env.ERROR_RESTART_THRESHOLD || 5;
const ERROR_RESET_THRESHOLD = process.env.ERROR_RESET_THRESHOLD || 3;
const MAX_REQUEST_BODY_SIZE = parseInt(process.env.MAX_REQUEST_BODY_SIZE || '10485760', 10); // Default 10MB
const MAX_RENDER_DELAY = parseInt(process.env.MAX_RENDER_DELAY || '10000', 10); // Default 10s
const MAX_TIMEOUT = parseInt(process.env.MAX_TIMEOUT || '60000', 10); // Default 60s
const MAX_REQUESTS_BEFORE_RESTART = parseInt(process.env.MAX_REQUESTS_BEFORE_RESTART || '1000', 10);

const TEMP_DIR = path.join(__dirname, 'temp_html');

// ... (existing code) ...

let currentPageCount = 0;
let errorCount = 0;
let successStreak = 0;
let totalRequestsProcessed = 0;
const queue = [];

// ... (existing code) ...

const restartBrowser = async () => {
    if (isRestarting) return;
    isRestarting = true;
    console.log('Restarting browser...');
    await closeBrowser();
    await startBrowser();
    isRestarting = false;

    errorCount = 0;
    successStreak = 0;
    totalRequestsProcessed = 0; // Reset total counter

    console.log('Browser restarted. Resuming queue processing...');
    processQueue();
};

// ... (existing code) ...

const processQueue = async () => {
    if (queue.length > 0 && currentPageCount < CONCURRENCY_LIMIT) {
        const { resolve, reject, task } = queue.shift();
        let page = null;
        try {
            page = await acquirePage();
            const result = await task(page);
            await releasePage(page);

            successStreak++;
            if (successStreak >= ERROR_RESET_THRESHOLD) {
                errorCount = 0;
                successStreak = 0;
            }

            // Periodic restart check
            totalRequestsProcessed++;
            if (MAX_REQUESTS_BEFORE_RESTART > 0 && totalRequestsProcessed >= MAX_REQUESTS_BEFORE_RESTART) {
                console.log(`Processed ${totalRequestsProcessed} requests. Triggering scheduled browser restart...`);
                // Use setTimeout to allow current stack to unwind before restarting
                // But since restartBrowser awaits closeBrowser which awaits page closes, it should be safe.
                // However, we are currently inside processQueue recursion (via finally).
                // It's safer to flag for restart or call it.
                // Since processQueue is called in finally, we should be careful not to create a race condition.
                // But restartBrowser sets isRestarting=true which blocks other processQueue calls effectively.
                
                // We'll call restartBrowser() but return immediately to stop this 'thread' of processQueue
                // The restartBrowser function calls processQueue at the end.
                restartBrowser();
                return; 
            }

            resolve(result);
        } catch (error) {
// ... (existing code) ...

const startBrowser = async () => {
    try {
        console.log('Starting browser...');
        browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
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
    }
};

const restartBrowser = async () => {
    if (isRestarting) return;
    isRestarting = true;
    console.log('Restarting browser... waiting for active tasks to finish.');

    // Wait for all active pages to be released
    while (currentPageCount > 0) {
        await new Promise(resolve => setTimeout(resolve, 500));
    }

    console.log('All tasks finished. Proceeding with restart.');
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
        await new Promise(resolve => setTimeout(resolve, 100)); // 等待
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
        const context = page.browserContext();
        await context.close();
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

            successStreak++;
            if (successStreak >= ERROR_RESET_THRESHOLD) {
                errorCount = 0;
                successStreak = 0;
            }
            resolve(result);

            totalRequestsProcessed++;
            if (MAX_REQUESTS_BEFORE_RESTART > 0 && totalRequestsProcessed >= MAX_REQUESTS_BEFORE_RESTART) {
                console.log(`Processed ${totalRequestsProcessed} requests. Restarting browser to release resources...`);
                restartBrowser();
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
                await restartBrowser();
            }
        } finally {
            processQueue();
        }
    }
};

const addToQueue = (task) => {
    return new Promise((resolve, reject) => {
        queue.push({ resolve, reject, task });
        processQueue();
    });
};

const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
        if (browser && browser.isConnected()) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'ok' }));
        } else {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'error', message: 'Browser not connected' }));
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
const MAX_BODY_SIZE = parseInt(process.env.MAX_REQUEST_BODY_SIZE || '10485760', 10); // Default 10MB
const MAX_WAIT_TIME = parseInt(process.env.MAX_WAIT_TIME || '10000', 10); // Default 10s

// ... (existing code) ...

    } else if (req.method === 'POST' && req.url === '/generate-pdf') {
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
                const { url, html, options, wait, mediaType, loadTimeout, printTimeout, renderDelay } = JSON.parse(body);

                if (!url && !html) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'URL or HTML content is required' }));
                    return;
                }

                // Security: Prevent arbitrary file writes by removing 'path' from options
                const safeOptions = { ...options };
                delete safeOptions.path;

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
                    console.log(`new task: ${targetUrl}`);
                    try {
                        if (mediaType) {
                            console.log(`Setting media type to: ${mediaType}`);
                            await page.emulateMediaType(mediaType);
                        }

                        // Configure navigation (load) timeout with security limits
                        const gotoOptions = { waitUntil: 'networkidle2' };
                        if (typeof loadTimeout === 'number') {
                            // If 0 or larger than MAX_TIMEOUT, cap at MAX_TIMEOUT.
                            // If negative, treat as 0 (then cap).
                            let t = loadTimeout <= 0 ? MAX_TIMEOUT : loadTimeout;
                            gotoOptions.timeout = Math.min(t, MAX_TIMEOUT);
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
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Failed to generate PDF' }));
                });

            } catch (error) {
                console.error('Error parsing request:', error);
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid JSON' }));
            }
        });
    } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not Found' }));
    }
});

(async () => {
    await startBrowser();
    server.listen(PORT, () => {
        console.log(`Server is running at http://localhost:${PORT}`);
    });
})();

const gracefulShutdown = async (signal) => {
    console.log(`\nReceived ${signal}. Shutting down gracefully...`);
    
    server.close(() => {
        console.log('HTTP server closed.');
    });

    await closeBrowser();
    console.log('Browser instance closed.');

    process.exit(0);
};

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

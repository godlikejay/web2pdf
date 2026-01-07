const http = require('http');
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const CONCURRENCY_LIMIT = process.env.CONCURRENCY_LIMIT || 5;
const ERROR_RESTART_THRESHOLD = process.env.ERROR_RESTART_THRESHOLD || 5;
const ERROR_RESET_THRESHOLD = process.env.ERROR_RESET_THRESHOLD || 3;
const TEMP_DIR = path.join(__dirname, 'temp_html');

// Ensure temp directory exists
if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR);
}

let browser;
let isRestarting = false;
let currentPageCount = 0;
let errorCount = 0;
let successStreak = 0;
const queue = [];

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
    console.log('Restarting browser...');
    await closeBrowser();
    await startBrowser();
    isRestarting = false;

    errorCount = 0;
    successStreak = 0;

    console.log('Browser restarted. Resuming queue processing...');
    processQueue();
};

const acquirePage = async () => {
    while (currentPageCount >= CONCURRENCY_LIMIT) {
        await new Promise(resolve => setTimeout(resolve, 100)); // 等待
    }
    currentPageCount++;
    try {
        return await browser.newPage();
    } catch (error) {
        currentPageCount--;
        throw error;
    }
};

const releasePage = async (page) => {
    try {
        await page.close();
    } catch (error) {
        console.error('Error closing page:', error);
    }
    currentPageCount--;
};

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
            resolve(result);
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
        const filename = path.basename(req.url);
        const filePath = path.join(TEMP_DIR, filename);

        // Security check: prevent directory traversal
        if (!path.resolve(filePath).startsWith(path.resolve(TEMP_DIR))) {
            res.writeHead(403);
            res.end('Forbidden');
            return;
        }

        fs.readFile(filePath, (err, data) => {
            if (err) {
                res.writeHead(404);
                res.end('Not Found');
                return;
            }
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(data);
        });
    } else if (req.method === 'POST' && req.url === '/generate-pdf') {
        let body = '';

        req.on('data', chunk => {
            body += chunk.toString();
        });

        req.on('end', async () => {
            try {
                const { url, html, options, wait } = JSON.parse(body);

                if (!url && !html) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'URL or HTML content is required' }));
                    return;
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
                        await page.goto(targetUrl, { waitUntil: 'networkidle2' });
                        if (wait && typeof wait === 'number') {
                            console.log(`Waiting for ${wait} ms...`);
                            await new Promise(resolve => setTimeout(resolve, wait));
                        }
                        return await page.pdf({ format: 'A4', ...options });
                    } finally {
                        if (tempFilePath) {
                            fs.unlink(tempFilePath, (err) => {
                                if (err) console.error(`Error deleting temp file ${tempFilePath}:`, err);
                            });
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

process.on('SIGINT', async () => {
    console.log('\nClosing browser instance...');
    await closeBrowser();
    process.exit(0);
});

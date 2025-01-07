const http = require('http');
const puppeteer = require('puppeteer');

const PORT = process.env.PORT || 3000;;
const CONCURRENCY_LIMIT = process.env.CONCURRENCY_LIMIT || 5;
const ERROR_RESTART_THRESHOLD = process.env.PORT || 5;
const ERROR_RESET_THRESHOLD = process.env.PORT || 3;

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
        console.log('Browser started.');
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
};

const acquirePage = async () => {
    while (currentPageCount >= CONCURRENCY_LIMIT) {
        await new Promise(resolve => setTimeout(resolve, 100)); // 等待
    }
    currentPageCount++;
    return await browser.newPage();
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
        try {
            const page = await acquirePage();
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
            reject(error);

            errorCount++;
            successStreak = 0;
            if (errorCount >= ERROR_RESTART_THRESHOLD) {
                console.error('Error count exceeded limit. Restarting browser...');
                await restartBrowser();
            }
        }
        processQueue();
    }
};

const addToQueue = (task) => {
    return new Promise((resolve, reject) => {
        queue.push({ resolve, reject, task });
        processQueue();
    });
};

const server = http.createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/generate-pdf') {
        let body = '';

        req.on('data', chunk => {
            body += chunk.toString();
        });

        req.on('end', async () => {
            try {
                const { url, options } = JSON.parse(body);

                if (!url) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'URL is required' }));
                    return;
                }

                addToQueue(async (page) => {
                    await page.goto(url, { waitUntil: 'networkidle2' });
                    return await page.pdf({ format: 'A4', ...options });
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

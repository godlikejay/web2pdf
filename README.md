# web2pdf

HTTP Server for generate PDFs from URLs

## Getting Started

### 1. Build the Docker Image

Clone the repository and navigate to the directory containing the Dockerfile.

**For AMD64 (Standard):**
```bash
docker build -t web2pdf .
```

**For ARM64 (Apple Silicon, Raspberry Pi):**
```bash
docker build -f Dockerfile.arm64 -t web2pdf .
```

You can also get the pre-built image from [ghcr.io](ghcr.io/godlikejay/web2pdf)

```bash
docker pull ghcr.io/godlikejay/web2pdf:latest
```

### 2. Run the Container

Run the service container using the following command:

```bash
docker run -d -p 3000:3000 --cap-add=SYS_ADMIN --rm --name web2pdf ghcr.io/godlikejay/web2pdf:latest
```

Note the image requires the `SYS_ADMIN` capability since the browser might run in sandbox mode.

### Run with Custom Configuration

You can adjust settings like concurrency limits by passing environment variables:

```bash
docker run -d -p 3000:3000 --cap-add=SYS_ADMIN --rm \
  -e CONCURRENCY_LIMIT=10 \
  -e ERROR_RESTART_THRESHOLD=10 \
  --name web2pdf \
  ghcr.io/godlikejay/web2pdf:latest
```

## Configuration

You can configure the service using environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Port the server listens on. |
| `CONCURRENCY_LIMIT` | `5` | Maximum number of concurrent PDF generation tasks. |
| `ERROR_RESTART_THRESHOLD` | `5` | Number of consecutive errors before restarting the browser. |
| `ERROR_RESET_THRESHOLD` | `3` | Number of consecutive successes to reset the error count. |

## Custom Fonts

This service supports custom fonts (e.g., for Chinese, Japanese, or special styling). You can add fonts in two ways:

### Method 1: Dynamic Loading (Recommended)

You can mount a local directory containing your font files (e.g., `.ttf`, `.otf`) to `/app/fonts` inside the container. The container will automatically install them at startup.

```bash
# 1. Prepare your fonts directory
mkdir -p my-fonts
cp /path/to/your/font.ttf my-fonts/

# 2. Run with volume mount
docker run -d -p 3000:3000 --cap-add=SYS_ADMIN --rm \
  -v $(pwd)/my-fonts:/app/fonts \
  --name web2pdf \
  ghcr.io/godlikejay/web2pdf:latest
```

### Method 2: Build into Image

If you prefer to package the fonts inside the image, you can create a custom `Dockerfile` extending this one:

```dockerfile
FROM ghcr.io/godlikejay/web2pdf:latest

# Switch to root to perform installation (if needed) or just copy to user font dir
USER pptruser

# Copy your fonts to the user's font directory
COPY ./my-fonts/*.ttf /home/pptruser/.fonts/

# Update font cache
USER root
RUN fc-cache -f -v
USER pptruser
```

Then build your custom image:
```bash
docker build -t my-web2pdf-with-fonts .
```

## Health Check

The service provides a health check endpoint for Kubernetes Liveness and Readiness probes.

**Endpoint**: `GET /health`

**Response**:
- `200 OK`: Browser instance is connected.
- `503 Service Unavailable`: Browser instance is disconnected or restarting.

## API Usage

### Endpoint

`POST /generate-pdf`

### Request Headers

- `Content-Type: application/json`

### Request Body

The service accepts JSON input with the following structure:

```json
{
  "url": "https://github.com/godlikejay/web2pdf",
  "options": {
    "format": "letter",
    "landscape": true,
    "printBackground": true
  }
}
```

- `url` (string, required): The URL of the page to generate the PDF from.
- `wait` (int, optional): the delay in milliseconds after the page loads.
- `options` (object, optional): Puppeteer PDF options. Refer to [Puppeteer documentation](https://pptr.dev/api/puppeteer.pdfoptions) for the full list of available options.

### Response

- Success: Returns a PDF file in binary format.
- Failure: Returns an error message in JSON format.

## Example with cURL

Run the following curl command to generate a PDF:

```bash
curl -X POST http://localhost:3000/generate-pdf \
-H "Content-Type: application/json" \
-d '{
  "url": "https://github.com/godlikejay/web2pdf",
  "options": {
    "format": "letter",
    "printBackground": true
  }
}' --output output.pdf
```

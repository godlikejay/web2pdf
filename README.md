# web2pdf

HTTP Server for generate PDFs from URLs

## Getting Started

### 1. Build the Docker Image

Clone the repository and navigate to the directory containing the Dockerfile. Build the Docker image using the following command:

```bash
docker build -t web2pdf .
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

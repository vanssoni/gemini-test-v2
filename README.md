# PDF Text Extraction Comparison Tool

Compare PDF text extraction between **Google Gemini 3 Pro** and **AWS Textract** with a beautiful, modern web interface.

## Features

- 📄 **PDF Upload** - Drag-and-drop or click to upload PDF files (up to 15MB)
- 🤖 **Gemini 3 Pro** - Google's latest AI model for text extraction
- ☁️ **AWS Textract** - Amazon's OCR service
- ⚡ **Non-Blocking Processing** - Results appear independently as each service completes
- ⏱️ **Performance Metrics** - See extraction time for each service
- 🎨 **Modern UI** - Beautiful dark theme with gradients and animations
- 📋 **Copy to Clipboard** - Easy copying of extracted text test

## Deploy to Vercel

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/yourusername/pdf-extraction-comparison)

### Quick Deploy Steps

1. **Click the Deploy button** or run:
   ```bash
   vercel
   ```

2. **Set Environment Variables** in Vercel Dashboard:
   - `GEMINI_API_KEY` - From https://makersuite.google.com/app/apikey
   - `AWS_ACCESS_KEY_ID` - Your AWS access key
   - `AWS_SECRET_ACCESS_KEY` - Your AWS secret key
   - `AWS_REGION` - e.g., `ap-south-1`
   - `AWS_REPORT_BUCKET` - Your S3 bucket name

3. **Deploy!** Your app will be live at `https://your-app.vercel.app`

### Important Notes for Vercel Deployment

- **Timeout**: Set to 60 seconds for PDF processing
- **Memory**: 1GB allocated for handling larger PDFs
- **Serverless Functions**: Each API endpoint runs as a serverless function
- **Cold Starts**: First request may be slower due to cold start

## Local Development

### Prerequisites

- Node.js (v14 or higher)
- AWS Account with Textract access
- Google AI API Key (Gemini)

### Setup

1. **Install Dependencies**
   ```bash
   npm install
   ```

2. **Configure Environment Variables**
   
   Create a `.env` file:
   ```env
   # AWS Textract Configuration
   AWS_ACCESS_KEY_ID=your_aws_access_key_id
   AWS_SECRET_ACCESS_KEY=your_aws_secret_access_key
   AWS_REGION=ap-south-1
   AWS_REPORT_BUCKET=your_s3_bucket_name

   # Google Gemini Configuration
   GEMINI_API_KEY=your_gemini_api_key_here

   # Server Configuration
   PORT=3000
   ```

3. **Start the Server**
   ```bash
   npm start
   ```

   The application will be available at: **http://localhost:3000**

## API Endpoints

### POST `/api/extract/gemini`
Extract text using Google Gemini 3 Pro.

**Request:**
- Method: `POST`
- Content-Type: `multipart/form-data`
- Body: PDF file with field name `pdf`

**Response:**
```json
{
  "success": true,
  "service": "gemini",
  "text": "Extracted text...",
  "time": 1234,
  "error": null
}
```

### POST `/api/extract/textract`
Extract text using AWS Textract.

**Request:**
- Method: `POST`
- Content-Type: `multipart/form-data`
- Body: PDF file with field name `pdf`

**Response:**
```json
{
  "success": true,
  "service": "textract",
  "text": "Extracted text...",
  "time": 2345,
  "error": null
}
```

### GET `/api/health`
Health check endpoint.

**Response:**
```json
{
  "status": "ok",
  "timestamp": "2026-01-16T12:10:59.000Z"
}
```

## Technologies Used

- **Backend:** Node.js, Express.js
- **File Upload:** Multer
- **AWS SDK:** AWS Textract and S3
- **Google AI:** @google/generative-ai (Gemini 3 Pro)
- **Frontend:** Vanilla HTML, CSS, JavaScript
- **Deployment:** Vercel (Serverless)

## Architecture

- **Separate Endpoints**: Gemini and Textract process independently
- **Non-Blocking**: Results display as soon as each service completes
- **S3 Integration**: Textract uses temporary S3 storage for regional compatibility
- **Auto Cleanup**: Temporary S3 files are automatically deleted

## Troubleshooting

**Vercel Deployment Issues:**
- Ensure all environment variables are set in Vercel Dashboard
- Check function logs in Vercel for errors
- Verify AWS credentials have Textract and S3 permissions

**Gemini Errors:**
- Verify API key is correct
- Check API quota at https://ai.dev/rate-limit
- Ensure you're using a valid Gemini API key from Google AI Studio

**Textract Errors:**
- Verify AWS credentials are correct
- Check IAM permissions include Textract and S3 access
- Ensure S3 bucket exists and is in the correct region

## License

ISC

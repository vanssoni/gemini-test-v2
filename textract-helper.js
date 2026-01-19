const AWS = require('aws-sdk');
const { v4: uuidv4 } = require('uuid');

const s3 = new AWS.S3({
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    region: process.env.AWS_REGION
});

const textract = new AWS.Textract({
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    region: process.env.AWS_REGION
});

class TextractHelper {
    async sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Extract text from PDF buffer using AWS Textract
     * Uploads to S3 first, then processes with Textract
     * @param {Buffer} fileBuffer - PDF file buffer
     * @param {string} originalFilename - Original filename
     * @returns {Promise<string>} Extracted text
     */
    async extractTextFromPDF(fileBuffer, originalFilename = 'document.pdf') {
        const fileName = `textract-temp/${uuidv4()}-${originalFilename}`;

        try {
            // Step 1: Upload to S3
            console.log('Uploading PDF to S3...');
            await s3.putObject({
                Bucket: process.env.AWS_REPORT_BUCKET,
                Key: fileName,
                Body: fileBuffer,
                ContentType: 'application/pdf'
            }).promise();

            // Step 2: Start Textract job
            console.log('Starting Textract job...');
            const startJob = await textract.startDocumentTextDetection({
                DocumentLocation: {
                    S3Object: {
                        Bucket: process.env.AWS_REPORT_BUCKET,
                        Name: fileName
                    }
                }
            }).promise();

            const jobId = startJob.JobId;

            // Step 3: Poll for completion
            let jobStatus = '';
            let extractedText = '';

            do {
                await this.sleep(3000); // Poll every 3 seconds
                const status = await textract.getDocumentTextDetection({ JobId: jobId }).promise();
                jobStatus = status.JobStatus;

                if (jobStatus === 'SUCCEEDED') {
                    let nextToken;

                    do {
                        const result = await textract.getDocumentTextDetection({
                            JobId: jobId,
                            NextToken: nextToken
                        }).promise();

                        result.Blocks.forEach(block => {
                            if (block.BlockType === 'LINE') {
                                extractedText += block.Text + '\n';
                            }
                        });

                        nextToken = result.NextToken;
                    } while (nextToken);

                } else if (jobStatus === 'FAILED') {
                    throw new Error('Textract job failed');
                }
            } while (jobStatus === 'IN_PROGRESS');

            // Step 4: Clean up - delete temporary S3 file
            try {
                await s3.deleteObject({
                    Bucket: process.env.AWS_REPORT_BUCKET,
                    Key: fileName
                }).promise();
                console.log('Cleaned up temporary S3 file');
            } catch (deleteError) {
                console.warn('Failed to delete temporary file:', deleteError.message);
            }

            return extractedText;

        } catch (err) {
            // Clean up on error
            try {
                await s3.deleteObject({
                    Bucket: process.env.AWS_REPORT_BUCKET,
                    Key: fileName
                }).promise();
            } catch (deleteError) {
                // Ignore cleanup errors
            }

            console.error('Textract extraction error:', err);
            throw new Error(`Textract extraction failed: ${err.message}`);
        }
    }
}

module.exports = new TextractHelper();

const AWS = require('aws-sdk');
const textract = new AWS.Textract({
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    region: process.env.AWS_REGION
});
class TextractHelper {
    async sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
    // Function to extract text from an image
    async extractTextFromImage(fileUrl) {
        const params = {
            Document: {
                S3Object: {
                    Bucket: process.env.AWS_REPORT_BUCKET,
                    Name: fileUrl.split('/').pop() // Assuming fileUrl is the S3 URL
                }
            }
        };

        try {
            await this.sleep(1000);
            const data = await textract.detectDocumentText(params).promise();
            let extractedText = '';
            data.Blocks.forEach(block => {
                if (block.BlockType === 'LINE') {
                    extractedText += block.Text + '\n';
                }
            });
            return extractedText;
        } catch (err) {
            throw err;
        }
    }

    async extractTextFromPDF(fileUrl) {
        const fileName = fileUrl.split('/').pop();

        const params = {
            DocumentLocation: {
                S3Object: {
                    Bucket: process.env.AWS_REPORT_BUCKET,
                    Name: fileName
                }
            }
        };

        try {
            // await this.sleep(1000);
            const startJob = await textract.startDocumentTextDetection(params).promise();
            const jobId = startJob.JobId;

            let jobStatus = '';
            do {
                await this.sleep(5000);
                const status = await textract.getDocumentTextDetection({ JobId: jobId }).promise();
                jobStatus = status.JobStatus;

                if (jobStatus === 'SUCCEEDED') {
                    let extractedText = '';
                    let nextToken;

                    do {
                        // await this.sleep(500);
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

                    return extractedText;
                } else if (jobStatus === 'FAILED') {
                    throw new Error('Textract PDF job failed');
                }
            } while (jobStatus === 'IN_PROGRESS');

        } catch (err) {
            throw err;
        }
    }
}

module.exports = new TextractHelper();

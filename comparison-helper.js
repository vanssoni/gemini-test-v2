const OpenAI = require("openai");

class ComparisonHelper {
    constructor() {
        this.client = new OpenAI({
            apiKey: process.env.OPENAI_API_KEY
        });
    }

    cleanResponse(response) {
        if (!response) {
            throw new Error(`No response received from AI`);
        }

        // Check if the response is wrapped with ```json and ```
        const match = response.match(/```json\n([\s\S]*?)\n```/);

        let jsonString;
        if (match && match[1]) {
            // If wrapped in ```json, extract the JSON string
            jsonString = match[1];
        } else {
            // If not wrapped in ```json, assume the whole response is the JSON
            jsonString = response;
        }

        try {
            return JSON.parse(jsonString);
        } catch (error) {
            throw new Error(`Unable to parse json: ${jsonString}`);
        }
    }

    async compareMedicalOutputs(output1, output2) {
        const prompt = `
You are given two JSON outputs extracted from the same medical report.

Input:
- output1 = JSON from AI Model 1 (reference)
- output2 = JSON from AI Model 2 (to evaluate)

Task:
1. Count how many unique medical data points exist in each output.
2. A data point means any medically meaningful observation that has a value (lab test, vital, measurement, clinical finding, etc.).
3. Ignore metadata like patient info, dates, IDs, empty fields, nulls, headers, or reference ranges without values.
4. If the same test appears multiple times, count it only once.
5. Compare coverage only — do NOT validate correctness of values.
6. Accuracy = (total_data_points_in_output2 / total_data_points_in_output1) * 100
7. If output1 count is 0, accuracy must be 0.
8. Round accuracy to 2 decimal places.

Return ONLY this JSON format:
{
  "total_data_points_in_input": 0,
  "total_data_points_in_output": 0,
  "accuracy": 0
}

output1:
${JSON.stringify(output1)}

output2:
${JSON.stringify(output2)}
`;

        try {
            const response = await this.client.chat.completions.create({
                model: "gpt-4.1", 
                temperature: 0.1,
                messages: [
                    { role: "system", content: prompt }
                ]
            });

            const result = response.choices[0].message.content;

            // Use cleanResponse to parse key
            return this.cleanResponse(result);
        } catch (error) {
            console.error("Comparison error:", error);
            throw error;
        }
    }
}

module.exports = new ComparisonHelper();

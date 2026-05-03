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

Scope: only compare the "tests and conditions" content — i.e. lab tests,
vital signs, measurements, clinical findings, and named medical
conditions/diagnoses that have a value. Each output may store this data
under a "testsAndConditions" key, or under another key like "tests",
"results", "labs", "conditions", or directly at the root. Locate it
intelligently in each side; do not assume a fixed key name.

Task:
1. Identify the unique tests-and-conditions data points in each output
   and label each one with a short canonical name (e.g. "Hemoglobin",
   "Blood Pressure", "Type 2 Diabetes"). Treat synonyms / case / minor
   formatting differences as the same data point.
2. A data point means any tests-and-conditions item that has a value.
   Ignore metadata like patient info, dates, IDs, empty fields, nulls,
   headers, or reference ranges without values.
3. If the same item appears multiple times in one side, count it only once.
4. Compare coverage only — do NOT validate correctness of values.
5. matched_data_points  = items present in BOTH output1 and output2.
6. missed_data_points   = items in output1 but NOT in output2.
7. extra_data_points    = items in output2 but NOT in output1.
8. matched_count, missed_count, extra_count are the lengths of those lists.
9. total_data_points_in_input  = unique data points in output1.
10. total_data_points_in_output = unique data points in output2.
11. Accuracy = (matched_count / total_data_points_in_input) * 100
    (i.e. coverage of the reference). If total_data_points_in_input is 0,
    accuracy must be 0. Round to 2 decimal places.

Return ONLY this JSON format (no extra keys, no commentary):
{
  "total_data_points_in_input": 0,
  "total_data_points_in_output": 0,
  "accuracy": 0,
  "matched_data_points": [],
  "missed_data_points": [],
  "extra_data_points": [],
  "matched_count": 0,
  "missed_count": 0,
  "extra_count": 0
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

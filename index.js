const express = require('express');
const bodyParser = require('body-parser');
const dotenv = require('dotenv');
const OpenAI = require('openai');
const cors = require('cors');
const fs = require('fs');
const stringSimilarity = require('string-similarity');

dotenv.config();

const app = express();
app.use(bodyParser.json());
app.use(cors());

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Function to load JSON data
function loadJsonData(filePath) {
  if (fs.existsSync(filePath)) {
    const rawData = fs.readFileSync(filePath);
    return JSON.parse(rawData);
  }
  return { components: [] };
}

// Load existing data
const parsedComponents = loadJsonData('parsedComponents.json');

function findBestProductMatch(query, products) {
  if (products.length === 0) return null;

  let bestMatch = null;
  let highestScore = 0;

  products.forEach(product => {
    // Calculate similarity score between query and product title
    const score = stringSimilarity.compareTwoStrings(query.toLowerCase(), product.title.toLowerCase());

    // Update best match if this product has a higher score
    if (score > highestScore) {
      highestScore = score;
      bestMatch = { product, score };
    }
  });

  return bestMatch;
}

const fetchProductsAndCalculatePrice = (components, parsedComponents, similarityThreshold = 0.5) => {
  const requiredComponents = ["CPU", "GPU", "Motherboard", "RAM", "PSU", "CPU Cooler", "FAN", "PC case"];
  let fetchedProducts = [];
  let totalPrice = 0;

  for (const key of requiredComponents) {
    const component = components[key];
    const bestMatchProduct = findBestProductMatch(component, parsedComponents.components);

    if (bestMatchProduct && bestMatchProduct.score >= similarityThreshold) {
      fetchedProducts.push({ key, product: bestMatchProduct.product });
    }
  }

  const uniqueProducts = {};
  for (const { key, product } of fetchedProducts) {
    if (!uniqueProducts[key]) {
      uniqueProducts[key] = product;
    }
  }

  const productResponse = uniqueProducts;
  totalPrice = Object.values(productResponse).reduce((sum, product) => sum + parseInt(product.price, 10), 0);

  return { productResponse, totalPrice };
};

const getValidBuild = async (budget, systemPrompt, modelId) => {
  const budgetLowerLimit = budget - 90000;
  const budgetUpperLimit = budget + 90000;
  let attempts = 0;
  let usedTokens = 0;
  const maxAttempts = 20;
  let currentMessages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: `The budget for this build is ${budget} KZT. Please calculate the total price of the components and ensure that they are within the ${budget -90000} KZT - ${budget +90000} KZT price range` }
  ];

  while (attempts < maxAttempts) {
    attempts += 1;
    console.log(`Attempt ${attempts} to get a valid build`);

    console.log('Sending messages to OpenAI:', currentMessages);

    const result = await openai.chat.completions.create({
      model: modelId,
      messages: currentMessages,
    });

    const completionTokens = result.usage.completion_tokens;
    const promptTokens = result.usage.prompt_tokens;
    const totalTokens = result.usage.total_tokens;
    usedTokens += totalTokens;

    const responseText = result.choices[0].message.content;
    console.log('Received response from OpenAI: \n', responseText);

    let components;
    try {
      components = JSON.parse(responseText);
      console.log('Parsed components:', components);
    } catch (error) {
      console.error('Failed to parse JSON response from OpenAI:', error);
      continue; // Try again if JSON is not valid
    }

    const { productResponse, totalPrice } = fetchProductsAndCalculatePrice(components, parsedComponents);

    console.log('Fetched products:', productResponse);
    console.log('Total price:', totalPrice);
    console.log('Total tokens:', totalTokens);

    if (Object.keys(productResponse).length !== 8) {
      console.log('There are duplicate components or missing components in the build');
      continue; // Try again if there are duplicates or missing components
    }

    if (totalPrice >= budgetLowerLimit && totalPrice <= budgetUpperLimit) {
      console.log('Valid build found');
      return { components, productResponse, totalPrice };
    }

    console.log(`Build is not valid. Total price ${totalPrice} is not within 50,000 KZT of the budget (${budgetLowerLimit} - ${budgetUpperLimit}).`);

    const componentsWithPrices = Object.entries(productResponse)
      .map(([key, product]) => `${key}: ${product.title} - ${product.price} KZT`)
      .join(', ');

      const adjustmentPrompt = `CRITICAL ERROR: The current build's total price of ${totalPrice} KZT is not within the required range of ${budgetLowerLimit} KZT to ${budgetUpperLimit} KZT.
      Current components and prices: ${componentsWithPrices}.
      STRICT REQUIREMENT: Adjust the build to fall within the range of ${budgetLowerLimit} KZT to ${budgetUpperLimit} KZT. This is NOT negotiable.
      MANDATORY: You MUST calculate the total cost of your selected components before responding.
      CRUCIAL: Provide your response in the same JSON format as before. DO NOT include any explanations or text outside the JSON.
      REMEMBER: Budget adherence is the ONLY priority. Sacrifice performance if necessary to meet this requirement.`;
    currentMessages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: adjustmentPrompt }
    ];
  }
  throw new Error('Failed to generate a valid build within the budget and component constraints after multiple attempts.');
};

app.post('/api/generate', async (req, res) => {
  try {
    const { prompt, budget } = req.body;
    console.log('Received prompt:', prompt);
    console.log('Budget:', budget);

    const modelId = "gpt-4o-mini";
    const systemPrompt = `You are an assistant building PCs with an EXTREMELY STRICT focus on the user's budget of ${budget} KZT. The build MUST be compatible and MUST adhere to this exact budget.
    CRITICAL: Only use components from the provided JSON. Select components that PRECISELY match the ${budget} KZT budget.
    MANDATORY: The total cost of all components MUST be within the range of ${budget - 90000} KZT to ${budget + 90000} KZT. NO EXCEPTIONS.
    CRUCIAL: Respond ONLY in JSON format. List EXACTLY these components: CPU, GPU, Motherboard, RAM, PSU, CPU Cooler, FAN, PC case.
    DO NOT include any text outside the JSON. DO NOT use markdown formatting.
    BUDGET ADHERENCE IS PARAMOUNT. You MUST calculate the total cost of your selected components before responding and ensure it falls within the specified range.
    Here is the listing of all available components:
    ${JSON.stringify(parsedComponents)}
    Example response format (DO NOT copy these components, select based on the given ${budget} KZT budget):
    {
    "CPU": "AMD Ryzen 5 3600",
    "GPU": "Gigabyte GeForce GTX 1660 SUPER OC",
    "Motherboard": "Asus PRIME B450M-K",
    "RAM": "Corsair Vengeance LPX 16GB",
    "PSU": "EVGA 600 W1",
    "CPU Cooler": "Cooler Master Hyper 212",
    "FAN": "Noctua NF-P12",
    "PC case": "NZXT H510"
    }`;

    const { components, productResponse, totalPrice } = await getValidBuild(budget, systemPrompt, modelId);

    console.log('Sending response to frontend:', {
      adjustedResponse: JSON.stringify(components),
      products: productResponse,
      totalPrice: totalPrice,
      budgetDifference: totalPrice - budget
    });

    // Send response
    res.json({
      adjustedResponse: JSON.stringify(components),
      products: productResponse,
      totalPrice: totalPrice,
      budgetDifference: totalPrice - budget
    });

  } catch (err) {
    console.error('Error in generateResponse:', err);
    res.status(500).json({ message: "Internal server error" });
  }
});

app.post('/api/checkFPS', async (req, res) => {
  try {
    const { games, components } = req.body;
    console.log('Received games:', games);
    console.log('Received components:', components);

    const systemPrompt = `You are an expert in PC hardware and gaming performance. Given a list of PC components and games, estimate the FPS (Frames Per Second) Range for each game. Provide realistic estimates based on the hardware configuration.

Components:
${components.join(', ')}

Games:
${games.join(', ')}
IMPORTANT: FPS should be a range, not just a single number. For example: 90 is incorrect, while 90-120 is acceptable.
Respond with a JSON object where keys are game names and values are estimated FPS.
For example:
{
  "Cyberpunk 2077": 65-90,
  "Fortnite": 120-150,
  "Red Dead Redemption 2": 55-80
}

CRUCIAL: Provide your response in the same JSON format as before. DO NOT include any explanations or text outside the JSON.
     `;

    const result = await openai.chat.completions.create({
      model: "gpt-4-1106-preview", // Use an appropriate model
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: "Estimate FPS for the given games and components." }
      ],
      response_format: { type: "json_object" }
    });

    const responseText = result.choices[0].message.content;
    console.log('Received response from OpenAI:', responseText);

    let fpsEstimates;
    try {
      fpsEstimates = JSON.parse(responseText);
    } catch (error) {
      console.error('Failed to parse JSON response from OpenAI:', error);
      res.status(500).json({ message: "Failed to parse FPS estimates" });
      return;
    }

    console.log('Sending FPS estimates to frontend:', fpsEstimates);
    res.json(fpsEstimates);

  } catch (err) {
    console.error('Error in checkFPS:', err);
    res.status(500).json({ message: "Internal server error" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

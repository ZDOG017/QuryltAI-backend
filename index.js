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

// Function to save JSON data
function saveJsonData(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

// Load existing data
const parsedComponents = loadJsonData('parsedComponents.json');
const missingComponentsFile = 'missingComponents.json';

// Initialize missing components
let missingComponents = loadJsonData(missingComponentsFile).components || [];

const findBestMatch = (searchTerm, products) => {
  if (products.length === 0) return null;
  const productNames = products.map(product => product.title);
  const { bestMatch } = stringSimilarity.findBestMatch(searchTerm, productNames);
  const bestMatchIndex = productNames.indexOf(bestMatch.target);
  return products[bestMatchIndex] || null;
};

// Function to fetch products and calculate total price
const fetchProductsAndCalculatePrice = (components, parsedComponents) => {
  const requiredComponents = ["CPU", "GPU", "Motherboard", "RAM", "PSU", "CPU Cooler", "FAN", "PC case"];
  let fetchedProducts = [];
  let currentMissingComponents = [];
  let totalPrice = 0;

  for (const key of requiredComponents) {
    const component = components[key];
    const bestMatchProduct = findBestMatch(component, parsedComponents.components);
    if (bestMatchProduct) {
      fetchedProducts.push({ key, product: bestMatchProduct });
    } else {
      currentMissingComponents.push({ key, component });
    }
  }

  // Filter out duplicates, ensure only one of each component type
  const uniqueProducts = {};
  for (const { key, product } of fetchedProducts) {
    if (!uniqueProducts[key]) {
      uniqueProducts[key] = product;
    }
  }

  const productResponse = uniqueProducts;
  totalPrice = Object.values(productResponse).reduce((sum, product) => sum + parseInt(product.price, 10), 0);

  return { productResponse, currentMissingComponents, totalPrice };
};

const getValidBuild = async (budget, systemPrompt, modelId) => {
  const budgetLowerLimit = budget * 0.9;
  const budgetUpperLimit = budget * 1.1;
  let attempts = 0;
  const maxAttempts = 20;
  let currentMessages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: `The budget for this build is ${budget} KZT.` }
  ];

  while (attempts < maxAttempts) {
    attempts += 1;
    console.log(`Attempt ${attempts} to get a valid build`);

    console.log('Sending messages to OpenAI:', currentMessages);

    const result = await openai.chat.completions.create({
      model: modelId,
      messages: currentMessages,
    });

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

    const { productResponse, currentMissingComponents, totalPrice } = fetchProductsAndCalculatePrice(components, parsedComponents);

    console.log('Fetched products:', productResponse);
    console.log('Missing components:', currentMissingComponents);
    console.log('Total price:', totalPrice);

    // Check if there are duplicate components or missing components
    if (Object.keys(productResponse).length !== 8 || currentMissingComponents.length > 0) {
      console.log('There are duplicate components or missing components in the build');
      continue; // Try again if there are duplicates or missing components
    }

    if (totalPrice >= budgetLowerLimit && totalPrice <= budgetUpperLimit) {
      console.log('Valid build found');
      return { components, productResponse, totalPrice };
    }

    console.log(`Build is not valid. Total price ${totalPrice} is not within 10% of the budget (${budgetLowerLimit} - ${budgetUpperLimit}).`);

    // If not valid, prepare adjustment prompt with current components and their prices
    const componentsWithPrices = Object.entries(productResponse)
      .map(([key, product]) => `${key}: ${product.title} - ${product.price} KZT`)
      .join(', ');

    const adjustmentPrompt = `The current build has a total price of ${totalPrice} KZT, which is not within 10% of the budget (${budget} KZT).
    Current components and prices: ${componentsWithPrices}.
    ${currentMissingComponents.length > 0 ? `The following components were not found: ${currentMissingComponents.map(comp => comp.key).join(', ')}.` : ''}
    Please adjust the build to be closer to the budget.
    If the current total price is below the budget, suggest more expensive components incrementally and vice versa.
    STRICTLY: Provide your response in the same JSON format as before. Ensure the total cost does not exceed the budget and remains within 10% of the budget.
    Also, please ensure that all components are real PC components.`;

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
    const systemPrompt = `You are an assistant helping to build PCs with a focus on budget of the user and the build should be compatible with the components.
    IMPORTANT: Use the components that are widely available in Kazakhstan. The components should be from kaspi.kz
    IMPORTANT: Look up the prices that are in Kaspi.kz and in KZT (Tenge).
    IMPORTANT: Make a build that accurately or closely matches the desired budget of the user and DON'T comment on this. IMPORTANT: take the real-time prices of the components from kaspi.kz. 
    IMPORTANT: Dont write anything except JSON Format. STRICTLY list only the component names in JSON format, with each component type as a key and the component name as the value. DO NOT WRITE ANYTHING EXCEPT THE JSON. The response must include exactly these components: CPU, GPU, Motherboard, RAM, PSU, CPU Cooler, FAN, PC case. Use components that are most popular in Kazakhstan's stores in July 2024. Before answering, check the prices today in Kazakhstan.
    IMPORTANT: please dont send '''json {code} '''
    Example of the response:
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

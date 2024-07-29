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

app.post('/api/generate', async (req, res) => {
  try {
    const { prompt, budget } = req.body;
    console.log('Received prompt:', prompt);
    console.log('Budget:', budget);

    const modelId = "gpt-4o-mini";
    const systemPrompt = `You are an assistant helping to build PCs with a focus on speed, affordability, and reliability.
    Make a research on the prices of the components and components themselves in Kazakhstan.
    Look up the prices strictly in KZT.
    Suggest components that are commonly available and offer good value for money.
    Prefer newer, widely available models over older or niche products.
    IMPORTANT: Make a build that accurately or closely matches the desired budget of the user and DON'T comment on this. IMPORTANT: take the real-time prices of the components from kaspi.kz. 
    IMPORTANT: Dont write anything except JSON Format. STRICTLY list only the component names in JSON format, with each component type as a key and the component name as the value. DO NOT WRITE ANYTHING EXCEPT THE JSON. The response must include exactly these components: CPU, GPU, Motherboard, RAM, PSU, CPU Cooler, FAN, PC case. Use components that are most popular in Kazakhstan's stores in July 2024. Before answering, check the prices today in Kazakhstan.
    IMPORTANT: please dont send '''json {code} '''
    IMPORTANT: Please choose pricier gpu and cpu. Main budget should be focused on GPU.
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

    const currentMessages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: `The budget for this build is ${budget} KZT.` }
    ];

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
    } catch (error) {
      throw new Error('Failed to parse JSON response from OpenAI');
    }

    const requiredComponents = ["CPU", "GPU", "Motherboard", "RAM", "PSU", "CPU Cooler", "FAN", "PC case"];
    const componentKeys = Object.keys(components);

    if (!requiredComponents.every(comp => componentKeys.includes(comp))) {
      throw new Error('OpenAI response is missing one or more required components');
    }

    let fetchedProducts = [];
    let currentMissingComponents = [];
    let productResponse = {};
    let totalPrice = 0;
    let adjustedResponseText = null;

    // Function to fetch products and calculate total price
    const fetchProductsAndCalculatePrice = () => {
      fetchedProducts = [];
      currentMissingComponents = [];
      for (const key of requiredComponents) {
        const component = components[key];
        const bestMatchProduct = findBestMatch(component, parsedComponents.components);
        if (bestMatchProduct) {
          fetchedProducts.push({ key, product: bestMatchProduct });
        } else {
          currentMissingComponents.push({ key, component });
        }
      }

      productResponse = fetchedProducts.reduce((acc, { key, product }) => {
        if (product) {
          acc[key] = product;
        }
        return acc;
      }, {});

      totalPrice = Object.values(productResponse).reduce((sum, product) => sum + parseInt(product.price, 10), 0);
    };

    // Initial fetch and price calculation
    fetchProductsAndCalculatePrice();

    // Always perform adjustment
    const componentsWithPrices = Object.entries(productResponse)
      .map(([key, product]) => `${key}: ${product.title} - ${product.price} KZT`)
      .join(', ');

    const adjustmentPrompt = `The current build has a total price of ${totalPrice} KZT, which may not be within 10% of the budget (${budget} KZT).
    Current components and prices: ${componentsWithPrices}.
    ${currentMissingComponents.length > 0 ? `The following components were not found: ${currentMissingComponents.map(comp => comp.key).join(', ')}.` : ''}
    Please adjust the build to be closer to the budget while maintaining performance. Suggest alternatives for any missing components.
    STRICTLY: Provide your response in the same JSON format as before. Ensure the total cost does not exceed the budget and remains within 10% of the budget.
    Also, please ensure that all components are real PC components.`;

    const adjustmentMessages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: adjustmentPrompt }
    ];

    const adjustmentResult = await openai.chat.completions.create({
      model: modelId,
      messages: adjustmentMessages,
    });

    adjustedResponseText = adjustmentResult.choices[0].message.content;
    console.log('Received adjusted response from OpenAI: \n', adjustedResponseText);

    try {
      components = JSON.parse(adjustedResponseText);
      fetchProductsAndCalculatePrice();

      if (currentMissingComponents.length > 0) {
        missingComponents = missingComponents.concat(currentMissingComponents);
        saveJsonData(missingComponentsFile, { components: missingComponents });
      }
    } catch (error) {
      console.error('Failed to parse adjusted JSON response from OpenAI:', error);
    }

    // Send only one response at the end
    res.json({
      adjustedResponse: adjustedResponseText,
      products: productResponse,
      totalPrice: totalPrice,
      missingComponents: currentMissingComponents,
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

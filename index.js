const axios = require('axios');

const searchProduct = async (productName) => {
  const query = encodeURIComponent(productName);
  const searchUrl = `https://kaspi.kz/shop/search/?text=${query}&hint_chips_click=false`;
  const jsonUrl = `https://kaspi.kz/yml/product-view/pl/filters?text=${query}&hint_chips_click=false&page=0&all=false&fl=true&ui=d&q=%3AavailableInZones%3AMagnum_ZONE1&i=-1&c=750000000`;

  const headers = {
    'Host': 'kaspi.kz',
    'User-Agent': 'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0',
    'Accept': 'application/json, text/*',
    'Accept-Language': 'en-US,en;q=0.5',
    'Accept-Encoding': 'gzip, deflate, br, zstd',
    'X-KS-City': '750000000',
    'Connection': 'keep-alive',
    'Referer': searchUrl,
    'Cookie': 'ks.tg=71; k_stat=aa96833e-dac6-4558-a423-eacb2f0e53e4; kaspi.storefront.cookie.city=750000000',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin'
  };

  try {
    const response = await axios.get(jsonUrl, { headers });
    const data = response.data;
    const products = data.data.cards.map(card => ({
      id: card.id,
      title: card.title,
      brand: card.brand,
      price: card.unitPrice,
      salePrice: card.unitSalePrice,
      priceFormatted: card.priceFormatted,
      link: card.shopLink,
      image: card.previewImages[0].large,
      rating: card.rating,
      reviewsQuantity: card.reviewsQuantity
    }));
    console.log(products);
  } catch (error) {
    console.error('Error fetching the JSON data:', error);
  }
};

// Example usage
const productName = 'NVIDIA GTX 1660 SUPER';
searchProduct(productName);

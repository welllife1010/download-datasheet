// tokenService.js
const axios = require("axios")
require("dotenv").config()
const { getToken, isTokenExpired } = require("./accessToken")

// Function to ensure a valid token is always returned
async function getValidToken() {
  let token = await getToken()
  if (isTokenExpired(token)) {
    console.log("Token expired, fetching new token...")
    token = await getToken()
    console.log("New token fetched successfully.")
  }
  return token
}

module.exports = { getValidToken }

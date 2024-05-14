const axios = require("axios")
require("dotenv").config()

let accessToken = null
let tokenExpiryTime = null

async function getToken() {
  try {
    // Check if token is expired
    if (!accessToken || isTokenExpired()) {
      const tokenResponse = await axios.post(
        process.env.API_TOKEN_URL,
        new URLSearchParams({
          client_id: process.env.CLIENT_ID,
          client_secret: process.env.CLIENT_SECRET,
          grant_type: "client_credentials",
        }),
        {
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
        }
      )

      accessToken = tokenResponse.data.access_token
      const expiresIn = tokenResponse.data.expires_in || 600 // Fallback to 10 minutes if expires_in isn't provided
      tokenExpiryTime = Date.now() + expiresIn * 1000
    }

    return accessToken
  } catch (error) {
    // Error handling
    console.log(err.message)
    throw error
  }
}

// isTokenExpired remains the same

// Function to check if token is expired
function isTokenExpired() {
  return Date.now() >= tokenExpiryTime
}

module.exports = { getToken, isTokenExpired }

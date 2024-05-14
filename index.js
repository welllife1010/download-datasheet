const axios = require("axios").default
const puppeteer = require("puppeteer")
const fs = require("fs")
const path = require("path")

const DOWNLOAD_TIMEOUT = 120000 // 2 minutes timeout
const S3_BASE_URL =
  "https://suntsu-products-s3-bucket.s3.us-west-1.amazonaws.com/microprocessor_datasheet/"

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/58.0.3029.110 Safari/537.3",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0.3 Safari/605.1.15",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:85.0) Gecko/20100101 Firefox/85.0",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/88.0.4324.96 Safari/537.36",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 14_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0 Mobile/15E148 Safari/604.1",
]

function saveState(filePath, state) {
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2), "utf8")
}

function loadState(filePath) {
  if (fs.existsSync(filePath)) {
    return JSON.parse(fs.readFileSync(filePath, "utf8"))
  }
  return { lastIndex: 0 }
}

function appendToJsonFile(filePath, data) {
  let array = []
  if (fs.existsSync(filePath)) {
    array = JSON.parse(fs.readFileSync(filePath, "utf8"))
  } else {
    // Ensure the directory exists
    const dir = path.dirname(filePath)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
  }

  // Check for duplicates
  const exists = array.some((item) => item.index === data.index)
  if (!exists) {
    array.push(data)
  }

  fs.writeFileSync(filePath, JSON.stringify(array, null, 2), "utf8")
}

async function downloadWithAxios(url, outputPath, userAgent) {
  const source = axios.CancelToken.source()
  setTimeout(() => {
    source.cancel(`Download timeout after ${DOWNLOAD_TIMEOUT / 1000} seconds.`)
  }, DOWNLOAD_TIMEOUT)

  try {
    const response = await axios({
      method: "GET",
      url: url,
      responseType: "stream",
      cancelToken: source.token,
      headers: {
        "User-Agent": userAgent,
        Accept: "*/*",
      },
    })

    const writer = fs.createWriteStream(outputPath)
    response.data.pipe(writer)

    return new Promise((resolve, reject) => {
      writer.on("finish", () => {
        console.log(
          `Successfully downloaded ${path.basename(
            outputPath
          )} with User-Agent: ${userAgent}`
        )
        resolve(true)
      })
      writer.on("error", reject)
    })
  } catch (error) {
    console.error(
      `Error downloading ${url} with User-Agent ${userAgent}: ${error.message}`
    )
    throw new Error(`Failed to download: ${url}`)
  }
}

async function downloadWithPuppeteer(url, outputPath) {
  const browser = await puppeteer.launch({ headless: true })
  const page = await browser.newPage()

  try {
    await page.goto(url, { waitUntil: "networkidle2" })

    // Extract the actual PDF URL from the viewer page
    const pdfUrl = await page.evaluate(() => {
      const iframe = document.querySelector("iframe")
      if (iframe) {
        return iframe.src
      }
      return null
    })

    if (!pdfUrl) {
      throw new Error("PDF URL not found in viewer page")
    }

    await page.goto(pdfUrl, { waitUntil: "networkidle2" })
    const pdfBuffer = await page.pdf()

    fs.writeFileSync(outputPath, pdfBuffer)
    console.log(
      `Successfully downloaded ${path.basename(outputPath)} via Puppeteer`
    )
  } catch (error) {
    console.error(`Error downloading ${url} with Puppeteer: ${error.message}`)
    throw new Error(`Failed to download: ${url}`)
  } finally {
    await browser.close()
  }
}

function extractValidUrl(url) {
  if (!url) return null

  // Extract URL up to and including .pdf
  const pdfIndex = url.indexOf(".pdf")
  if (pdfIndex !== -1) {
    return url.substring(0, pdfIndex + 4) // Include .pdf
  }

  // Return the original URL if no special handling is required
  return url
}

async function downloadDatasheets(jsonData, outputFolder) {
  const stateFile = path.join(outputFolder, "state.json")
  let state = loadState(stateFile)
  const outputJsonPath = path.join(outputFolder, "output.json")
  const failedJsonPath = path.join(outputFolder, "failed.json")

  if (!fs.existsSync(outputFolder)) {
    fs.mkdirSync(outputFolder, { recursive: true })
  }

  for (let i = state.lastIndex; i < jsonData.length; i++) {
    const item = jsonData[i]
    const index = i + 1 // Using 1-based index for clarity in output
    const partNumber = item.ManufacturerProductNumber
      ? item.ManufacturerProductNumber.replace(/\//g, "-")
      : `UnknownPart_${index}`

    let datasheetUrl = extractValidUrl(item.DatasheetUrl)

    const datasheetName = `${partNumber}.pdf`
    const outputPath = path.join(outputFolder, datasheetName)

    // Initially, assume the download will be successful
    appendToJsonFile(outputJsonPath, {
      index: index,
      partNumber: partNumber,
      datasheetUrl: datasheetUrl, // Use original URL in output.json until download is confirmed
    })

    if (!datasheetUrl) {
      console.log(
        `Skipping download due to missing URL for index ${index}, part number: ${partNumber}`
      )
      appendToJsonFile(failedJsonPath, {
        index: index,
        partNumber: partNumber,
        datasheetUrl: null,
        reason: "Missing or invalid URL",
      })
      continue
    }

    console.log(
      `Processing index ${index}, ${datasheetName} from ${datasheetUrl}`
    )

    let success = false
    for (const userAgent of USER_AGENTS) {
      try {
        if (datasheetUrl.includes("widen.net")) {
          await downloadWithPuppeteer(datasheetUrl, outputPath)
        } else {
          console.log(
            `Downloading from ${datasheetUrl} with User-Agent: ${userAgent}`
          )
          await downloadWithAxios(datasheetUrl, outputPath, userAgent)
        }

        // Update output.json only after successful download
        const updatedEntry = {
          index: index,
          partNumber: partNumber,
          datasheetUrl: `${S3_BASE_URL}${datasheetName}`, // Update with S3 URL upon successful download
        }

        // Remove the old entry and add the updated entry
        let outputData = JSON.parse(fs.readFileSync(outputJsonPath, "utf8"))
        outputData = outputData.filter((entry) => entry.index !== index)
        outputData.push(updatedEntry)
        fs.writeFileSync(
          outputJsonPath,
          JSON.stringify(outputData, null, 2),
          "utf8"
        )

        success = true
        break
      } catch (error) {
        console.error(
          `Failed to process index ${index}, ${partNumber} with User-Agent ${userAgent}: ${error}`
        )
        appendToJsonFile(failedJsonPath, {
          index: index,
          partNumber: partNumber,
          datasheetUrl: datasheetUrl,
          reason: error.message,
        })
      }
    }

    if (!success) {
      appendToJsonFile(failedJsonPath, {
        index: index,
        partNumber: partNumber,
        datasheetUrl: datasheetUrl,
        reason: "All user agents failed",
      })
    }

    state.lastIndex = i + 1
    saveState(stateFile, state)
  }

  console.log("All datasheets processed.")
}

;(async () => {
  const jsonData = require("./reference-files/test-temp.json")
  const outputFolder = "./generated-folders/test-folder"

  await downloadDatasheets(jsonData, outputFolder)
})()

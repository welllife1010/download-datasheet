const axios = require("axios").default
const fs = require("fs")
const path = require("path")

const DOWNLOAD_TIMEOUT = 120000 // 2 minutes timeout
const S3_BASE_URL =
  "https://suntsu-products-s3-bucket.s3.us-west-1.amazonaws.com/rf_switch_datasheets/"

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

function extractValidUrl(url) {
  if (!url) return null

  // Extract URL up to and including .pdf and keep query parameters
  const pdfIndex = url.indexOf(".pdf")
  if (pdfIndex !== -1) {
    return url.substring(0, pdfIndex + 4) + url.substring(pdfIndex + 4) // Include .pdf and keep query parameters
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

    if (datasheetUrl) {
      const shouldDownload = datasheetUrl.includes("media.digikey.com")

      if (shouldDownload) {
        console.log(
          `Processing index ${index}, ${datasheetName} from ${datasheetUrl}`
        )

        let success = false
        for (const userAgent of USER_AGENTS) {
          try {
            console.log(
              `Downloading from ${datasheetUrl} with User-Agent: ${userAgent}`
            )
            await downloadWithAxios(datasheetUrl, outputPath, userAgent)

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
      } else {
        // If we don't need to download, just copy the original URL to the output
        appendToJsonFile(outputJsonPath, {
          index: index,
          partNumber: partNumber,
          datasheetUrl: datasheetUrl, // Use original URL
        })
      }
    } else {
      // If datasheetUrl is null, keep it as null in the output.json
      appendToJsonFile(outputJsonPath, {
        index: index,
        partNumber: partNumber,
        datasheetUrl: null, // Keep null value
      })
    }

    state.lastIndex = i + 1
    saveState(stateFile, state)
  }

  console.log("All datasheets processed.")
}

;(async () => {
  const jsonData = require("./reference-files/fpga-field-programmable-gate-array-0515.json")
  const outputFolder =
    "./generated-folders/fpga_field_programmable_gate_array_datasheets_0520_v2"

  await downloadDatasheets(jsonData, outputFolder)
})()

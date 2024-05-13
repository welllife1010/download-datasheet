const axios = require("axios").default
const puppeteer = require("puppeteer")
const fs = require("fs")
const path = require("path")
const querystring = require("querystring")

const DOWNLOAD_TIMEOUT = 120000 // 2 minutes timeout
const S3_BASE_URL =
  "https://suntsu-products-s3-bucket.s3.us-west-1.amazonaws.com/microprocessor_datasheet/"

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
  array.push(data)
  fs.writeFileSync(filePath, JSON.stringify(array, null, 2), "utf8")
}

async function downloadWithAxios(url, outputPath) {
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
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/58.0.3029.110 Safari/537.3",
        Accept: "*/*",
      },
    })

    const writer = fs.createWriteStream(outputPath)
    response.data.pipe(writer)

    return new Promise((resolve, reject) => {
      writer.on("finish", () => {
        console.log(`Successfully downloaded ${path.basename(outputPath)}`)
        resolve(true)
      })
      writer.on("error", reject)
    })
  } catch (error) {
    console.error(`Error downloading ${url}: ${error.message}`)
    throw new Error(`Failed to download: ${url}`)
  }
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

    let datasheetUrl = item.DatasheetUrl
      ? item.DatasheetUrl.startsWith("//")
        ? "https:" + item.DatasheetUrl
        : item.DatasheetUrl
      : null

    if (datasheetUrl && datasheetUrl.includes("gotoUrl=")) {
      const urlParts = new URL(datasheetUrl)
      const gotoUrl = urlParts.searchParams.get("gotoUrl")
      datasheetUrl = decodeURIComponent(gotoUrl)
    }

    if (
      datasheetUrl &&
      datasheetUrl.includes(".pdf") &&
      !datasheetUrl.includes(".pdf?")
    ) {
      datasheetUrl = datasheetUrl.split(".pdf")[0] + ".pdf"
    }

    const datasheetName = `${partNumber}.pdf`
    const outputPath = path.join(outputFolder, datasheetName)

    let datasheetLogUrl = datasheetUrl

    // Check for mm.digikey.com to adjust the log URL
    if (datasheetUrl && datasheetUrl.includes("mm.digikey.com")) {
      datasheetLogUrl = `${S3_BASE_URL}${datasheetName}`
    }

    appendToJsonFile(outputJsonPath, {
      index: index,
      partNumber: partNumber,
      datasheetUrl: datasheetLogUrl,
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

    try {
      if (datasheetUrl.includes("www.renesas.com")) {
        console.log(`Using original URL for Renesas link: ${datasheetUrl}`)
      } else {
        console.log(`Downloading from ${datasheetUrl}`)
        await downloadWithAxios(datasheetUrl, outputPath)
        if (datasheetUrl.includes("mm.digikey.com")) {
          // Update the S3 URL only if downloaded from Digikey
          appendToJsonFile(outputJsonPath, {
            index: index,
            partNumber: partNumber,
            datasheetUrl: `${S3_BASE_URL}${datasheetName}`,
          })
        }
      }
    } catch (error) {
      console.error(`Failed to process index ${index}, ${partNumber}: ${error}`)
      appendToJsonFile(failedJsonPath, {
        index: index,
        partNumber: partNumber,
        datasheetUrl: datasheetUrl,
        reason: error.message,
      })
      // If failed, revert datasheetUrl to original for this index in output.json
      appendToJsonFile(outputJsonPath, {
        index: index,
        partNumber: partNumber,
        datasheetUrl: datasheetUrl,
      })
    }

    state.lastIndex = i + 1
    saveState(stateFile, state)
  }

  console.log("All datasheets processed.")
}

;(async () => {
  const jsonData = require("./reference-files/microprocessor-datasheet-0510.json")
  const outputFolder = "./generated-folders/microprocessor_datasheet"

  await downloadDatasheets(jsonData, outputFolder)
})()
